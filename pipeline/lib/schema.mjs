/**
 * Enough JSON Schema to refuse a malformed proposal.
 *
 * ## What this is not
 *
 * It is not a JSON Schema implementation, and it must not grow into one.
 *
 * `README.md` records the reason: the plugin validates every document as it
 * loads it, and its opinion is the one that decides whether a site accepts a
 * registry. A second full validator here would eventually disagree with it, and
 * the disagreement would surface as a document this repository called valid and
 * a site refused — the worst place to find out.
 *
 * ## What it is
 *
 * The subset needed to stop a model's output before it becomes a pull request:
 *
 * - every `required` field is present;
 * - no field outside `properties` is invented;
 * - `enum` values are one of the listed ones;
 * - `type` is right for the primitives that decide behaviour.
 *
 * A document that passes this is not "valid". It is *not obviously invalid*,
 * which is a smaller claim and the right one for a gate whose job is to catch
 * a plausible-looking fabrication rather than to certify data.
 *
 * Anything subtler — conditional schemas, cross-field constraints, `$ref` — is
 * left to the plugin, and a proposal that gets past this and fails there fails
 * in the pull request's CI, before a person merges it.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Which schema governs a repository path.
 *
 * @param {string} file Repository-relative path.
 * @return {string|null} Schema filename.
 */
export const schemaFor = ( file ) => {
	if ( file.startsWith( 'tweaks/' ) ) {
		return 'tweak.schema.json';
	}

	if ( file.startsWith( 'profiles/' ) ) {
		return 'profile.schema.json';
	}

	if ( file.startsWith( 'compatibility/' ) ) {
		return 'compat.schema.json';
	}

	return null;
};

/**
 * Check a document against the parts of its schema this understands.
 *
 * @param {Object} document The proposed document.
 * @param {Object} schema   The parsed JSON Schema.
 * @return {string[]} Problems; empty means nothing obviously wrong.
 */
export const validate = ( document, schema ) => {
	const problems = [];

	if ( ! document || 'object' !== typeof document || Array.isArray( document ) ) {
		return [ 'the document is not a JSON object' ];
	}

	const properties = schema.properties ?? {};

	for ( const field of schema.required ?? [] ) {
		if ( ! Object.hasOwn( document, field ) ) {
			problems.push( `missing required field "${ field }"` );
		}
	}

	for ( const [ field, value ] of Object.entries( document ) ) {
		const rule = properties[ field ];

		if ( ! rule ) {
			// An invented field is the clearest sign of a fabrication, and the
			// cheapest to catch. `additionalProperties` is not consulted:
			// nothing in this registry allows them, and assuming otherwise
			// would let one through the day a schema forgets to say so.
			problems.push( `"${ field }" is not a field this document may have` );

			continue;
		}

		if ( Array.isArray( rule.enum ) && ! rule.enum.includes( value ) ) {
			problems.push(
				`"${ field }" is ${ JSON.stringify( value ) }, not one of ` +
					rule.enum.map( ( one ) => JSON.stringify( one ) ).join( ', ' )
			);

			continue;
		}

		const expected = rule.type;

		if ( ! expected ) {
			continue;
		}

		const actual = Array.isArray( value ) ? 'array' : typeof value;
		const types = Array.isArray( expected ) ? expected : [ expected ];

		// JSON Schema's "integer" and "number" are both JavaScript numbers, and
		// null is its own type rather than an object.
		const matches = types.some( ( type ) => {
			if ( 'integer' === type ) {
				return Number.isInteger( value );
			}

			if ( 'number' === type ) {
				return 'number' === actual;
			}

			if ( 'null' === type ) {
				return null === value;
			}

			if ( 'object' === type ) {
				return null !== value && 'object' === actual;
			}

			return type === actual;
		} );

		if ( ! matches ) {
			problems.push(
				`"${ field }" is ${ null === value ? 'null' : actual }, not ${ types.join( ' or ' ) }`
			);
		}
	}

	return problems;
};

/**
 * Check a proposed document for the file it claims to be.
 *
 * @param {string} root Repository root.
 * @param {string} file Repository-relative path.
 * @param {Object} document The proposed document.
 * @return {string[]} Problems.
 */
export const validateFor = ( root, file, document ) => {
	const name = schemaFor( file );

	if ( ! name ) {
		return [ `${ file } is not governed by any schema here` ];
	}

	const schemaPath = path.join( root, 'schemas', name );

	if ( ! fs.existsSync( schemaPath ) ) {
		return [ `${ name } is missing, so ${ file } cannot be checked` ];
	}

	const problems = validate( document, JSON.parse( fs.readFileSync( schemaPath, 'utf8' ) ) );

	// The registry's own convention, asserted by tests/integrity.mjs on every
	// push: a document's id is its filename. Checked here too, so a proposal
	// that would break the repository is refused before it is written rather
	// than after.
	const expectedId = path.basename( file, '.json' );

	if ( Object.hasOwn( document, 'id' ) && document.id !== expectedId ) {
		problems.push( `id "${ document.id }" does not match the filename ${ expectedId }` );
	}

	return problems;
};
