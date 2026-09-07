/**
 * Which model answers, and nothing else.
 *
 * The analyze stage asks a model to interpret observations. *Which* model is a
 * question about billing and rate limits, not about how this registry decides
 * anything — so it lives here, behind one function, and nothing downstream of
 * it can tell which provider replied.
 *
 * That separation is load-bearing. Every check that makes the pipeline safe to
 * run unattended — the evidence gate, the schema check, the direction
 * classifier — works on the *parsed proposals*, not on the response. Adding a
 * provider must not be able to weaken any of them, and the way to guarantee
 * that is for a provider to return one thing: text.
 *
 *     complete( { system, user, schemaHint } ) -> { text, provider, model }
 *
 * `provider` and `model` come back only so the run artifact can record who
 * answered. Nothing branches on them.
 *
 * ## Why Gemini by default
 *
 * The Anthropic API bills separately from a claude.ai subscription. Google's
 * free tier covers the Flash models, and this pipeline sends a few thousand
 * tokens a week, so the free tier is the right size for it.
 *
 * **Free-tier prompts are used by Google to improve its products** — the
 * pricing page states this plainly, and it is a real difference from the paid
 * tier. It is acceptable here for one specific reason: every input this stage
 * sends is already public. The schemas, `AUTHORING.md` and the tweak documents
 * are in a public repository; the observations are facts about a throwaway
 * WordPress container; the signals are links to public forum threads. Nothing
 * about a customer, a site, or a key is in the prompt, and nothing may be
 * added. `docs/PIPELINE.md` records that as a constraint rather than a
 * coincidence.
 *
 * ## Zero dependencies
 *
 * `fetch`, as everywhere else in this repository. An SDK would be two SDKs, and
 * two SDKs are two things to keep current for a call that is one POST.
 */

/**
 * How long one request may take.
 *
 * Generous, because a long prompt to a busy free-tier endpoint is slow, and a
 * timeout that fires on a working request turns into a retry that costs more
 * than waiting did.
 */
const TIMEOUT_MS = 180000;

/**
 * How long to wait before the single retry.
 */
const BACKOFF_MS = 20000;

/**
 * Statuses worth trying again.
 *
 * 429 is the free tier saying "not so fast", and 5xx is the provider having a
 * moment. Both are transient. A 400 or a 401 is not: those mean the request or
 * the key is wrong, and repeating it changes nothing except the log.
 */
const shouldRetry = ( status ) => 429 === status || status >= 500;

/**
 * Sleep.
 *
 * @param {number} ms Milliseconds.
 * @return {Promise<void>} Resolves after the wait.
 */
const wait = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

/**
 * POST JSON, with a timeout and one retry on a transient failure.
 *
 * @param {string} url     Endpoint.
 * @param {Object} headers Request headers.
 * @param {Object} body    Request body.
 * @return {Promise<Object>} The parsed response.
 * @throws {Error} When the request fails for a reason retrying will not fix.
 */
const post = async ( url, headers, body ) => {
	let attempt = 0;

	for (;;) {
		attempt++;

		let response;

		try {
			response = await fetch( url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify( body ),
				signal: AbortSignal.timeout( TIMEOUT_MS ),
			} );
		} catch ( error ) {
			// A timeout or a dropped connection. Worth one retry for the same
			// reason a 5xx is.
			if ( 1 === attempt ) {
				await wait( BACKOFF_MS );

				continue;
			}

			throw new Error( `the request failed twice: ${ error.message }` );
		}

		if ( response.ok ) {
			return response.json();
		}

		// The body often says what is actually wrong — a quota name, an
		// unknown model — and losing it makes every failure look the same.
		const detail = await response.text().catch( () => '' );

		if ( shouldRetry( response.status ) && 1 === attempt ) {
			process.stderr.write(
				`HTTP ${ response.status }; retrying once in ${ BACKOFF_MS / 1000 }s\n`
			);

			await wait( BACKOFF_MS );

			continue;
		}

		throw new Error(
			`HTTP ${ response.status }${ detail ? `: ${ detail.slice( 0, 400 ) }` : '' }`
		);
	}
};

/**
 * Stop, saying which key is missing.
 *
 * A missing key exits rather than returning nothing, because "the model had no
 * suggestions" and "nobody asked the model" must not produce the same artifact.
 * The caller enforces the same rule; this makes the message specific.
 *
 * @param {string} variable Environment variable name.
 * @param {string} where    Where to get one.
 * @throws {Error} Always.
 */
const demandKey = ( variable, where ) => {
	throw new Error(
		`no ${ variable }.\n\n` +
			`The analyze stage will not run without a key, and will not write an\n` +
			`empty proposal set instead. Get one from ${ where }, or use\n` +
			`--fixture=<file> to exercise the checks without calling anything.`
	);
};

/**
 * Google's Gemini, on the free tier.
 *
 * The key goes in a header rather than the `?key=` query parameter the quickstart
 * shows. Both work; a credential in a URL ends up in proxy logs, shell history
 * and error messages, and a header does not.
 */
const gemini = {
	name: 'gemini',

	/**
	 * Ask Gemini.
	 *
	 * @param {Object} request            The request.
	 * @param {string} request.system     System instruction.
	 * @param {string} request.user       The prompt.
	 * @param {boolean} request.schemaHint Whether to demand JSON.
	 * @return {Promise<{text: string, model: string}>} The reply.
	 */
	async complete( { system, user, schemaHint } ) {
		const key = process.env.GEMINI_API_KEY;

		if ( ! key ) {
			demandKey( 'GEMINI_API_KEY', 'https://aistudio.google.com/apikey' );
		}

		// Verified against ai.google.dev rather than remembered: the Flash
		// models on the free tier, newest stable first.
		const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

		const body = {
			contents: [ { role: 'user', parts: [ { text: user } ] } ],
			generationConfig: {
				maxOutputTokens: 8000,
				// Deterministic-ish. This is a classification task with a fixed
				// output shape, not a writing one.
				temperature: 0.2,
			},
		};

		if ( system ) {
			body.systemInstruction = { parts: [ { text: system } ] };
		}

		if ( schemaHint ) {
			// Asks the model for JSON rather than prose. The caller still
			// parses defensively: this makes a fence less likely, not
			// impossible, and the reply is untrusted either way.
			body.generationConfig.responseMimeType = 'application/json';
		}

		const json = await post(
			`https://generativelanguage.googleapis.com/v1beta/models/${ encodeURIComponent( model ) }:generateContent`,
			{ 'x-goog-api-key': key },
			body
		);

		const text = ( json?.candidates?.[ 0 ]?.content?.parts ?? [] )
			.map( ( part ) => part?.text ?? '' )
			.join( '' );

		// A blocked or truncated reply comes back with a finishReason and no
		// usable text. Saying which is the difference between "the model
		// declined" and "the model is broken".
		if ( '' === text.trim() ) {
			const reason = json?.candidates?.[ 0 ]?.finishReason ?? 'no candidates';

			throw new Error( `the reply had no text (finishReason: ${ reason })` );
		}

		return { text, model };
	},
};

/**
 * Anthropic's API.
 *
 * Kept working, and kept second. It bills separately from a claude.ai
 * subscription, which is the whole reason the default moved.
 */
const anthropic = {
	name: 'anthropic',

	/**
	 * Ask Claude.
	 *
	 * @param {Object} request            The request.
	 * @param {string} request.system     System instruction.
	 * @param {string} request.user       The prompt.
	 * @param {boolean} request.schemaHint Whether to demand JSON.
	 * @return {Promise<{text: string, model: string}>} The reply.
	 */
	async complete( { system, user } ) {
		const key = process.env.ANTHROPIC_API_KEY;

		if ( ! key ) {
			demandKey( 'ANTHROPIC_API_KEY', 'https://console.anthropic.com/' );
		}

		const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

		const body = {
			model,
			max_tokens: 8000,
			temperature: 0.2,
			messages: [ { role: 'user', content: user } ],
		};

		if ( system ) {
			body.system = system;
		}

		const json = await post(
			'https://api.anthropic.com/v1/messages',
			{ 'x-api-key': key, 'anthropic-version': '2023-06-01' },
			body
		);

		const text = ( json?.content ?? [] )
			.filter( ( block ) => 'text' === block?.type )
			.map( ( block ) => block.text )
			.join( '' );

		if ( '' === text.trim() ) {
			throw new Error(
				`the reply had no text (stop_reason: ${ json?.stop_reason ?? 'unknown' })`
			);
		}

		return { text, model };
	},
};

const PROVIDERS = { gemini, anthropic };

/**
 * The provider this run uses.
 *
 * @return {Object} The provider.
 * @throws {Error} When PROVIDER names one that does not exist.
 */
export const selected = () => {
	const name = ( process.env.PROVIDER || 'gemini' ).toLowerCase();
	const provider = PROVIDERS[ name ];

	if ( ! provider ) {
		throw new Error(
			`PROVIDER is "${ name }", which is not one of: ${ Object.keys( PROVIDERS ).join( ', ' ) }`
		);
	}

	return provider;
};

/**
 * Ask whichever model this run is configured for.
 *
 * @param {Object}  request            The request.
 * @param {string}  request.system     System instruction, or ''.
 * @param {string}  request.user       The prompt.
 * @param {boolean} [request.schemaHint] Ask for JSON where the provider can.
 * @return {Promise<{text: string, provider: string, model: string}>} The reply.
 */
export const complete = async ( { system = '', user, schemaHint = false } ) => {
	const provider = selected();
	const { text, model } = await provider.complete( { system, user, schemaHint } );

	return { text, provider: provider.name, model };
};

/**
 * Pull the text out of a provider's raw response body.
 *
 * Exported for the tests, which check that a recorded response from each
 * provider produces the same internal shape. The extraction is the only part
 * of a provider that differs in a way worth testing, and testing it against a
 * fixture is how that stays true without calling anything.
 *
 * @param {string} name Provider name.
 * @param {Object} body A raw response body.
 * @return {string} The text.
 */
export const textFrom = ( name, body ) => {
	if ( 'gemini' === name ) {
		return ( body?.candidates?.[ 0 ]?.content?.parts ?? [] )
			.map( ( part ) => part?.text ?? '' )
			.join( '' );
	}

	if ( 'anthropic' === name ) {
		return ( body?.content ?? [] )
			.filter( ( block ) => 'text' === block?.type )
			.map( ( block ) => block.text )
			.join( '' );
	}

	throw new Error( `unknown provider: ${ name }` );
};

export const RETRY_ON = shouldRetry;
