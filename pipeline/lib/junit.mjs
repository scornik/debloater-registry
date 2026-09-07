/**
 * Reading a JUnit report, with no side effects.
 *
 * Separated from `pipeline/verify.mjs` for the reason `lib/versions.mjs` is
 * separated from `pipeline/watch.mjs`, which is that the same mistake was made
 * twice in one afternoon: a test imported the stage script, the script's
 * top-level code ran on import, and the suite failed because the script exited
 * for want of a `--junit` argument it was never going to be given.
 *
 * The convention this settles: anything that decides something lives in
 * `pipeline/lib/` and is importable without consequences. Anything that reads
 * arguments, touches the network or exits lives in `pipeline/` and is only ever
 * run. Tests import from `lib/`, never from a stage.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read the testcases out of a JUnit document.
 *
 * A regex reader, because this repository installs nothing. JUnit is a shallow
 * format and the three attributes wanted here are all on the `testcase`
 * element.
 *
 * @param {string} xml The report.
 * @return {Array<{name: string, classname: string, failure: string|null}>} Cases.
 */
export const parseJUnit = ( xml ) => {
	const cases = [];

	// From `<testcase` to whichever comes first: its own self-closing bracket,
	// or the closing tag.
	//
	// The obvious pattern is wrong in a way that took a fixture to see. Letting
	// a negated class of everything-but-a-closing-bracket run over the
	// attributes lets it eat the slash of a self-closing tag, because a slash is
	// not an angle bracket; the alternation then takes the open-tag branch and
	// runs on into the *next* case, so two testcases merge into one and the
	// second one's failure is reported against the first one's classname.
	//
	// That is not a parsing curiosity. It attributes a regression to the wrong
	// tweak, and the analyze stage then proposes changes to that tweak citing a
	// real failure -- evidence that passes every gate and points at the wrong
	// file.
	for ( const block of xml.match( /<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g ) ?? [] ) {
		const attr = ( name ) => {
			const match = block.match( new RegExp( `\\b${ name }="([^"]*)"` ) );

			return match ? match[ 1 ] : '';
		};

		const failed = /<(failure|error)\b/.test( block );
		const message = failed
			? ( block.match( /<(?:failure|error)\b[^>]*message="([^"]*)"/ )?.[ 1 ] ?? 'failed' )
			: null;

		cases.push( {
			name: attr( 'name' ),
			classname: attr( 'classname' ),
			failure: message
				? message
						.replace( /&quot;/g, '"' )
						.replace( /&apos;/g, "'" )
						.replace( /&lt;/g, '<' )
						.replace( /&gt;/g, '>' )
						.replace( /&amp;/g, '&' )
						.replace( /\s+/g, ' ' )
						.trim()
						.slice( 0, 400 )
				: null,
		} );
	}

	return cases;
};

/**
 * Which tweak a test is about, if any.
 *
 * @param {Object}   testcase The case.
 * @param {string[]} ids      Known tweak ids, longest first.
 * @return {string|null} A tweak id.
 */
export const tweakFor = ( testcase, ids ) => {
	const haystack = `${ testcase.classname } ${ testcase.name }`;

	for ( const id of ids ) {
		if ( haystack.includes( id ) ) {
			return id;
		}
	}

	// Tests often name a tweak with underscores where the id has dots.
	for ( const id of ids ) {
		if ( haystack.includes( id.replace( /\./g, '_' ) ) ) {
			return id;
		}
	}

	return null;
};
