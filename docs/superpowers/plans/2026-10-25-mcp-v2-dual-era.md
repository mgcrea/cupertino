# MCP SDK v2 and Dual-Era Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Cupertino surface stays usable by every client as the ecosystem moves to the 2026-07-28 protocol. Move the eight npm servers and core off `@modelcontextprotocol/sdk` v1.x before its promised security-fix window ends (**2027-01-27**). Make every surface **dual-era**: it answers a 2025-era `initialize` exactly as today, and also answers a 2026-07-28 opening.

**Architecture:** Two halves that share no code.

- **npm (TypeScript):** `@modelcontextprotocol/server` / `client` 2.x, migrated with the official codemod. Then `packages/core/src/cli.ts` switches from `server.connect(transport)` to `serveStdio(factory, { transport })`, which is the v2 entry that owns the era decision. A hand-wired v2 server stays 2025-era only.
- **In-app (Swift):** the four surfaces the app serves itself (screen, sound, desktop, simulator) go through `InProcessRPC.dispatch`, which is hand-rolled JSON-RPC. It gains `server/discover` and per-request `_meta` handling.

**Tech Stack:** TypeScript, zod 4.4.3 (v2 needs ≥ 4.2), vitest, Node ≥ 24 (v2 needs ≥ 20), tsdown. Swift 6.0 for `InProcessRPC`.

**Source:** `.idea/feature-scout/2026-10-24.md`, Required change 1. Standing context in `2026-10-24b.md`: v1 got 1.32.2 on 2026-10-23, and v2 is at 2.4.0.

## Why now, and what isn't urgent

- **The date:** the v1.x README (rewritten in 1.32.1, 2026-10-05) promises "bug fixes and security updates for at least six months after the v2 release (2026-07-27)". That makes 2027-01-27 the end of a *promise*, not an end-of-life. "Support for the 2026-07-28 spec is not planned for v1.x."
- **The undated risk:** in the spec's compatibility matrix (modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle), *Modern client → Legacy server* is **Fails**. Today every Cupertino surface is legacy. Dual-era clients fall back to `initialize`, so nothing is broken yet. No modern-only host had been found as of 2026-10-24.
- **Not in scope:** the app's own clients (`SurfaceCatalog.swift:306-312`, `MCPChatClient.swift:165-171`, both `initialize` at `2025-06-18`). The matrix says *Legacy client → Dual-era server* works, so they can wait. Skills over MCP (SEP-2640, `skills.attach`, experimental) stays in Watch.

## Global Constraints

- **A 2025-era client must see no difference.** That covers the `initialize` result, `tools/list` bytes after trimming, error codes and texts that tests pin, and the write gate (mutating tools not registered when `allowWrites` is off). Each task diffs the legacy-era transcript before and after.
- The `withTrimmedListing` seam survives. Pass the wrapped transport through `serveStdio`'s `transport` option. `StdioServerTransport` now comes from `@modelcontextprotocol/server/stdio`; the root barrel doesn't export it.
- stdout stays the JSON-RPC channel only (`cli.ts:22-28`).
- One PR per phase. Phase 1 is a pure SDK swap with legacy behaviour unchanged. Phase 2 turns on modern serving. Phase 3 is Swift. Each one ships on its own.
- Comment density and voice match the surrounding files.

## Review Focus

1. **`listing.ts`'s `execution.taskSupport` paragraph** (`packages/core/src/listing.ts:18-33`). It keeps `"forbidden"` on purpose because v1 stamps it on every tool. v2 removed experimental tasks (SEP-2663, per the upgrade guide). Re-measure what v2's `tools/list` actually emits, in both eras, and rewrite the paragraph to match. Don't assume either way.
2. **`$schema` stamping.** The trim exists because v1's generator stamps draft-07 on every `inputSchema` (4,836 B across eight servers). v2 converts through zod's `~standard.jsonSchema` and advertises draft 2020-12. Re-measure, and keep the trim only if there's still something to trim.
3. **Error texts.** v2 renames `McpError` to `ProtocolError`, re-emits `-32002` as `-32602`, and changes the default "Resource not found" message. Tests that pin strings need re-baselining against codes and URIs, not just updating.
4. **Tools registered without `inputSchema`.** In v2 the callback receives the *context* as its only argument, not an args object. Any zero-argument tool whose handler reads `args` breaks silently. Grep for them in Phase 1.
5. **Client identity on a modern connection.** `RequestObserver.swift:213` names a session from `initialize`'s `clientInfo` alone. A modern client never sends `initialize`, so its session would show unnamed in Connections. Phase 3, Task 7.

---

## Phase 1: SDK swap, legacy behaviour unchanged

### Task 1: Spike the codemod on core + one surface

**Files:** a throwaway branch. Nothing from this task is merged.

- [ ] **Step 1:** On a clean tree, run `npx @modelcontextprotocol/codemod@latest v1-to-v2 packages/core packages/notes`. Then `grep -rn '@mcp-codemod-error' packages/core packages/notes`.
- [ ] **Step 2:** Record what the codemod didn't do. Its README says manifests are reported, not applied, and that `Transport` / `JSONRPCMessage` (in `listing.ts:1-2`), `GetPromptResult` (`prompts.ts:2`) and the `inMemory.js` → `InMemoryTransport` from `@modelcontextprotocol/server` change need checking.
- [ ] **Step 3:** Capture a legacy-era transcript with v1 and with v2 for notes: `initialize`, `tools/list` with writes off and on, one `tools/call`, one `resources/read`, one unknown resource. Diff them. This diff is the spec for Tasks 2-3. Write it into the PR description.

### Task 2: Core

**Files:** `packages/core/package.json:52`, `packages/core/src/{cli,facade,listing,prompts,resources}.ts`, `packages/core/test/*.test.ts`

- [ ] **Step 1:** Swap the dependency. Replace `@modelcontextprotocol/sdk` with `@modelcontextprotocol/server`, plus `@modelcontextprotocol/client` as a devDependency for tests.
- [ ] **Step 2:** Run the codemod, then fix what Task 1 found by hand.
- [ ] **Step 3:** `listing.test.ts` asserts the trim on v2's real output (Review Focus 1-2).
- [ ] **Step 4:** `pnpm --filter @mgcrea/mcp-apple-core test`. Expected: PASS, with any re-baselines justified in the diff.

### Task 3: The eight surfaces

**Files:** `packages/{notes,messages,safari,mail,maps,contacts,reminders,calendar}/package.json` (each pins `^1.30.0`), the 64 `import type { McpServer }` and 13 value imports from `server/mcp.js`, and the 36 test files on `client/index.js` + `inMemory.js`

- [ ] **Step 1:** Codemod each package, one commit per package. Most call sites go through core's facade (`facade.ts:96-100,427`), so expect type-import churn more than logic.
- [ ] **Step 2:** Grep for zero-argument tools (Review Focus 4) and fix their handlers.
- [ ] **Step 3:** `pnpm test` across the workspace, `make chat-check-real` (every shipped schema still converts), `make smoke`, and the Task 1 transcript diff for each surface.

## Phase 2: Serve 2026-07-28 from the npm servers

### Task 4: `serveStdio` in `runStdioServer`

**Files:** `packages/core/src/cli.ts:55`

- [ ] **Step 1:** Replace `server.connect(withTrimmedListing(new StdioServerTransport()))` with `serveStdio(() => server, { transport: withTrimmedListing(new StdioServerTransport()) })`. stdio has one connection per process, so the factory hands back the server already built by `opts.start`. Assert it's called once, and fail loudly if not.
- [ ] **Step 2:** Leave `legacy` at its default of `'serve'`. `'reject'` would break every current host.
- [ ] **Step 3:** Add an era test in core that spawns `dist/cli.js` of one surface, sends `server/discover`, and gets a `DiscoverResult`. Then spawn it again, send `initialize`, and confirm the same answer as Phase 1. `InMemoryTransport.createLinkedPair()` connects 2025-era instances only (per the v2 guide), so the modern test has to run over real stdio.
- [ ] **Step 4:** Extend `make smoke` (`Makefile:234-237`, which today sends only `initialize`) with a `server/discover` line through the bridge for each npm surface.

## Phase 3: Make the in-app surfaces dual-era

### Task 5: `server/discover` and `_meta` in `InProcessRPC.dispatch`

**Files:** `apps/apple/Cupertino/InProcessRPC.swift:18,73-109`, `scripts/{screen,sound,desktop,simulator}-check.swift`

- [ ] **Step 1:** Read the 2026-07-28 schema for `DiscoverResult` and the `_meta` keys that carry protocol version, client identity and capabilities (spec `basic/index#meta`, `server/discover`). Copy the field names from the schema, not from this plan. None are spelled out here because none were checked against the schema.
- [ ] **Step 2:** Write the failing checks, in each surface's `*-check.swift`:
  - `server/discover` returns the supported versions (`2026-07-28` plus the legacy one), capabilities, `serverInfo` and the `instructions` that `initialize` carries today.
  - A modern request with an unsupported version in `_meta` returns `-32022` with `data.supported` / `data.requested` (spec example).
  - `initialize` still answers exactly as now.
- [ ] **Step 3:** Implement it. Era selection follows the spec: a request carrying modern `_meta` is served statelessly, and `initialize` selects legacy for the connection. The current `-32601` for an unknown method stays, since it's what makes a dual-era *client* fall back correctly today.
- [ ] **Step 4:** Revisit `protocolVersion = "2024-11-05"` (`:18`). Its comment says it "matches what the node servers negotiate". After Phase 1 that may no longer be true. Measure what v2 answers to a `2025-11-25` `initialize`, and match it.

### Task 6: Bridge pass-through

- [ ] **Step 1:** Confirm that `cupertino-bridge` and `ServerHost` relay a modern opening untouched. Nothing should depend on the first line being `initialize`. Check the handshake line (`BridgeProtocol.swift`), the pump and `RequestObserver` for npm and in-app surfaces alike, and test it with the Task 4 smoke line.

### Task 7: Name modern sessions

**Files:** `apps/apple/Cupertino/RequestObserver.swift:211-217`, `Sessions.swift:20-24,111`

- [ ] **Step 1:** If a request carries the client-identity `_meta` key (from Task 5 Step 1), name the session from it the first time it's seen, as `initialize` does now. Keep the `initialize` path.
- [ ] **Step 2:** Update the doc comments at `Sessions.swift:20-24` and `RequestObserver.swift:211-212`. They say the handshake is "the only place a client says who it is", which stops being true.

## Done when

- `rg -n '"@modelcontextprotocol/sdk"' packages/*/package.json` returns nothing.
- For every surface, npm and in-app, through the bridge: `initialize` answers as it did on 1.30.0, and `server/discover` answers a `DiscoverResult`.
- CHANGELOG: "Every surface now also speaks the 2026-07-28 MCP protocol; older clients see no change."

## Open questions carried from the reports

- **Does any host Cupertino supports speak 2026-07-28 only?** None found as of 2026-10-24. If one appears, Phase 3 moves ahead of Phase 1. In-app surfaces don't depend on the SDK, so they can go dual-era first.
