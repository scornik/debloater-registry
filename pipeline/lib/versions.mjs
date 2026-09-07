/**
 * Comparing version strings, with no side effects of any kind.
 *
 * This lives apart from `pipeline/watch.mjs` because that script *does* things
 * — it fetches from wordpress.org, prints a report and sets an exit code — and
 * all of that runs the moment the module is imported.
 *
 * The version of this file that did not exist cost about four minutes to find:
 * `tests/watch.test.mjs` imported `isNewer` from the script, which meant the
 * test suite made three seconds of live API calls every run, printed the
 * watcher's whole report into the test output, and would have set
 * `process.exitCode = 1` on any unreachable API — failing a green test run for
 * a reason with nothing to do with the tests.
 *
 * A pure function that decides something is worth being able to import without
 * consequences.
 */

/**
 * Whether `reported` is a version we have not looked at yet.
 *
 * Deliberately not a semver implementation. WordPress versions look like `7.1`,
 * Rank Math's look like `1.0.277.2`, and neither is semver; a library that
 * insisted otherwise would refuse to compare exactly the ones that matter.
 *
 * Segments are compared numerically where both sides are integers, and
 * anything this cannot order is reported as newer. That asymmetry is the whole
 * design: being wrong towards "newer" wastes one pipeline run, and being wrong
 * towards "unchanged" means a release nobody ever looks at.
 *
 * @param {string|null|undefined} known    What state/versions.json records.
 * @param {string}                reported What wordpress.org says.
 * @return {boolean} Whether reported is ahead of known.
 */
export const isNewer = ( known, reported ) => {
	if ( known === reported ) {
		return false;
	}

	if ( 'string' !== typeof known || '' === known ) {
		return true;
	}

	const left = known.split( '.' );
	const right = reported.split( '.' );

	for ( let i = 0; i < Math.max( left.length, right.length ); i++ ) {
		const a = left[ i ] ?? '0';
		const b = right[ i ] ?? '0';

		if ( a === b ) {
			continue;
		}

		const na = Number( a );
		const nb = Number( b );

		if ( Number.isInteger( na ) && Number.isInteger( nb ) ) {
			return nb > na;
		}

		// A beta, a release candidate, or whatever a plugin author invents
		// next. Erring towards a wasted run rather than towards silence.
		return true;
	}

	return false;
};
