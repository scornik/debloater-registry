/**
 * Reading a JUnit report, and attributing failures to the right tweak.
 *
 * The first version of the parser merged a self-closing `<testcase/>` with the
 * one after it, so a failure was reported against the *previous* case's
 * classname. Everything downstream would then have worked perfectly on a lie:
 * the evidence gate would pass, because the regression was real; the classifier
 * would pass, because the change was safe; and the pull request would propose
 * tightening a tweak that had nothing wrong with it, citing a failure belonging
 * to another.
 *
 * That is the worst shape of bug this pipeline can have — not one that breaks
 * a run, but one that produces a well-evidenced, well-formed, wrong answer. So
 * the parser gets its own tests.
 *
 * Imported from `pipeline/lib/junit.mjs` rather than from the stage script,
 * because a stage script runs when it is imported. That was learned twice.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJUnit, tweakFor } from '../pipeline/lib/junit.mjs';

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Compat">
    <testcase name="home_probe" classname="Matrix\\core_remove_jquery_migrate"/>
    <testcase name="cart_probe" classname="Matrix\\core_disable_emojis">
      <failure type="AssertionError" message="Cart returned 500">trace</failure>
    </testcase>
    <testcase name="checkout_probe" classname="Matrix\\Unrelated">
      <error type="Error" message="Fatal: undefined function"/>
    </testcase>
    <testcase name="head_probe" classname="Matrix\\core_remove_rsd"/>
  </testsuite>
</testsuites>`;

test( 'a self-closing testcase does not swallow the next one', () => {
	const cases = parseJUnit( REPORT );

	assert.equal( cases.length, 4, 'all four testcases must be seen' );
	assert.deepEqual(
		cases.map( ( one ) => one.name ),
		[ 'home_probe', 'cart_probe', 'checkout_probe', 'head_probe' ]
	);
} );

test( 'a failure belongs to its own testcase', () => {
	const cases = parseJUnit( REPORT );

	// The bug: this failure was attributed to home_probe's classname.
	assert.equal( cases[ 0 ].failure, null, 'a passing case has no failure' );
	assert.equal( cases[ 1 ].failure, 'Cart returned 500' );
	assert.equal( cases[ 1 ].classname, 'Matrix\\core_disable_emojis' );
	assert.equal( cases[ 3 ].failure, null );
} );

test( 'an error element counts as a failure', () => {
	const cases = parseJUnit( REPORT );

	assert.equal( cases[ 2 ].failure, 'Fatal: undefined function' );
} );

test( 'a test name is matched to a tweak, dots or underscores', () => {
	const ids = [ 'core.disable_emojis', 'core.remove_rsd', 'core.remove_jquery_migrate' ];

	assert.equal(
		tweakFor( { classname: 'Matrix\\core_disable_emojis', name: 'cart_probe' }, ids ),
		'core.disable_emojis'
	);
	assert.equal(
		tweakFor( { classname: 'Matrix\\core.remove_rsd', name: 'head_probe' }, ids ),
		'core.remove_rsd'
	);
} );

test( 'a failure that matches no tweak is not attributed to one', () => {
	const ids = [ 'core.disable_emojis' ];

	assert.equal(
		tweakFor( { classname: 'Matrix\\Unrelated', name: 'checkout_probe' }, ids ),
		null
	);
} );

test( 'the longest matching id wins', () => {
	// A substring match would attribute a `core.disable_embeds` failure to a
	// hypothetical `core.disable`, and the shorter one would win by being
	// checked first.
	const ids = [ 'core.disable_embeds', 'core.disable' ].sort( ( a, b ) => b.length - a.length );

	assert.equal(
		tweakFor( { classname: 'Matrix\\core.disable_embeds', name: 'p' }, ids ),
		'core.disable_embeds'
	);
} );
