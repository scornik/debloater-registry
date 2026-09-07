/**
 * The three pieces of the pipeline that decide anything.
 *
 * Everything else in `pipeline/` moves data between a workflow and a file. These
 * three make judgements — what changed, whether a proposal may merge itself, and
 * whether a proposal is supported by anything real — and each of them is a place
 * where being wrong has consequences on somebody's site.
 *
 * Run with `node --test tests/pipeline.test.mjs`, which needs nothing installed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { diffFacts, familyOf, isStable, toCandidates } from '../pipeline/lib/factdiff.mjs';
import { classify } from '../pipeline/lib/direction.mjs';
import { gate } from '../pipeline/lib/evidence.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/* --------------------------------------------------------------- fact diff */

test( 'a new fact is an addition, and carries what it became', () => {
	const diff = diffFacts(
		{ 'cron.events.count': 1 },
		{ 'cron.events.count': 1, 'cron.orphans.count': 1 }
	);

	assert.equal( diff.added.length, 1 );
	assert.equal( diff.added[ 0 ].key, 'cron.orphans.count' );
	assert.equal( diff.added[ 0 ].family, 'cron' );
	assert.deepEqual( diff.changed, [] );
	assert.deepEqual( diff.removed, [] );
} );

test( 'a fact whose value moved is a change, with both sides', () => {
	const diff = diffFacts(
		{ 'plugins.active': [ 'jquery' ] },
		{ 'plugins.active': [ 'jquery', 'wc-blocks' ] }
	);

	assert.equal( diff.changed.length, 1 );
	assert.deepEqual( diff.changed[ 0 ].before, [ 'jquery' ] );
	assert.deepEqual( diff.changed[ 0 ].after, [ 'jquery', 'wc-blocks' ] );
} );

test( 'a fact with the same contents in a new array is not a change', () => {
	// The scan rebuilds its arrays every run. Comparing by identity would
	// report every fact as different and drown the real ones.
	const diff = diffFacts(
		{ 'plugins.active': [ 'jquery' ] },
		{ 'plugins.active': [ 'jquery' ] }
	);

	assert.deepEqual( diff.changed, [] );
	assert.deepEqual( diff.added, [] );
} );

test( 'a fact that disappeared is reported, and never becomes something to add', () => {
	const diff = diffFacts( { 'woo.marketplace_suggestions': 1 }, {} );

	assert.equal( diff.removed.length, 1 );
	assert.equal( diff.added.length, 0 );

	const candidates = toCandidates( {
		stack: 'woocommerce',
		versions: { woocommerce: '10.2.0' },
		diff,
	} );

	assert.equal( candidates.length, 1 );
	assert.equal( candidates[ 0 ].kind, 'removed' );

	// Nothing in a removal proposes adding a rule.
	assert.equal( candidates.filter( ( c ) => 'added' === c.kind ).length, 0 );
} );

test( 'every fact a real scan produces is classified', () => {
	// The test that was missing, and the reason it was missing is the point.
	//
	// The families were first written from the brief's description of the
	// scanner -- admin.notices, cron.hooks, assets.handles, rest.routes -- and
	// none of those prefixes exists. Against this fixture, a real 72-fact scan
	// from a live install, every single fact classified as `other`, and no test
	// noticed because every test used the invented keys too.
	//
	// So the fixture is the authority now. A prefix that stops matching the
	// scanner fails here.
	const scan = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'tests', 'fixtures', 'scan-clean.json' ), 'utf8' )
	);

	const keys = Object.keys( scan.facts );

	assert.ok( keys.length > 50, `the fixture should be a full scan, got ${ keys.length } facts` );

	const unclassified = keys.filter( ( key ) => 'other' === familyOf( key ) );

	// The only facts without a family are the ones about the run rather than
	// the site, and every one of those is excluded from diffing anyway.
	assert.deepEqual(
		unclassified.sort(),
		[ 'scan.elapsed_ms', 'scan.failed', 'scan.over_budget', 'scan.scanner_ms' ],
		'every fact about the site must belong to a family'
	);

	for ( const key of unclassified ) {
		assert.equal( isStable( key ), false, `${ key } has no family and must be volatile` );
	}
} );

test( 'the families are the scanner\u2019s namespaces', () => {
	assert.equal( familyOf( 'wp.emojis_enabled' ), 'core_behaviour' );
	assert.equal( familyOf( 'db.autoload.bytes' ), 'database' );
	assert.equal( familyOf( 'cron.events.count' ), 'cron' );
	assert.equal( familyOf( 'assets.available' ), 'enqueued_assets' );
	assert.equal( familyOf( 'woo.marketplace_suggestions' ), 'woocommerce' );
	assert.equal( familyOf( 'elementor.experiments' ), 'elementor' );

	// Still kept rather than dropped, for a genuinely unknown namespace.
	assert.equal( familyOf( 'something.nobody.anticipated' ), 'other' );
} );

test( 'facts that move on their own never become candidates', () => {
	// scan.elapsed_ms differs on every run of an unchanged site. Diffing it
	// would produce a candidate every week, for ever, describing nothing --
	// and a model handed a weekly candidate will eventually explain it.
	const diff = diffFacts(
		{ 'scan.elapsed_ms': 120, 'wp.emojis_enabled': true },
		{ 'scan.elapsed_ms': 3400, 'wp.emojis_enabled': true }
	);

	assert.deepEqual( diff.changed, [] );
	assert.deepEqual( diff.added, [] );

	// And a real change beside a volatile one is still seen.
	const real = diffFacts(
		{ 'scan.elapsed_ms': 120, 'wp.emojis_enabled': true },
		{ 'scan.elapsed_ms': 3400, 'wp.emojis_enabled': false }
	);

	assert.equal( real.changed.length, 1 );
	assert.equal( real.changed[ 0 ].key, 'wp.emojis_enabled' );
} );

test( 'every candidate carries the versions it was observed at', () => {
	const candidates = toCandidates( {
		stack: 'clean',
		versions: { wordpress: '7.2', woocommerce: '10.2.0' },
		diff: diffFacts( {}, { 'wp.rsd_link': 1 } ),
	} );

	assert.equal( candidates.length, 1 );
	assert.deepEqual( candidates[ 0 ].evidence[ 0 ].versions, {
		wordpress: '7.2',
		woocommerce: '10.2.0',
	} );
	assert.equal( candidates[ 0 ].evidence[ 0 ].after, 1 );
	assert.equal( candidates[ 0 ].evidence[ 0 ].before, null );
} );

/* --------------------------------------------------------------- direction */

test( 'raising a risk band is safer and may merge itself', () => {
	const verdict = classify( {
		file: 'tweaks/core.disable_embeds.json',
		op: 'modify',
		before: { risk: 'safe' },
		after: { risk: 'medium' },
	} );

	assert.equal( verdict.direction, 'safer' );
	assert.equal( verdict.automatic, true );
} );

test( 'the risk ordering comes from the schema, not from invention', () => {
	// This test exists because the ordering *was* invented -- safe, moderate,
	// advanced, expert -- and none of those but the first is a band this
	// registry has. Every real risk change fell through to "bolder", which is
	// safe and therefore silent: the automatic path would never have fired on
	// a real document, and no test would have said so.
	const schema = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'schemas', 'tweak.schema.json' ), 'utf8' )
	);

	assert.deepEqual( schema.properties.risk.enum, [ 'safe', 'low', 'medium', 'high' ] );

	// And the classifier can order the real ones, in the real direction.
	for ( const [ from, to ] of [
		[ 'safe', 'low' ],
		[ 'low', 'medium' ],
		[ 'medium', 'high' ],
	] ) {
		assert.equal(
			classify( { file: 'tweaks/x.json', op: 'modify', before: { risk: from }, after: { risk: to } } ).automatic,
			true,
			`raising ${ from } to ${ to } should be automatic`
		);
		assert.equal(
			classify( { file: 'tweaks/x.json', op: 'modify', before: { risk: to }, after: { risk: from } } ).automatic,
			false,
			`lowering ${ to } to ${ from } must not be`
		);
	}
} );

test( 'lowering a risk band is bolder and waits for a person', () => {
	const verdict = classify( {
		file: 'tweaks/core.disable_embeds.json',
		op: 'modify',
		before: { risk: 'medium' },
		after: { risk: 'safe' },
	} );

	assert.equal( verdict.direction, 'bolder' );
	assert.equal( verdict.automatic, false );
} );

test( 'a new document is never automatic', () => {
	const verdict = classify( {
		file: 'tweaks/core.something_new.json',
		op: 'add',
		after: { id: 'core.something_new', risk: 'safe' },
	} );

	assert.equal( verdict.automatic, false );
	assert.equal( verdict.direction, 'bolder' );
} );

test( 'a handler change is never automatic, whatever else the diff says', () => {
	// Otherwise safe on every other axis: the risk went up.
	const verdict = classify( {
		file: 'tweaks/core.remove_rsd.json',
		op: 'modify',
		before: { risk: 'safe', handler: 'runtime-handlers/core-remove-rsd.php' },
		after: { risk: 'medium', handler: 'runtime-handlers/elsewhere.php' },
	} );

	assert.equal( verdict.automatic, false );
	assert.equal( verdict.direction, 'bolder' );

	// The guard's own wording, not just the word "handler". The catch-all for
	// unknown fields also says "handler changed, and there is no rule saying
	// that is safer", so a looser assertion passes with ALWAYS_REVIEW deleted
	// -- which it did, until a probe removed the entry and nothing went red.
	// What is being tested is that handler is refused *by name*.
	assert.match( verdict.reasons.join( ' ' ), /code in the plugin/ );
} );

test( "a profile's include_risk is never automatic", () => {
	const verdict = classify( {
		file: 'profiles/safe.json',
		op: 'modify',
		before: { include_risk: [ 'safe' ] },
		after: { include_risk: [ 'safe', 'moderate' ] },
	} );

	assert.equal( verdict.automatic, false );

	// The guard's wording, for the same reason as handler above.
	assert.match( verdict.reasons.join( ' ' ), /every tweak in it means/ );
} );

test( 'adding a constraint is safer; removing one is not', () => {
	const added = classify( {
		file: 'tweaks/core.disable_emojis.json',
		op: 'modify',
		before: { conflicts: [] },
		after: { conflicts: [ 'core.something' ] },
	} );

	assert.equal( added.automatic, true );

	const removed = classify( {
		file: 'tweaks/core.disable_emojis.json',
		op: 'modify',
		before: { conflicts: [ 'core.something' ] },
		after: { conflicts: [] },
	} );

	assert.equal( removed.automatic, false );
} );

test( 'a field with no rule about it is not automatic', () => {
	// The default has to be "ask", or the first field nobody thought about is
	// the one that merges itself.
	const verdict = classify( {
		file: 'tweaks/core.remove_rsd.json',
		op: 'modify',
		before: { base_confidence: 0.98 },
		after: { base_confidence: 0.4 },
	} );

	assert.equal( verdict.automatic, false );
	assert.match( verdict.reasons.join( ' ' ), /no rule saying that is safer/ );
} );

/* ---------------------------------------------------------------- evidence */

const INPUTS = {
	candidates: [ { fact_key: 'cron.orphans.count' } ],
	regressions: [ { tweak: 'core.remove_jquery_migrate' } ],
	signals: [ { url: 'https://wordpress.org/support/topic/example/' } ],
};

test( 'a proposal with no evidence is dropped', () => {
	const { kept, dropped } = gate(
		[ { file: 'tweaks/core.remove_rsd.json', op: 'modify' } ],
		INPUTS
	);

	assert.equal( kept.length, 0 );
	assert.equal( dropped.length, 1 );
	assert.match( dropped[ 0 ].why, /no evidence/ );
} );

test( 'a proposal citing a fact nothing scanned is dropped', () => {
	const { kept, dropped } = gate(
		[
			{
				file: 'tweaks/core.remove_rsd.json',
				op: 'modify',
				evidence: [ { fact_key: 'cron.hooks.invented_by_the_model' } ],
			},
		],
		INPUTS
	);

	assert.equal( kept.length, 0 );
	assert.match( dropped[ 0 ].why, /no scan reported/ );
} );

test( 'a proposal citing an observed fact is kept', () => {
	const { kept, dropped } = gate(
		[
			{
				file: 'tweaks/core.remove_rsd.json',
				op: 'modify',
				evidence: [ { fact_key: 'cron.orphans.count' } ],
			},
		],
		INPUTS
	);

	assert.equal( kept.length, 1 );
	assert.equal( dropped.length, 0 );
} );

test( 'a proposal may only touch the data directories', () => {
	const { kept, dropped } = gate(
		[
			{
				file: '.github/workflows/registry-update.yml',
				op: 'modify',
				evidence: [ { fact_key: 'cron.orphans.count' } ],
			},
			{
				file: 'manifest.json',
				op: 'modify',
				evidence: [ { tweak: 'core.remove_jquery_migrate' } ],
			},
		],
		INPUTS
	);

	assert.equal( kept.length, 0 );
	assert.equal( dropped.length, 2 );

	// The pipeline may not propose changes to its own guards or to the file
	// that a signature covers.
	for ( const entry of dropped ) {
		assert.match( entry.why, /not a tweak, compatibility or profile document/ );
	}
} );

test( 'a regression and a signal are both usable as evidence', () => {
	const { kept } = gate(
		[
			{
				file: 'compatibility/woocommerce.json',
				op: 'modify',
				evidence: [ { tweak: 'core.remove_jquery_migrate' } ],
			},
			{
				file: 'tweaks/core.heartbeat_interval.json',
				op: 'modify',
				evidence: [ { url: 'https://wordpress.org/support/topic/example/' } ],
			},
		],
		INPUTS
	);

	assert.equal( kept.length, 2 );
} );
