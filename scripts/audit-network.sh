#!/usr/bin/env bash
#
# Assert that nothing Cupertino ships can reach the network on its own, beyond
# the one thing that is allowed to and is named here.
#
# The claim in docs/licensing.md is worth only as much as it is checkable by a
# stranger, so this runs against the built artifact rather than the sources: any
# user can point it at the .app they downloaded and get the same answer CI got.
#
#   scripts/audit-network.sh [path/to/Cupertino.app]
#
# Since Sparkle landed, the source tree no longer contains all the code that
# ships. One binary dependency does networking on purpose, and a symbol table is
# now the only place that is visible — a `grep` over apps/apple/ cannot see it.
# That is exactly why the binary sweep below discovers what to audit rather than
# being told, and why the allowance is spelled out symbol by symbol.
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
saw_sparkle=0

# High-level networking only. Every one of these implies an intent no local IPC
# path has: loading a URL, resolving a name, negotiating TLS.
DENY='URLSession|URLConnection|URLRequest|URLDownload|^_nw_|_CFHTTP|_CFURLRequest|CFReadStreamCreateForHTTP|_getaddrinfo|_gethostby|_res_9_|_SSLHandshake|_SSLCreateContext|_curl_'

# ---------------------------------------------------------------------------
# The exceptions, both of them, in one table rather than one table and one
# footnote. Adding a line here is the whole decision, and it is a diff a
# stranger can read.
# ---------------------------------------------------------------------------

# Sparkle is the update checker: the one thing in this bundle that opens a socket
# to the internet. It does so only when the user has turned checks on or pressed
# Check Now, and docs/licensing.md carries the reworded claim that admits it.
SPARKLE_BIN='Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle'

# And exactly which symbols it may have — measured against the pinned version,
# not assumed. A Sparkle that starts resolving names itself, negotiates TLS by
# hand or links CFNetwork directly fails this line rather than inheriting the
# allowance the previous version earned.
SPARKLE_ALLOWED='^_OBJC_CLASS_\$_(NSURLSession|NSURLSessionConfiguration|NSMutableURLRequest)$'

# Set to 0 for a deliberately Sparkle-free build. Left at 1, a bundle that has
# lost Sparkle is a failure rather than a quiet pass — see the stale-allowance
# check at the bottom.
SPARKLE_EXPECTED="${SPARKLE_EXPECTED:-1}"

# Reported, never failed: see the header.
NOTED='Contents/Resources/node'

# Every Mach-O in the bundle, FOUND rather than listed. The previous version of
# this script named two binaries by hand; a framework, an XPC service or a helper
# that nobody remembered to add to that list is precisely the thing this gate
# exists to catch, so the list is derived from what actually shipped.
mach_o_paths() {
  find "$APP/Contents" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' f; do
      case "$(file -b "$f" 2>/dev/null)" in
        *Mach-O*) printf '%s\n' "${f#"$APP/"}" ;;
      esac
    done | LC_ALL=C sort
}

# sort -u because nm lists undefined symbols once per architecture slice, and
# a universal binary would otherwise report every hit twice.
scan() {
  {
    nm -u "$1" 2>/dev/null | grep -E "$DENY" || true
    otool -L "$1" 2>/dev/null | grep -E 'CFNetwork|/Network\.framework' || true
  } | sed 's/^[[:space:]]*//' | grep -v '^$' | sort -u || true
}

if [ ! -d "$APP" ]; then
  echo ""
  echo "  FAIL  no bundle at $APP"
  echo ""
  exit 1
fi

echo ""
echo "  Binaries — $APP"

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  checked=$((checked + 1))

  if [ "$rel" = "$NOTED" ]; then
    printf '  note  %-46s links networking by design — constrained at runtime\n' "$rel"
    continue
  fi

  hits=$(scan "$APP/$rel")

  if [ "$rel" = "$SPARKLE_BIN" ]; then
    saw_sparkle=1
    # The allowance is exact, not a blanket pardon for a path.
    unexpected=$(printf '%s\n' "$hits" | grep -v '^$' | grep -vE "$SPARKLE_ALLOWED" || true)
    if [ -n "$unexpected" ]; then
      printf '  FAIL  %-46s Sparkle grew a network capability it did not have:\n' "$rel"
      printf '%s\n' "$unexpected" | sed 's/^/          /'
      status=1
    else
      printf '  UPD   %-46s reaches the network — the update check, off by default\n' "$rel"
    fi
    continue
  fi

  if [ -n "$hits" ]; then
    count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
    printf '  FAIL  %-46s reaches the network (%s symbols):\n' "$rel" "$count"
    printf '%s\n' "$hits" | head -8 | sed 's/^/          /'
    [ "$count" -gt 8 ] && printf '          … and %s more\n' "$((count - 8))"
    status=1
  else
    printf '  ok    %-46s no URL loading, no DNS, no TLS\n' "$rel"
  fi
done <<EOF
$(mach_o_paths)
EOF

# A pardon that outlives the thing it pardons is a hole waiting for whatever
# lands at that path next. If Sparkle is ever dropped, this line has to be
# dropped with it, and the way to guarantee that is to fail until it is.
if [ "$SPARKLE_EXPECTED" = "1" ] && [ "$saw_sparkle" -eq 0 ]; then
  printf '  FAIL  %-46s the allowance names a binary this bundle does not contain\n' "$SPARKLE_BIN"
  status=1
fi

# ---------------------------------------------------------------------------
# The symbol sweep says the capability exists. These say it is switched off and
# points where we said it does — which is what turns "off by default" from a
# promise in a settings pane into something CI refuses to ship without.
# ---------------------------------------------------------------------------
if [ "$saw_sparkle" -eq 1 ]; then
  echo ""
  echo "  Configuration — the update check is off until asked for"
  plist="$APP/Contents/Info.plist"
  pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null || true; }

  assert_plist() {
    local key="$1" want="$2" got
    got=$(pb "$key")
    if [ "$got" = "$want" ]; then
      printf '  ok    %-46s %s\n' "$key" "$got"
    else
      printf '  FAIL  %-46s is %s, must be %s\n' "$key" "${got:-absent}" "$want"
      status=1
    fi
  }

  # Absent is not the same as false: an ABSENT SUEnableAutomaticChecks is exactly
  # what makes Sparkle ask on its own, in its own words, which is the outcome the
  # consent card was written to replace.
  assert_plist SUEnableAutomaticChecks false
  assert_plist SUAutomaticallyUpdate    false
  assert_plist SUSendProfileInfo        false
  assert_plist SUFeedURL "https://cupertino.mgcrea.io/appcast.xml"

  # Present is not enough. An ed25519 public key is 32 bytes in base64 — 44
  # characters ending in '=' — and the placeholder in the committed plist is
  # deliberately not that, so a build that never had a real key wired in fails
  # here rather than shipping an updater that trusts nobody's signature.
  edkey=$(pb SUPublicEDKey)
  if printf '%s' "$edkey" | grep -qE '^[A-Za-z0-9+/]{43}=$'; then
    printf '  ok    %-46s well-formed\n' "SUPublicEDKey"
  elif [ -z "$edkey" ]; then
    printf '  FAIL  %-46s absent — updates would be unverified\n' "SUPublicEDKey"
    status=1
  else
    printf '  FAIL  %-46s not an ed25519 public key: %s\n' "SUPublicEDKey" "$edkey"
    status=1
  fi

  # Sandbox-only, and this app is not sandboxed. They are stripped in `make
  # bundle` because each one is another binary that would need pardoning here.
  if [ -d "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices" ]; then
    printf '  FAIL  %-46s sandbox-only XPC services ship\n' "XPCServices"
    status=1
  else
    printf '  ok    %-46s stripped\n' "XPCServices"
  fi
fi

# The binary check cannot rule out AF_INET, because the AF_UNIX bridge shares
# its syscalls. This can, and it is the assertion that actually carries the
# claim for the code we wrote: a socket that never names an internet address
# family is not one.
echo ""
echo "  Sources — an internet address family appears nowhere"
# Named explicitly, and existence-checked: `grep -r` over a directory that has
# been moved away returns nothing and exits non-zero, which `|| true` would
# launder into a pass. The check would then report "ok" having read no source at
# all — the same silent-skip failure the `checked` counter above exists to stop.
SOURCES=(apps/apple packages/*/native)
# Build output and vendored dependencies are not our source, and scanning them
# reads someone else's code as though we had written it. Sparkle's own test
# harness contains a `sockaddr_in` web server; unpacked under apps/apple it would
# fail this gate for a claim it has no bearing on, because nothing in
# Contents/Frameworks answers to a grep over apps/apple in the first place —
# what constrains the framework is the symbol sweep above.
PRUNE=(--exclude-dir=.build --exclude-dir=Vendor)
for dir in "${SOURCES[@]}"; do
  [ -d "$dir" ] || {
    printf '  FAIL  %-46s no such directory: %s\n' "sources" "$dir"
    status=1
  }
done
inet=$(grep -rInE "${PRUNE[@]}" 'AF_INET|PF_INET|sockaddr_in\b|sockaddr_in6' "${SOURCES[@]}" 2>/dev/null || true)
if [ -n "$inet" ]; then
  printf '  FAIL  %s\n' "AF_INET is referenced:"
  printf '%s\n' "$inet" | sed 's/^/          /'
  status=1
else
  printf '  ok    %-46s AF_UNIX only\n' "sockets"
fi

# A gate that passes when it inspected nothing is not a gate. If no binary was
# found the build did not happen, and that is a failure here rather than a quiet
# success.
if [ "$checked" -eq 0 ]; then
  echo ""
  echo "  FAIL  audited nothing — no Mach-O binary found under $APP"
  status=1
fi

echo ""
if [ "$status" -eq 0 ]; then
  echo "  Audited $checked Mach-O files."
  if [ "$saw_sparkle" -eq 1 ]; then
    echo "  Cupertino opens exactly one socket of its own beyond the local bridge:"
    echo "  the update check, to cupertino.mgcrea.io, and only once you turn it on."
  else
    echo "  Cupertino opens no socket of its own beyond the local bridge."
  fi
  echo "  This says nothing about Mail.app, which sends over its own connections."
else
  echo "  Audit failed — see docs/licensing.md for what this claim is load-bearing for."
fi
echo ""
exit "$status"
