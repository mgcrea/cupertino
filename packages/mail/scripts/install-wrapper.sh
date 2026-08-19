#!/bin/bash
# Install the FDA launcher for apple-mail-mcp.
#
# Compiles native/launcher.c with the node and server paths baked in, ad-hoc
# signs it under a stable identifier, and installs it to a fixed location.
#
# Two details that are easy to get wrong and matter:
#
#   * The paths are COMPILED IN, not passed as arguments. A launcher that runs
#     whatever it is told would be a way for any local process to read the whole
#     disk using a permission you granted for mail.
#
#   * The install path is fixed and outside the repo. macOS ties the Full Disk
#     Access grant to a file path, so a launcher living in node_modules or an
#     npx cache would silently lose its permission on the next version bump.
#
# Re-run after upgrading node or moving the repo.
#
# Signing identity matters for how often you have to re-grant. A real certificate
# gives the binary a designated requirement based on its identifier and team, so
# the grant SURVIVES rebuilds. Ad-hoc signing identifies it by content hash
# instead, so every rebuild is a new identity and Full Disk Access has to be
# granted again. We therefore use a certificate when one is available and fall
# back to ad-hoc, which needs no Apple Developer account, with a warning.
set -euo pipefail

ROOT="$HOME/Library/Application Support/apple-mail-mcp"
BIN="$ROOT/bin/apple-mail-mcp"
IDENTIFIER="io.mgcrea.apple-mail-mcp.launcher"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$REPO/dist/cli.js"
NODE="$(readlink -f "$(command -v node)")"

if [ ! -f "$SERVER" ]; then
  echo "error: $SERVER not found. Run 'pnpm build' first." >&2
  exit 1
fi
if ! command -v clang >/dev/null; then
  echo "error: clang not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi

echo "==> compiling"
echo "    node   : $NODE"
echo "    server : $SERVER"
mkdir -p "$ROOT/bin"
clang -O2 -Wall -Wextra \
  -DNODE_PATH="\"$NODE\"" \
  -DSERVER_PATH="\"$SERVER\"" \
  -o "$BIN" "$REPO/native/launcher.c"

# Prefer a real identity so the grant survives rebuilds; fall back to ad-hoc.
# Either way the point is a DISTINCT identifier: a plain copy of a binary keeps
# the original's code hash and would share its TCC identity, which is exactly
# how you would accidentally grant Full Disk Access to every node on the machine.
echo "==> signing"
SIGN_ID="${IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
             | grep -oE '"(Apple Development|Developer ID Application)[^"]*"' \
             | head -1 | tr -d '"')"
fi

if [ -n "$SIGN_ID" ]; then
  echo "    identity: $SIGN_ID"
  codesign --force --sign "$SIGN_ID" --identifier "$IDENTIFIER" "$BIN"
  echo "    the Full Disk Access grant will survive future rebuilds"
else
  echo "    identity: ad-hoc (no signing certificate found)"
  codesign --force --sign - --identifier "$IDENTIFIER" "$BIN"
  echo "    NOTE: ad-hoc signing means each rebuild is a new identity, so you"
  echo "          will have to re-grant Full Disk Access after every update."
fi
codesign -dvvv "$BIN" 2>&1 | grep -E '^Identifier|^CDHash|^TeamIdentifier' | sed 's/^/    /'

echo "==> smoke test"
if printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install","version":"0"}}}' \
   | "$BIN" 2>/dev/null | grep -q '"serverInfo"'; then
  echo "    server responds through the launcher"
else
  echo "    WARNING: no handshake response; run '$BIN' by hand to see the error" >&2
fi

cat <<MSG

────────────────────────────────────────────────────────────────────────
Installed:  $BIN

1. Grant it Full Disk Access:
     System Settings > Privacy & Security > Full Disk Access
     +  then  Cmd-Shift-G  and paste:

       $BIN

   Grant it to nothing else. Not VS Code, not node, not Mail.

2. Point .mcp.json at the launcher instead of node:

     {
       "mcpServers": {
         "apple-mail": {
           "command": "$BIN",
           "env": { "APPLE_MAIL_ALLOW_WRITES": "1" }
         }
       }
     }

3. Restart your MCP host, then call apple_mail_diagnostics.
   Expect  fullDiskAccess: "granted"  and  index: "live".
────────────────────────────────────────────────────────────────────────
MSG
