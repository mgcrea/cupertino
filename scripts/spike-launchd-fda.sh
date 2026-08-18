#!/bin/bash
# Spike 1 — does a launchd-spawned process get its OWN Full Disk Access identity?
#
# A process spawned by Claude/VS Code is attributed to VS Code for TCC purposes,
# so granting it FDA means granting the whole editor. A launchd-spawned process
# is its own responsible process, so TCC should attribute to its own binary —
# which would let us grant FDA to one pinned executable and nothing else.
#
# "Should" is why this exists. Two things need proving, not assuming:
#   1. a re-signed node copy gets a TCC identity distinct from Homebrew's node
#      (Homebrew's is ad-hoc signed, and TCC keys ad-hoc binaries by cdhash,
#      which a plain `cp` preserves — so an unsigned copy may share one identity
#      with every node on the machine)
#   2. the grant is SCOPED: plain node under VS Code must still be denied
#
#   ./scripts/spike-launchd-fda.sh setup     # install, then prompts you
#   ./scripts/spike-launchd-fda.sh check     # run after granting FDA
#   ./scripts/spike-launchd-fda.sh teardown  # remove everything
set -euo pipefail

IDENTITY="${IDENTITY:-Apple Development: Olivier Louvignes (493B6W4L7C)}"
LABEL="io.mgcrea.apple-mail-mcp.fda-spike"
ROOT="$HOME/Library/Application Support/apple-mail-mcp"
BIN="$ROOT/bin/node-apple-mail"
LIB="$ROOT/lib"
LOG="$ROOT/fda-spike.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROBE="$(cd "$(dirname "$0")" && pwd)/fda-probe.mjs"

setup() {
  local node lib_src
  node="$(readlink -f "$(which node)")"
  lib_src="$(dirname "$node")/../lib/libnode.137.dylib"

  echo "==> pinning node"
  mkdir -p "$ROOT/bin" "$LIB"
  cp -f "$node" "$BIN"

  # node resolves libnode via @loader_path/../lib, so the copy needs it beside
  # it. A symlink is enough for dyld and keeps us from duplicating 60 MB.
  ln -sf "$(readlink -f "$lib_src")" "$LIB/libnode.137.dylib"

  # Re-sign under our own identifier. Without this the copy keeps Homebrew's
  # ad-hoc cdhash identity and the FDA grant would not be ours alone.
  echo "==> signing as $LABEL.node"
  codesign --force --sign "$IDENTITY" --identifier "$LABEL.node" "$BIN"
  codesign -dv "$BIN" 2>&1 | grep -E 'Identifier|TeamIdentifier' | sed 's/^/    /'

  echo "==> checking the copy actually runs"
  "$BIN" -e 'console.log("    node ok:", process.version)'

  echo "==> installing LaunchAgent"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>$PROBE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>FDA_PROBE_LOG</key><string>$LOG</string></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG.out</string>
  <key>StandardErrorPath</key><string>$LOG.err</string>
</dict>
</plist>
PLISTEOF

  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST"
  echo "    bootstrapped $LABEL"

  cat <<MSG

────────────────────────────────────────────────────────────────────────
ACTION NEEDED — this cannot be scripted, TCC requires a human click.

  1. Open  System Settings > Privacy & Security > Full Disk Access
  2. Click  +
  3. Press  Cmd-Shift-G  and paste this exact path:

       $BIN

  4. Enable the toggle next to it.

Do NOT grant anything to VS Code, Terminal, node, or Mail — the whole
point is to find out whether this ONE binary can hold the permission.

Then run:  ./scripts/spike-launchd-fda.sh check
────────────────────────────────────────────────────────────────────────
MSG
}

check() {
  : > "$LOG"
  echo "==> kicking the agent"
  launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true
  sleep 2

  echo
  echo "  launchd-spawned pinned node :"
  if [ -s "$LOG" ]; then
    sed 's/^/    /' "$LOG"
  else
    echo "    (no output; check $LOG.err)"
    [ -s "$LOG.err" ] && sed 's/^/    /' "$LOG.err"
  fi

  # The scoping half. If this ALSO reads, the grant leaked to the host and the
  # whole exercise achieved nothing.
  echo
  echo "  plain node under this shell (must stay denied) :"
  node "$PROBE" 2>&1 | sed 's/^/    /' || true

  local agent_ok=1 host_denied=1
  grep -q '"readable":true' "$LOG" 2>/dev/null || agent_ok=0
  node "$PROBE" >/dev/null 2>&1 && host_denied=0

  echo
  if [ "$agent_ok" = 1 ] && [ "$host_denied" = 1 ]; then
    echo "RESULT: PASS - launchd gives the pinned binary its own scoped FDA."
    echo "        Route B is viable."
  elif [ "$agent_ok" = 1 ] && [ "$host_denied" = 0 ]; then
    echo "RESULT: LEAKED - the agent can read, but so can plain node here."
    echo "        The grant is not scoped to the pinned binary."
  else
    echo "RESULT: FAIL - the launchd agent still cannot read the index."
    echo "        Either FDA was not granted to $BIN, or launchd does not confer it."
  fi
}

teardown() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$LOG" "$LOG.out" "$LOG.err"
  # Only this spike's artefacts. $ROOT/bin also holds the production launcher,
  # so removing the whole directory would uninstall the real thing.
  rm -f "$BIN" "$LIB/libnode.137.dylib"
  rmdir "$LIB" 2>/dev/null || true
  echo "removed the agent, the pinned binary and the logs."
  echo "You can now delete the leftover Full Disk Access entry in System Settings."
}

case "${1:-setup}" in
  setup) setup ;;
  check) check ;;
  teardown) teardown ;;
  *) echo "usage: $0 {setup|check|teardown}" >&2; exit 2 ;;
esac
