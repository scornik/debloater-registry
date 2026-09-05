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

## How the plugin uses it

**The plugin ships its own copy.** Every release vendors a snapshot of this
repository, and that snapshot is what a site runs. Nothing here is fetched
during normal operation, and a site with no outbound access is not missing
anything.

Fetching a newer registry is optional, off by default, and reached only by
running a WP-CLI command. Downloaded registries are refused unless signed, and
signing is not yet enabled — until a key is published, the vendored snapshot is
the only registry any site will load.

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
