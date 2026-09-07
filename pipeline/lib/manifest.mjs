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
 * The directories that hold registry data.
 *
 * An allow-list, and the reason is `docs/DECISIONS.md` D-0057, which argued the
 * same thing for `.distignore`: **a deny-list ships what it forgets.**
 *
 * This function used to walk every `.json` outside an exclusion list, which
 * made anything new in the tree registry data by default. The propose job then
 * downloaded `candidates.json` into the repository root, and the manifest
 * listed one run's observations as rules for every site to fetch. Nothing was
 * wrong with the exclusion list except that it could not know about a file
 * nobody had written yet.
 *
 * Confirmed against the committed manifest rather than assumed: five
 * directories and three root files, 58 documents.
 */
export const REGISTRY_DIRECTORIES = [
	'compatibility',
	'detectors',
	'profiles',
	'schemas',
	'tweaks',
];

/**
 * Registry documents that live at the root rather than in a directory.
 */
export const REGISTRY_ROOT_FILES = [
	'admin-notices.json',
	'host-optimizers.json',
	'plugin-categories.json',
];

/**
 * Directories that are part of the repository and are not registry data.
 *
 * Named so that a `.json` inside one is *known* not to be a document, rather
 * than unrecognised. The difference matters: an unrecognised file stops a
 * build, and these must not.
 */
const NON_REGISTRY_DIRECTORIES = [
	'.git',
	'.github',
	'baselines',
	'dist',
	'docs',
	'node_modules',
	'pipeline',
	'state',
	'tests',
];

/**
 * Root files that are known, and known not to be registry data.
 *
 * Release metadata, packaging, and the artifacts a pipeline run leaves in the
 * checkout. The propose job downloads four of these into the root before
 * regenerating the manifest.
 */
const NON_REGISTRY_ROOT_FILES = [
	'manifest.json',
	'package.json',
	'package-lock.json',

	// A pipeline run's own artifacts.
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
 * Raised when the tree holds a JSON file this cannot classify.
 */
export class UnrecognisedFile extends Error {}

/**
 * Every registry document, as repository-relative paths, byte-sorted.
 *
 * Throws on a `.json` that is neither registry data nor a known non-document.
 * Silence in either direction is what produced the bug this replaces: including
 * it shipped a run artifact as a rule, and dropping it would hide a real
 * document from the manifest and therefore from every site.
 *
 * @param {string} root Repository root.
 * @return {string[]} Relative paths.
 * @throws {UnrecognisedFile} When something in the tree cannot be classified.
 */
export const registryFiles = ( root ) => {
	const found = [];
	const unrecognised = [];

	for ( const name of REGISTRY_DIRECTORIES ) {
		const directory = path.join( root, name );

		if ( ! fs.existsSync( directory ) ) {
			continue;
		}

		const walk = ( where ) => {
			for ( const entry of fs.readdirSync( where, { withFileTypes: true } ) ) {
				const full = path.join( where, entry.name );
				const relative = path.relative( root, full ).split( path.sep ).join( '/' );

				if ( entry.isDirectory() ) {
					walk( full );

					continue;
				}

				if ( relative.endsWith( '.json' ) ) {
					found.push( relative );

					continue;
				}

				// A non-JSON file inside a registry directory. Not a document,
				// and not something to pass over in silence either.
				unrecognised.push( `${ relative } (not JSON, inside a registry directory)` );
			}
		};

		walk( directory );
	}

	// Now the rest of the tree, looking only for things this cannot account for.
	const audit = ( where ) => {
		for ( const entry of fs.readdirSync( where, { withFileTypes: true } ) ) {
			const full = path.join( where, entry.name );
			const relative = path.relative( root, full ).split( path.sep ).join( '/' );
			const top = relative.split( '/' )[ 0 ];

			if ( REGISTRY_DIRECTORIES.includes( top ) || NON_REGISTRY_DIRECTORIES.includes( top ) ) {
				continue;
			}

			if ( entry.isDirectory() ) {
				audit( full );

				continue;
			}

			if ( ! relative.endsWith( '.json' ) ) {
				continue;
			}

			if (
				REGISTRY_ROOT_FILES.includes( relative ) ||
				NON_REGISTRY_ROOT_FILES.includes( relative )
			) {
				continue;
			}

			unrecognised.push( relative );
		}
	};

	audit( root );

	if ( unrecognised.length > 0 ) {
		throw new UnrecognisedFile(
			`This tree holds ${ unrecognised.length } file(s) that are neither registry ` +
				'data nor known non-documents:\n\n' +
				unrecognised.map( ( one ) => `  - ${ one }` ).join( '\n' ) +
				'\n\nAdd it to REGISTRY_ROOT_FILES if a site should fetch it, or to the ' +
				'non-registry list if not. It is deliberately not possible to leave it ' +
				'unclassified: including it by default is how a run artifact was once ' +
				'listed as a rule, and dropping it by default would hide a real document ' +
				'from every site.'
	 	);
	}

	for ( const relative of REGISTRY_ROOT_FILES ) {
		if ( fs.existsSync( path.join( root, relative ) ) ) {
			found.push( relative );
		}
	}

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
