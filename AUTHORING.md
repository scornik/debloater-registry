# REGISTRY.md

How to add or change something in `registry/`, and what has to be true before it
ships.

The registry is the only part of Debloater that decides *what the plugin
offers to do to a site*. The code decides how; the registry decides what. That
is why it is JSON with schemas and signatures rather than PHP, and why this
document is longer than the change you are probably about to make.

---

## What is in here

```
registry/
├── manifest.json          generated — every file with its SHA-256, and the tag
├── schemas/               the eight schemas everything else is validated against
├── tweaks/                one file per change Debloater can make
├── compatibility/         what a plugin or theme depends on
├── detectors/             how to tell a plugin or theme is present
├── profiles/              which changes each profile selects
├── plugin-categories.json a table: plugin slug → functional category
├── host-optimizers.json   a table: other tools that offer the same settings
└── admin-notices.json     a table: whose admin notices may be hidden
```

**Nothing here is executable, ever.** A tweak names a handler; the handler is a
PHP file that lives in the plugin, not in the registry. That separation is what
makes it safe to update the registry over the network at all, and it is not
negotiable.

---

## The rules a change has to satisfy

1. **It validates.** Every file is checked against its schema, and unknown keys
   are a failure rather than a warning.
2. **The filename is the id.** `tweaks/core.remove_rsd.json` has
   `"id": "core.remove_rsd"`. The loader asserts this.
3. **Every reference resolves.** A `requires` or `conflicts` naming a tweak that
   does not exist fails the load, not silently at runtime.
4. **The handler exists and declares `register()` and `unregister()`.** A tweak
   whose handler cannot be undone is a tweak that cannot be applied.
5. **Risk is honest.** `safe` means it cannot break the site — not that it is
   unlikely to. Anything that changes what a visitor sees, or what another
   plugin does, is at least `medium`.
6. **`breaks` says what actually breaks**, in the words of somebody who would be
   annoyed by it. "May affect some themes" is not an entry; "the cart total in
   your header will stop updating" is.
7. **`probes` name what must still work.** Every WooCommerce change lists
   `woo_cart`, `woo_checkout` and `woo_account`. A change nobody verifies is a
   change nobody should apply.

Run the whole set before opening a pull request:

```bash
npm run test:unit          # schemas, loader, references, invariants
npm run test:integration   # the change against a real WordPress
php tools/registry-manifest.php --check
```

---

## Adding a tweak

1. Write `runtime-handlers/<id-with-dashes>.php`. Read
   `core-remove-generator.php` first — it documents the rules every handler
   follows. The class name is derived from the tweak id: `admin.remove_welcome_panel`
   becomes `Debloater_Handler_Admin_Remove_Welcome_Panel`, and a test asserts it.
2. Write `registry/tweaks/<id>.json` against `schemas/tweak.schema.json`.
3. Add the id and its risk to the pinned lists in
   `tests/Unit/Registry/LoaderTest.php`. They are pinned deliberately: a new
   tweak should be a decision somebody made, not something that appeared.
4. If it is destructive, it also goes in the explicit destructive list, and no
   profile may admit it.
5. Regenerate the manifest: `php tools/registry-manifest.php --tag=<next tag>`.

---

## Reviewing a pull request

Copy this into the PR description and answer it. It is the checklist a reviewer
will use anyway.

```markdown
### What changes on a site that installs this?

<!-- In one sentence, as a person would notice it. -->

### Risk

- [ ] The risk level matches what this actually does
- [ ] `breaks` names the real consequence, not a hedge
- [ ] `probes` cover what would notice if this went wrong
- [ ] If it deletes anything: `destructive: true`, and no profile admits it

### Evidence

- [ ] The handler declares `register()` and `unregister()`, and unregister puts
      back everything register touched
- [ ] Tested against a real site, not only against a fixture
- [ ] `php tools/registry-manifest.php --check` passes
- [ ] The full suite passes

### Compatibility

- [ ] Anything that depends on what this removes has a compatibility rule
- [ ] Checked against the stack matrix: Woo, Elementor, CF7, Rank Math,
      LiteSpeed
```

---

## When WordPress releases a new version

Work through this before claiming support for it.

- [ ] Run the full matrix against the new version.
- [ ] Check every `since_wp` — a tweak whose hook core has removed must be
      retired, not left to fail quietly.
- [ ] Check for renamed option values. WordPress 6.6 changed the autoload column
      from `yes`/`no` to `on`/`off`; the plugin reads it through
      `wp_set_option_autoload()` for exactly this reason, and the next such
      change will look the same.
- [ ] Check the core-feature scanners still see what they claim to.
- [ ] Re-run the E2E suite: `npm run test:e2e`.
- [ ] Update `Tested up to` and cut a registry release.

---

## Releasing the registry

A release is a git tag plus a signed manifest.

```bash
php tools/registry-manifest.php --tag=v1.2.0
php tools/registry-manifest.php --tag=v1.2.0 --sign=/secure/path/ed25519.key
git tag v1.2.0 && git push --tags
```

**The signing key never enters this repository.** The tool refuses a key path
inside the working tree, a repository invariant refuses anything key-shaped in
the package, and the plugin carries only the public half.

The plugin verifies a release like this, and refuses at every step:

| Check | Refusal |
|---|---|
| Did the user ask? | No request at all unless they did |
| Is a public key pinned, and is libsodium present? | Refuse — never "skip the check" |
| Is the signature ours, over the *canonical* manifest? | Refuse |
| Is the manifest for this product, in a format we know? | Refuse |
| Is every path a plain relative `.json`? | Refuse |
| Does every file's SHA-256 match? | Refuse **the whole release** |
| Does every file parse as JSON? | Refuse |

There is no partial update. A registry half from one version and half from
another is a registry nobody tested.

---

## Splitting this into its own repository

The registry is laid out to move to `scornik/debloater-registry` unchanged:
`registry/` becomes the repository root, `manifest.json` sits beside the
directories, and `.github/workflows/registry.yml` in this repository is the CI
that repository needs.

**It has not been published.** Creating a public repository is an external act
that needs a person's decision and their credentials, so the layout and the
workflow are ready and the publishing is not done. Nothing in the plugin depends
on the split having happened: the vendored snapshot is the source of truth until
a signed release replaces it.
