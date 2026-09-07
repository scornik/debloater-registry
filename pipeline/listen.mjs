#!/usr/bin/env node
/**
 * Stage 3 — listen. What are people reporting about the plugins we touch?
 *
 *     node pipeline/listen.mjs --out=signals.json [--days=14]
 *
 * Fetches the wordpress.org support-forum feeds for the watched plugins and for
 * Debloater itself, keeps the threads whose titles match words that tend to
 * mean "something broke", and writes links.
 *
 * ## Links, and almost nothing else
 *
 * A signal is a URL, a title, a feed and a date. The excerpt is capped at 300
 * characters and exists so that a person scanning the pull request can tell a
 * checkout failure from a caching question without opening ten tabs.
 *
 * Support posts are written by people who did not agree to have their words
 * copied into a registry repository and kept forever. A link goes to the post
 * in its own context, where the author can still edit or delete it; a copy here
 * outlives that. So this stores the smallest thing that is useful, and the cap
 * is enforced on the way in rather than on the way out.
 *
 * ## What a signal is worth
 *
 * Very little, on its own, and the pipeline treats it that way. A forum thread
 * is somebody's account of their own site, with no versions, no reproduction
 * and no way to check. It can support a proposal to be *more* careful — a new
 * `dont_touch`, a raised risk band — because being more careful because of a
 * rumour costs little. It is not evidence for a new tweak.
 *
 * The evidence gate does not enforce that distinction, and it deliberately
 * cannot: it knows a URL was collected, not what the thread said. What enforces
 * it is that a new tweak is `direction: bolder` and waits for a person, whatever
 * it cites.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/**
 * Words that tend to appear when something is broken.
 *
 * From the brief. Kept short on purpose: a wider list matches every thread on a
 * busy forum, and a stage that returns everything has told you nothing.
 */
const KEYWORDS = [
	'fatal',
	'broke',
	'broken',
	'heartbeat',
	'rest',
	'cart',
	'checkout',
	'jquery',
	'undo',
	'rollback',
];

/**
 * The longest excerpt kept from anybody's post.
 */
const EXCERPT = 300;

/**
 * Read a `--name=value` argument.
 *
 * @param {string} name       Argument name.
 * @param {string} [fallback] Value when absent.
 * @return {string|null} Its value.
 */
const option = ( name, fallback = null ) => {
	const found = process.argv.find( ( arg ) => arg.startsWith( `--${ name }=` ) );

	return found ? found.slice( name.length + 3 ) : fallback;
};

const outPath = option( 'out', 'signals.json' );
const days = Number( option( 'days', '14' ) );

const state = JSON.parse(
	fs.readFileSync( path.join( ROOT, 'state', 'versions.json' ), 'utf8' )
);

/**
 * The feeds to read: every watched plugin, and Debloater's own.
 *
 * Debloater's is the one that matters most and is listed last so it is never
 * lost in the noise of a busy plugin's forum. A report about *this* plugin is
 * first-hand; the others are context.
 */
const feeds = [
	...Object.entries( state.plugins ?? {} )
		.filter( ( [ , entry ] ) => entry.watch )
		.map( ( [ slug ] ) => ( {
			slug,
			url: `https://wordpress.org/support/plugin/${ slug }/feed/`,
		} ) ),
	{ slug: 'debloater', url: 'https://wordpress.org/support/plugin/debloater/feed/' },
	{ slug: 'debloater-reviews', url: 'https://wordpress.org/support/plugin/debloater/reviews/feed/' },
];

/**
 * Pull the items out of an RSS document.
 *
 * A small regex reader rather than an XML parser, because this repository
 * installs nothing. It reads `<item>` blocks and the four fields wanted from
 * each; anything it cannot read is skipped rather than guessed at.
 *
 * @param {string} xml Feed body.
 * @return {Array<{title: string, url: string, date: string, excerpt: string}>} Items.
 */
export const parseFeed = ( xml ) => {
	const items = [];

	for ( const block of xml.match( /<item[\s\S]*?<\/item>/g ) ?? [] ) {
		const field = ( name ) => {
			const match = block.match(
				new RegExp( `<${ name }>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${ name }>` )
			);

			return match ? match[ 1 ].trim() : '';
		};

		// Tags first, then entities, then whitespace. wordpress.org puts markup
		// in feed titles -- a resolved thread arrives as
		// `<span class="resolved" ...>` followed by the actual title -- so a
		// title that only had its entities decoded carries that into the pull
		// request's summary table and into anything reading it.
		const title = field( 'title' )
			.replace( /<[^>]*>/g, ' ' )
			.replace( /&amp;/g, '&' )
			.replace( /&lt;/g, '<' )
			.replace( /&gt;/g, '>' )
			.replace( /&quot;/g, '"' )
			.replace( /&#0?39;|&#8217;|&apos;/g, "'" )
			.replace( /&#8211;/g, '-' )
			.replace( /&nbsp;/g, ' ' )
			.replace( /\s+/g, ' ' )
			.trim();

		const url = field( 'link' );

		if ( '' === title || '' === url ) {
			continue;
		}

		items.push( {
			title,
			url,
			date: field( 'pubDate' ),
			// Stripped of markup and capped here, at the point of collection,
			// so no later stage can be the one that decided how much of
			// somebody's post to keep.
			excerpt: field( 'description' )
				.replace( /<[^>]*>/g, ' ' )
				.replace( /\s+/g, ' ' )
				.trim()
				.slice( 0, EXCERPT ),
		} );
	}

	return items;
};

/**
 * Which keywords a title or excerpt mentions.
 *
 * @param {Object} item A feed item.
 * @return {string[]} Matched keywords.
 */
export const matches = ( item ) => {
	const haystack = `${ item.title } ${ item.excerpt }`.toLowerCase();

	// Word boundaries, so "rest" does not match "restore" and "cart" does not
	// match "cartridge". A filter that matches everything is the same as no
	// filter, and worse, because it looks like one.
	return KEYWORDS.filter( ( word ) =>
		new RegExp( `\\b${ word }\\b` ).test( haystack )
	);
};

const since = Date.now() - days * 24 * 60 * 60 * 1000;
const signals = [];
const unreachable = [];

for ( const feed of feeds ) {
	try {
		const response = await fetch( feed.url, {
			headers: { 'user-agent': 'debloater-registry listen' },
			signal: AbortSignal.timeout( 20000 ),
		} );

		if ( ! response.ok ) {
			unreachable.push( { feed: feed.slug, why: `HTTP ${ response.status }` } );

			continue;
		}

		for ( const item of parseFeed( await response.text() ) ) {
			const when = Date.parse( item.date );

			if ( Number.isFinite( when ) && when < since ) {
				continue;
			}

			const keywords = matches( item );

			if ( 0 === keywords.length ) {
				continue;
			}

			signals.push( {
				feed: feed.slug,
				url: item.url,
				title: item.title,
				date: item.date,
				keywords,
				excerpt: item.excerpt,
			} );
		}
	} catch ( error ) {
		unreachable.push( { feed: feed.slug, why: error.message } );
	}
}

fs.writeFileSync(
	outPath,
	`${ JSON.stringify( { window_days: days, signals, unreachable }, null, 4 ) }\n`
);

process.stdout.write(
	`${ signals.length } signal(s) from ${ feeds.length - unreachable.length } feed(s) -> ${ outPath }\n`
);

for ( const entry of unreachable ) {
	// Not fatal. A forum that is down is a forum that is down, and the run is
	// still worth making on what the scanner found. Said out loud so that a
	// permanently unreachable feed does not become invisible.
	process.stdout.write( `WARN ${ entry.feed }: ${ entry.why }\n` );
}
