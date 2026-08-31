# The commands you would otherwise retype. Not a build system: the Node half is
# pnpm from here, the Swift half is xcodebuild, and this only names them.
#
# Deliberately not a delegator like cadence-platform's — there is one Makefile
# here, not two, so there is nothing to forward to.

CONFIG  := Debug

# The embedded runtime. nodejs.org, not Homebrew: the official darwin builds are
# a single self-contained binary, Homebrew's needs libnode.dylib beside it.
NODE_VERSION ?= 24.18.0
# `arm64 x64` for a release; `arm64` alone builds far faster while iterating.
NODE_ARCHS   ?= arm64 x64
STAGED       := apps/apple/.build/staged
# The updater. Pinned exactly, and checksum-verified against the value in
# Sparkle's own Package.swift: the audit in scripts/audit-network.sh pardons a
# specific list of symbols in this framework, and a version that drifted under
# that allowance would be pardoned for something nobody measured.
SPARKLE_VERSION  ?= 2.9.6
SPARKLE_SHA256   := 8d5fb41d960b43f4a68aa14126bf62b098544ec8d191cdcc73eb14e63a8e7606
SPARKLE_VENDOR   := apps/apple/Vendor
SPARKLE_FRAMEWORK := $(SPARKLE_VENDOR)/Sparkle.framework
SPARKLE_TOOLS    := apps/apple/.build/sparkle-cache/bin
# The surfaces the app brokers. GENERATED from surfaces.json — run `make surfaces`
# after editing the manifest, never this line. `make surfaces-check` is what CI runs.
# <generated:surfaces> generated from surfaces.json by `make surfaces` — do not edit by hand
SURFACES     := mail notes reminders calendar contacts messages safari maps
# </generated:surfaces>
# Extra build settings forwarded to xcodebuild. CI sets MARKETING_VERSION from
# the `app-v*` tag so the shipped version is the tag rather than the pbxproj
# default, which nothing bumps. Empty locally, where VERSION_ARGS stands in.
# Command-line variables propagate to the sub-makes `build-release` runs.
XCARGS       ?=
# What a local build calls itself, from the same two facts CI derives it from:
# the nearest `app-v*` tag and the commit count. Without this a `make install`
# app inherited the pbxproj default and sat in /Applications calling itself 1.0
# — two minors behind what shipped, which is confusing on its own, and below the
# appcast's build number, so Sparkle offered a developer their own build as an
# update and would have quietly replaced it with the release.
# Empty outside a git checkout, or in a clone fetched without tags, and there
# the pbxproj default stands — the same fallback GIT_COMMIT takes below, and for
# the same reason: a release tarball is still buildable.
APP_VERSION  := $(shell git describe --tags --match 'app-v*' --abbrev=0 2>/dev/null | sed 's/^app-v//')
APP_BUILD    := $(shell git rev-list --count HEAD 2>/dev/null)
# Emitted only when XCARGS does not already carry the setting. CI passes both
# from the tag and `bundle` forwards that string to this same xcodebuild, so
# emitting them unconditionally would put each setting on the command line twice
# and leave the shipped version to whichever duplicate xcodebuild honours — a
# coin flip that only ever lands on a tag push, where it is too late to notice.
# Standing aside keeps the release path byte-identical to what it was.
VERSION_ARGS := $(if $(findstring MARKETING_VERSION,$(XCARGS)),,$(if $(APP_VERSION),MARKETING_VERSION=$(APP_VERSION)))
VERSION_ARGS += $(if $(findstring CURRENT_PROJECT_VERSION,$(XCARGS)),,$(if $(APP_BUILD),CURRENT_PROJECT_VERSION=$(APP_BUILD)))
# The commit a build came from, for the About line. `--dirty` because a hash
# that does not describe the code that actually ran is worse than no hash: it
# points a bug report at a diff nobody can reproduce. Empty outside a git
# checkout rather than failing — a release tarball is still buildable.
# `diff --quiet HEAD`, not `diff --quiet`: the bare form compares the worktree to
# the index, so anything already `git add`-ed reads as clean and a staged-but-
# uncommitted build would claim a hash that does not describe it. Untracked files
# are deliberately not counted — marketing drafts and scratch files would mark
# every developer build dirty, and a marker that is always on says nothing.
GIT_COMMIT   := $(shell git rev-parse --short HEAD 2>/dev/null)$(shell git diff --quiet HEAD 2>/dev/null || echo -dirty)
APP     ?= apps/apple/.build/Build/Products/$(CONFIG)/Cupertino.app
INSTALLED := /Applications/Cupertino.app
BRIDGE  := $(APP)/Contents/Helpers/cupertino-bridge
# A Debug build carries its own bundle identifier so it can hold its own Full
# Disk Access grant — see BridgeProtocol.appIdentifier. Its socket and dev.json
# live beside it, so this must follow CONFIG.
BUNDLE_ID := io.mgcrea.cupertino$(if $(filter Debug,$(CONFIG)),.debug,)
SUPPORT := $(HOME)/Library/Application Support/$(BUNDLE_ID)

.DEFAULT_GOAL := help

help: ## Show this help
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-21s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  servers: pnpm -r build | test | typecheck, pnpm lint | format"
	@echo ""

build: ## Build both halves: the npm servers and the app (Debug)
	@pnpm -r build
	@$(MAKE) --no-print-directory app

# The `|| true` belongs to grep, not to the pipeline: grep exits 1 on a clean
# build with nothing to report, and swallowing that must not also swallow
# xcodebuild's own failure. Without pipefail plus the inner braces, a failed
# Release build reaches `bundle`, which then fails at `ditto` with a missing-path
# error that says nothing about what actually broke.
app: sparkle ## Build Cupertino.app (Debug; Release needs the bundled servers)
	@set -o pipefail; xcodebuild -project apps/apple/Cupertino.xcodeproj -scheme Cupertino \
		-configuration $(CONFIG) -derivedDataPath apps/apple/.build \
		CUPERTINO_GIT_COMMIT=$(GIT_COMMIT) $(VERSION_ARGS) $(XCARGS) build \
		| { grep -E 'error:|BUILD (SUCCEEDED|FAILED)' || true; }
	@# A Debug build ships no Safari extension, and that is the honest state
	@# rather than a shortcut. Safari refuses to list an extension whose container
	@# app is not notarized AND stapled — measured, silently, in docs/safari.md —
	@# so a Debug appex can never be enabled or exercised. What it CAN do is
	@# register itself: LaunchServices picks it up, and a second "Cupertino"
	@# appears in Safari's Extensions pane beside the installed one with nothing
	@# to say which is live. Three of them turned up during development.
	@#
	@# Renaming it was tried first and cannot work here: Safari shows
	@# manifest.json's `name`, one file shared by both configurations, and a build
	@# phase cannot rewrite it because the Resources phase already produces that
	@# path ("Multiple commands produce"). Scoping ENABLE_USER_SCRIPT_SANDBOXING
	@# off to get around that would trade a project-wide hardening for a string.
	@#
	@# Extension work therefore goes through `make build-release`, which is what
	@# Safari requires of it anyway.
	@if [ "$(CONFIG)" = "Debug" ]; then \
		rm -rf "$(APP)/Contents/PlugIns/CupertinoSafariExtension.appex"; \
		rmdir "$(APP)/Contents/PlugIns" 2>/dev/null || true; \
	fi

run: app dev-config ## Build, then (re)launch the menu bar app
	@pkill -f 'Cupertino.app/Contents/MacOS/Cupertino' 2>/dev/null || true
	@sleep 1 && open "$(APP)"
	@echo "Cupertino running — look for the tray icon in the menu bar."

# `dev-config` is a prerequisite, not a nicety. A Debug app has no staged
# servers, so it resolves them through dev.json — and dev.json holds an
# absolute path to this checkout. Moving or renaming the repo therefore breaks
# the copy in /Applications, which answers to a path that no longer exists:
# every new connection is refused with "no build at …" while sessions started
# before the move keep working, so it presents as a client that mysteriously
# stopped connecting. Rewriting it on every install keeps the two in step.
# A Release bundle does not have this problem; it carries its own servers.
install: app dev-config ## Install the Debug build to /Applications (development)
	@$(MAKE) --no-print-directory install-from SRC="$(APP)"

# The whole release path in one command. Written as sequential sub-makes rather
# than `build-release: bundle notarize`, because prerequisites may run in
# parallel under -j and notarizing a bundle that is still being signed would
# staple a ticket to a cdhash that is about to change.
build-release: ## Build, sign and notarize a shippable Cupertino.app
	@$(MAKE) --no-print-directory bundle
	@$(MAKE) --no-print-directory notarize

# Deliberately NOT `install-release: bundle`. `bundle` re-signs, and re-signing
# changes the cdhash the stapled notarization ticket is bound to — so depending
# on it silently un-notarizes the very thing being installed. The order is
# bundle -> notarize -> install, and this target is only the last step.
install-release: ## Install the notarized Release build (run build-release first)
	@xcrun stapler validate "$(RELEASE_APP)" >/dev/null 2>&1 \
		|| { echo "$(RELEASE_APP) is not stapled — run 'make build-release' first"; exit 1; }
	@$(MAKE) --no-print-directory install-from SRC="$(RELEASE_APP)"

# Not in help: an implementation detail of the two targets above.
# `install CONFIG=Release` used to look like it would do the right thing and
# quietly installed a Release app with no Resources/servers and no node, because
# staging happens in `bundle`, not in `app`.
install-from:
	@test -d "$(SRC)" || { echo "no app at $(SRC) — run 'make bundle' first"; exit 1; }
	@if [ -d "$(INSTALLED)" ]; then \
		id=$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$(INSTALLED)/Contents/Info.plist" 2>/dev/null); \
		if [ "$$id" != "io.mgcrea.cupertino" ]; then \
			echo "refusing to replace $(INSTALLED): its identifier is '$$id', not io.mgcrea.cupertino"; exit 1; \
		fi; \
	fi
	@pkill -f 'Cupertino.app/Contents/MacOS/Cupertino' 2>/dev/null || true
	@sleep 1
	@rm -rf "$(INSTALLED)"
	@ditto "$(SRC)" "$(INSTALLED)"
	@open "$(INSTALLED)"
	@echo "installed  $(INSTALLED)"
	@echo "bridge     $(INSTALLED)/Contents/Helpers/cupertino-bridge"
	@spctl -a -t exec "$(INSTALLED)" >/dev/null 2>&1 \
		&& echo "gatekeeper accepted (notarized)" \
		|| echo "NOT notarized — fine locally, but this copy will not run on another Mac"
	@echo ""
	@echo "Grant Full Disk Access to this copy if you have not already. The grant"
	@echo "follows the code signature rather than the path, so it survives moves and"
	@echo "reinstalls — what breaks on a move is the bridge path written into MCP"
	@echo "client configs, which is why /Applications is the right home."
	@echo ""
	@# Functional, not structural. Checking for Resources/servers would only catch
	@# the shapes of breakage anyone thought to look for; actually starting a
	@# server catches an install that cannot serve, whatever the reason.
	@sleep 2
	@for s in $(SURFACES); do \
		printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install","version":"0"}}}' \
			| "$(INSTALLED)/Contents/Helpers/cupertino-bridge" --server=$$s 2>/dev/null \
			| grep -q '"serverInfo"' && echo "  serves $$s" \
			|| { echo "  FAILED to serve $$s — this install cannot run a server"; exit 1; }; \
	done

uninstall: ## Remove the installed copy
	@pkill -f 'Cupertino.app/Contents/MacOS/Cupertino' 2>/dev/null || true
	@rm -rf "$(INSTALLED)"
	@echo "removed $(INSTALLED)"

stop: ## Quit the app and remove its socket
	@pkill -f 'Cupertino.app/Contents/MacOS/Cupertino' 2>/dev/null || true
	@rm -f "$(SUPPORT)/cupertino.sock"

dev-config: ## Point the Debug app at packages/*/dist instead of bundled servers
	@mkdir -p "$(SUPPORT)"
	@printf '{ "node": "%s", "repo": "%s" }\n' "$$(command -v node)" "$(CURDIR)" \
		> "$(SUPPORT)/dev.json"

smoke: ## Handshake both servers through the bridge, as CI does directly
	@for s in $(SURFACES); do \
		printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"make","version":"0"}}}' \
			| "$(BRIDGE)" --server=$$s 2>/dev/null | grep -q '"serverInfo"' \
			&& echo "  ok   $$s" || { echo "  FAIL $$s"; exit 1; }; \
	done

wiring-check: ## Assert the config merge leaves other people's files alone
	@mkdir -p apps/apple/.build
	@swiftc -O -o apps/apple/.build/wiring-check \
		apps/apple/Cupertino/ClientWiringMerge.swift scripts/wiring-check.swift
	@apps/apple/.build/wiring-check

audit: app ## Assert the built app cannot reach the network
	@scripts/audit-network.sh "$(APP)"

# Run this after a refund, then commit the diff. It is a source change like any
# other, deliberately: the app cannot consult a list at run time — it makes no
# network connections at all — so revocation is something a BUILD carries. A
# refunded key keeps working until the next release and then stops, which is
# what EULA §4(a) tells the buyer.
revocations: ## Rewrite the baked-in revocation list from D1
	@node scripts/generate-revocations.mjs

# The workspace packages the server bundles inline. NOT an optimisation, and not
# something a previous command can be assumed to have done: `@mgcrea/mcp-apple-core`
# resolves through its package.json `exports` to `./dist/index.js`, so an unbuilt
# core is not a missing file to rolldown — it is an unresolvable specifier, which
# rolldown externalises with a warning and a zero exit. The bare import then lands
# in a bundle that has no node_modules to satisfy it.
#
# That is exactly how 1.0.0, 1.1.0 and 1.2.0 all shipped seven servers that died
# on their first line: the release job installs and goes straight to the app,
# never building the workspace, so core's `dist/` was never there. It passed
# locally only because a previous `make build` had left one behind.
#
# `./packages/**` rather than `-r`: the website is a workspace member too, and
# building it here would drag in LFS-tracked images for no reason.
server-deps: ## Build the workspace packages the server bundles inline
	@pnpm --filter "./packages/**" build

servers: server-deps ## Bundle the MCP servers self-contained (no node_modules at runtime)
	@pnpm exec tsdown --config apps/apple/tsdown.servers.config.ts -l warn
	@for s in $(SURFACES); do \
		python3 -c "import json;src=json.load(open('packages/$$s/package.json'));json.dump({'name':src['name'],'version':src['version'],'type':'module','private':True},open('$(STAGED)/servers/$$s/package.json','w'),indent=2)"; \
	done
	@echo "  staged $$(find $(STAGED)/servers -name '*.js' | wc -l | tr -d ' ') server files"
	@# Static half only: `make servers` has no reason to depend on `make node`,
	@# and the import check is what would have caught all three broken releases.
	@# The smoke test runs in `bundle`, against the artifact that actually ships.
	@scripts/verify-servers.sh $(STAGED) --static-only

verify-extension: ## Assert the built artifact's Safari extension is shippable
	@scripts/verify-extension.sh "$(or $(APP_PATH),$(RELEASE_APP))"

verify-servers: ## Assert a built artifact's servers resolve and start
	@scripts/verify-servers.sh $(or $(APP_PATH),$(RELEASE_APP))

# Vendored rather than resolved through SPM. Sparkle ships its SPM product as a
# binaryTarget that points at this same zip, so the bytes are identical either
# way — but a plain `xcodebuild` can consume a framework on disk without a
# package graph, which keeps `make app` working the way `make node` already does
# and leaves one pinned-and-checksummed download rather than two mechanisms.
sparkle: ## Download and stage the pinned Sparkle.framework
	@mkdir -p apps/apple/.build/sparkle-cache $(SPARKLE_VENDOR)
	@zip="apps/apple/.build/sparkle-cache/Sparkle-$(SPARKLE_VERSION).zip"; \
	[ -f "$$zip" ] || curl -fsSL -o "$$zip" \
		"https://github.com/sparkle-project/Sparkle/releases/download/$(SPARKLE_VERSION)/Sparkle-for-Swift-Package-Manager.zip"; \
	echo "$(SPARKLE_SHA256)  $$zip" | shasum -a 256 -c - >/dev/null \
		|| { echo "  Sparkle checksum mismatch — refusing to build against it"; rm -f "$$zip"; exit 1; }; \
	rm -rf apps/apple/.build/sparkle-cache/unpacked; \
	unzip -qo "$$zip" -d apps/apple/.build/sparkle-cache/unpacked
	@rm -rf $(SPARKLE_FRAMEWORK)
	@ditto apps/apple/.build/sparkle-cache/unpacked/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework \
		$(SPARKLE_FRAMEWORK)
	@mkdir -p $(SPARKLE_TOOLS)
	@ditto apps/apple/.build/sparkle-cache/unpacked/bin $(SPARKLE_TOOLS)
	@# Sandbox-only, and this app is not sandboxed. Stripped here rather than at
	@# bundle time so a Debug build audits identically to a Release one — each is
	@# another Mach-O that scripts/audit-network.sh would otherwise have to pardon.
	@rm -rf $(SPARKLE_FRAMEWORK)/Versions/B/XPCServices
	@echo "  Sparkle $(SPARKLE_VERSION) staged: $(SPARKLE_FRAMEWORK)"

node: ## Download and lipo the embedded node runtime
	@mkdir -p $(STAGED) apps/apple/.build/node-cache
	@for arch in $(NODE_ARCHS); do \
		tar="apps/apple/.build/node-cache/node-v$(NODE_VERSION)-darwin-$$arch.tar.gz"; \
		[ -f "$$tar" ] || curl -fsSL -o "$$tar" \
			"https://nodejs.org/dist/v$(NODE_VERSION)/node-v$(NODE_VERSION)-darwin-$$arch.tar.gz"; \
		tar -xzf "$$tar" -C apps/apple/.build/node-cache \
			"node-v$(NODE_VERSION)-darwin-$$arch/bin/node"; \
	done
	@slices=""; for arch in $(NODE_ARCHS); do \
		slices="$$slices apps/apple/.build/node-cache/node-v$(NODE_VERSION)-darwin-$$arch/bin/node"; done; \
		lipo -create $$slices -output $(STAGED)/node
	@lipo -info $(STAGED)/node | sed 's/^/  /'

RELEASE_APP := apps/apple/.build/Build/Products/Release/Cupertino.app
RELEASE_SPARKLE := $(RELEASE_APP)/Contents/Frameworks/Sparkle.framework
# Signed at the .appex, never at its inner Mach-O — the same rule as the
# framework above. `bundle` builds with CODE_SIGNING_ALLOWED=NO, so Xcode's
# CodeSignOnCopy never fires in the release path and this line is the only thing
# that signs it. Without it the appex ships unsigned, `codesign --verify --deep`
# fails, and notarization refuses the archive.
RELEASE_EXTENSION := $(RELEASE_APP)/Contents/PlugIns/CupertinoSafariExtension.appex
TEAM_ID     := 75QE9PRT3V

# `sign` below is what gives the Release bundle its Developer ID signature, so
# letting xcodebuild sign first is redundant — and on a CI runner it is fatal:
# automatic signing demands a "Mac Development" certificate for the team, which
# a release machine has no reason to hold. It passes on a developer Mac only
# because an Apple Development certificate happens to be in the keychain, so the
# break shows up for the first time in CI. Debug keeps automatic signing, which
# the TCC identity of a locally installed build depends on.
bundle: servers node ## Build, stage and sign a Release Cupertino.app
	@$(MAKE) --no-print-directory app CONFIG=Release \
		XCARGS="$(XCARGS) CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO"
	@rm -rf "$(RELEASE_APP)/Contents/Resources/servers" "$(RELEASE_APP)/Contents/Resources/node"
	@ditto "$(STAGED)/servers" "$(RELEASE_APP)/Contents/Resources/servers"
	@ditto "$(STAGED)/node" "$(RELEASE_APP)/Contents/Resources/node"
	@install -m 644 apps/apple/EULA "$(RELEASE_APP)/Contents/Resources/EULA.txt"
	@# Before signing, not after: a signature over a bundle whose servers cannot
	@# start is precisely what shipped three times, and it is worth nothing. The
	@# smoke test runs here because this is the first point at which the servers
	@# and the runtime they will actually be spawned under sit side by side.
	@scripts/verify-servers.sh "$(RELEASE_APP)"
	@$(MAKE) --no-print-directory sign
	@scripts/verify-extension.sh "$(RELEASE_APP)"

# Inner-out, and never in the other order: signing the bundle first and then
# touching anything inside it invalidates the outer signature.
#
# Sparkle needs the same treatment one level down: `Updater.app` and `Autoupdate`
# are separate signable units that codesign does not reach by being pointed at
# the framework, and sealing the framework before them invalidates that seal the
# moment they are touched. Signed at `Sparkle.framework`, never at `Versions/B` —
# codesign understands versioned bundles, and signing the version directory
# leaves the outer symlink structure unsealed.
#
# --deep is not an option here and never was: it re-signs nested code with the
# OUTER identity and options and drops nested designated requirements, which is
# precisely what this enumeration exists to avoid. Apple documents it as
# unsuitable for signing. `codesign --verify --deep` below is a different verb.
sign: ## Sign the Release bundle (Developer ID if present, else Apple Development)
	@id=$$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $$2; exit}'); \
	if [ -z "$$id" ]; then \
		id=$$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $$2; exit}'); \
		echo "  !! no Developer ID Application certificate — signing with Apple Development."; \
		echo "     This build will NOT notarize and will not run on another Mac."; \
	fi; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		"$(RELEASE_SPARKLE)/Versions/B/Updater.app"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		"$(RELEASE_SPARKLE)/Versions/B/Autoupdate"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		"$(RELEASE_SPARKLE)"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		--entitlements apps/apple/node.entitlements "$(RELEASE_APP)/Contents/Resources/node"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		"$(RELEASE_APP)/Contents/Helpers/cupertino-bridge"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		--entitlements apps/apple/SafariExtension.entitlements "$(RELEASE_EXTENSION)"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		--entitlements apps/apple/Cupertino.entitlements "$(RELEASE_APP)"
	@codesign --verify --deep --strict --verbose=1 "$(RELEASE_APP)" 2>&1 | sed 's/^/  /'
	@# The hardened runtime is on and nothing disables library validation, so a
	@# Sparkle signed by another team fails at dlopen — at launch, on a user's
	@# Mac, long after this. Assert the team here, where the message is readable.
	@codesign -dv --verbose=2 "$(RELEASE_SPARKLE)" 2>&1 | grep -q 'TeamIdentifier=$(TEAM_ID)' \
		|| { echo "  Sparkle is not signed by $(TEAM_ID) — library validation will reject it"; exit 1; }
	@echo "  size: $$(du -sh "$(RELEASE_APP)" | cut -f1)"

# Run once, ever. The private key goes into the login keychain and the public
# key into apps/apple/Cupertino-Info.plist, where it is committed.
#
# That private key is the most dangerous secret this project has: together with
# the Developer ID certificate it is enough to hand every user a new version of
# an app that holds Full Disk Access, with one click and no further question.
# It belongs in the keychain and in one repository secret, never in an org-wide
# one and never anywhere a pull_request workflow can read it. See
# docs/succession.md.
sparkle-keys: sparkle ## Generate the EdDSA update-signing keypair (once, ever)
	@$(SPARKLE_TOOLS)/generate_keys
	@echo ""
	@echo "  Then run 'make sparkle-key-shred' — an exported key left in the working"
	@echo "  tree is one 'git add -A' from being committed."
	@echo ""
	@echo "  Put the public key above into apps/apple/Cupertino-Info.plist (SUPublicEDKey),"
	@echo "  and export the private key for CI with:"
	@echo ""
	@echo "    $(SPARKLE_TOOLS)/generate_keys -x sparkle_key.pem   # -x EXPORTS; without it you get a NEW key"
	@echo "    gh secret set SPARKLE_ED_PRIVATE_KEY < sparkle_key.pem"
	@echo ""

# Not `rm -P`: that flag is BSD-only, and a Mac with Homebrew's coreutils ahead
# of /bin on PATH gets GNU rm, which errors on it. Chained after `gh secret set`
# with &&, that error leaves the private key sitting in the working tree — the
# one command whose whole job was to remove it, failing silently enough that the
# file is still there afterwards. Overwrite first, then unlink by absolute path.
sparkle-key-shred: ## Overwrite and remove an exported sparkle_key.pem
	@# One shell, not four: each @-line is its own process, so an early `exit 0`
	@# in the guard would still be followed by a `wc` against a file that is not
	@# there — the target failing precisely when it had nothing to do.
	@if [ ! -f sparkle_key.pem ]; then \
		echo "  no sparkle_key.pem here — nothing to shred"; \
	else \
		dd if=/dev/urandom of=sparkle_key.pem bs=$$(wc -c < sparkle_key.pem) count=1 \
			conv=notrunc 2>/dev/null; \
		/bin/rm -f sparkle_key.pem; \
		echo "  sparkle_key.pem overwritten and removed — the keychain copy is untouched"; \
	fi

# Signed against the STAPLED zip, which is why this is not folded into
# `notarize`: that target re-creates Cupertino.zip after stapling, so a signature
# made any earlier would be a valid EdDSA signature over an artifact that has no
# ticket — and every first launch would hit Gatekeeper with the signature saying
# nothing is wrong. Run after `notarize`, so the published .sha256 and the
# edSignature describe the same bytes.
appcast: ## Sign the release zip and write a one-item appcast
	@test -f apps/apple/.build/Cupertino.zip \
		|| { echo "no apps/apple/.build/Cupertino.zip — run 'make notarize' first" >&2; exit 1; }
	@test -x $(SPARKLE_TOOLS)/sign_update || $(MAKE) --no-print-directory sparkle
	@set -e; \
	if [ -n "$$SPARKLE_ED_PRIVATE_KEY" ]; then \
		: "# CI. The key reaches sign_update through a file, never argv: a private"; \
		: "# key on a command line is readable by every process via ps."; \
		umask 077; printf '%s' "$$SPARKLE_ED_PRIVATE_KEY" > apps/apple/.build/sparkle.key; \
		sig=$$($(SPARKLE_TOOLS)/sign_update --ed-key-file apps/apple/.build/sparkle.key \
			apps/apple/.build/Cupertino.zip); \
		rm -f apps/apple/.build/sparkle.key; \
	else \
		: "# A developer's Mac, where generate_keys put the key in the keychain."; \
		: "# Same signature either way, so the feed can be produced and read"; \
		: "# locally without exporting the private key to do it."; \
		sig=$$($(SPARKLE_TOOLS)/sign_update apps/apple/.build/Cupertino.zip); \
	fi; \
	version=$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
		"$(RELEASE_APP)/Contents/Info.plist"); \
	build=$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
		"$(RELEASE_APP)/Contents/Info.plist"); \
	notes=$$(sed -n "/^## \[$$version\]/,/^## \[/p" CHANGELOG.md | sed '1d;$$d'); \
	: "# An empty description is not a cosmetic problem: it is the release notes"; \
	: "# a user reads inside the update dialog before agreeing to replace an app"; \
	: "# that holds Full Disk Access. Silently shipping nothing there because a"; \
	: "# heading did not match — '## [1.1]' against '## [1.1.0]' — is exactly the"; \
	: "# quiet pass the audit script's own counters exist to stop."; \
	printf '%s' "$$notes" | grep -q '[^[:space:]]' \
		|| { echo "no CHANGELOG.md section '## [$$version]' — the update dialog would show nothing" >&2; \
		     rm -f apps/apple/.build/sparkle.key; exit 1; }; \
	printf '%s\n' \
	'<?xml version="1.0" encoding="utf-8"?>' \
	'<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">' \
	'  <channel>' \
	'    <title>Cupertino</title>' \
	'    <link>https://cupertino.mgcrea.io/appcast.xml</link>' \
	'    <item>' \
	"      <title>Cupertino $$version</title>" \
	"      <pubDate>$$(date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>" \
	"      <sparkle:version>$$build</sparkle:version>" \
	"      <sparkle:shortVersionString>$$version</sparkle:shortVersionString>" \
	'      <sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>' \
	"      <description><![CDATA[$$notes]]></description>" \
	"      <enclosure url=\"https://github.com/mgcrea/cupertino/releases/download/app-v$$version/Cupertino.zip\"" \
	"        type=\"application/octet-stream\" $$sig/>" \
	'    </item>' \
	'  </channel>' \
	'</rss>' \
	> apps/apple/.build/appcast.xml
	@xmllint --noout apps/apple/.build/appcast.xml 2>/dev/null || true
	@echo "  appcast: apps/apple/.build/appcast.xml"

notarize: ## Submit the signed bundle to Apple and staple the ticket
	@test -n "$$AC_KEY_ID" || { echo "set AC_KEY_ID, AC_ISSUER_ID and AC_KEY_PATH first" >&2; exit 1; }
	@ditto -c -k --keepParent "$(RELEASE_APP)" apps/apple/.build/Cupertino.zip
	@xcrun notarytool submit apps/apple/.build/Cupertino.zip --wait \
		--key "$$AC_KEY_PATH" --key-id "$$AC_KEY_ID" --issuer "$$AC_ISSUER_ID"
	@xcrun stapler staple "$(RELEASE_APP)"
	@ditto -c -k --keepParent "$(RELEASE_APP)" apps/apple/.build/Cupertino.zip
	@echo "  stapled: apps/apple/.build/Cupertino.zip"

# The icon is generated, never hand-drawn: one mark, three renderings. The plate
# lives in the flags rather than the artwork so the .icon layers stay separable.
ICON_MARK   := design/cupertino-mark.svg
# '#' opens a comment in a Makefile, so the hexes are spelled through a variable.
HASH        := \#
ICON_SKY     = $(HASH)FFD08A,$(HASH)F2895C
ICON_RADIUS := 230
ICON_MENUBAR := design/cupertino-menubar.svg

surfaces: ## Regenerate every copy of the surface list from surfaces.json
	@node scripts/generate-surfaces.mjs

surfaces-check: ## Fail if any generated copy has drifted from surfaces.json
	@node scripts/generate-surfaces.mjs --check

version: ## Propagate the root package.json version into every copy of it
	@node scripts/generate-version.mjs

version-check: ## Fail if any copy of the version has drifted from package.json
	@node scripts/generate-version.mjs --check

icon: ## Regenerate Cupertino.icon and the web SVG from design/cupertino-mark.svg
	@appshot icon build --from $(ICON_MARK) \
		--plate-gradient '$(ICON_SKY)' --plate-angle 90 --mark-fraction 1.0 \
		--out apps/apple/Cupertino/Cupertino.icon
	@appshot icon build --from $(ICON_MARK) \
		--plate-gradient '$(ICON_SKY)' --plate-angle 90 --mark-fraction 1.0 \
		--corner-radius $(ICON_RADIUS) --label 'Cupertino' \
		--out design/cupertino-icon.svg
	@# The mark bleeds past the plate's corner radius by design, and nothing masks
	@# an SVG on a web page — so the vector needs the clip the OS applies for free.
	@# perl, not `sed -i`: the flag's in-place syntax differs between BSD and GNU sed
	@# and Homebrew's gnu-sed shadows the system one on some of these machines.
	@perl -pi \
		-e 's|</defs>|<clipPath id="c"><rect width="1024" height="1024" rx="$(ICON_RADIUS)"/></clipPath></defs>|;' \
		-e 's|<g transform=|<g clip-path="url($(HASH)c)" transform=|;' \
		design/cupertino-icon.svg
	@# The README banner is composed from the icon above, never drawn beside it.
	@# The lockup that lived in the design canvas was hand-drawn, and its hills
	@# stopped matching the mark two revisions before anyone noticed.
	@node scripts/generate-lockup.mjs
	@appshot icon check --out apps/apple/Cupertino/Cupertino.icon
	@# The menu bar glyph is authored, not composed — but the imageset needs the
	@# file *inside* it, so design/ stays the one copy anyone edits.
	@cp $(ICON_MENUBAR) apps/apple/Cupertino/Assets.xcassets/MenuBarIcon.imageset/
	@echo "  copied $(notdir $(ICON_MENUBAR)) into MenuBarIcon.imageset"
	@# The Safari extension shows an icon in Safari's Extensions pane, in the
	@# toolbar and in every per-site permission prompt — so it is the mark a user
	@# is asked to trust with a page's contents, and it must be the app's rather
	@# than Xcode's placeholder. Rendered from the same mark and the same plate
	@# as the icon above, never copied from a derived file: web extensions want
	@# plain PNGs, and .appiconset is the one format appshot emits them in.
	@$(MAKE) --no-print-directory extension-icons

extension-icons: ## Render the Safari extension's PNGs from design/cupertino-mark.svg
	@# Rasterises design/cupertino-icon.svg, which already carries the corner
	@# clip. An .appiconset does not: the mark bleeds past the plate by design and
	@# macOS masks an app icon for free, but these PNGs are drawn in browser
	@# chrome that masks nothing, so the hills spilled out of the corners.
	@node scripts/generate-extension-icons.mjs

# ── App screenshots ───────────────────────────────────────────────────────────
#
# One tool, `appshot` — never a pile of per-project scripts. Install it with
# `cd ~/Projects/appshot && make install`.
#
# Cupertino does not ship on the App Store (docs/distribution.md settles that),
# so the framed set is not a store upload: it is what the README, a Product Hunt
# gallery and a social card want, and it costs nothing extra once the captures
# exist. The website set is the half with a live consumer today.
#
# PATHS ARE REPO-ROOT RELATIVE, unlike the canonical template's app-relative
# ones. `appshot` has no notion of a project root — every path resolves against
# the process working directory — so the rule that matters is that they all
# agree with wherever make runs. There is one Makefile here, at the root, by the
# deliberate decision recorded at the top of this file; adding a sub-Makefile at
# apps/apple just to make the paths shorter would be the delegator that decision
# rejected. The hazard to know: `capture --out` and `compose --out` CREATE their
# directories, so running these from anywhere but the repo root writes a
# complete, correct-looking set into a directory nobody reads, while the real
# one keeps last week's images.

SHOT_SCREENS := surface prompt activity connections settings writes

# Every flag the screens depend on, passed explicitly. Anything omitted falls
# back to whatever is persisted in the capturing Mac's UserDefaults — which is
# how a screenshot ends up describing one laptop rather than the product.
#
# The second and third lines are not app-specific and are the ones people leave
# out. macOS renders the app against the capturing Mac's System Settings, and
# none of that lives in this repo:
#
#   -allowWrites.<surface>  The per-surface write gate, read straight out of
#       UserDefaults by `WritesToggle`'s @AppStorage. Unpinned it is whatever the
#       capturing Mac has opted into, so the same commit photographs Mail with
#       writes on here and off on a clean machine — and the checkbox is the one
#       control in these screens that makes a safety claim. Mail on, the rest
#       off, which is the story the log fixture tells too: opt in per surface,
#       and watch the refusal when you have not. Needs no app code; launch
#       arguments land in NSArgumentDomain, which @AppStorage already reads.
#   -AppleHighlightColor  The text-selection background, which is still System
#       Settings' to choose. Nothing is selected in these screens, so this is
#       insurance for the log pane's `.textSelection(.enabled)` rather than a
#       dependency — but it is ambient, and ambient is what this list is for.
#
#       `-AppleAccentColor` used to be here too, pinned to 4 (blue), because
#       AccentColor.colorset declared no colour and the app therefore followed
#       System Settings — the tint reaching the sidebar selection and every
#       `.accentColor` log line, i.e. all three screens. That was a finding, not
#       a solution: it made the captures deterministic while every real user
#       still saw their own accent. The colorset now carries Cupertino's own
#       ramp (#F2895C on dark, #B0532F on light), which makes the flag a no-op,
#       and a flag that does nothing is the next person's dead flag.
#   -AppleLocale / -AppleLanguages  Locale.current drives every formatter.
#   -AppleShowScrollBars  `Always` bakes a scrollbar into the log pane.
#
# Quoting: the whole value already sits inside --extra-args="…", so a nested `"`
# would end the string at the shell. Inner values use single quotes; appshot's
# own splitting is quote-aware.
# The write toggles the screenshots are taken with: Mail on so the write tools
# appear, everything else off. Its own variable because a comment cannot sit
# inside a backslash continuation — putting the generated region in the middle of
# SHOT_ARGS is a `missing separator` error, which is how this was found.
# <generated:surfaces-shot> generated from surfaces.json by `make surfaces` — do not edit by hand
SHOT_WRITES  := -allowWrites.mail YES -allowWrites.notes NO -allowWrites.reminders NO -allowWrites.calendar NO -allowWrites.contacts NO -allowWrites.messages NO -allowWrites.maps NO
SHOT_ENABLED := -surfaceEnabled.mail YES -surfaceEnabled.notes YES -surfaceEnabled.reminders YES -surfaceEnabled.calendar YES -surfaceEnabled.contacts YES -surfaceEnabled.messages YES -surfaceEnabled.safari NO -surfaceEnabled.maps YES
# </generated:surfaces-shot>

SHOT_ARGS := -ScreenshotMode YES \
             $(SHOT_WRITES) \
             $(SHOT_ENABLED) \
             -AppleLocale en_US -AppleLanguages '(en)' \
             -AppleHighlightColor '0.698039 0.843137 1.000000 Blue' \
             -AppleShowScrollBars WhenScrolling

# A floor, not the whole wait: appshot then polls frames and shoots once the
# window stops changing. It can stay at the default because the app does not
# guess here at all — DemoSeed.signalReady touches --ready-file's path once
# MainView's body has run with the model populated, which is a fact rather than
# a duration. A padded number here would be that guess coming back.
SHOT_SETTLE := 0.3

# Only `screenshots-capture` needs this, and the asymmetry is not a mistake.
# `appshot run` reads the appearances out of the config's "appearances" key;
# `appshot capture` does not — it has its own --appearances flag defaulting to
# `dark, light`. So the standalone capture target has to say `dark` out loud or
# it produces a light set that nothing downstream expects: six files where the
# gate's expected set is three. Keep this equal to the config's key.
SHOT_APPEARANCES := dark

SHOT_DIR      := apps/apple/Screenshots
SHOT_SOURCE   := $(SHOT_DIR)/source
SHOT_GOLDEN   := $(SHOT_DIR)/golden
SHOT_APPSTORE := $(SHOT_DIR)/appstore
SHOT_CONFIG   := $(SHOT_DIR)/screenshots.config.json

# Pipeline-owned: `compose website` DELETES every .png in this directory before
# writing, so nothing hand-made may be parked in it. That is why it is a
# dedicated `shots/` directory and not the site's asset root.
#
# src/assets, not public/, so astro:assets processes them — these are 2240px
# PNGs and the landing page would otherwise ship ~860 KB of unoptimised image.
# It also buys the better failure: a capture that is missing breaks `astro
# build` outright, where a public/ reference would build clean and 404 in
# production.
#
# Absolute, because this is the one path that leaves the app's own tree.
# $(abspath) is purely lexical and never stats, so a typo here yields a
# plausible wrong path that `compose website` will happily create.
SHOT_WEBSITE := $(abspath apps/website/src/assets/shots)

.PHONY: screenshots screenshots-capture screenshots-check screenshots-update \
        screenshots-seal screenshots-selftest screenshots-appstore \
        screenshots-website screenshots-compose screenshots-doctor screenshots-clean

## A capture run takes over the pointer and the active app at the moment of each
## shot — don't use the machine while it runs, and a stray click can land in an
## image. It needs Screen Recording permission for the TERMINAL running it;
## nothing is granted to Cupertino itself. `--wait` queues behind another
## project's run on this Mac instead of failing.

screenshots: app ## Capture, gate against the goldens, and compose both sets
	appshot run \
		--app "$(APP)" \
		--config "$(SHOT_CONFIG)" \
		--source "$(SHOT_SOURCE)" \
		--golden "$(SHOT_GOLDEN)" \
		--appstore-out "$(SHOT_APPSTORE)" \
		--website-out "$(SHOT_WEBSITE)" \
		--screens $(SHOT_SCREENS) \
		--extra-args="$(SHOT_ARGS)" \
		--settle $(SHOT_SETTLE) \
		--ready-file \
		--wait

screenshots-capture: app ## Capture only (no gate, no compose)
	@# --config checks $(SHOT_SCREENS) against the config's screens[].id BEFORE
	@# launching anything, so a typo staging the wrong screen under the right
	@# filename fails now rather than ninety seconds later.
	@# --extra-args needs the `=`: the value starts with `-`, and without it
	@# ArgumentParser reads it as appshot's own flags.
	appshot capture \
		--app "$(APP)" \
		--out "$(SHOT_SOURCE)" \
		--config "$(SHOT_CONFIG)" \
		--screens $(SHOT_SCREENS) \
		--appearances $(SHOT_APPEARANCES) \
		--extra-args="$(SHOT_ARGS)" \
		--settle $(SHOT_SETTLE) \
		--ready-file \
		--wait

screenshots-check: ## Fail if the captures drifted from the goldens
	@# --config checks the exact expected SET, and it is the only thing that can
	@# see two captures that are the same image — the tell that a
	@# -ScreenshotStage value did nothing and one screen was photographed twice
	@# under two names. Count and file validity say nothing about that, and each
	@# would match its golden, because the golden came from the same broken run.
	@# --require-manifest refuses a baseline nothing can vouch for: `accept`
	@# seals the goldens (sha256 per file, plus who accepted them and with what
	@# arguments) and this verifies the seal before comparing anything.
	appshot check --source "$(SHOT_SOURCE)" --golden "$(SHOT_GOLDEN)" \
		--config "$(SHOT_CONFIG)" --require-manifest

screenshots-update: ## Accept the captures as the new goldens (review the diffs first)
	appshot accept --source "$(SHOT_SOURCE)" --golden "$(SHOT_GOLDEN)"
	@$(MAKE) --no-print-directory screenshots-compose

screenshots-seal: ## Adopt the goldens on disk as the sealed baseline (one-time)
	appshot seal --golden "$(SHOT_GOLDEN)"

screenshots-selftest: ## Prove the golden gate actually fails when it should
	appshot selftest --golden "$(SHOT_GOLDEN)"

screenshots-appstore: ## Compose the framed, captioned visuals
	appshot compose appstore \
		--config "$(SHOT_CONFIG)" --source "$(SHOT_SOURCE)" --out "$(SHOT_APPSTORE)"

screenshots-website: ## Emit bare app captures into apps/website/public/shots
	appshot compose website \
		--config "$(SHOT_CONFIG)" --source "$(SHOT_SOURCE)" --out "$(SHOT_WEBSITE)"

screenshots-compose: screenshots-appstore screenshots-website ## Recompose both sets (no re-capture)

screenshots-doctor: ## Check what fails silently: font, Screen Recording, config
	appshot doctor --config "$(SHOT_CONFIG)"

screenshots-clean: ## Remove generated captures and composites (keeps the goldens)
	@# Deliberately not $(SHOT_WEBSITE): a clean target must not delete another
	@# half of the repo's assets, and only a full capture run regenerates them.
	@rm -rf $(SHOT_SOURCE) $(SHOT_APPSTORE) $(SHOT_DIR)/diff
	@echo "Removed generated screenshots. Goldens in $(SHOT_GOLDEN) kept."

clean: ## Remove the app build output
	@rm -rf apps/apple/.build

.PHONY: help build app run install build-release install-release install-from uninstall stop dev-config smoke wiring-check audit revocations servers node bundle sign notarize surfaces surfaces-check version version-check icon clean
