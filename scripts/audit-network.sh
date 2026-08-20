#!/usr/bin/env bash
#
# Assert that nothing Cupertino ships can reach the network on its own.
#
# The claim in docs/licensing.md is worth only as much as it is checkable by a
# stranger, so this runs against the built artifact rather than the sources: any
# user can point it at the .app they downloaded and get the same answer CI got.
#
#   scripts/audit-network.sh [path/to/Cupertino.app]
#
# What it does NOT assert, deliberately:
#
#   * `socket`, `bind`, `connect` are expected. The bridge is an AF_UNIX socket
#     — a filesystem entry — so the syscalls are shared with the thing being
#     ruled out and cannot themselves be the test. AF_INET is the test, and it
#     is asserted at the source level below.
#   * The embedded `node` links networking by design and is reported, not
#     failed. A general-purpose runtime cannot be symbol-audited into safety;
#     what constrains it is the sandbox profile, at runtime.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="${1:-apps/apple/.build/Build/Products/Debug/Cupertino.app}"
status=0
checked=0

# High-level networking only. Every one of these implies an intent no local IPC
# path has: loading a URL, resolving a name, negotiating TLS.
DENY='URLSession|URLConnection|URLRequest|URLDownload|^_nw_|_CFHTTP|_CFURLRequest|CFReadStreamCreateForHTTP|_getaddrinfo|_gethostby|_res_9_|_SSLHandshake|_SSLCreateContext|_curl_'

check_binary() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    printf '  skip  %-18s not built\n' "$label"
    return 0
  fi
  checked=$((checked + 1))

  # sort -u because nm lists undefined symbols once per architecture slice, and
  # a universal binary would otherwise report every hit twice.
  local hits count
  hits=$(
    {
      nm -u "$path" 2>/dev/null | grep -E "$DENY" || true
      otool -L "$path" | grep -E 'CFNetwork|/Network\.framework' || true
    } | sed 's/^[[:space:]]*//' | grep -v '^$' | sort -u || true
  )

  if [ -n "$hits" ]; then
    count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
    printf '  FAIL  %-18s reaches the network (%s symbols):\n' "$label" "$count"
    printf '%s\n' "$hits" | head -8 | sed 's/^/          /'
    [ "$count" -gt 8 ] && printf '          … and %s more\n' "$((count - 8))"
    status=1
  else
    printf '  ok    %-18s no URL loading, no DNS, no TLS\n' "$label"
  fi
}

echo ""
echo "  Binaries — $APP"
check_binary "Cupertino" "$APP/Contents/MacOS/Cupertino"
check_binary "cupertino-bridge" "$APP/Contents/Helpers/cupertino-bridge"

# Reported, never failed: see the header.
if [ -f "$APP/Contents/Resources/node" ]; then
  printf '  note  %-18s links networking by design — constrained at runtime\n' "node"
fi

# The binary check cannot rule out AF_INET, because the AF_UNIX bridge shares
# its syscalls. This can, and it is the assertion that actually carries the
# claim: a socket that never names an internet address family is not one.
echo ""
echo "  Sources — an internet address family appears nowhere"
# Named explicitly, and existence-checked: `grep -r` over a directory that has
# been moved away returns nothing and exits non-zero, which `|| true` would
# launder into a pass. The check would then report "ok" having read no source at
# all — the same silent-skip failure the `checked` counter above exists to stop.
SOURCES=(apps/apple packages/*/native)
for dir in "${SOURCES[@]}"; do
  [ -d "$dir" ] || {
    printf '  FAIL  %-18s no such directory: %s\n' "sources" "$dir"
    status=1
  }
done
inet=$(grep -rInE 'AF_INET|PF_INET|sockaddr_in\b|sockaddr_in6' "${SOURCES[@]}" 2>/dev/null || true)
if [ -n "$inet" ]; then
  printf '  FAIL  %s\n' "AF_INET is referenced:"
  printf '%s\n' "$inet" | sed 's/^/          /'
  status=1
else
  printf '  ok    %-18s AF_UNIX only\n' "sockets"
fi

# A gate that passes when it inspected nothing is not a gate. If neither binary
# was present the build did not happen, and that is a failure here rather than
# a quiet success.
if [ "$checked" -eq 0 ]; then
  echo ""
  echo "  FAIL  audited nothing — no binary found under $APP"
  status=1
fi

echo ""
if [ "$status" -eq 0 ]; then
  echo "  Cupertino opens no socket of its own beyond the local bridge."
  echo "  This says nothing about Mail.app, which sends over its own connections."
else
  echo "  Audit failed — see docs/licensing.md for what this claim is load-bearing for."
fi
echo ""
exit "$status"
