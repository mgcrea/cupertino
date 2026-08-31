#!/usr/bin/env bash
# Assert the Safari extension inside a built Cupertino.app is actually shippable.
#
# Nothing else in the pipeline would notice if it were not. `verify-servers.sh`
# checks the node servers, `make smoke` goes through the bridge, and
# `codesign --verify --deep` catches a BADLY signed appex but not a
# non-functional one. The failures this catches are all silent:
#
#   * The appex missing entirely — `bundle` stages by hand, and a copy phase
#     that stopped firing looks exactly like a smaller app.
#   * A resource the manifest names but the bundle does not carry. Safari
#     reports this only in its own extension error list, which nothing reads;
#     the build stays green. Measured on the probe: adding a background.js
#     without wiring it in shipped a bundle without it and said nothing.
#   * A bundle identifier that is not prefixed by the app's. Safari keys
#     enablement state to that identifier, so a change silently resets whether
#     the extension is switched on.
#   * An entitlement beyond the sandbox. The appex needs exactly one; anything
#     else is a capability nobody asked for, and audit-network.sh cannot see
#     entitlements because it inspects Mach-O symbols.
#
# Usage: scripts/verify-extension.sh <path/to/Cupertino.app>
set -euo pipefail

APP="${1:?usage: verify-extension.sh <Cupertino.app>}"
APP="${APP%/}"
EXT="$APP/Contents/PlugIns/CupertinoSafariExtension.appex"
fail() { echo "  FAIL  $*" >&2; exit 1; }
ok() { printf '  ok    %-46s %s\n' "$1" "${2:-}"; }

echo "  Safari extension — $APP"

[ -d "$EXT" ] || fail "no appex at Contents/PlugIns/CupertinoSafariExtension.appex"
ok "appex present"

# The identifier prefix rule, which the Debug and Release apps satisfy with
# different strings.
#
# Read from Info.plist rather than from the signature. `bundle` builds with
# CODE_SIGNING_ALLOWED=NO and signs afterwards, and `codesign -dv` on an
# unsigned bundle reports the bundle NAME — so a signature-based check reads
# "Cupertino" and "CupertinoSafariExtension" and fails an artifact that is
# perfectly correct. The identifier is a property of the bundle, not of the
# signature.
app_id=$(/usr/bin/defaults read "$(cd "$APP/Contents" && pwd)/Info" CFBundleIdentifier 2>/dev/null || true)
ext_id=$(/usr/bin/defaults read "$(cd "$EXT/Contents" && pwd)/Info" CFBundleIdentifier 2>/dev/null || true)
[ -n "$app_id" ] && [ -n "$ext_id" ] || fail "could not read CFBundleIdentifier from Info.plist"
case "$ext_id" in
  "$app_id".*) ok "identifier prefixed by the app's" "$ext_id" ;;
  *) fail "appex id '$ext_id' is not prefixed by the app's '$app_id' — Xcode refuses this, and Safari keys enablement to it" ;;
esac

# Exactly one entitlement, and it is the sandbox. The app hosting it must NOT be
# sandboxed; that asymmetry is the whole shape of this lane.
if ! /usr/bin/codesign -dv "$EXT" >/dev/null 2>&1; then
  fail "appex is not signed — run this after \`make sign\`, not before"
fi
ents=$(/usr/bin/codesign -d --entitlements - --xml "$EXT" 2>/dev/null | /usr/bin/plutil -convert json -o - - 2>/dev/null || echo '{}')
python3 - "$ents" <<'PY'
import json, sys
e = json.loads(sys.argv[1] or "{}")
# get-task-allow is Xcode's debug-signing artifact; the release path signs by
# hand and never carries it. Notarization rejects it outright.
e.pop("com.apple.security.get-task-allow", None)
extra = sorted(k for k in e if k != "com.apple.security.app-sandbox")
if not e.get("com.apple.security.app-sandbox"):
    print("  FAIL  appex is not sandboxed — an app extension must be", file=sys.stderr); sys.exit(1)
if extra:
    print(f"  FAIL  appex carries entitlements beyond the sandbox: {extra}", file=sys.stderr); sys.exit(1)
print("  ok    entitlements                                  sandbox only")
PY

# Every file the manifest names must be in the bundle.
python3 - "$EXT/Contents/Resources" <<'PY'
import json, sys, pathlib
res = pathlib.Path(sys.argv[1])
manifest = res / "manifest.json"
if not manifest.exists():
    print("  FAIL  no manifest.json in the appex", file=sys.stderr); sys.exit(1)
m = json.loads(manifest.read_text())
named = set()
bg = m.get("background", {})
named.update(v for v in [bg.get("service_worker")] if v)
named.update(bg.get("scripts", []))
for cs in m.get("content_scripts", []):
    named.update(cs.get("js", [])); named.update(cs.get("css", []))
named.update(m.get("icons", {}).values())
named.update(m.get("action", {}).get("default_icon", {}).values())
if p := m.get("action", {}).get("default_popup"): named.add(p)
missing = sorted(n for n in named if not (res / n).exists())
if missing:
    print(f"  FAIL  manifest names files the bundle does not carry: {missing}", file=sys.stderr); sys.exit(1)
print(f"  ok    manifest resources                            {len(named)} named, all present")
PY

echo "  The extension is present, correctly identified, minimally entitled and complete."
