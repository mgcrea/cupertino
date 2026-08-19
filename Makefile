# The commands you would otherwise retype. Not a build system: the Node half is
# pnpm from here, the Swift half is xcodebuild, and this only names them.
#
# Deliberately not a delegator like cadence-platform's — there is one Makefile
# here, not two, so there is nothing to forward to.

CONFIG  := Debug
APP     := app/.build/Build/Products/$(CONFIG)/Cupertino.app
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

clean: ## Remove the app build output
	@rm -rf app/.build

.PHONY: help app run stop dev-config smoke clean
