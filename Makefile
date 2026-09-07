# Building and releasing the registry.
#
# Two targets matter and the difference between them is the whole security
# model of this repository:
#
#   make registry-build     regenerates manifest.json. Anyone can run it, CI
#                           runs it, the pipeline runs it. It signs nothing.
#
#   make registry-release   signs and tags. A person, at a machine holding the
#                           offline private key. Never CI, never the pipeline.
#
# docs/DECISIONS.md D-0067 explains why main carries content and a tag carries a
# signature. The short version: the pipeline opens pull requests and has no key,
# so requiring a signature on every push made every automated proposal
# impossible rather than merely reviewed.

NODE ?= node
TAG  ?=
KEY  ?= $(HOME)/.keys/debloater-registry-signing.key

.PHONY: help test registry-build registry-check registry-release

help:
	@echo "make test              every check that needs nothing installed"
	@echo "make registry-build    regenerate manifest.json (TAG=vX.Y.Z optional)"
	@echo "make registry-check    is the manifest still true of what is on disk?"
	@echo "make registry-release  sign and tag — needs the offline key"

# Everything, with no dependencies. That constraint is deliberate: a check that
# needs an install is a check that stops running the day the install breaks.
test:
	$(NODE) tests/integrity.mjs
	$(NODE) --test tests/pipeline.test.mjs tests/manifest.test.mjs \
		tests/release-gate.test.mjs tests/watch.test.mjs

# Regenerate the manifest so it describes what is on disk.
#
# Without TAG, the tag already in the manifest is kept — which is what the
# pipeline wants, because a proposal changes content and does not make a
# release. With TAG, the manifest is stamped for a release that is about to be
# signed.
registry-build:
	@$(NODE) pipeline/build-manifest.mjs $(if $(TAG),--tag=$(TAG),)

registry-check:
	@$(NODE) pipeline/build-manifest.mjs --check

# Sign and tag. The only target that touches the private key, and the only one
# that produces something a site will ever accept.
#
# The key is read from KEY and is expected to live outside this repository. It
# has never been in one and must not be: a key inside a public repository is a
# key that has already leaked, and a key on a runner is a key that can sign
# whatever a workflow can be persuaded to produce.
#
# `-rawin` is not optional. Ed25519 signs the message itself, and anything that
# pre-hashes produces a signature the plugin refuses.
registry-release:
ifndef TAG
	$(error Pass the tag: make registry-release TAG=v0.2.0)
endif
	@test -f "$(KEY)" || { \
		echo "No signing key at $(KEY)."; \
		echo "It is held offline and is not in this repository. Set KEY=<path>."; \
		exit 1; \
	}
	@echo "==> manifest for $(TAG)"
	@$(NODE) pipeline/build-manifest.mjs --tag=$(TAG)
	@echo "==> signing"
	@openssl pkeyutl -sign -inkey "$(KEY)" -rawin -in manifest.json -out manifest.sig
	@$(NODE) tests/signature.mjs
	@echo "==> recording what is released"
	@$(NODE) pipeline/build-manifest.mjs --released=$(TAG)
	@echo
	@echo "Signed $(TAG). Nothing has been pushed. To publish it:"
	@echo
	@echo "    git add manifest.json manifest.sig state/released.json"
	@echo "    git commit -m 'registry: $(TAG)'"
	@echo "    git tag -a $(TAG) -m 'Registry $(TAG)'"
	@echo "    git push --follow-tags"
	@echo
	@echo "The release gate verifies the signature, the tag and state/released.json"
	@echo "when that tag arrives. If any of them disagree, the tag is refused."
