/**
 * The Node manifest builder produces exactly what the PHP one does.
 *
 * There are two implementations of a signed format. `tools/registry-manifest.php`
 * in the plugin has cut every release so far; `pipeline/lib/manifest.mjs` exists
 * because the pipeline runs here, where the plugin is not checked out.
 *
 * Two implementations drift. When these two drift, the symptom is not a failing
 * build — it is a manifest that regenerates with different bytes, a signature
 * that no longer verifies against it, and a site refusing a registry update for
 * a reason nobody can see from here.
 *
 * So the committed manifest, which PHP wrote, is the fixture. Rebuilding it with
 * the same tag and timestamp must reproduce it byte for byte.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
	buildManifest,
	checkManifest,
	registryFiles,
	serialise,
} from '../pipeline/lib/manifest.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

test( 'rebuilding the committed manifest reproduces it byte for byte', () => {
	const committed = fs.readFileSync( path.join( ROOT, 'manifest.json' ), 'utf8' );
	const parsed = JSON.parse( committed );

	const rebuilt = serialise(
		buildManifest( {
			root: ROOT,
			tag: parsed.tag,
			generatedAt: parsed.generated_at,
		} )
	);

	assert.equal(
		rebuilt,
		committed,
		'The Node builder and the PHP builder must agree exactly, or a rebuild ' +
			'invalidates a signature that was fine.'
	);
} );

test( 'the manifest on disk describes the files on disk', () => {
	const { ok, problems } = checkManifest( ROOT );

	assert.deepEqual( problems, [] );
	assert.equal( ok, true );
} );

test( 'the pipeline, its tests and its state are not registry data', () => {
	const files = registryFiles( ROOT );

	// A site downloads registry documents. It has no use for a workflow, a
	// baseline or a unit test, and listing them would ask every site to fetch
	// and hash files that decide nothing.
	for ( const excluded of [ 'pipeline/', 'tests/', 'state/', 'baselines/', 'docs/', '.github/' ] ) {
		assert.equal(
			files.some( ( file ) => file.startsWith( excluded ) ),
			false,
			`${ excluded } must not be in the manifest`
		);
	}

	// And the documents that are data really are there, so this cannot pass by
	// excluding everything.
	assert.ok( files.includes( 'tweaks/core.remove_rsd.json' ) );
	assert.ok( files.includes( 'profiles/safe.json' ) );
	assert.ok( files.includes( 'schemas/tweak.schema.json' ) );
	assert.ok( files.length > 40, `only ${ files.length } documents found` );
} );

test( 'a run\u2019s own artifacts never become registry data', () => {
	// The propose job downloads these into the repository root and then
	// regenerates the manifest. If they were treated as documents, a released
	// registry would instruct every site to fetch one run's observations as
	// though they were rules.
	//
	// Written as a test rather than trusted to the list, because the list is
	// exactly the kind of thing a new stage adds an output to without noticing.
	const artifacts = [
		'candidates.json',
		'candidates-clean.json',
		'candidates-fixture.json',
		'regressions.json',
		'signals.json',
		'proposals.json',
		'scan-clean.json',
		'scan-fixture.json',
	];

	const written = [];

	try {
		for ( const name of artifacts ) {
			const full = path.join( ROOT, name );

			if ( ! fs.existsSync( full ) ) {
				fs.writeFileSync( full, '{"written":"by a test"}\n' );
				written.push( full );
			}
		}

		const files = registryFiles( ROOT );

		for ( const name of artifacts ) {
			assert.equal(
				files.includes( name ),
				false,
				`${ name } is a run artifact and must never be in the manifest`
			);
		}

		// And the real documents are still there, so this cannot pass by
		// excluding everything.
		assert.ok( files.includes( 'admin-notices.json' ) );
		assert.ok( files.includes( 'host-optimizers.json' ) );
	} finally {
		for ( const full of written ) {
			fs.rmSync( full, { force: true } );
		}
	}
} );

test( 'the file order does not depend on the machine', () => {
	// PHP sorts with SORT_STRING, a byte-wise comparison. localeCompare orders
	// some characters differently depending on the runtime's locale, and a
	// manifest whose key order depends on the builder's machine is a manifest
	// whose signature does too.
	const files = registryFiles( ROOT );
	const byBytes = [ ...files ].sort();

	assert.deepEqual( files, byBytes );
} );
