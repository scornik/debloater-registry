#!/usr/bin/env node
/**
 * Regenerate `manifest.json`, and record what is released.
 *
 *     node pipeline/build-manifest.mjs                 keep the current tag
 *     node pipeline/build-manifest.mjs --tag=v0.2.0    stamp it for a release
 *     node pipeline/build-manifest.mjs --check         verify, change nothing
 *     node pipeline/build-manifest.mjs --released=v0.2.0
 *
 * This never signs. Signing is `make registry-release`, on a machine holding
 * the offline key, by a person (docs/DECISIONS.md D-0067).
 *
 * ## Keeping the tag by default
 *
 * The pipeline changes content, not releases. When it opens a pull request it
 * regenerates the manifest so the hashes are right — which is what keeps the
 * integrity check green on every push — and leaves the tag naming the last
 * release. So `manifest.json` on main means "these are the current files, and
 * the last thing signed was `tag`", which is exactly what state/released.json
 * says in longer form.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	buildManifest,
	checkManifest,
	serialise,
	UnrecognisedFile,
} from './lib/manifest.mjs';

/**
 * An unclassifiable file is a clear message, not a stack trace.
 *
 * The whole point of the allow-list is that somebody has to decide what a new
 * file is. A stack trace tells them something broke; this tells them what to
 * do about it.
 */
process.on( 'uncaughtException', ( error ) => {
	if ( ! ( error instanceof UnrecognisedFile ) ) {
		throw error;
	}

	process.stderr.write( `\n${ error.message }\n\n` );
	process.exit( 1 );
} );

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const MANIFEST = path.join( ROOT, 'manifest.json' );
const RELEASED = path.join( ROOT, 'state', 'released.json' );

/**
 * Read a `--name=value` argument.
 *
 * @param {string} name Argument name.
 * @return {string|null} Its value, or null.
 */
const option = ( name ) => {
	const found = process.argv.find( ( arg ) => arg.startsWith( `--${ name }=` ) );

	return found ? found.slice( name.length + 3 ) : null;
};

/* ------------------------------------------------------------------ check */

if ( process.argv.includes( '--check' ) ) {
	const { ok, problems } = checkManifest( ROOT );

	if ( ! ok ) {
		process.stderr.write( `\nThe manifest does not describe what is on disk:\n\n` );

		for ( const problem of problems ) {
			process.stderr.write( `  - ${ problem }\n` );
		}

		process.stderr.write( `\nRun 'make registry-build'.\n\n` );
		process.exit( 1 );
	}

	process.stdout.write( 'The manifest describes exactly what is on disk.\n' );
	process.exit( 0 );
}

/* --------------------------------------------------------------- released */

const released = option( 'released' );

if ( null !== released ) {
	// Called by `make registry-release` *after* signing, so the hash it records
	// is the hash of the bytes that were actually signed.
	const manifestBytes = fs.readFileSync( MANIFEST );
	const previous = fs.existsSync( RELEASED )
		? JSON.parse( fs.readFileSync( RELEASED, 'utf8' ) )
		: {};

	const record = {
		_comment: previous._comment ?? [],
		tag: released,
		released_at: new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ),
		manifest_sha256: crypto.createHash( 'sha256' ).update( manifestBytes ).digest( 'hex' ),
		signed: fs.existsSync( path.join( ROOT, 'manifest.sig' ) ),
	};

	fs.writeFileSync( RELEASED, `${ JSON.stringify( record, null, 4 ) }\n` );

	process.stdout.write( `state/released.json now names ${ released }.\n` );
	process.exit( 0 );
}

/* ------------------------------------------------------------------ build */

const existing = fs.existsSync( MANIFEST )
	? JSON.parse( fs.readFileSync( MANIFEST, 'utf8' ) )
	: {};

const tag = option( 'tag' ) ?? existing.tag;

if ( ! tag ) {
	process.stderr.write(
		'\nThere is no tag to write. Pass --tag=vX.Y.Z, or run this where a ' +
			'manifest already exists.\n\n'
	);
	process.exit( 1 );
}

const manifest = buildManifest( { root: ROOT, tag } );
const bytes = serialise( manifest );
const before = fs.existsSync( MANIFEST ) ? fs.readFileSync( MANIFEST, 'utf8' ) : '';

// The timestamp moves on every run, so comparing whole files would report a
// change every time. What matters is whether the *files* changed.
const sameFiles =
	JSON.stringify( existing.files ?? {} ) === JSON.stringify( manifest.files ) &&
	existing.tag === tag;

if ( sameFiles && '' !== before ) {
	process.stdout.write(
		`manifest.json already describes these ${ Object.keys( manifest.files ).length } files ` +
			`for ${ tag }. Left alone.\n`
	);
	process.exit( 0 );
}

fs.writeFileSync( MANIFEST, bytes );

process.stdout.write(
	`Wrote manifest.json for ${ tag } with ${ Object.keys( manifest.files ).length } files.\n`
);

if ( fs.existsSync( path.join( ROOT, 'manifest.sig' ) ) ) {
	process.stdout.write(
		'\nThe committed signature no longer matches this manifest, and that is\n' +
			'expected on main: content is unsigned until a release. The release gate\n' +
			"verifies the signature when a tag is pushed — see docs/DECISIONS.md D-0067.\n"
	);
}
