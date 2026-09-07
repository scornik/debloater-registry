#!/usr/bin/env node
/**
 * Is anything newer than what the pipeline has already looked at?
 *
 * Run every six hours by `.github/workflows/release-watch.yml`. It asks
 * wordpress.org for the current version of WordPress and of each watched
 * plugin, compares against `state/versions.json`, and prints a decision. The
 * workflow dispatches the expensive run only when this says something moved.
 *
 * ## What it does when it cannot see
 *
 * A watcher whose failure mode is silence is a watcher that stops working
 * without telling anybody. Three things are therefore distinguished, and only
 * one of them is "nothing to do":
 *
 * - **newer** — a version we have not investigated. Dispatch.
 * - **unchanged** — asked, answered, same as recorded. Do nothing.
 * - **unreachable** — the API did not answer, or answered with something this
 *   cannot read. Reported as a failure, never folded into "unchanged".
 *
 * `elementor-pro` is a fourth case and an honest one: it is commercial, is not
 * on wordpress.org, and the plugin-information API answers 404 for its slug. It
 * is marked `watch: false` in state/versions.json with the reason, so it is
 * skipped deliberately rather than failing every six hours or, worse, being
 * counted as up to date.
 *
 * Usage:
 *     node pipeline/watch.mjs            # print a decision, exit 0
 *     node pipeline/watch.mjs --github   # also write GITHUB_OUTPUT
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNewer } from './lib/versions.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const STATE = path.join( ROOT, 'state', 'versions.json' );

const CORE_API = 'https://api.wordpress.org/core/version-check/1.7/';
const PLUGIN_API = 'https://api.wordpress.org/plugins/info/1.2/';

/**
 * Fetch JSON, distinguishing "answered no" from "did not answer".
 *
 * @param {string} url Where.
 * @return {Promise<{ok: boolean, json?: Object, why?: string}>} The answer.
 */
const ask = async ( url ) => {
	try {
		const response = await fetch( url, {
			headers: { 'user-agent': 'debloater-registry release-watch' },
			signal: AbortSignal.timeout( 20000 ),
		} );

		if ( ! response.ok ) {
			return { ok: false, why: `HTTP ${ response.status }` };
		}

		return { ok: true, json: await response.json() };
	} catch ( error ) {
		return { ok: false, why: error.message };
	}
};

/**
 * The current WordPress version.
 *
 * @return {Promise<{ok: boolean, version?: string, why?: string}>} The answer.
 */
const currentCore = async () => {
	const answer = await ask( CORE_API );

	if ( ! answer.ok ) {
		return answer;
	}

	const version = answer.json?.offers?.[ 0 ]?.current;

	return 'string' === typeof version
		? { ok: true, version }
		: { ok: false, why: 'the version-check response had no current offer' };
};

/**
 * The current version of one plugin.
 *
 * @param {string} slug wordpress.org slug.
 * @return {Promise<{ok: boolean, version?: string, why?: string}>} The answer.
 */
const currentPlugin = async ( slug ) => {
	const url =
		`${ PLUGIN_API }?action=plugin_information` +
		`&request[slug]=${ encodeURIComponent( slug ) }` +
		'&request[fields][sections]=0';

	const answer = await ask( url );

	if ( ! answer.ok ) {
		return answer;
	}

	const version = answer.json?.version;

	return 'string' === typeof version
		? { ok: true, version }
		: { ok: false, why: answer.json?.error ?? 'the response carried no version' };
};

const state = JSON.parse( fs.readFileSync( STATE, 'utf8' ) );

const newer = [];
const unchanged = [];
const unreachable = [];
const skipped = [];

const core = state.core?.wordpress;

if ( core?.watch ) {
	const answer = await currentCore();

	if ( ! answer.ok ) {
		unreachable.push( { what: 'wordpress', why: answer.why } );
	} else if ( isNewer( core.version, answer.version ) ) {
		newer.push( { what: 'wordpress', from: core.version, to: answer.version } );
	} else {
		unchanged.push( { what: 'wordpress', version: answer.version } );
	}
}

for ( const [ slug, recorded ] of Object.entries( state.plugins ?? {} ) ) {
	if ( ! recorded.watch ) {
		skipped.push( { what: slug, why: recorded.why ?? 'not watched' } );

		continue;
	}

	const answer = await currentPlugin( slug );

	if ( ! answer.ok ) {
		unreachable.push( { what: slug, why: answer.why } );

		continue;
	}

	if ( isNewer( recorded.version, answer.version ) ) {
		newer.push( { what: slug, from: recorded.version, to: answer.version } );
	} else {
		unchanged.push( { what: slug, version: answer.version } );
	}
}

const report = { newer, unchanged, unreachable, skipped };

process.stdout.write( `${ JSON.stringify( report, null, 2 ) }\n` );

for ( const entry of newer ) {
	process.stdout.write( `NEW  ${ entry.what }: ${ entry.from } -> ${ entry.to }\n` );
}

for ( const entry of skipped ) {
	process.stdout.write( `SKIP ${ entry.what }: ${ entry.why }\n` );
}

for ( const entry of unreachable ) {
	process.stdout.write( `WARN ${ entry.what } could not be checked: ${ entry.why }\n` );
}

if ( process.argv.includes( '--github' ) && process.env.GITHUB_OUTPUT ) {
	fs.appendFileSync(
		process.env.GITHUB_OUTPUT,
		`dispatch=${ newer.length > 0 ? 'true' : 'false' }\n` +
			`summary=${ newer.map( ( e ) => `${ e.what } ${ e.to }` ).join( ', ' ) }\n`
	);
}

// Being unable to look is a failure. It is reported after the decision so that
// a run which found something new still dispatches, and it is not silent:
// a watcher that cannot see must not read as a watcher that saw nothing.
if ( unreachable.length > 0 ) {
	process.exitCode = 1;
}
