/**
 * Two providers, one internal shape.
 *
 * The point of `lib/provider.mjs` is that nothing downstream can tell which
 * model answered. If a Gemini reply and an Anthropic reply reduced to even
 * slightly different text, every gate after it would be working on something
 * provider-shaped, and "adding a provider cannot weaken a check" would stop
 * being true.
 *
 * So both recorded responses carry the *same* proposal in different envelopes,
 * and this asserts they come out identical.
 *
 * **No live calls.** The fixtures are the documented response shapes, and what
 * is being tested is the extraction path — `candidates[0].content.parts[].text`
 * against `content[].text` — which is the only part of a provider that differs
 * in a way worth testing. Calling the real APIs would test Google's uptime and
 * cost money to do it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { RETRY_ON, selected, textFrom } from '../pipeline/lib/provider.mjs';
import { gate } from '../pipeline/lib/evidence.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/**
 * Load a recorded provider response.
 *
 * @param {string} name Provider name.
 * @return {Object} The body.
 */
const recorded = ( name ) =>
	JSON.parse(
		fs.readFileSync(
			path.join( ROOT, 'tests', 'fixtures', 'providers', `${ name }-response.json` ),
			'utf8'
		)
	);

test( 'both provider shapes yield the same text', () => {
	const fromGemini = textFrom( 'gemini', recorded( 'gemini' ) );
	const fromAnthropic = textFrom( 'anthropic', recorded( 'anthropic' ) );

	assert.equal( fromGemini, fromAnthropic );
	assert.ok( fromGemini.length > 0 );
} );

test( 'both parse to the same proposals, and survive the same gate', () => {
	const inputs = {
		candidates: [],
		regressions: [ { tweak: 'core.disable_emojis' } ],
		signals: [],
	};

	const parse = ( name ) => JSON.parse( textFrom( name, recorded( name ) ) ).proposals;

	const viaGemini = parse( 'gemini' );
	const viaAnthropic = parse( 'anthropic' );

	assert.deepEqual( viaGemini, viaAnthropic );

	// And the gate treats them identically, which is the property that matters:
	// no check downstream of the provider may behave differently per provider.
	const a = gate( viaGemini, inputs );
	const b = gate( viaAnthropic, inputs );

	assert.deepEqual( a.kept, b.kept );
	assert.deepEqual( a.dropped, b.dropped );
	assert.equal( a.kept.length, 1 );
} );

test( 'a multi-part reply is joined, not truncated to the first part', () => {
	// Gemini may split a long answer across parts. Reading only parts[0] would
	// produce valid-looking JSON with the end missing, which is worse than an
	// error: the tail of a proposal list would silently disappear.
	const split = {
		candidates: [
			{ content: { parts: [ { text: '{"proposals":' }, { text: '[]}' } ] } },
		],
	};

	assert.equal( textFrom( 'gemini', split ), '{"proposals":[]}' );

	const anthropicSplit = {
		content: [
			{ type: 'text', text: '{"proposals":' },
			{ type: 'text', text: '[]}' },
		],
	};

	assert.equal( textFrom( 'anthropic', anthropicSplit ), '{"proposals":[]}' );
} );

test( 'non-text blocks are ignored rather than stringified', () => {
	// A thinking block or a tool-use block is not the answer. Concatenating one
	// would put an object into the JSON parser's input.
	const withOther = {
		content: [
			{ type: 'thinking', thinking: 'ignore me' },
			{ type: 'text', text: '{"proposals":[]}' },
		],
	};

	assert.equal( textFrom( 'anthropic', withOther ), '{"proposals":[]}' );
} );

test( 'an empty reply is empty, not a crash', () => {
	assert.equal( textFrom( 'gemini', {} ), '' );
	assert.equal( textFrom( 'gemini', { candidates: [] } ), '' );
	assert.equal( textFrom( 'anthropic', {} ), '' );

	// The provider turns this into an error naming the finishReason; here what
	// matters is that extraction does not throw on a shape it did not expect.
} );

test( 'only transient failures are retried', () => {
	// A 400 or a 401 means the request or the key is wrong. Repeating it
	// changes nothing except the log, and on a free tier it spends quota.
	assert.equal( RETRY_ON( 429 ), true );
	assert.equal( RETRY_ON( 500 ), true );
	assert.equal( RETRY_ON( 503 ), true );

	assert.equal( RETRY_ON( 400 ), false );
	assert.equal( RETRY_ON( 401 ), false );
	assert.equal( RETRY_ON( 403 ), false );
	assert.equal( RETRY_ON( 404 ), false );
} );

test( 'the default provider is gemini, and an unknown one is refused', () => {
	const before = process.env.PROVIDER;

	try {
		delete process.env.PROVIDER;
		assert.equal( selected().name, 'gemini' );

		process.env.PROVIDER = 'anthropic';
		assert.equal( selected().name, 'anthropic' );

		process.env.PROVIDER = 'GEMINI';
		assert.equal( selected().name, 'gemini', 'the name is case-insensitive' );

		process.env.PROVIDER = 'llama';
		assert.throws( () => selected(), /not one of: gemini, anthropic/ );
	} finally {
		if ( undefined === before ) {
			delete process.env.PROVIDER;
		} else {
			process.env.PROVIDER = before;
		}
	}
} );

test( 'the default Gemini model is one the free tier actually offers', () => {
	// Checked against ai.google.dev rather than remembered. The risk bands and
	// the fact families in this repository were both invented from a
	// description once; a model name is the same kind of mistake, and it fails
	// at the API rather than silently.
	const source = fs.readFileSync(
		path.join( ROOT, 'pipeline', 'lib', 'provider.mjs' ),
		'utf8'
	);

	const match = source.match( /GEMINI_MODEL \|\| '([^']+)'/ );

	assert.ok( match, 'provider.mjs should name a default Gemini model' );

	// Flash, because that is what the free tier covers. Pro is not free.
	assert.match(
		match[ 1 ],
		/^gemini-[0-9.]+-flash(-lite)?$/,
		`${ match[ 1 ] } is not a Flash model, and only Flash is on the free tier`
	);
} );
