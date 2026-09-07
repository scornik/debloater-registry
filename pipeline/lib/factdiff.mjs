/**
 * What a new version of something added to a site.
 *
 * The pipeline's first stage scans a clean install and a seeded fixture at the
 * new versions and compares the FactSet against `baselines/<stack>.json`. This
 * is the comparison. It is deliberately the smallest thing that answers the
 * question the registry actually asks — *what is new here that nobody has
 * written a rule about* — and nothing else.
 *
 * ## Only additions matter
 *
 * A fact that disappeared is not a candidate for a new tweak: there is nothing
 * left to switch off. It is reported separately as `removed`, because a rule
 * that targets something no longer present is dead weight and worth pruning,
 * but it never becomes a proposal to add anything.
 *
 * ## Facts are compared by key, not by shape
 *
 * `BUILD-SPEC.md` §5 makes a FactSet a flat map of `key -> value`. Comparing
 * whole objects would report every scan as different, because scans carry
 * timings and counts that move on their own. Comparing by key, and then by
 * value only for keys present in both, is what separates "WooCommerce 10.2 adds
 * a dashboard widget" from "this run was 4ms slower".
 *
 * ## Families come from the scanner, not from a description of it
 *
 * The families below are the top-level namespaces a real `wp debloater scan
 * --json` produces. Three of the things Phase 21 asked to watch -- admin
 * notices, dashboard widgets and public REST routes -- are not among them,
 * because the scanner does not record them: it reports `wp.emojis_enabled`,
 * `db.transients.count`, `cron.events.count` and so on, which are flags and
 * counts rather than enumerations. docs/PIPELINE.md says so plainly rather
 * than leaving a family that silently never matches.
 *
 * A fact outside every family is recorded as `other` rather than dropped -- the
 * registry may grow a rule about something nobody anticipated, and silently
 * discarding evidence is how a pipeline starts misreporting what it looked at.
 */

/**
 * The fact families this registry writes rules about.
 *
 * Read off a real `wp debloater scan --json`, not invented. The first version
 * of this list guessed at `admin.notices`, `admin.dashboard_widgets`,
 * `cron.hooks`, `assets.handles`, `db.autoloaded_options` and `rest.routes`,
 * from the brief's description rather than from the scanner. Not one of those
 * prefixes exists: against a live scan of 72 facts, every single one
 * classified as `other`.
 *
 * That would not have broken a run. It would have labelled every candidate
 * `other` and carried on, and the label is what a person reads first.
 */
export const FAMILIES = [
	[ 'wp', 'core_behaviour' ],
	[ 'db', 'database' ],
	[ 'cron', 'cron' ],
	[ 'assets', 'enqueued_assets' ],
	[ 'plugins', 'plugins' ],
	[ 'theme', 'theme' ],
	[ 'users', 'users' ],
	[ 'env', 'environment' ],
	[ 'woo', 'woocommerce' ],
	[ 'elementor', 'elementor' ],
];

/**
 * Facts that move on their own, and are never a candidate.
 *
 * `scan.elapsed_ms` and `scan.scanner_ms` differ on every run of the same site,
 * so diffing them would produce two candidates a week, for ever, describing
 * nothing. `scan.failed` and `scan.over_budget` say something about the run
 * rather than about the site.
 *
 * `assets.unavailable_reason` is here for a subtler reason. It carries a cURL
 * error string when the scanner cannot reach the site over loopback, and that
 * string contains a port number and a timing. Two runs in the same broken
 * environment produce two different strings, and the diff would report a change
 * in the *site* when what changed was the failure message.
 */
export const VOLATILE = [
	'scan.elapsed_ms',
	'scan.scanner_ms',
	'scan.failed',
	'scan.over_budget',
	'scan.pages_sampled',
	'assets.unavailable_reason',
	'assets.pages_sampled',
	'woo.pages_sampled',
];

/**
 * Which family a fact key belongs to.
 *
 * @param {string} key Fact key.
 * @return {string} A family name, or 'other'.
 */
export const familyOf = ( key ) => {
	for ( const [ prefix, family ] of FAMILIES ) {
		if ( key === prefix || key.startsWith( `${ prefix }.` ) ) {
			return family;
		}
	}

	return 'other';
};

/**
 * Whether a fact is worth comparing at all.
 *
 * @param {string} key Fact key.
 * @return {boolean} True when a change in it means something.
 */
export const isStable = ( key ) => ! VOLATILE.includes( key );

/**
 * Compare two flat fact maps.
 *
 * @param {Object} baseline What was recorded for the previous versions.
 * @param {Object} observed What this run scanned.
 * @return {{added: Array, changed: Array, removed: Array}} The difference.
 */
export const diffFacts = ( baseline, observed ) => {
	const before = baseline && 'object' === typeof baseline ? baseline : {};
	const after = observed && 'object' === typeof observed ? observed : {};

	const added = [];
	const changed = [];
	const removed = [];

	for ( const key of Object.keys( after ).sort() ) {
		if ( ! isStable( key ) ) {
			continue;
		}

		if ( ! Object.hasOwn( before, key ) ) {
			added.push( { key, family: familyOf( key ), after: after[ key ] } );

			continue;
		}

		// Compared as JSON rather than by identity, because a fact's value may
		// be an array of handles or a count, and two arrays with the same
		// contents are the same fact.
		const wasJson = JSON.stringify( before[ key ] ?? null );
		const isJson = JSON.stringify( after[ key ] ?? null );

		if ( wasJson !== isJson ) {
			changed.push( {
				key,
				family: familyOf( key ),
				before: before[ key ],
				after: after[ key ],
			} );
		}
	}

	for ( const key of Object.keys( before ).sort() ) {
		if ( ! isStable( key ) ) {
			continue;
		}

		if ( ! Object.hasOwn( after, key ) ) {
			removed.push( { key, family: familyOf( key ), before: before[ key ] } );
		}
	}

	return { added, changed, removed };
};

/**
 * Turn a difference into candidate entries, one per new item, with evidence.
 *
 * A candidate is not a proposal. It is an observation with its provenance
 * attached, and the only thing that makes it worth acting on is that
 * provenance: which fact, what it was, what it is, and at which versions. The
 * analyze stage may not invent any of it, and the evidence gate drops anything
 * that arrives without it.
 *
 * @param {Object} options          Options.
 * @param {string} options.stack    Which fixture stack was scanned.
 * @param {Object} options.versions Versions in play at scan time.
 * @param {Object} options.diff     Output of diffFacts().
 * @return {Array} Candidates.
 */
export const toCandidates = ( { stack, versions, diff } ) => {
	const candidates = [];

	for ( const entry of diff.added ) {
		candidates.push( {
			stack,
			kind: 'added',
			family: entry.family,
			fact_key: entry.key,
			evidence: [
				{
					fact_key: entry.key,
					before: null,
					after: entry.after,
					versions,
					stack,
				},
			],
		} );
	}

	for ( const entry of diff.changed ) {
		candidates.push( {
			stack,
			kind: 'changed',
			family: entry.family,
			fact_key: entry.key,
			evidence: [
				{
					fact_key: entry.key,
					before: entry.before,
					after: entry.after,
					versions,
					stack,
				},
			],
		} );
	}

	// Removals are reported so a stale rule can be pruned, and are never a
	// reason to add one.
	for ( const entry of diff.removed ) {
		candidates.push( {
			stack,
			kind: 'removed',
			family: entry.family,
			fact_key: entry.key,
			evidence: [
				{
					fact_key: entry.key,
					before: entry.before,
					after: null,
					versions,
					stack,
				},
			],
		} );
	}

	return candidates;
};
