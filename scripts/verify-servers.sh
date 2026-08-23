#!/usr/bin/env bash
#
# Assert that the MCP servers in a built artifact actually run.
#
#   scripts/verify-servers.sh [path/to/Cupertino.app | path/to/staged] [--static-only]
#
# Every release up to and including 1.2.0 shipped seven servers that died on
# their first line, and nothing in the pipeline noticed. The bundler could not
# resolve `@mgcrea/mcp-apple-core` — its `exports` point at a `dist/` that CI
# never built — so rolldown externalised the import, said "Module not found,
# treating it as an external dependency", and exited 0. There is no node_modules
# inside the bundle for a bare specifier to resolve against at runtime, so every
# surface raised ERR_MODULE_NOT_FOUND before serving a single tool call.
#
# The signature was valid, the notarisation ticket stapled, the network audit
# clean. All three gates passed because none of them ran the thing.
#
# So this asserts the two properties that failure violated, in that order:
#
#   1. STATIC — no server imports a bare specifier. Inside the bundle the only
#      resolvable imports are `node:` builtins, provided by the embedded
#      runtime. Anything else is a module that will not be there.
#   2. SMOKE  — each server, spawned under the runtime that ships beside it,
#      answers `initialize`. This is the one that cannot be fooled: it is what
#      an MCP host does, and a server that survives it has resolved every
#      import it has.
#
# (1) alone would have caught all three broken releases, and it runs in
# milliseconds without a runtime. (2) is the backstop for the failure we have
# not thought of yet — a bad chunk path, a syntax error, a missing runtime flag.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-apps/apple/.build/Build/Products/Release/Cupertino.app}"
MODE="${2:-}"

status=0
checked=0

# ---------------------------------------------------------------------------
# Where the servers and their runtime live.
#
# Two layouts, because this has to be runnable at both ends: against `staged/`
# the moment `make servers` writes it, where a failure costs seconds, and
# against the finished .app, which is what a user actually downloads and the
# only artifact whose contents are not taken on trust.
# ---------------------------------------------------------------------------
if [ -d "$TARGET/Contents/Resources/servers" ]; then
  SERVERS="$TARGET/Contents/Resources/servers"
  NODE="$TARGET/Contents/Resources/node"
  layout="app bundle"
elif [ -d "$TARGET/servers" ]; then
  SERVERS="$TARGET/servers"
  NODE="$TARGET/node"
  layout="staged tree"
else
  echo ""
  echo "  FAIL  no servers directory under $TARGET"
  echo ""
  exit 1
fi

# The manifest, never a hardcoded list: a surface added to surfaces.json and
# forgotten by the bundler must fail here rather than go unmentioned. This is
# the same source `make surfaces` generates SURFACES from.
surfaces=$(python3 -c "
import json
print(' '.join(s['id'] for s in json.load(open('surfaces.json'))['surfaces']))
")

if [ -z "$surfaces" ]; then
  echo ""
  echo "  FAIL  surfaces.json named no surfaces"
  echo ""
  exit 1
fi

echo ""
echo "  Imports — every specifier resolves inside the bundle ($layout)"

for s in $surfaces; do
  cli="$SERVERS/$s/dist/cli.js"

  if [ ! -f "$cli" ]; then
    printf '  FAIL  %-12s no bundle at %s\n' "$s" "${cli#"$TARGET/"}"
    status=1
    continue
  fi

  checked=$((checked + 1))

  # Bare = neither a `node:` builtin nor a relative path. Matching the import
  # FORM rather than a package name is what makes this a gate and not a
  # regression test for one dependency: a new workspace package that escapes the
  # bundler the same way fails here without anyone remembering to add it.
  #
  # Anchored to statements, not to the word "from" anywhere in the file. An
  # earlier draft scanned the whole text and reported `parseBound("from",
  # opts.from, …)` as a missing module — prose and arguments inside string
  # literals are full of the token, and a gate that cries wolf gets switched
  # off. ESM imports are static and hoisted, so a line-anchored scan sees all of
  # them; if a future bundler minifies onto one line, the `from "…"` sweep still
  # reads that line, and the smoke test below is what actually carries the claim.
  bare=$(grep -E '^import' "$cli" 2>/dev/null |
    grep -oE '(from[[:space:]]*|^import[[:space:]]*)["'"'"'][^"'"'"']+["'"'"']' |
    grep -oE '["'"'"'][^"'"'"']+["'"'"']' |
    tr -d '"'"'"'' |
    grep -vE '^(node:|\.\.?/)' |
    sort -u || true)

  if [ -n "$bare" ]; then
    printf '  FAIL  %-12s imports a module the bundle does not contain:\n' "$s"
    printf '%s\n' "$bare" | sed 's/^/                  /'
    status=1
  else
    printf '  ok    %-12s node: builtins and relative chunks only\n' "$s"
  fi
done

# A gate that inspected nothing is not a gate — the same reason
# audit-network.sh counts what it audited.
if [ "$checked" -eq 0 ]; then
  echo ""
  echo "  FAIL  inspected no server bundles under $SERVERS"
  echo ""
  exit 1
fi

# ---------------------------------------------------------------------------
# The smoke test. Static analysis says the imports look resolvable; this says
# the process actually starts and speaks MCP.
# ---------------------------------------------------------------------------
if [ "$MODE" = "--static-only" ]; then
  echo ""
  echo "  Skipped the smoke test (--static-only)."
  echo ""
  exit "$status"
fi

if [ ! -x "$NODE" ]; then
  echo ""
  echo "  FAIL  no runtime at ${NODE#"$TARGET/"} — cannot smoke-test what ships"
  echo "        (run 'make node' first, or pass --static-only to skip)"
  echo ""
  exit 1
fi

echo ""
echo "  Startup — each server answers initialize under its own runtime"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-servers","version":"1"}}}'

for s in $surfaces; do
  cli="$SERVERS/$s/dist/cli.js"
  [ -f "$cli" ] || continue

  err=$(mktemp)
  # stdin stays open past the write: a stdio server that reaches EOF shuts down,
  # and it would do so before answering — which reads as a failure of the server
  # rather than of the probe. The sleep is the wait for the reply.
  out=$({ printf '%s\n' "$INIT"; sleep 3; } |
    timeout 20 "$NODE" "$cli" 2>"$err" | head -c 2000 || true)

  if printf '%s' "$out" | grep -q '"protocolVersion"'; then
    version=$(printf '%s' "$out" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)
    printf '  ok    %-12s serving %s\n' "$s" "${version:-?}"
  else
    printf '  FAIL  %-12s did not answer initialize:\n' "$s"
    head -4 "$err" | sed 's/^/                  /'
    status=1
  fi
  rm -f "$err"
done

echo ""
if [ "$status" -eq 0 ]; then
  echo "  Verified $checked servers: every import resolves, every server starts."
else
  echo "  Verification failed — this artifact must not ship."
  echo "  A server that cannot start makes the whole surface dead on arrival,"
  echo "  however valid the signature over it is."
fi
echo ""
exit "$status"
