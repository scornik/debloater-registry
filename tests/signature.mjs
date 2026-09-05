#!/usr/bin/env node
/**
 * The committed signature is this manifest's, made with the key the plugin pins.
 *
 * A manifest edited without re-signing fails here, which is the point: the
 * hashes inside `manifest.json` are what a site checks each file against, so an
 * edited manifest that still carried a valid-looking release would be a way to
 * hand a site any file at all.
 *
 * No dependencies, deliberately. Node verifies Ed25519 itself; the only work is
 * wrapping the 32 raw key bytes in the SPKI header `crypto` expects, which is a
 * fixed twelve-byte prefix and not a cryptographic operation.
 *
 *     node tests/signature.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

const ROOT = path.resolve( path.dirname( url.fileURLToPath( import.meta.url ) ), '..' );

/**
 * The public half of the registry signing key.
 *
 * Pinned in the plugin as `SignatureVerifier::PUBLIC_KEY_HEX`, and recorded in
 * its `docs/DECISIONS.md` D-0059 with this fingerprint:
 *
 *   sha256(raw) = a2179aba16aa74a34b3d0c80a2a86d2adb622a7fcf2043dd93da6f9c8964caa3
 *
 * Written out here rather than fetched from anywhere. A key that travels with
 * the thing it verifies verifies nothing.
 */
const PUBLIC_KEY_HEX = 'c0504cbb47724218570330a31cd175d3b40c0bb58d72c4ce640fdebdacaeab06';

const FINGERPRINT = 'a2179aba16aa74a34b3d0c80a2a86d2adb622a7fcf2043dd93da6f9c8964caa3';

/**
 * Fail with a message.
 *
 * @param {string} message What is wrong.
 * @param {string} [fix]   What to do about it.
 */
function refuse( message, fix ) {
	process.stderr.write( `\nThe registry signature does not check out: ${ message }\n` );

	if ( fix ) {
		process.stderr.write( `\n  ${ fix }\n` );
	}

	process.stderr.write( '\n' );
	process.exit( 1 );
}

const manifestPath = path.join( ROOT, 'manifest.json' );
const signaturePath = path.join( ROOT, 'manifest.sig' );

for ( const required of [ manifestPath, signaturePath ] ) {
	if ( ! fs.existsSync( required ) ) {
		refuse(
			`${ path.basename( required ) } is missing.`,
			'A release is a manifest and a detached signature over it; one without the other is neither.'
		);
	}
}

const manifest = fs.readFileSync( manifestPath );
const signature = fs.readFileSync( signaturePath );

const raw = Buffer.from( PUBLIC_KEY_HEX, 'hex' );

if ( 32 !== raw.length ) {
	refuse( `the pinned key is ${ raw.length } bytes; an Ed25519 public key is 32.` );
}

const fingerprint = crypto.createHash( 'sha256' ).update( raw ).digest( 'hex' );

if ( fingerprint !== FINGERPRINT ) {
	refuse(
		`the key in this file has fingerprint ${ fingerprint }, not ${ FINGERPRINT }.`,
		'Either the key was changed without updating its fingerprint, or somebody changed it who should not have.'
	);
}

if ( 64 !== signature.length ) {
	refuse(
		`manifest.sig is ${ signature.length } bytes; an Ed25519 signature is 64.`,
		'A signature stored as text, or with a line ending appended, arrives at the wrong length. ' +
			'.gitattributes marks *.sig binary for exactly this reason.'
	);
}

// SPKI: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING key }. Fixed bytes.
const publicKey = crypto.createPublicKey( {
	key: Buffer.concat( [ Buffer.from( '302a300506032b6570032100', 'hex' ), raw ] ),
	format: 'der',
	type: 'spki',
} );

if ( ! crypto.verify( null, manifest, publicKey, signature ) ) {
	refuse(
		'the signature is not this manifest\'s, or was not made with the pinned key.',
		'If manifest.json was edited, regenerate it and sign it again — see AUTHORING.md. ' +
			'A manifest may not change without its signature changing with it.'
	);
}

process.stdout.write(
	`manifest.json (${ manifest.length } bytes) is signed by ${ PUBLIC_KEY_HEX.slice( 0, 8 ) }… — verified.\n`
);
