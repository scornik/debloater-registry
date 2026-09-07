#!/usr/bin/env node
/**
 * Stage 2 — verify. Does the existing registry still hold at the new versions?
 *
 *     node pipeline/verify.mjs --junit=results.xml --out=regressions.json
 *
 * The workflow runs the plugin's compatibility and probe matrix against the new
 * WordPress and plugin versions, with `--log-junit`. This reads that report and
 * writes one entry per failure, naming the tweak and the probe.
 *
 * ## Why this reads a report rather than running the tests
 *
 * The matrix belongs to the plugin. It knows how to stand a site up, which
 * probes exist and what a probe failing means; this repository is data and has
 * never contained code that runs on a site. Re-implementing any of that here
 * would produce a second opinion about whether a tweak is safe, and the second
 * opinion would eventually be the wrong one.
 *
 * So the contract is a JUnit file. PHPUnit already writes one, every CI system
 * understands it, and it does not require this repository to know anything
 * about how the plugin tests itself.
 *
 * ## A missing report is a failure
 *
 * If the matrix did not run, or crashed before writing its report, this exits
 * non-zero. It does not write an empty `regressions.json`.
 *
 * That distinction is the entire value of this stage. "The matrix passed" and
 * "the matrix never ran" produce the same empty file, and downstream a model
 * would be told there were no regressions — a false statement built out of an
 * absence. The pipeline's other stages make the same distinction for the same
 * reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJUnit, tweakFor } from './lib/junit.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

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

const junitPath = option( 'junit' );
const outPath = option( 'out', 'regressions.json' );

if ( ! junitPath ) {
	process.stderr.write( '\nUsage: verify.mjs --junit=<results.xml> [--out=regressions.json]\n\n' );
	process.exit( 1 );
}

if ( ! fs.existsSync( junitPath ) ) {
	process.stderr.write(
		`\nThere is no report at ${ junitPath }.\n\n` +
			'That means the matrix did not run, or died before writing one. It does\n' +
			'not mean there were no regressions, and this stage will not write an\n' +
			'empty regressions.json saying so.\n\n'
	);
	process.exit( 1 );
}

/**
 * Every tweak id the registry knows about.
 *
 * Used to turn a test name into a tweak. Read from disk rather than guessed
 * from the name's shape, so a renamed tweak stops matching instead of quietly
 * matching something else.
 *
 * @return {string[]} Tweak ids, longest first.
 */
const tweakIds = () =>
	fs
		.readdirSync( path.join( ROOT, 'tweaks' ) )
		.filter( ( file ) => file.endsWith( '.json' ) )
		.map( ( file ) => path.basename( file, '.json' ) )
		// Longest first: `core.disable_embeds` must win over a hypothetical
		// `core.disable`, or a substring match would attribute a failure to the
		// wrong tweak.
		.sort( ( a, b ) => b.length - a.length );

const xml = fs.readFileSync( junitPath, 'utf8' );
const cases = parseJUnit( xml );

if ( 0 === cases.length ) {
	process.stderr.write(
		`\n${ junitPath } contained no testcases.\n\n` +
			'An empty report is not a passing matrix. Either the run produced\n' +
			'nothing or this could not read it, and both are failures.\n\n'
	);
	process.exit( 1 );
}

const ids = tweakIds();
const regressions = [];

for ( const testcase of cases ) {
	if ( null === testcase.failure ) {
		continue;
	}

	const tweak = tweakFor( testcase, ids );

	regressions.push( {
		// The evidence gate matches on `tweak`, so an unmapped failure still
		// carries an identifier — the test's own name. A failure nobody can
		// attribute is still a failure worth putting in front of a person.
		tweak: tweak ?? `${ testcase.classname }::${ testcase.name }`,
		mapped: null !== tweak,
		probe: testcase.name,
		suite: testcase.classname,
		message: testcase.failure,
	} );
}

fs.writeFileSync(
	outPath,
	`${ JSON.stringify(
		{
			source: path.basename( junitPath ),
			cases: cases.length,
			failures: regressions.length,
			unmapped: regressions.filter( ( entry ) => ! entry.mapped ).length,
			regressions,
		},
		null,
		4
	) }\n`
);

process.stdout.write(
	`${ cases.length } case(s), ${ regressions.length } failure(s) -> ${ outPath }\n`
);

for ( const entry of regressions ) {
	process.stdout.write(
		`FAIL ${ entry.tweak }${ entry.mapped ? '' : ' (unmapped)' }: ${ entry.message.slice( 0, 90 ) }\n`
	);
}
