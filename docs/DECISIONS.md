# Decisions — Debloater registry

Decisions about **this repository**: the data, its manifest, its signature, and
the pipeline that proposes changes to it.

The numbering is one sequence shared across the three repositories, so that a
reference like `D-0059` means one thing wherever it is written. Decisions about
the plugin live in `scornik/debloater`; decisions about Pro live in
`scornik/debloater-pro`. This file starts at `D-0067` because the sixty-six
before it were taken elsewhere.

---

## Principles

Decisions that turned out to apply beyond what they were written about.

They are here because a numbered list is not something anybody reads
front-to-back. `D-0057` argued that an allow-list is safer than a deny-list,
and eighteen decisions later the same mistake was made two directories away, in
a repository that carries a copy of the decision. The reasoning was written
down and still not found. So the general half is lifted out, and the specific
half stays where it was.

**Read this section before implementing anything.** It is short on purpose. If
it grows past about a dozen entries it has stopped being read, and that is a
signal to consolidate rather than to append.

---

**P1. Allow-list what ships. Never deny-list.**
A deny-list ships what it forgets, and what it forgets is always something
nobody had written yet. Enumerate what belongs; refuse what is not on the list.
*From `D-0057` in `scornik/debloater`. Violated here, in `registryFiles()`,
and fixed in `67f3e6a` — the failure that produced this section.*

**P2. A skipped test is a failed test in CI.**
Skipping is a fair answer to "this machine cannot run that" and never a fair
answer in the one environment configured to run everything. The two are
indistinguishable in a green tick, so a suite that can skip needs a step that
fails when the skip count is not zero.
*From `D-0065` in `scornik/debloater-pro`.*

**P3. A check that has never passed in the runner is not coverage.**
Watch a new or repaired CI job go green at least once before counting it.
Passing locally is a different claim about a different machine, and a check
that cannot pass is indistinguishable from a check nobody wrote.
*From `D-0066` in `scornik/debloater`.*

**P4. Pin the literal that forms a contract, never the constant both sides
read.**
`assertSame( Thing::NAME . '=x', $url )` compares a constant with itself: rename
it and both halves rename together, so the test agrees with whatever it became
while the other component, still sending the old name, silently stops working.
Write the literal, and name who else depends on it.
*Not a numbered decision — `CLAUDE.md` in `scornik/debloater`, under Testing
conventions.*

**P5. When code encodes a vocabulary that lives somewhere else, test it against
the real artifact.**
Risk bands taken from a description instead of the schema; fact-key prefixes
taken from a brief instead of a scan. Both were wrong, both failed *safe*, and
both passed their tests because the tests used the same invented vocabulary.
Commit a real sample and assert against it.
*From this repository: `7d73490`, and the comments in
`pipeline/lib/direction.mjs` and `pipeline/lib/factdiff.mjs`. The risk bands and
the fact families were both invented, and both tested against the invention.*

**P6. When both defaults are wrong, refuse.**
Sometimes including by default is unsafe and excluding by default is unsafe in
a quieter way. Do neither: stop, name the thing, and make somebody decide. A
default is only defensible when one direction is harmless.
*From `67f3e6a` in this repository, extending `D-0057`.*

**P7. Code that decides something is importable; code that runs does not
decide.**
Anything with a judgement in it belongs where a test can import it without
consequences. Anything that reads arguments, touches the network or exits is a
script, and a test must never import one — twice in one afternoon a suite made
live API calls, or died for want of an argument, because it imported a stage.
*From `docs/PIPELINE.md`, "A convention worth keeping".*

---

## D-0067 – `main` carries content; a tag carries a signature

- **Phase:** 21
- **Date:** 2026-09-07
- **Status:** accepted
- **Spec:** `BUILD-SPEC.md` §17 Phase 17, §13 rule 9
- **Supersedes:** the release half of `D-0045`, which put the signature check on
  every push.

### What was true, and why it stopped working

`.github/workflows/registry.yml` ran two checks on every push and every pull
request:

1. **integrity** — every file is in `manifest.json` with its own hash;
2. **signature** — `manifest.json` is signed by the key the plugin pins.

Both were right for a repository that only a person edits. A human editing a
tweak regenerates the manifest and signs it in the same sitting, because they
have the offline key in front of them.

Phase 21 adds a pipeline that opens pull requests. It has no key, and it must
never have one. So every proposal it makes is caught in a contradiction:

- change `tweaks/foo.json` and leave the manifest alone → **integrity fails**,
  because the recorded hash is now wrong;
- regenerate the manifest → **signature fails**, because the committed signature
  was made over the previous bytes.

There is no third option available to something without the private key. The
pipeline as specified could not merge anything, ever — not because a guard
caught a bad change, but because the guards made every change impossible.

### The decision

**Integrity runs on every push and every pull request, unchanged.** The bot is
required to keep `manifest.json` consistent with the files it changes; a
proposal that edits a document without regenerating the manifest is red, exactly
as a person's would be.

**The signature is verified on tags.** A tag without a valid signature fails the
workflow and blocks the release.

So `main` is *content*, and a tag is a *release*. Between releases `main` may
carry a manifest that is accurate and unsigned.

### Why this is fail-closed

This does not weaken anything a site relies on, and the reason is specific
rather than general.

`Debloater\Update\RegistryOrigin::url()` builds every request as
`<base>/<tag>/<path>` — the tag is a required segment, validated before use.
**Sites fetch tags. Nothing fetches `main`.** A tag can only be created by
somebody holding the offline private key, because a tag without a valid
signature does not pass the release gate.

And if someone does point a site at the ref `main`, the outcome is a refusal
rather than an acceptance: `SignatureVerifier` has the public key pinned
(`c0504cbb…`), the fetch finds no valid signature over that manifest, and the
update is rejected. The failure mode of this change is "the update does not
happen", never "an unverified registry is installed".

### The gate has to be the gate

Moving the check makes the tag job the *only* thing standing between a bad
manifest and a release. It is therefore not skippable: no `continue-on-error`,
no condition that can silently evaluate false, and no path where a missing file
is treated as a pass. `tests/release-gate.test.mjs` asserts those properties of
the workflow itself, and the check is fail-probed — a tag pushed with a stale
signature must go red, and that has been demonstrated rather than assumed.

This is the lesson of the last two phases applied in advance: a check that
cannot fail is indistinguishable from a check nobody wrote, and the moment to
prove a gate works is when you move it, not the first time you need it.

### `main` says what it is

A repository where `main` is ahead of the last release has to say so, or the
next person reads `tweaks/` and assumes that is what sites are running.

`state/released.json` records the last signed tag, when it was made, and the
manifest hash it covers. `make registry-build` refreshes it, the pipeline
commits it with every proposal, and the README reads from it. Anyone can see at
a glance what is released and what is merged and waiting for a signature.

### What this costs

Three things, stated plainly.

1. **`main` can carry an unsigned manifest.** That is the point, but it means
   "the signature is valid" is no longer true of every commit — only of every
   tag.
2. **Anyone pointing a site at `main` gets refusals.** Fail-closed, and a real
   behaviour change for anyone who was doing that. Nothing documented ever told
   them to, and the plugin's own flow passes a tag.
3. **Releases need a person, every time.** That was already true and is now
   load-bearing: the pipeline can propose and merge, and it can never publish.

### Alternatives rejected

**Give CI a signing key.** It would make everything above unnecessary and it is
the one thing this project has consistently refused. A key on a runner in a
public repository is a key that can sign anything a workflow can be persuaded
to produce.

**Drop auto-merge; review everything.** Honest, and it was the fallback. It was
not chosen because the proposals that most want to be automatic are the strictly
safer ones — a new `dont_touch`, a raised risk band — and those are exactly the
changes where waiting a week for review leaves sites doing something the
registry already knows is unwise.

**Sign a throwaway key on `main` and the real key on tags.** Two keys, one of
which is worthless, and a verification step that passes for a signature nobody
should trust. It would turn a real check into a ceremony.
