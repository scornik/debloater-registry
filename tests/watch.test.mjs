/**
 * The version comparison, and the state file it reads.
 *
 * `isNewer` decides whether the expensive pipeline runs. Getting it wrong in
 * one direction wastes a WordPress install; getting it wrong in the other means
 * a release nobody looks at. The second is the one that matters, so where this
 * cannot decide, it says "newer" and a person ends up looking.
 *
 * Imported from `pipeline/lib/versions.mjs`, not from `pipeline/watch.mjs`, and
 * that is not tidiness. The script fetches from wordpress.org, prints a report
 * and sets an exit code at import time, so the first version of this file made
 * three seconds of live API calls on every run and would have failed the whole
 * suite whenever an API was unreachable -- a red test run caused by somebody
 * else's outage.
 *
 * No network here. `pipeline/watch.mjs` is exercised against the live API by
 * running it, which is a different kind of check and belongs in a workflow.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { isNewer } from '../pipeline/lib/versions.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

test( 'a higher segment is newer', () => {
	assert.equal( isNewer( '6.9', '7.1' ), true );
	assert.equal( isNewer( '9.0.0', '11.1.0' ), true );
	assert.equal( isNewer( '1.0.277.1', '1.0.277.2' ), true );
} );

test( 'the same version is not newer', () => {
	assert.equal( isNewer( '7.1', '7.1' ), false );
	assert.equal( isNewer( '1.0.277.2', '1.0.277.2' ), false );
} );

test( 'an older version is not newer', () => {
	assert.equal( isNewer( '7.1', '6.9' ), false );
	assert.equal( isNewer( '11.1.0', '9.0.0' ), false );
} );

test( 'ten is greater than nine, which string comparison gets wrong', () => {
	// "10" < "9" as text. WooCommerce went from 9.x to 10.x, so this is the
	// case that would have silently stopped the pipeline for a whole major.
	assert.equal( isNewer( '9.9.0', '10.0.0' ), true );
	assert.equal( isNewer( '10.0.0', '9.9.0' ), false );
} );

test( 'a missing segment counts as zero', () => {
	assert.equal( isNewer( '7', '7.1' ), true );
	assert.equal( isNewer( '7.1', '7' ), false );
	assert.equal( isNewer( '7.0', '7' ), false );
} );

test( 'nothing recorded means look at it', () => {
	assert.equal( isNewer( null, '7.1' ), true );
	assert.equal( isNewer( '', '7.1' ), true );
	assert.equal( isNewer( undefined, '7.1' ), true );
} );

test( 'a version this cannot order is treated as newer, not as unchanged', () => {
	// Betas, release candidates and whatever a plugin author invents next. The
	// safe direction is a wasted run, not a missed release.
	assert.equal( isNewer( '7.1', '7.2-beta1' ), true );
	assert.equal( isNewer( '1.0.0', '1.0.0-rc1' ), true );
} );

test( 'every watched plugin has a version, and every unwatched one says why', () => {
	const state = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'state', 'versions.json' ), 'utf8' )
	);

	assert.ok( state.core?.wordpress?.version, 'WordPress must have a recorded version' );

	const entries = Object.entries( state.plugins ?? {} );

	assert.ok( entries.length >= 6, 'the six plugins in the brief should be listed' );

	for ( const [ slug, entry ] of entries ) {
		if ( entry.watch ) {
			assert.equal(
				typeof entry.version,
				'string',
				`${ slug } is watched but has no recorded version`
			);

			continue;
		}

		// Not watched is a decision, and a decision that is not written down
		// looks identical to an oversight six months later.
		assert.equal(
			typeof entry.why,
			'string',
			`${ slug } is not watched and does not say why`
		);
		assert.ok( entry.why.length > 40, `${ slug }'s reason is too short to be a reason` );
	}
} );
