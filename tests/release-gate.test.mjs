/**
 * The release gate is a gate.
 *
 * Moving the signature check from every push to tags (docs/DECISIONS.md D-0067)
 * made one job the only thing between a bad manifest and a release. Before that
 * move, a mistake in the tag job was survivable, because every push had already
 * verified the signature. It is not survivable now.
 *
 * This file asserts the properties that make it a gate, against the workflow
 * file itself. That is an unusual thing to unit-test and it is deliberate: the
 * ways a CI check stops working are not bugs in its logic, they are an
 * `if:` that never becomes true, a `continue-on-error` somebody added while
 * debugging, or a trigger that does not fire.
 *
 * This repository has already been bitten by the third. Until Phase 21 the
 * workflow's `on.push` listed `branches: [ main ]` and no `tags:`, so a tag
 * push started nothing, and the step guarded by
 * `if: startsWith( github.ref, 'refs/tags/' )` had never once executed. It read
 * as a check. It was a comment.
 *
 * Parsed with regular expressions rather than a YAML library, because this
 * repository installs nothing and a check that needs a dependency is one that
 * stops running the day the dependency does.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const WORKFLOW = path.join( ROOT, '.github', 'workflows', 'registry.yml' );

const yaml = fs.readFileSync( WORKFLOW, 'utf8' );

/**
 * The lines of one top-level job, by name.
 *
 * @param {string} name Job key.
 * @return {string} That job's block.
 */
const job = ( name ) => {
	const lines = yaml.split( '\n' );
	const start = lines.findIndex( ( line ) => line.startsWith( `  ${ name }:` ) );

	assert.notEqual( start, -1, `the workflow has no job called ${ name }` );

	const rest = lines.slice( start + 1 );
	const end = rest.findIndex( ( line ) => /^ {2}[A-Za-z0-9_-]+:/.test( line ) );

	return ( -1 === end ? rest : rest.slice( 0, end ) ).join( '\n' );
};

test( 'a pushed tag actually starts this workflow', () => {
	// The bug this repository shipped with. Without a `tags:` filter, a tag
	// push triggers nothing and every tag-conditioned check is unreachable.
	const triggers = yaml.slice( yaml.indexOf( 'on:' ), yaml.indexOf( 'permissions:' ) );

	assert.match(
		triggers,
		/tags:\s*\[\s*'v\*'\s*\]/,
		'on.push must list tags, or the release gate never runs'
	);
} );

test( 'the release gate runs on tags, and only on tags', () => {
	const gate = job( 'release-gate' );

	assert.match( gate, /if:\s*startsWith\(\s*github\.ref,\s*'refs\/tags\/'\s*\)/ );
} );

test( 'nothing in the release gate is allowed to fail softly', () => {
	const gate = job( 'release-gate' );

	assert.equal(
		/continue-on-error/.test( gate ),
		false,
		'a gate that continues on error is not a gate'
	);

	// `if:` appears once, on the job. A second one would be a step able to
	// evaluate itself away on the very ref the job exists to check.
	const conditions = gate.match( /^\s*if:/gm ) ?? [];

	assert.equal(
		conditions.length,
		1,
		'only the job may be conditional; a conditional step inside it can skip itself'
	);
} );

test( 'the gate verifies the signature, the tag and what main advertises', () => {
	const gate = job( 'release-gate' );

	for ( const required of [
		'tests/signature.mjs',
		'tests/integrity.mjs',
		'manifest.sig',
		'state/released.json',
	] ) {
		assert.ok(
			gate.includes( required ),
			`the release gate must check ${ required }`
		);
	}
} );

test( 'a missing half of a release is a failure, not an absence', () => {
	const gate = job( 'release-gate' );

	// The loop that checks the files exist must exit non-zero, or "the file
	// was not there" reads as "nothing was wrong".
	assert.match( gate, /if \[ ! -f "\$required" \]; then[\s\S]*?exit 1/ );
} );

test( 'integrity still runs on every push, not only on tags', () => {
	const integrity = job( 'integrity' );

	assert.ok( integrity.includes( 'tests/integrity.mjs' ) );

	// The half of D-0067 that did not move. The bot regenerates the manifest
	// with its changes, so hashes are checked on every proposal.
	assert.equal(
		/^\s*if:/m.test( integrity ),
		false,
		'integrity must not be conditional on anything'
	);
} );

test( 'released.json names a real tag and the manifest it covers', () => {
	const released = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'state', 'released.json' ), 'utf8' )
	);

	assert.match( released.tag, /^v\d+\.\d+\.\d+$/ );
	assert.match( released.manifest_sha256, /^[0-9a-f]{64}$/ );
	assert.equal( typeof released.signed, 'boolean' );

	// And it is the manifest actually on disk, at the released tag. When main
	// moves ahead this will differ, which is the point of recording it -- but
	// the tag it names must be the tag the manifest names.
	const manifest = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'manifest.json' ), 'utf8' )
	);

	assert.equal(
		released.tag,
		manifest.tag,
		'released.json and manifest.json disagree about which release this is'
	);
} );
