#!/usr/bin/env node
/**
 * Stage 4 — analyze. Turn observations into proposals, and refuse the rest.
 *
 *     node pipeline/analyze.mjs --candidates=c.json --regressions=r.json \
 *         --signals=s.json --out=proposals.json
 *     node pipeline/analyze.mjs ... --fixture=tests/fixtures/model-response.json
 *
 * Sends the registry's schemas, the authoring guide and the three observation
 * artifacts to a model, and requires a JSON-only reply proposing changes. Every
 * proposal is then put through checks the model has no say in.
 *
 * ## The model is the least trusted thing in this pipeline
 *
 * It is asked to interpret observations, and it is structurally incapable of
 * knowing whether it is doing that or inventing something plausible. So nothing
 * it returns is taken on trust:
 *
 * 1. **The reply must be JSON.** Prose, markdown fences and explanation are
 *    stripped where they wrap the JSON and rejected where they replace it.
 * 2. **Every proposal cites evidence** the earlier stages actually produced
 *    (`lib/evidence.mjs`). A proposal citing a fact nothing scanned is dropped.
 * 3. **Every document is schema-checked** (`lib/schema.mjs`) before it can
 *    become a file.
 * 4. **Direction is decided here, not there** (`lib/direction.mjs`). The reply
 *    may *claim* `direction: safer`; the classifier decides, from the diff, and
 *    its answer is the one that travels.
 *
 * A model that returned nothing at all would cost this pipeline one wasted run.
 * A model that returned confident nonsense would cost it nothing either, and
 * that is the property being bought.
 *
 * ## Which model, and why it does not matter here
 *
 * The call lives in `lib/provider.mjs`, behind one function that returns text.
 * `PROVIDER` selects it and defaults to `gemini`, because the Anthropic API
 * bills separately from a claude.ai subscription and Google's free tier covers
 * the Flash models this needs.
 *
 * Nothing below this line knows which provider answered. Every gate works on
 * the parsed proposals, so adding a provider cannot weaken one; the artifact
 * records `provider` and `model` for the audit trail and nothing branches on
 * either.
 *
 * ## No key, no run
 *
 * The key comes from a secret and the model from a repository variable. Neither
 * is in this repository and neither may be. Without a key this stage refuses to
 * run rather than silently producing an empty proposal set — "the model had no
 * suggestions" and "nobody called the model" must not look alike.
 *
 * `--fixture` reads a recorded reply instead of calling anything, which is how
 * the dry run exercises every check below without a key or a bill.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify } from './lib/direction.mjs';
import { gate } from './lib/evidence.mjs';
import { complete } from './lib/provider.mjs';
import { validateFor } from './lib/schema.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/**
 * Read a `--name=value` argument.
 *
 * @param {string} name       Argument name.
 * @param {string} [fallback] Value when absent.
 * @return {string|null} Its value.
 */
const option = ( name, fallback = null ) => {
	const found = process.argv.find( ( arg ) => arg.startsWith( `--${ name }=` ) );

	return found ? found.slice( name.length + 3 ) : fallback;
};

/**
 * Read a JSON artifact, treating absence as empty rather than as a crash.
 *
 * A stage that found nothing still writes its file, so a missing one means a
 * stage did not run. That is worth saying, and it is said by the workflow,
 * which requires every artifact; here an absent file is an empty list so that
 * `--fixture` runs work from a partial set.
 *
 * @param {string|null} file Path.
 * @param {string}      key  Which array to pull out.
 * @return {Array} The entries.
 */
const artifact = ( file, key ) => {
	if ( ! file ) {
		return [];
	}

	// A path that was given and is not there is a mistake, not an empty
	// result. Reading it as "nothing was found" is how a mis-pathed artifact
	// becomes a confident report that there was nothing to report -- which is
	// exactly what happened the first time this was run by hand.
	if ( ! fs.existsSync( file ) ) {
		process.stderr.write(
			`\n${ file } does not exist.\n\n` +
				'It was named on the command line, so something meant to produce it.\n' +
				'An absent artifact is not an empty one.\n\n'
		);
		process.exit( 1 );
	}

	const parsed = JSON.parse( fs.readFileSync( file, 'utf8' ) );

	return Array.isArray( parsed ) ? parsed : parsed[ key ] ?? [];
};

const candidates = artifact( option( 'candidates' ), 'candidates' );
const regressions = artifact( option( 'regressions' ), 'regressions' );
const signals = artifact( option( 'signals' ), 'signals' );
const outPath = option( 'out', 'proposals.json' );
const fixture = option( 'fixture' );

/**
 * Everything the model is allowed to see about how this registry works.
 *
 * The schemas and the authoring guide, verbatim. Not a summary: a summary is
 * one more thing that can drift from the rules it describes, and the rules are
 * a few kilobytes of JSON.
 *
 * @return {string} The reference material.
 */
const reference = () => {
	const parts = [];

	for ( const name of [ 'tweak.schema.json', 'profile.schema.json', 'compat.schema.json' ] ) {
		parts.push( `--- schemas/${ name } ---\n${ fs.readFileSync( path.join( ROOT, 'schemas', name ), 'utf8' ) }` );
	}

	const authoring = path.join( ROOT, 'AUTHORING.md' );

	if ( fs.existsSync( authoring ) ) {
		parts.push( `--- AUTHORING.md ---\n${ fs.readFileSync( authoring, 'utf8' ) }` );
	}

	return parts.join( '\n\n' );
};

/**
 * What the model is asked for.
 *
 * @return {string} The prompt.
 */
const prompt = () => `
You maintain the data for a WordPress plugin that switches features off on
people's sites. Below are the rules the data must satisfy, and three sets of
observations from a scheduled run.

Propose changes to tweaks/, compatibility/ and profiles/ documents, and nothing
else. Reply with JSON only — no prose, no markdown fence — in exactly this shape:

{"proposals":[{
  "file": "tweaks/<id>.json",
  "op": "modify",
  "after": { ...the complete document as it should be... },
  "why": "one sentence",
  "evidence": [ {"fact_key": "..."} or {"tweak": "..."} or {"url": "..."} ]
}]}

Rules you must follow:

- Every proposal MUST cite evidence from the observations below. A proposal
  citing anything not in them will be discarded, so do not invent one.
- Prefer proposing nothing. An empty list is a correct answer and a common one.
- A support-forum thread is one person's account of their own site. It can
  justify being MORE careful — raising a risk band, adding a dont_touch, adding
  an incompatibility. It cannot justify a new tweak.
- Do not propose changes to a tweak's "handler". Handlers are PHP in the plugin,
  not data here.
- "after" must be the complete document, valid against the schema above.

${ reference() }

--- candidates.json (what changed on a real install) ---
${ JSON.stringify( candidates, null, 1 ) }

--- regressions.json (tweaks whose probes failed at the new versions) ---
${ JSON.stringify( regressions, null, 1 ) }

--- signals.json (support threads mentioning trouble) ---
${ JSON.stringify( signals, null, 1 ) }
`.trim();

/**
 * Pull a JSON object out of a reply that may be wrapped in prose.
 *
 * Tolerant of a markdown fence and of leading commentary, because those are
 * formatting mistakes rather than dishonest ones. Not tolerant of a reply with
 * no JSON in it: that is refused, and refusing is what stops "the model said
 * something unparseable" from becoming "the model proposed nothing".
 *
 * @param {string} text The reply.
 * @return {Object} The parsed object.
 */
export const parseReply = ( text ) => {
	const fenced = text.match( /```(?:json)?\s*([\s\S]*?)```/ );
	const body = fenced ? fenced[ 1 ] : text;
	const start = body.indexOf( '{' );
	const end = body.lastIndexOf( '}' );

	if ( -1 === start || -1 === end || end <= start ) {
		throw new Error( 'the reply contained no JSON object' );
	}

	return JSON.parse( body.slice( start, end + 1 ) );
};

/**
 * Ask whichever model this run is configured for.
 *
 * @return {Promise<{text: string, provider: string, model: string}>} The reply.
 */
const ask = async () => {
	try {
		return await complete( {
			system:
				'You maintain data for a WordPress plugin. You reply with JSON and ' +
				'nothing else. You prefer proposing nothing to proposing something ' +
				'you cannot evidence.',
			user: prompt(),
			schemaHint: true,
		} );
	} catch ( error ) {
		process.stderr.write( `\n${ error.message }\n\n` );
		process.exit( 1 );
	}
};

/* ------------------------------------------------------------------- run */

const answered = fixture
	? { text: fs.readFileSync( fixture, 'utf8' ), provider: 'fixture', model: path.basename( fixture ) }
	: await ask();

const reply = answered.text;

let returned = [];

try {
	returned = parseReply( reply ).proposals ?? [];
} catch ( error ) {
	process.stderr.write( `\nThe model's reply could not be read: ${ error.message }\n\n` );
	process.exit( 1 );
}

// 1. Evidence.
const { kept, dropped } = gate( returned, { candidates, regressions, signals } );

// 2. Schema, and 3. direction — decided here rather than taken from the reply.
const accepted = [];
const rejected = dropped.map( ( entry ) => ( {
	file: entry.proposal?.file ?? '(none)',
	why: entry.why,
} ) );

for ( const proposal of kept ) {
	const before = fs.existsSync( path.join( ROOT, proposal.file ) )
		? JSON.parse( fs.readFileSync( path.join( ROOT, proposal.file ), 'utf8' ) )
		: null;

	const op = proposal.op ?? ( before ? 'modify' : 'add' );

	if ( 'remove' !== op ) {
		const problems = validateFor( ROOT, proposal.file, proposal.after );

		if ( problems.length > 0 ) {
			rejected.push( { file: proposal.file, why: problems.join( '; ' ) } );

			continue;
		}
	}

	const verdict = classify( { file: proposal.file, op, before, after: proposal.after } );

	accepted.push( {
		file: proposal.file,
		op,
		before,
		after: proposal.after ?? null,
		why: 'string' === typeof proposal.why ? proposal.why.slice( 0, 300 ) : '',
		evidence: proposal.evidence,

		// The classifier's verdict, not the reply's claim. A model that
		// labelled a risk reduction "safer" would otherwise be labelling its
		// own change automatic.
		direction: verdict.direction,
		automatic: verdict.automatic,
		reasons: verdict.reasons,
		claimed_direction: proposal.direction ?? null,
	} );
}

fs.writeFileSync(
	outPath,
	`${ JSON.stringify(
		{
			provider: answered.provider,
			model: answered.model,
			returned: returned.length,
			accepted: accepted.length,
			rejected,
			proposals: accepted,
		},
		null,
		4
	) }\n`
);

process.stdout.write(
	`${ answered.provider }/${ answered.model } returned ${ returned.length }, ` +
		`accepted ${ accepted.length }, rejected ${ rejected.length } -> ${ outPath }\n`
);

for ( const entry of rejected ) {
	process.stdout.write( `DROP ${ entry.file }: ${ entry.why }\n` );
}

for ( const entry of accepted ) {
	process.stdout.write(
		`KEEP ${ entry.file } [${ entry.direction }${ entry.automatic ? ', automatic' : '' }]\n`
	);
}
