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
STAGED       := app/.build/staged
APP     ?= app/.build/Build/Products/$(CONFIG)/Cupertino.app
INSTALLED := /Applications/Cupertino.app
BRIDGE  := $(APP)/Contents/Helpers/cupertino-bridge
SUPPORT := $(HOME)/Library/Application Support/io.mgcrea.cupertino

.DEFAULT_GOAL := help

help: ## Show this help
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  servers: pnpm -r build | test | typecheck, pnpm lint | format"
	@echo ""

app: ## Build Cupertino.app (Debug; Release needs the bundled servers)
	@xcodebuild -project app/Cupertino.xcodeproj -scheme Cupertino \
		-configuration $(CONFIG) -derivedDataPath app/.build build \
		| grep -E 'error:|BUILD (SUCCEEDED|FAILED)' || true

run: app dev-config ## Build, then (re)launch the menu bar app
	@pkill -f 'Cupertino.app/Contents/MacOS/Cupertino' 2>/dev/null || true
	@sleep 1 && open "$(APP)"
	@echo "Cupertino running — look for the tray icon in the menu bar."

install: app ## Install the Debug build to /Applications (development)
	@$(MAKE) --no-print-directory install-from SRC="$(APP)"

# Deliberately NOT `install-release: bundle`. `bundle` re-signs, and re-signing
# changes the cdhash the stapled notarization ticket is bound to — so depending
# on it silently un-notarizes the very thing being installed. The order is
# bundle -> notarize -> install, and this target is only the last step.
install-release: ## Install the already-notarized Release build (run: bundle, notarize)
	@xcrun stapler validate "$(RELEASE_APP)" >/dev/null 2>&1 \
		|| { echo "$(RELEASE_APP) is not stapled — run 'make bundle && make notarize' first"; exit 1; }
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
	@echo "Grant Full Disk Access to THIS copy. A grant binds to the PATH, not to the"
	@echo "signature, so it does NOT carry over from a build directory — but it does"
	@echo "survive every later reinstall here, because /Applications does not move."
	@echo ""
	@# Functional, not structural. Checking for Resources/servers would only catch
	@# the shapes of breakage anyone thought to look for; actually starting a
	@# server catches an install that cannot serve, whatever the reason.
	@sleep 2
	@for s in mail notes; do \
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
	@for s in mail notes; do \
		printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"make","version":"0"}}}' \
			| "$(BRIDGE)" --server=$$s 2>/dev/null | grep -q '"serverInfo"' \
			&& echo "  ok   $$s" || { echo "  FAIL $$s"; exit 1; }; \
	done

audit: app ## Assert the built app cannot reach the network
	@scripts/audit-network.sh "$(APP)"

servers: ## Bundle the MCP servers self-contained (no node_modules at runtime)
	@pnpm exec tsdown --config app/tsdown.servers.config.ts -l warn
	@for s in mail notes; do \
		python3 -c "import json;src=json.load(open('packages/$$s/package.json'));json.dump({'name':src['name'],'version':src['version'],'type':'module','private':True},open('$(STAGED)/servers/$$s/package.json','w'),indent=2)"; \
	done
	@echo "  staged $$(find $(STAGED)/servers -name '*.js' | wc -l | tr -d ' ') server files"

node: ## Download and lipo the embedded node runtime
	@mkdir -p $(STAGED) app/.build/node-cache
	@for arch in $(NODE_ARCHS); do \
		tar="app/.build/node-cache/node-v$(NODE_VERSION)-darwin-$$arch.tar.gz"; \
		[ -f "$$tar" ] || curl -fsSL -o "$$tar" \
			"https://nodejs.org/dist/v$(NODE_VERSION)/node-v$(NODE_VERSION)-darwin-$$arch.tar.gz"; \
		tar -xzf "$$tar" -C app/.build/node-cache \
			"node-v$(NODE_VERSION)-darwin-$$arch/bin/node"; \
	done
	@slices=""; for arch in $(NODE_ARCHS); do \
		slices="$$slices app/.build/node-cache/node-v$(NODE_VERSION)-darwin-$$arch/bin/node"; done; \
		lipo -create $$slices -output $(STAGED)/node
	@lipo -info $(STAGED)/node | sed 's/^/  /'

RELEASE_APP := app/.build/Build/Products/Release/Cupertino.app

bundle: servers node ## Build, stage and sign a Release Cupertino.app
	@$(MAKE) --no-print-directory app CONFIG=Release
	@rm -rf "$(RELEASE_APP)/Contents/Resources/servers" "$(RELEASE_APP)/Contents/Resources/node"
	@ditto "$(STAGED)/servers" "$(RELEASE_APP)/Contents/Resources/servers"
	@ditto "$(STAGED)/node" "$(RELEASE_APP)/Contents/Resources/node"
	@$(MAKE) --no-print-directory sign

# Inner-out, and never in the other order: signing the bundle first and then
# touching anything inside it invalidates the outer signature.
sign: ## Sign the Release bundle (Developer ID if present, else Apple Development)
	@id=$$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $$2; exit}'); \
	if [ -z "$$id" ]; then \
		id=$$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $$2; exit}'); \
		echo "  !! no Developer ID Application certificate — signing with Apple Development."; \
		echo "     This build will NOT notarize and will not run on another Mac."; \
	fi; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		--entitlements app/node.entitlements "$(RELEASE_APP)/Contents/Resources/node"; \
	codesign --force --options runtime --timestamp --sign "$$id" \
		"$(RELEASE_APP)/Contents/Helpers/cupertino-bridge"; \
	codesign --force --options runtime --timestamp --sign "$$id" "$(RELEASE_APP)"
	@codesign --verify --deep --strict --verbose=1 "$(RELEASE_APP)" 2>&1 | sed 's/^/  /'
	@echo "  size: $$(du -sh "$(RELEASE_APP)" | cut -f1)"

notarize: ## Submit the signed bundle to Apple and staple the ticket
	@test -n "$$AC_KEY_ID" || { echo "set AC_KEY_ID, AC_ISSUER_ID and AC_KEY_PATH first" >&2; exit 1; }
	@ditto -c -k --keepParent "$(RELEASE_APP)" app/.build/Cupertino.zip
	@xcrun notarytool submit app/.build/Cupertino.zip --wait \
		--key "$$AC_KEY_PATH" --key-id "$$AC_KEY_ID" --issuer "$$AC_ISSUER_ID"
	@xcrun stapler staple "$(RELEASE_APP)"
	@ditto -c -k --keepParent "$(RELEASE_APP)" app/.build/Cupertino.zip
	@echo "  stapled: app/.build/Cupertino.zip"

# The icon is generated, never hand-drawn: one mark, three renderings. The plate
# lives in the flags rather than the artwork so the .icon layers stay separable.
ICON_MARK   := design/cupertino-mark.svg
# '#' opens a comment in a Makefile, so the hexes are spelled through a variable.
HASH        := \#
ICON_SKY     = $(HASH)FFD08A,$(HASH)F2895C
ICON_RADIUS := 230
ICON_MENUBAR := design/cupertino-menubar.svg

icon: ## Regenerate Cupertino.icon and the web SVG from design/cupertino-mark.svg
	@appshot icon build --from $(ICON_MARK) \
		--plate-gradient '$(ICON_SKY)' --plate-angle 90 --mark-fraction 1.0 \
		--out app/Cupertino/Cupertino.icon
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
	@appshot icon check --out app/Cupertino/Cupertino.icon
	@# The menu bar glyph is authored, not composed — but the imageset needs the
	@# file *inside* it, so design/ stays the one copy anyone edits.
	@cp $(ICON_MENUBAR) app/Cupertino/Assets.xcassets/MenuBarIcon.imageset/
	@echo "  copied $(notdir $(ICON_MENUBAR)) into MenuBarIcon.imageset"

clean: ## Remove the app build output
	@rm -rf app/.build

.PHONY: help app run install install-release install-from uninstall stop dev-config smoke audit servers node bundle sign notarize icon clean
