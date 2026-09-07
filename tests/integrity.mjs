#!/usr/bin/env node
/**
 * The registry checks itself, with nothing installed.
 *
 * This repository is data. What can go wrong with data is that it stops
 * parsing, that the manifest stops describing what is actually here, or that a
 * document loses a field the plugin depends on. All three are checkable with
 * the standard library alone, and a check that needs nothing installed is a
 * check that still runs in two years.
 *
 * What this deliberately does not do is validate every document against its
 * JSON Schema. That needs a validator, and the plugin already has one it uses
 * on load — `Debloater\Registry\SchemaValidator`, run against this content by
 * the plugin's own suite. Reimplementing it here would mean two validators
 * disagreeing eventually, and the plugin's is the one whose opinion decides
 * whether a site loads the registry.
 *
 *     node tests/integrity.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { registryFiles } from '../pipeline/lib/manifest.mjs';
import process from 'node:process';
import url from 'node:url';

const ROOT = path.resolve( path.dirname( url.fileURLToPath( import.meta.url ) ), '..' );

const failures = [];

/**
 * Record a failure.
 *
 * @param {string} message What is wrong.
 */
function fail( message ) {
	failures.push( message );
}

/**
 * Every JSON file the registry actually publishes.
 *
 * Imported rather than re-implemented. `pipeline/lib/manifest.mjs` decides what
 * goes *into* the manifest; this file checks what is *in* it. Two answers to
 * "which files are registry data" is two lists to keep in step, and the day
 * they disagree is the day a correct manifest fails this check — which is
 * exactly what happened when the pipeline added state/released.json and this
 * file, walking every .json in the repository, reported it as an undeclared
 * document.
 *
 * The exclusions live with the builder because the builder is what a release
 * depends on. This follows it.
 *
 * @return {string[]} Sorted relative paths.
 */
function documents() {
	return registryFiles( ROOT );
}

const files = documents();

if ( 0 === files.length ) {
	fail( 'No JSON documents were found at all, so this check is not reading the repository.' );
}

// 1. Everything parses.
const parsed = new Map();

for ( const relative of files ) {
	try {
		parsed.set( relative, JSON.parse( fs.readFileSync( path.join( ROOT, relative ), 'utf8' ) ) );
	} catch ( error ) {
		fail( `${ relative } is not valid JSON: ${ error.message }` );
	}
}

// 2. The manifest describes exactly what is here.
//
// Read directly rather than from `parsed`, because registryFiles() lists what
// the manifest *covers* and the manifest is not one of those files.
let manifest = null;

try {
	manifest = JSON.parse( fs.readFileSync( path.join( ROOT, 'manifest.json' ), 'utf8' ) );
} catch ( error ) {
	fail( `manifest.json could not be read: ${ error.message }` );
}

if ( ! manifest ) {
	fail( 'manifest.json is missing, so nothing can say which version this is.' );
} else {
	const recorded = Object.keys( manifest.files ?? {} ).sort();
	const present = [ ...files ].sort();

	for ( const relative of present ) {
		if ( ! recorded.includes( relative ) ) {
			fail( `${ relative } is in the repository but not in the manifest.` );
		}
	}

	for ( const relative of recorded ) {
		if ( ! present.includes( relative ) ) {
			fail( `The manifest lists ${ relative }, which is not here.` );
		}
	}

	// 3. And the hashes are the files' own.
	for ( const [ relative, expected ] of Object.entries( manifest.files ?? {} ) ) {
		const where = path.join( ROOT, relative );

		if ( ! fs.existsSync( where ) ) {
			continue;
		}

		const actual = crypto.createHash( 'sha256' ).update( fs.readFileSync( where ) ).digest( 'hex' );

		if ( actual !== expected ) {
			fail( `${ relative } does not match its manifest hash. The manifest needs regenerating.` );
		}
	}

	if ( 'string' !== typeof manifest.tag || '' === manifest.tag ) {
		fail( 'The manifest carries no tag, so a site could not say which registry it is running.' );
	}
}

// 4. Every tweak carries the fields the plugin reads before it will load one.
for ( const [ relative, document ] of parsed ) {
	if ( ! relative.startsWith( 'tweaks/' ) ) {
		continue;
	}

	for ( const field of [ 'id', 'risk', 'kind' ] ) {
		if ( undefined === document[ field ] ) {
			fail( `${ relative } has no "${ field }".` );
		}
	}

	const id = path.basename( relative, '.json' );

	if ( document.id !== id ) {
		fail( `${ relative } declares id "${ document.id }", which is not its filename.` );
	}
}

process.stdout.write( `Checked ${ files.length } documents.\n` );

if ( 0 !== failures.length ) {
	process.stderr.write( `\n${ failures.length } problem(s):\n\n` );

	for ( const message of failures ) {
		process.stderr.write( `  - ${ message }\n` );
	}

	process.stderr.write( '\n' );
	process.exit( 1 );
}

process.stdout.write( 'The registry is internally consistent.\n' );
