#!/usr/bin/env node
/**
 * Stage 1 — observe. What is on a site at the new versions that was not before?
 *
 *     node pipeline/observe.mjs --stack=clean --facts=scan.json \
 *         --versions=state/versions.json --out=candidates.json
 *
 * The workflow stands WordPress up at the new versions, runs
 * `wp debloater scan --json` on a clean install and on the seeded fixture, and
 * hands the FactSet here. This compares it against `baselines/<stack>.json` and
 * writes one candidate per new item, with the evidence attached.
 *
 * ## A candidate is not a proposal
 *
 * Nothing here suggests a registry change. A candidate says "this fact appeared
 * between these two versions, on this stack, and here is what it was and what
 * it is". Everything downstream has to point back at one of these, and the
 * evidence gate drops anything that cannot.
 *
 * That separation is the reason a model is allowed anywhere near this
 * repository. The observations are made by a scanner on a real install; the
 * model only gets to *interpret* them, and only in ways that cite one.
 *
 * ## The first run records, and proposes nothing
 *
 * A missing baseline is not an empty baseline. If it were treated as one, the
 * first run on a new stack would report every fact on the site as newly
 * appeared — several hundred candidates, all of them meaningless, and a model
 * asked to find meaning in them would find some.
 *
 * So a missing baseline is recorded and the run emits zero candidates. The
 * comparison starts from the second run, which is the first one that has two
 * things to compare.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffFacts, toCandidates } from './lib/factdiff.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/**
 * Read a `--name=value` argument.
 *
 * @param {string} name Argument name.
 * @param {string} [fallback] Value when absent.
 * @return {string|null} Its value.
 */
const option = ( name, fallback = null ) => {
	const found = process.argv.find( ( arg ) => arg.startsWith( `--${ name }=` ) );

	return found ? found.slice( name.length + 3 ) : fallback;
};

const stack = option( 'stack' );
const factsPath = option( 'facts' );
const versionsPath = option( 'versions', path.join( ROOT, 'state', 'versions.json' ) );
const outPath = option( 'out', 'candidates.json' );

if ( ! stack || ! factsPath ) {
	process.stderr.write(
		'\nUsage: observe.mjs --stack=<name> --facts=<scan.json> [--out=candidates.json]\n\n'
	);
	process.exit( 1 );
}

/**
 * The flat fact map from a `wp debloater scan --json` document.
 *
 * The CLI wraps its facts; older shapes put them at the top level. Both are
 * accepted, and anything else is refused rather than guessed at — a scan this
 * cannot read must not become "the site had no facts", which would report every
 * baseline entry as removed.
 *
 * @param {Object} document Parsed scan output.
 * @return {Object} The fact map.
 */
const factsFrom = ( document ) => {
	if ( document && 'object' === typeof document.facts ) {
		return document.facts;
	}

	if ( document && 'object' === typeof document && ! Array.isArray( document ) ) {
		return document;
	}

	throw new Error(
		'The scan output has no facts. Expected { "facts": { … } } or a flat map.'
	);
};

const scan = JSON.parse( fs.readFileSync( factsPath, 'utf8' ) );
const observed = factsFrom( scan );

if ( 0 === Object.keys( observed ).length ) {
	// An empty FactSet is a broken scan, not a bare site. Every WordPress
	// install has cron hooks and autoloaded options.
	process.stderr.write(
		`\n${ factsPath } parsed but contained no facts. That is a failed scan, ` +
			'not an empty site, and treating it as one would report the entire ' +
			'baseline as removed.\n\n'
	);
	process.exit( 1 );
}

const versions = JSON.parse( fs.readFileSync( versionsPath, 'utf8' ) );
const observedAt = {
	wordpress: versions.core?.wordpress?.version ?? null,
	...Object.fromEntries(
		Object.entries( versions.plugins ?? {} ).map( ( [ slug, entry ] ) => [
			slug,
			entry.version,
		] )
	),
};

const baselinePath = path.join( ROOT, 'baselines', `${ stack }.json` );

if ( ! fs.existsSync( baselinePath ) ) {
	fs.mkdirSync( path.dirname( baselinePath ), { recursive: true } );
	fs.writeFileSync(
		baselinePath,
		`${ JSON.stringify(
			{
				_comment: [
					`What ${ stack } looked like when this baseline was recorded.`,
					'Written by pipeline/observe.mjs. Compared against on later runs.',
				],
				stack,
				recorded_at: new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ),
				versions: observedAt,
				facts: observed,
			},
			null,
			4
		) }\n`
	);

	fs.writeFileSync( outPath, `${ JSON.stringify( { stack, first_run: true, candidates: [] }, null, 4 ) }\n` );

	process.stdout.write(
		`Recorded a first baseline for ${ stack } (${ Object.keys( observed ).length } facts).\n` +
			'No candidates: there was nothing to compare against, and calling every ' +
			'fact on the site "new" would be a lie with several hundred parts.\n'
	);

	process.exit( 0 );
}

const baseline = JSON.parse( fs.readFileSync( baselinePath, 'utf8' ) );
const diff = diffFacts( baseline.facts ?? {}, observed );
const candidates = toCandidates( { stack, versions: observedAt, diff } );

fs.writeFileSync(
	outPath,
	`${ JSON.stringify(
		{
			stack,
			first_run: false,
			compared_against: {
				recorded_at: baseline.recorded_at ?? null,
				versions: baseline.versions ?? null,
			},
			observed_at: observedAt,
			counts: {
				added: diff.added.length,
				changed: diff.changed.length,
				removed: diff.removed.length,
			},
			candidates,
		},
		null,
		4
	) }\n`
);

process.stdout.write(
	`${ stack }: ${ diff.added.length } added, ${ diff.changed.length } changed, ` +
		`${ diff.removed.length } removed -> ${ outPath }\n`
);
