/**
 * Build the manifest, in this repository, with nothing installed.
 *
 * `manifest.json` lists every file here with its sha256, and `manifest.sig` is
 * a detached Ed25519 signature over it. A site checks each downloaded file
 * against this list, so the manifest is the thing that decides what a site is
 * allowed to receive.
 *
 * ## Why a second implementation, and how it stays honest
 *
 * The plugin has `tools/registry-manifest.php`, which is what a person has used
 * to cut every release so far. This exists because the pipeline runs *here*,
 * where the plugin is not checked out, and needing PHP plus another repository
 * to regenerate a list of hashes would be a lot of machinery for a list of
 * hashes.
 *
 * Two implementations of a signed format is exactly the kind of thing that
 * drifts, so this one is not allowed to have an opinion. It reproduces the
 * PHP tool's bytes exactly:
 *
 * - the same key order — `schema_version`, `product`, `tag`, `generated_at`,
 *   `files`;
 * - the same file ordering, a plain byte-wise sort of relative paths;
 * - `JSON_PRETTY_PRINT`, which is four spaces, and which `JSON.stringify` with
 *   an indent of 4 matches;
 * - unescaped slashes and unicode, which Node does by default;
 * - one trailing newline.
 *
 * `tests/manifest.test.mjs` asserts that rebuilding the committed manifest
 * reproduces it byte for byte, so the day the two disagree is the day that test
 * fails rather than the day a signature stops verifying on somebody's site.
 *
 * ## This never signs
 *
 * There is no signing here and there is no key on any runner. Signing is a
 * person, at a machine that has the offline key — `make registry-release`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Directories and files that are part of the repository but not the registry.
 *
 * The plugin downloads the registry's *data*. Workflows, tests, the pipeline
 * and documentation are not data a site consumes, and listing them would ask
 * sites to fetch and hash files they have no use for.
 */
const NOT_REGISTRY = [
	'.git',
	'.github',
	'baselines',
	'docs',
	'node_modules',
	'pipeline',
	'state',
	'tests',
];

/**
 * Files at the root that are not registry data.
 *
 * Two kinds. Documentation and release metadata, which have always been here;
 * and the artifacts a pipeline run leaves in the checkout, which have not.
 *
 * The second kind matters more than it looks. The propose job downloads
 * `candidates.json`, `regressions.json`, `signals.json` and `proposals.json`
 * into the repository root and then regenerates the manifest. Without these
 * lines that manifest lists them as registry documents, hashes them, and
 * commits them in the pull request -- so a released registry would tell every
 * site to fetch one run's observations as though they were rules.
 *
 * It did not happen because the first run had nothing to propose. The first run
 * that proposed anything would have shipped it.
 */
const NOT_REGISTRY_FILES = [
	'manifest.json',
	'manifest.sig',
	'package.json',
	'Makefile',
	'README.md',
	'AUTHORING.md',
	'.gitattributes',
	'.gitignore',

	// A pipeline run's own artifacts. Never registry data.
	'candidates.json',
	'candidates-clean.json',
	'candidates-fixture.json',
	'regressions.json',
	'signals.json',
	'proposals.json',
	'scan-clean.json',
	'scan-fixture.json',
];

/**
 * Every registry document, as repository-relative paths, byte-sorted.
 *
 * @param {string} root Repository root.
 * @return {string[]} Relative paths.
 */
export const registryFiles = ( root ) => {
	const found = [];

	const walk = ( directory ) => {
		for ( const entry of fs.readdirSync( directory, { withFileTypes: true } ) ) {
			const full = path.join( directory, entry.name );
			const relative = path.relative( root, full ).split( path.sep ).join( '/' );

			if ( entry.isDirectory() ) {
				if ( ! NOT_REGISTRY.includes( relative ) ) {
					walk( full );
				}

				continue;
			}

			if ( NOT_REGISTRY_FILES.includes( relative ) || ! relative.endsWith( '.json' ) ) {
				continue;
			}

			found.push( relative );
		}
	};

	walk( root );

	// A plain byte-wise sort, matching PHP's sort( $found, SORT_STRING ).
	// localeCompare would order differently on some machines, and a manifest
	// whose key order depends on the machine that built it is a manifest whose
	// signature depends on it too.
	found.sort();

	return found;
};

/**
 * The manifest object for the files on disk.
 *
 * @param {Object} options              Options.
 * @param {string} options.root         Repository root.
 * @param {string} options.tag          Tag this manifest describes.
 * @param {string} [options.generatedAt] Override the timestamp, for tests.
 * @return {Object} The manifest.
 */
export const buildManifest = ( { root, tag, generatedAt } ) => {
	const files = {};

	for ( const relative of registryFiles( root ) ) {
		const contents = fs.readFileSync( path.join( root, relative ) );

		files[ relative ] = crypto.createHash( 'sha256' ).update( contents ).digest( 'hex' );
	}

	return {
		schema_version: 1,
		product: 'debloater',
		tag,
		generated_at: generatedAt ?? new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ),
		files,
	};
};

/**
 * The manifest's bytes, exactly as they are written and signed.
 *
 * @param {Object} manifest The manifest object.
 * @return {string} Its serialisation.
 */
export const serialise = ( manifest ) => `${ JSON.stringify( manifest, null, 4 ) }\n`;

/**
 * Whether the manifest on disk still describes the files on disk.
 *
 * @param {string} root Repository root.
 * @return {{ok: boolean, problems: string[]}} The verdict.
 */
export const checkManifest = ( root ) => {
	const problems = [];
	const manifestPath = path.join( root, 'manifest.json' );

	if ( ! fs.existsSync( manifestPath ) ) {
		return { ok: false, problems: [ 'manifest.json is missing' ] };
	}

	const manifest = JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) );
	const recorded = manifest.files ?? {};
	const present = registryFiles( root );

	for ( const relative of present ) {
		if ( ! Object.hasOwn( recorded, relative ) ) {
			problems.push( `${ relative } is here but not in the manifest` );
		}
	}

	for ( const relative of Object.keys( recorded ) ) {
		if ( ! present.includes( relative ) ) {
			problems.push( `the manifest lists ${ relative }, which is not here` );

			continue;
		}

		const actual = crypto
			.createHash( 'sha256' )
			.update( fs.readFileSync( path.join( root, relative ) ) )
			.digest( 'hex' );

		if ( actual !== recorded[ relative ] ) {
			problems.push( `${ relative } does not match its manifest hash` );
		}
	}

	return { ok: 0 === problems.length, problems };
};
