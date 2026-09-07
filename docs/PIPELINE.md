# The registry update pipeline

A scheduled job that watches WordPress and the plugins Debloater has rules
about, observes what actually changes on a real site, and opens a pull request
proposing registry changes — with the evidence attached.

It can merge a change that is strictly more cautious than what is there now. It
cannot sign a release, and nothing it does reaches a site until somebody does.

---

## The one rule

**A stage that could not do its job fails. It never writes an empty artifact.**

"Nothing was found" and "nothing was looked at" produce the same file, and
everything downstream believes the first one. So:

| Situation | What happens |
|---|---|
| The scan returned no facts | fail — that is a broken scan, not a bare site |
| The matrix report is missing | fail — the matrix did not run; it did not pass |
| The matrix report has no testcases | fail |
| A named artifact does not exist | fail — something meant to produce it |
| No `ANTHROPIC_API_KEY` | fail — "the model suggested nothing" is a different sentence from "nobody asked it" |
| The model's reply is not JSON | fail |
| A support feed is unreachable | **warn** and continue — the run is still worth making on what the scanner found |
| A version API is unreachable | **warn**, still dispatch, and end the watcher red |

The last two are the only fail-open cases, and both are about a third party
being down rather than about this pipeline being unable to see.

---

## The stages

### 1. observe — what changed on a real site

Stands WordPress up at the new versions, runs `wp debloater scan --json` on a
clean install and on the seeded fixture, and diffs the FactSet against
`baselines/<stack>.json`.

**In:** the plugin, wp-env, `state/versions.json`, `baselines/`
**Out:** `candidates.json` — one entry per changed fact, each carrying the fact
key, its before and after, the versions in play and the stack.

A missing baseline is **recorded**, and the run emits zero candidates. Treating
it as an empty baseline would report every fact on the site as newly appeared —
seventy-odd candidates, all meaningless, and a model asked to find meaning in
them would find some. Comparison starts on the second run, which is the first
one with two things to compare.

Facts that move on their own — `scan.elapsed_ms`, `scan.scanner_ms`,
`assets.unavailable_reason` — are excluded. Otherwise the pipeline would file
the same non-observation every week for ever.

### 2. verify — does the existing registry still hold?

Runs the plugin's compatibility and probe matrix at the new versions and reads
the JUnit report.

**In:** the plugin, wp-env
**Out:** `regressions.json` — one entry per failure, naming the tweak and probe.

It reads a report rather than running the tests itself. The matrix belongs to
the plugin, which knows what a probe failing means; a second opinion here would
eventually be the wrong one.

A failure that cannot be attributed to a tweak is still recorded, under the
test's own name. A failure nobody can attribute is still a failure worth
putting in front of a person.

### 3. listen — what are people reporting?

Reads the wordpress.org support feeds for the watched plugins and for Debloater
itself, and keeps threads matching words that tend to mean something broke.

**Out:** `signals.json` — links, titles, dates, matched keywords, and an
excerpt capped at 300 characters.

The cap is applied at collection, so no later stage decides how much of
somebody's post to keep. These are people writing about their own sites who did
not agree to be quoted in a registry repository; a link goes to the post in its
own context, where its author can still edit or delete it.

**A signal is weak evidence and is treated that way.** A forum thread has no
versions, no reproduction and no way to check. It can support being *more*
careful — a raised risk band, a new incompatibility — because being cautious on
a rumour costs little. It cannot support a new tweak, and the direction
classifier enforces that by making every new tweak `bolder` regardless of what
it cites.

### 4. analyze — interpret, under supervision

Sends the schemas, `AUTHORING.md` and the three artifacts to a model and
requires JSON back.

**The model is the least trusted component here.** It is asked to interpret
observations and cannot know whether it is doing that or producing something
plausible. Four checks it has no say in:

1. **The reply must be JSON.** A markdown fence is tolerated; prose instead of
   JSON is refused.
2. **Every proposal cites evidence** the earlier stages actually produced. A
   proposal citing a fact nothing scanned is dropped, by name, in the report.
3. **Every document is schema-checked** before it can become a file.
4. **Direction is decided here, not there.** The reply may *claim*
   `direction: safer`; the classifier decides from the diff. The claim is kept
   as `claimed_direction` so a disagreement is visible, and is never used.

A proposal may only touch `tweaks/`, `compatibility/` and `profiles/`. It cannot
propose changes to a workflow, a test, or the manifest — that is, to its own
guards.

### 5. propose — write it down, decide who looks

**Out:** up to two pull requests.

| Direction | Means | Label | Merges |
|---|---|---|---|
| `safer` | fewer or gentler changes reach a site: raised risk, new `dont_touch`, added `requires`/`conflicts` | `auto-merge` | when CI is green |
| `bolder` | anything else: a new tweak, a lowered risk band, a removed rule | `needs-review` | when a person says so |

Two things are **never** automatic, whatever else is true:

- **`handler`** — it names PHP in the plugin. The registry cannot add code.
- **`include_risk`** — it changes what every tweak in a band means for everyone
  running that profile.

The brief asked for one pull request; it cannot be one, because a pull request
has a single merge behaviour. Mixing the two means either the reviewed change
merges itself or the safe change waits.

The direction is computed **twice** — once in analyze, once here, from the
documents on disk — and the stricter answer wins. Not from distrust of the
first pass, which is the same code, but of the artifact between them:
`proposals.json` travels between two jobs, and a file saying
`"automatic": true` would otherwise grant auto-merge to whoever can write it.

### 6. release — a draft, and only a draft

On a merge to `main`, checks the manifest still describes what is on disk and
updates one rolling draft release saying what is unreleased.

**Nothing in CI signs.** `make registry-release` is a person, at a machine
holding the offline key. See `DECISIONS.md` D-0067.

---

## Why this is safe to run unattended

Not because each stage is careful, though they are. Because of where the
private key is.

`main` carries content; a tag carries a signature. Sites fetch
`<base>/<tag>/<path>` — never `main` — and a tag cannot exist without a valid
signature, which cannot be made without a key that is on no runner.

So the worst outcome of every check here failing at once is that this
repository's `main` branch is wrong. No site has been offered it. Somebody with
the key would still have to look at a diff and decide to sign it.

`state/released.json` names the last signed tag, so anyone reading the
repository can tell what is released from what is merged and waiting.

---

## What it cannot see

Stated because a gap that is written down is a gap somebody can close, and a
gap that is not is a gap everybody assumes is covered.

**Three of the six things Phase 21 asked to watch are not in the FactSet.**
Admin notices, dashboard widgets and public REST routes are not recorded by
`wp debloater scan`. It reports flags and counts — `wp.emojis_enabled`,
`db.transients.count`, `cron.events.count` — not enumerations. Watching them
needs new facts in the plugin's scanner, which is a change to the plugin and
not to this repository.

The families that *do* exist are `wp`, `db`, `cron`, `assets`, `plugins`,
`theme`, `users`, `env`, `woo` and `elementor`, and they are asserted against a
committed real scan in `tests/pipeline.test.mjs`.

**Elementor Pro cannot be watched for releases.** It is commercial and not on
wordpress.org; the plugin-information API answers 404. Its updates are served
from Elementor's own endpoint, which needs a licence key the pipeline does not
have and should not hold. It is marked `watch: false` in `state/versions.json`
with that reason, so it is skipped deliberately rather than counted as up to
date. Changes to it are found only when somebody updates the fixture stack.

**Enqueued assets may be unavailable.** The scanner samples pages over HTTP,
and inside a container the site's own address can resolve to the container. When
that happens `assets.available` is `false` and the asset facts are missing
rather than wrong.

**The analyze stage has never run against the real API.** It is exercised by
`--fixture`, which is how the dry run reaches every check without a key or a
bill. The first real run will be the first time the prompt meets the model.

---

## Running it by hand

```bash
node pipeline/watch.mjs                    # is anything newer?
node pipeline/observe.mjs --stack=clean --facts=scan.json --out=candidates.json
node pipeline/verify.mjs  --junit=matrix.xml --out=regressions.json
node pipeline/listen.mjs  --out=signals.json --days=14
node pipeline/analyze.mjs --candidates=candidates.json \
    --regressions=regressions.json --signals=signals.json \
    --fixture=tests/fixtures/model-response.json --out=proposals.json
node pipeline/propose.mjs --proposals=proposals.json \
    --candidates=candidates.json --regressions=regressions.json \
    --signals=signals.json --dry-run
```

`--dry-run` runs every stage and opens nothing. The workflow takes the same
flag as a `workflow_dispatch` input.

---

## A convention worth keeping

**Anything that decides something lives in `pipeline/lib/` and imports without
consequences. Anything that reads arguments, touches the network or exits lives
in `pipeline/` and is only ever run. Tests import from `lib/`, never from a
stage.**

This was learned twice in one afternoon. A test imported `isNewer` from
`watch.mjs`, so the suite made live API calls on every run and would have gone
red on somebody else's outage. The same mistake was then made with the JUnit
parser, where importing the stage exited for want of an argument it was never
given.
