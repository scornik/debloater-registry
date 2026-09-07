# Debloater registry

The rules the [Debloater](https://wordpress.org/plugins/debloater/) plugin
reasons with: which changes exist, what each one touches, how risky it is, what
it conflicts with, and which plugins and hosts change the answer.

This repository is **data**. There is no code here that runs on a site.

## What is in here

| Path | What it holds |
|---|---|
| `tweaks/` | One document per change the plugin can make |
| `profiles/` | `safe`, `performance`, `maximum` — which tweaks each considers |
| `detectors/` | How to tell whether a plugin or theme is present |
| `compatibility/` | What a given plugin changes about a tweak's risk |
| `schemas/` | The JSON Schemas every document above is validated against |
| `manifest.json` | Every file, its hash, and the tag they were released as |
| `AUTHORING.md` | How to add or change a tweak, and what a review checks |
| `state/released.json` | The last signed release, so `main` says what it is |
| `docs/PIPELINE.md` | The automated proposal pipeline, and its limits |
| `docs/DECISIONS.md` | Decisions about this repository |

## How the plugin uses it

**The plugin ships its own copy.** Every release vendors a snapshot of this
repository, and that snapshot is what a site runs. Nothing here is fetched
during normal operation, and a site with no outbound access is not missing
anything.

Fetching a newer registry is optional, off by default, and reached only by
running a WP-CLI command. Downloaded registries are refused unless signed.

Releases are signed. `manifest.sig` is a detached Ed25519 signature over
`manifest.json`, made with a private key held offline; the public half is
compiled into the plugin. Verify it yourself with:

```
openssl pkeyutl -verify -rawin -pubin -inkey registry-signing.pub     -in manifest.json -sigfile manifest.sig
```

or `node tests/signature.mjs`, which needs nothing installed.

## What is released, and what is merged

**`main` carries content. A tag carries a signature.**

This repository accepts automated proposals (see `docs/PIPELINE.md`), and
nothing automated has a signing key. So `main` can be ahead of the last signed
release, and between releases its `manifest.json` is accurate but unsigned.

`state/released.json` says which release is the current one:

```
node -p "require('./state/released.json').tag"
```

**Sites are unaffected by any of this.** The plugin fetches
`<base>/<tag>/<path>` — a tag, never `main` — and a tag cannot be pushed without
a valid signature, which the release gate checks when it arrives. A site pointed
at `main` would be refused rather than served something unverified.

The reasoning, the fail-closed property and what it costs are in
`docs/DECISIONS.md` D-0067.

## Automated proposals

A scheduled pipeline watches WordPress and the plugins this registry has rules
about, scans a real site at the new versions, runs the plugin's compatibility
matrix, reads the support forums, and opens a pull request when it finds
something — with every proposal citing evidence a machine actually observed.

Proposals that are **strictly more cautious** than the current data — a raised
risk band, a new incompatibility — can merge themselves once CI is green.
Everything else waits for a person, and two things always do: a tweak's
`handler`, which names code in the plugin, and a profile's `include_risk`.

It signs nothing and releases nothing. `docs/PIPELINE.md` has every stage, what
it can see, and what it cannot.

## Versions

Releases are tagged, and `manifest.json` names the tag it was generated for.
`wp debloater status` reports the tag a site is carrying.

The current tag is **v0.1.0**, matching the snapshot vendored in Debloater
0.1.1.

## Contributing

Read [AUTHORING.md](AUTHORING.md) first — it sets out what a tweak document has
to say for itself, and the questions a review asks of it.

Two rules matter more than the rest:

1. **A tweak that cannot be undone does not belong here.** Every change carries
   a way back, and destructive operations are separate from profiles by design.
2. **Risk is a claim about somebody's site, not about tidiness.** If a change
   can break a checkout, it is not "safe" because it usually does not.

Run the checks before opening a pull request:

```
node tests/integrity.mjs
```

## License

GPL-2.0-or-later, the same as the plugin.
