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
	REGISTRY_DIRECTORIES,
	REGISTRY_ROOT_FILES,
	serialise,
	UnrecognisedFile,
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

test( 'the allow-list matches what the committed manifest actually holds', () => {
	// The brief for this change named four directories. The manifest holds
	// five: detectors/ was missing from it. Confirmed against the file rather
	// than the description, which is the same rule that the risk bands and the
	// fact families were both learned under.
	const manifest = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'manifest.json' ), 'utf8' )
	);

	const directories = new Set();
	const rootFiles = new Set();

	for ( const name of Object.keys( manifest.files ) ) {
		const slash = name.indexOf( '/' );

		if ( -1 === slash ) {
			rootFiles.add( name );
		} else {
			directories.add( name.slice( 0, slash ) );
		}
	}

	assert.deepEqual( [ ...directories ].sort(), [ ...REGISTRY_DIRECTORIES ].sort() );
	assert.deepEqual( [ ...rootFiles ].sort(), [ ...REGISTRY_ROOT_FILES ].sort() );
} );

test( 'an unclassifiable file stops the build rather than being guessed at', () => {
	// The bug this replaces: registryFiles() walked every .json outside an
	// exclusion list, so anything new in the tree was registry data by default,
	// and a run artifact was listed as a rule for every site to fetch.
	//
	// Including by default ships what the list forgot. Dropping by default
	// hides a real document from every site. So neither: it refuses.
	const stray = path.join( ROOT, 'tweaks-backup.json' );

	try {
		fs.writeFileSync( stray, '{"id":"not-a-real-document"}\n' );

		assert.throws(
			() => registryFiles( ROOT ),
			UnrecognisedFile,
			'an unrecognised .json must stop the build'
		);

		// And it says which file, because a refusal nobody can act on is just
		// a broken build.
		try {
			registryFiles( ROOT );
		} catch ( error ) {
			assert.match( error.message, /tweaks-backup\.json/ );
		}
	} finally {
		fs.rmSync( stray, { force: true } );
	}
} );

test( 'a new document in a registry directory is picked up automatically', () => {
	// The other half of the allow-list. It must not require a person to
	// enumerate every tweak, or adding one would silently ship a registry
	// missing it.
	const added = path.join( ROOT, 'tweaks', 'core.probe_only.json' );

	try {
		fs.writeFileSync( added, '{"id":"core.probe_only"}\n' );

		assert.ok(
			registryFiles( ROOT ).includes( 'tweaks/core.probe_only.json' ),
			'a new tweak must appear without anybody listing it'
		);
	} finally {
		fs.rmSync( added, { force: true } );
	}
} );

test( 'a non-JSON file inside a registry directory is reported, not ignored', () => {
	const stray = path.join( ROOT, 'tweaks', 'NOTES.txt' );

	try {
		fs.writeFileSync( stray, 'notes\n' );

		assert.throws( () => registryFiles( ROOT ), UnrecognisedFile );
	} finally {
		fs.rmSync( stray, { force: true } );
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
