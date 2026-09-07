/**
 * The gate every proposal passes before it can become a pull request.
 *
 * A model asked to propose registry changes will propose registry changes. It
 * will do so fluently whether or not the observation stages found anything,
 * because producing plausible text is what it is for. The defence against that
 * is not a better prompt — it is refusing to carry anything that cannot point
 * at a fact somebody's machine actually observed.
 *
 * So a proposal arrives with `evidence[]`, and every entry must correspond to a
 * candidate, a regression or a signal that the earlier stages emitted. Evidence
 * the model wrote itself, about a fact nothing scanned, is not evidence; it is
 * the failure mode wearing the costume of the check.
 *
 * `AUTHORING.md` already asks a human author for exactly this — "evidence" is
 * one of the things a review checks. This applies the same bar to a machine,
 * which is the only reason a machine is allowed to open the pull request.
 */

/**
 * Every fact key the observation stages actually reported.
 *
 * @param {Object} inputs             The three stage artifacts.
 * @param {Array}  inputs.candidates  From observe.
 * @param {Array}  inputs.regressions From verify.
 * @param {Array}  inputs.signals     From listen.
 * @return {{facts: Set<string>, tweaks: Set<string>, urls: Set<string>}} What was observed.
 */
export const observed = ( { candidates = [], regressions = [], signals = [] } ) => {
	const facts = new Set();
	const tweaks = new Set();
	const urls = new Set();

	for ( const candidate of candidates ) {
		if ( candidate && 'string' === typeof candidate.fact_key ) {
			facts.add( candidate.fact_key );
		}
	}

	for ( const regression of regressions ) {
		if ( regression && 'string' === typeof regression.tweak ) {
			tweaks.add( regression.tweak );
		}
	}

	for ( const signal of signals ) {
		if ( signal && 'string' === typeof signal.url ) {
			urls.add( signal.url );
		}
	}

	return { facts, tweaks, urls };
};

/**
 * Whether one evidence entry names something that was actually observed.
 *
 * @param {Object} entry What the proposal cited.
 * @param {Object} seen  Output of observed().
 * @return {string|null} Why it fails, or null when it holds up.
 */
const rejectEvidence = ( entry, seen ) => {
	if ( ! entry || 'object' !== typeof entry ) {
		return 'an evidence entry that is not an object';
	}

	if ( 'string' === typeof entry.fact_key ) {
		return seen.facts.has( entry.fact_key )
			? null
			: `cites fact_key "${ entry.fact_key }", which no scan reported`;
	}

	if ( 'string' === typeof entry.tweak ) {
		return seen.tweaks.has( entry.tweak )
			? null
			: `cites a regression in "${ entry.tweak }", which the matrix did not report`;
	}

	if ( 'string' === typeof entry.url ) {
		return seen.urls.has( entry.url )
			? null
			: `cites ${ entry.url }, which the listen stage did not collect`;
	}

	return 'an evidence entry naming neither a fact, a tweak nor a URL';
};

/**
 * Keep the proposals that are supported; say why the rest were dropped.
 *
 * @param {Array}  proposals What the model returned.
 * @param {Object} inputs    The three stage artifacts.
 * @return {{kept: Array, dropped: Array}} The split, with reasons.
 */
export const gate = ( proposals, inputs ) => {
	const seen = observed( inputs );
	const kept = [];
	const dropped = [];

	for ( const proposal of Array.isArray( proposals ) ? proposals : [] ) {
		if ( ! proposal || 'object' !== typeof proposal ) {
			dropped.push( { proposal, why: 'not an object' } );

			continue;
		}

		if ( ! Array.isArray( proposal.evidence ) || 0 === proposal.evidence.length ) {
			dropped.push( {
				proposal,
				why: 'no evidence, and a proposal without evidence is a guess with a diff attached',
			} );

			continue;
		}

		const problems = proposal.evidence
			.map( ( entry ) => rejectEvidence( entry, seen ) )
			.filter( ( reason ) => null !== reason );

		if ( problems.length > 0 ) {
			dropped.push( { proposal, why: problems.join( '; ' ) } );

			continue;
		}

		if ( 'string' !== typeof proposal.file || '' === proposal.file ) {
			dropped.push( { proposal, why: 'names no file to change' } );

			continue;
		}

		// A proposal may only touch the data directories. Nothing here writes
		// a workflow, a test or a manifest, and a proposal that tried would be
		// the pipeline proposing changes to its own guards.
		if ( ! /^(tweaks|compatibility|profiles)\/[A-Za-z0-9._-]+\.json$/.test( proposal.file ) ) {
			dropped.push( {
				proposal,
				why: `${ proposal.file } is not a tweak, compatibility or profile document`,
			} );

			continue;
		}

		kept.push( proposal );
	}

	return { kept, dropped };
};
