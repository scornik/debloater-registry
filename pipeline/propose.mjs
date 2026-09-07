#!/usr/bin/env node
/**
 * Stage 5 — propose. Write the changes, and decide who has to look at them.
 *
 *     node pipeline/propose.mjs --proposals=p.json --candidates=c.json \
 *         --regressions=r.json --signals=s.json [--dry-run]
 *
 * Applies accepted proposals to the working tree, regenerates the manifest,
 * and opens a pull request. `--dry-run` does everything except touching git.
 *
 * ## Two branches, not one
 *
 * The brief asked for one pull request. It cannot be one, and the reason is
 * worth stating rather than quietly working around: a pull request has one
 * merge behaviour. Putting a strictly-safer change and a change needing review
 * in the same one means either the reviewed change merges itself or the safe
 * change waits — and the second is only a nuisance while the first is the whole
 * risk this pipeline is built to avoid.
 *
 * So a run with both kinds opens two: `safer` labelled `auto-merge`, `bolder`
 * labelled `needs-review`. A run with one kind opens one. Most runs will open
 * none.
 *
 * ## The direction is decided twice
 *
 * `analyze.mjs` classified every proposal and wrote the verdict down. This
 * classifies them again, from the documents on disk, and refuses to auto-merge
 * anything the second pass disagrees about.
 *
 * That is not distrust of the first pass; it is the same code. It is distrust
 * of the *artifact between them*. `proposals.json` travels between two jobs, and
 * a file that says `"automatic": true` is a file that grants auto-merge to
 * whoever can write it. Re-deriving it from the diff means the flag in the
 * artifact is a report rather than an instruction.
 *
 * ## What it never does
 *
 * It does not sign, tag, or release. It does not merge — the `auto-merge` label
 * asks GitHub to merge when CI is green, and CI is what actually decides. And
 * it cannot write outside `tweaks/`, `compatibility/` and `profiles/`, because
 * the evidence gate refused anything else long before this ran.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify } from './lib/direction.mjs';

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

const dryRun = process.argv.includes( '--dry-run' );

/**
 * Read one of the stage artifacts.
 *
 * @param {string|null} file Path.
 * @param {string}      key  Which array to read.
 * @return {Array} Entries.
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

const proposalsPath = option( 'proposals', 'proposals.json' );

if ( ! fs.existsSync( proposalsPath ) ) {
	process.stderr.write(
		`\nThere is no ${ proposalsPath }. The analyze stage did not run, and a run ` +
			'that skipped it has not decided there is nothing to propose.\n\n'
	);
	process.exit( 1 );
}

const analysis = JSON.parse( fs.readFileSync( proposalsPath, 'utf8' ) );
const proposals = analysis.proposals ?? [];

const candidates = artifact( option( 'candidates' ), 'candidates' );
const regressions = artifact( option( 'regressions' ), 'regressions' );
const signals = artifact( option( 'signals' ), 'signals' );

/* ------------------------------------------------- re-decide the direction */

const safer = [];
const bolder = [];
const disagreements = [];

for ( const proposal of proposals ) {
	const full = path.join( ROOT, proposal.file );
	const before = fs.existsSync( full )
		? JSON.parse( fs.readFileSync( full, 'utf8' ) )
		: null;

	const verdict = classify( {
		file: proposal.file,
		op: proposal.op,
		before,
		after: proposal.after,
	} );

	if ( verdict.automatic !== proposal.automatic ) {
		disagreements.push( {
			file: proposal.file,
			recorded: proposal.automatic,
			recomputed: verdict.automatic,
		} );
	}

	// The stricter of the two wins. An artifact cannot promote a change to
	// automatic, only fail to.
	const automatic = verdict.automatic && proposal.automatic;

	( automatic ? safer : bolder ).push( { ...proposal, ...verdict, automatic } );
}

/* ------------------------------------------------------------- the summary */

/**
 * The table that goes at the top of the pull request.
 *
 * @param {Array} group Proposals in this request.
 * @return {string} Markdown.
 */
const summary = ( group ) => {
	const versions = JSON.parse(
		fs.readFileSync( path.join( ROOT, 'state', 'versions.json' ), 'utf8' )
	);

	const covered = [
		`WordPress ${ versions.core?.wordpress?.version ?? '?' }`,
		...Object.entries( versions.plugins ?? {} )
			.filter( ( [ , entry ] ) => entry.watch )
			.map( ( [ slug, entry ] ) => `${ slug } ${ entry.version }` ),
	].join( ', ' );

	const rows = group
		.map(
			( one ) =>
				`| \`${ one.file }\` | ${ one.op } | ${ one.direction } | ${ one.reasons.join( '; ' ) } | ${ one.evidence.length } |`
		)
		.join( '\n' );

	return [
		'| | |',
		'|---|---|',
		`| Versions covered | ${ covered } |`,
		`| Candidates observed | ${ candidates.length } |`,
		`| Regressions | ${ regressions.length } |`,
		`| Support signals | ${ signals.length } |`,
		`| Model returned | ${ analysis.returned ?? 0 } |`,
		`| Accepted after gates | ${ proposals.length } |`,
		'',
		'| File | Op | Direction | Why | Evidence |',
		'|---|---|---|---|---|',
		rows,
		'',
		'Every proposal above cites evidence produced by this run. Proposals without',
		'evidence, or citing anything the observation stages did not report, were',
		'dropped before this was written:',
		'',
		...( analysis.rejected ?? [] ).map(
			( entry ) => `- \`${ entry.file }\` — ${ entry.why }`
		),
		( analysis.rejected ?? [] ).length ? '' : '- (none)',
		'',
		'---',
		'',
		'`manifest.json` is regenerated here so the integrity check passes. It is',
		'**not signed**: `main` carries content and a tag carries a signature, so',
		'nothing merged here reaches a site until somebody signs a release with the',
		'offline key. See `docs/DECISIONS.md` D-0067.',
	].join( '\n' );
};

/* --------------------------------------------------------------- apply it */

/**
 * Write one proposal to disk.
 *
 * @param {Object} proposal The proposal.
 */
const apply = ( proposal ) => {
	const full = path.join( ROOT, proposal.file );

	if ( 'remove' === proposal.op ) {
		fs.rmSync( full, { force: true } );

		return;
	}

	fs.mkdirSync( path.dirname( full ), { recursive: true } );
	fs.writeFileSync( full, `${ JSON.stringify( proposal.after, null, 2 ) }\n` );
};

/**
 * Run a command, returning its output.
 *
 * @param {string}   file Command.
 * @param {string[]} args Arguments.
 * @return {string} stdout.
 */
const run = ( file, args ) =>
	execFileSync( file, args, { cwd: ROOT, encoding: 'utf8' } ).trim();

/**
 * Open one pull request for a group of proposals.
 *
 * @param {Object}  group        The group.
 * @param {Array}   group.items  Proposals.
 * @param {string}  group.branch Branch name.
 * @param {string}  group.title  PR title.
 * @param {string}  group.label  Label to apply.
 */
const propose = ( { items, branch, title, label } ) => {
	if ( 0 === items.length ) {
		return;
	}

	process.stdout.write( `\n=== ${ title } (${ items.length }) ===\n` );

	for ( const one of items ) {
		process.stdout.write( `  ${ one.op } ${ one.file } — ${ one.reasons.join( '; ' ) }\n` );
	}

	if ( dryRun ) {
		process.stdout.write( `  [dry run] would open ${ branch } labelled ${ label }\n` );

		return;
	}

	run( 'git', [ 'checkout', '-B', branch ] );

	for ( const one of items ) {
		apply( one );
	}

	// So the integrity check passes on the pull request. The tag is left
	// naming the last release, because this changes content and not releases.
	run( 'node', [ path.join( ROOT, 'pipeline', 'build-manifest.mjs' ) ] );

	run( 'git', [ 'add', '-A' ] );
	run( 'git', [ 'commit', '-m', title ] );
	run( 'git', [ 'push', '--force', 'origin', branch ] );

	const body = `${ summary( items ) }\n`;
	const bodyFile = path.join( ROOT, '.pr-body.md' );

	fs.writeFileSync( bodyFile, body );

	run( 'gh', [
		'pr', 'create',
		'--title', title,
		'--body-file', bodyFile,
		'--label', label,
		'--head', branch,
	] );

	fs.rmSync( bodyFile, { force: true } );

	if ( 'auto-merge' === label ) {
		// Asks GitHub to merge when CI is green. CI is what decides; this only
		// says "do not wait for a person".
		run( 'gh', [ 'pr', 'merge', '--auto', '--squash', branch ] );
	}
};

const stamp = new Date().toISOString().slice( 0, 10 );

if ( disagreements.length > 0 ) {
	process.stdout.write( '\nThe recorded direction and the recomputed one disagree:\n' );

	for ( const entry of disagreements ) {
		process.stdout.write(
			`  ${ entry.file }: recorded automatic=${ entry.recorded }, ` +
				`recomputed automatic=${ entry.recomputed } — taking the stricter\n`
		);
	}
}

if ( 0 === proposals.length ) {
	process.stdout.write( 'Nothing to propose. That is the common case and a correct one.\n' );
	process.exit( 0 );
}

propose( {
	items: safer,
	branch: `registry/auto-${ stamp }`,
	title: `registry: safer adjustments from the ${ stamp } run`,
	label: 'auto-merge',
} );

propose( {
	items: bolder,
	branch: `registry/review-${ stamp }`,
	title: `registry: proposals needing review from the ${ stamp } run`,
	label: 'needs-review',
} );

process.stdout.write(
	`\n${ safer.length } automatic, ${ bolder.length } for review` +
		`${ dryRun ? ' (dry run: nothing was written or pushed)' : '' }\n`
);
