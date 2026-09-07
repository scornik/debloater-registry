/**
 * Which proposals may merge themselves, and which need a person.
 *
 * The pipeline can open a pull request. Whether that pull request may merge
 * without anybody reading it is decided here, and it is the most consequential
 * file in the pipeline: this repository is data that decides what a plugin does
 * to other people's sites.
 *
 * ## The rule
 *
 * **safer** — the change can only ever result in *fewer or gentler* changes
 * being applied to a site. Marking a tweak `dont_touch`, raising its risk band,
 * adding a `requires`, adding an incompatibility. If the model is wrong about
 * one of these, the worst outcome is that Debloater declines to do something it
 * could safely have done. That is a bad recommendation, not a broken site.
 *
 * **bolder** — everything else. A new tweak, a lowered risk band, a removed
 * rule, a widened profile. If the model is wrong about one of these, a site
 * gets a change nobody vetted. These wait for review, always.
 *
 * ## Two things are never automatic, whatever the direction
 *
 * `handler` and a profile's `include_risk`.
 *
 * A tweak's `handler` names a PHP file in the plugin. The registry cannot add
 * one — handlers live in the plugin and are code, not data (§13) — so a diff
 * that touches `handler` is either pointing an existing tweak at different
 * code or introducing a tweak whose handler does not exist yet. Both need eyes.
 *
 * `include_risk` decides which risk bands a profile admits. Changing it does
 * not alter one tweak; it alters what every tweak in that band means for
 * everyone running that profile. There is no version of that which is a
 * detail.
 *
 * These are enforced here rather than trusted to the classifier's own opinion,
 * because a classifier that decided its own exemptions would not be a guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


/**
 * Fields whose appearance in a diff forces review, whatever else is true.
 */
export const ALWAYS_REVIEW = [
	{ field: 'handler', why: 'a handler is code in the plugin, not data here' },
	{
		field: 'include_risk',
		why: "a profile's risk band changes what every tweak in it means",
	},
];

/**
 * Risk bands, weakest first. Raising a tweak's risk is safer; lowering is not.
 *
 * Read from the schema rather than written here, and that is not tidiness. The
 * first version of this file hardcoded `safe, moderate, advanced, expert`,
 * which are not this registry's bands -- they are `safe, low, medium, high`.
 * Every real risk change would have found `indexOf( 'low' ) === -1`, decided it
 * could not order them, and fallen through to "bolder".
 *
 * That fails safe, which is why nothing would have caught it: the automatic
 * path would simply never have fired, on any real document, for as long as
 * anybody left it alone. The unit tests passed because they used the invented
 * bands too -- a test and its subject agreeing about a fiction.
 *
 * Reading the enum means the classifier follows the data. If a band is added,
 * the ordering gains it; if the enum is reordered, this notices.
 */
const RISK_ORDER = JSON.parse(
	fs.readFileSync(
		path.join(
			path.dirname( fileURLToPath( import.meta.url ) ),
			'..',
			'..',
			'schemas',
			'tweak.schema.json'
		),
		'utf8'
	)
).properties.risk.enum;

/**
 * Whether a risk change makes the registry more cautious.
 *
 * @param {string} before Previous band.
 * @param {string} after  Proposed band.
 * @return {boolean} True when the tweak became more restricted.
 */
const raisesRisk = ( before, after ) => {
	const from = RISK_ORDER.indexOf( before );
	const to = RISK_ORDER.indexOf( after );

	// An unknown band is not a judgement this can make. Unknown is not safe.
	if ( -1 === from || -1 === to ) {
		return false;
	}

	return to > from;
};

/**
 * Classify one proposed change.
 *
 * @param {Object} proposal          A proposal from the analyze stage.
 * @param {string} proposal.file     Repository-relative path being changed.
 * @param {string} proposal.op       'add' | 'modify' | 'remove'.
 * @param {Object} [proposal.before] The document as it is now.
 * @param {Object} [proposal.after]  The document as proposed.
 * @return {{direction: string, automatic: boolean, reasons: string[]}} Verdict.
 */
export const classify = ( proposal ) => {
	const reasons = [];
	const before = proposal.before ?? {};
	const after = proposal.after ?? {};

	// 1. The two fields that are never automatic.
	for ( const { field, why } of ALWAYS_REVIEW ) {
		const wasSet = Object.hasOwn( before, field );
		const isSet = Object.hasOwn( after, field );

		if ( ! wasSet && ! isSet ) {
			continue;
		}

		const changedValue =
			JSON.stringify( before[ field ] ?? null ) !==
			JSON.stringify( after[ field ] ?? null );

		if ( changedValue ) {
			reasons.push( `${ field }: ${ why }` );
		}
	}

	if ( reasons.length > 0 ) {
		return { direction: 'bolder', automatic: false, reasons };
	}

	// 2. A new document is a new capability. Never automatic.
	if ( 'add' === proposal.op ) {
		return {
			direction: 'bolder',
			automatic: false,
			reasons: [ 'a new document adds something the registry could not do before' ],
		};
	}

	// 3. A removed document removes a rule that was constraining something.
	if ( 'remove' === proposal.op ) {
		return {
			direction: 'bolder',
			automatic: false,
			reasons: [ 'removing a document removes a constraint somebody added deliberately' ],
		};
	}

	// 4. A modification. Every changed field must be individually safer.
	const fields = new Set( [ ...Object.keys( before ), ...Object.keys( after ) ] );
	const safer = [];

	for ( const field of fields ) {
		const was = before[ field ];
		const now = after[ field ];

		if ( JSON.stringify( was ?? null ) === JSON.stringify( now ?? null ) ) {
			continue;
		}

		if ( 'risk' === field ) {
			if ( raisesRisk( was, now ) ) {
				safer.push( `risk raised from ${ was } to ${ now }` );

				continue;
			}

			return {
				direction: 'bolder',
				automatic: false,
				reasons: [ `risk lowered from ${ was } to ${ now }` ],
			};
		}

		if ( 'dont_touch' === field ) {
			if ( true === now ) {
				safer.push( 'marked dont_touch' );

				continue;
			}

			return {
				direction: 'bolder',
				automatic: false,
				reasons: [ 'dont_touch removed' ],
			};
		}

		// Lists that constrain: growing them narrows what the planner will do.
		if ( [ 'requires', 'conflicts', 'breaks', 'incompatible' ].includes( field ) ) {
			const grew = Array.isArray( was ) && Array.isArray( now ) && now.length > was.length;
			const kept = Array.isArray( was ) && Array.isArray( now ) &&
				was.every( ( item ) => now.some( ( candidate ) => JSON.stringify( candidate ) === JSON.stringify( item ) ) );

			if ( grew && kept ) {
				safer.push( `${ field } gained an entry` );

				continue;
			}

			return {
				direction: 'bolder',
				automatic: false,
				reasons: [ `${ field } lost or replaced an entry` ],
			};
		}

		// Anything this does not have an opinion about is not safe by default.
		// A classifier whose unknown case is "probably fine" is a classifier
		// that eventually waves through the one field nobody thought about.
		return {
			direction: 'bolder',
			automatic: false,
			reasons: [ `${ field } changed, and there is no rule saying that is safer` ],
		};
	}

	if ( 0 === safer.length ) {
		return {
			direction: 'safer',
			automatic: false,
			reasons: [ 'nothing changed' ],
		};
	}

	return { direction: 'safer', automatic: true, reasons: safer };
};
