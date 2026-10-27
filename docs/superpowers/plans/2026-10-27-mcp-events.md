# MCP Events (experimental) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the draft MCP Events extension (SEP-3415) on Mail and Messages: `events/list`, `events/poll` and `events/stream` over stdio, on 2026-07-28 connections, behind off-by-default gates. Then grade it against the Working Group's conformance suite and draft a field report.

**Architecture:**

- **Core** gets a pure engine (`events.ts`): descriptors, the cursor codec, and a stateless scan over the existing `ArrivalSource`. It also gets a registration module (`event-handlers.ts`), which wires the three methods onto an `McpServer` through SDK v2's custom-method `setRequestHandler`.
- **Each surface** supplies an `EventTypeAdapter`, built on its own instance of the existing watch service: that service already opens its own store handle, supplies the source, starts the file trigger and resolves arguments.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` 2.4.0 (SDK v2), vitest, `node:test` for the script tests, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-27-mcp-events-design.md`. Read it first. The SEP text is at https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415 (`seps/0000-events-extension.md`).

## Global Constraints

- The extension identifier is `io.modelcontextprotocol/events`. The capability is `capabilities.extensions["io.modelcontextprotocol/events"]: {}`, with no `listChanged`.
- It is served on the modern era only. On a legacy instance, and on any instance with the gate off, nothing is declared and every `events/*` method answers `-32601`.
- The gates are `APPLE_MAIL_ALLOW_EVENTS` and `APPLE_MESSAGES_ALLOW_EVENTS`, config key `allowEvents`, default `false`.
- The event names are `mail.received` (Mail) and `messages.received` (Messages). `delivery` is `["poll","push"]`.
- **Error codes:**
  - `InvalidParams` `-32602`
  - `NotFound` `-32023`, with `data.kind: "event"`
  - `ResourceExhausted` `-32025`, with `data.limit: "streams"` and `data.max: 10`
  - `Unsupported` `-32026`, with `data.feature: "deliveryMode"`
- **Cursor:** `v1.<dev>-<ino>.<rowid>`. `null` or absent means now.
- **Limits:**
  - `maxEvents`: default 50, capped at 50.
  - Scan limit: 1,000 rows per call.
  - `nextPollMs`: 10000.
  - Heartbeat: every 25000 ms.
  - At most 10 concurrent streams per connection.
- **Payload, envelope only:**
  - Mail: `ref`, `mailbox`, `senderAddress`, `senderName`, `subject`, `dateReceived`.
  - Messages: `id`, `chat`, `handle`, `date`.
- **Occurrence fields:**
  - `eventId`: Mail's `global_message_id` (the row's `key`), the Messages `guid` (the row's `key`).
  - `timestamp`: the received date.
- **Filter:** an empty filter is `InvalidParams`, whatever the caller. The `inputSchema` uses `anyOf: [{required:["from"]},{required:["domains"]}]`.
- **Gates off:** every server behaves byte for byte as today.
- **Platform:** scripts committed to the repo must work with BSD tools. GNU shortcuts are fine only in throwaway shell work.

## Review Focus

- **The index is rebuilt or replaced while a stream is open.** The stream stays open and sends a fresh `notifications/events/active` with `truncated: true` and a new cursor. It does not error, and it does not go silent. Test in Task 4.
- **A cancel arrives while a scan is in flight.** No `notifications/events/*` frame for that stream is written after the cancel. Test in Task 4.
- **A cursor minted by another store,** whether the other surface or a rebuilt index, is answered with `truncated: true` and a fresh head cursor, not an error. A malformed cursor is the only `InvalidParams`. Test in Task 2.
- **Mail is closed, so the mailbox lookup has never loaded.** A poll returns no events and does not move the cursor past rows that were never judged. Test in Task 5.
- **Watches and events are on together.** They use separate service instances and store handles, and closing the connection closes both. Test in Task 5.

---

### Task 1: Spike SDK v2's handling of a long-lived custom request over stdio

**Files:**

- Create: `scripts/spike-events-stream.mjs`. It is a throwaway, committed beside `scripts/spike-watch-arrivals.mjs`.
- Create: `docs/superpowers/reports/2026-10-27-mcp-events-field-report.md`, the section "SDK v2 2.4.0 findings" only.

**Interfaces:**

- Produces: a written finding for each of the four questions below, plus the workaround a later task must apply if any answer is no.

- [ ] **Step 1: Write the spike script.**
  - The server: `serveStdio` with `McpServer`. It registers `events/stream` through the three-argument `server.server.setRequestHandler("events/stream", {params, result}, handler)`. The handler sends `notifications/events/active`, then one `notifications/events/heartbeat` per second. Every frame carries `_meta["io.modelcontextprotocol/subscriptionId"]` set to the request id. The handler resolves only when `ctx.mcpReq.signal` aborts.
  - The client: a spawn of that server, which opens modern-era (the same `_meta` as `scripts/mcp-era.test.mjs` `session()`), sends `events/stream`, waits 5 s, then sends `notifications/cancelled` for that id.
- [ ] **Step 2: Run it** with `node scripts/spike-events-stream.mjs`. Record:
  1. whether the request stays open for 5 s or more;
  2. whether heartbeats reach stdout, so the listen router passed them through;
  3. whether the cancel aborts the handler's signal;
  4. whether any request timeout or cap ended it early. Open 11 streams to check.
- [ ] **Step 3: Write the findings section** of the field report. For each "no", name the workaround the later tasks use. A transport wrapper in the style of `withTrimmedListing` in `packages/core/src/cli.ts` is the default.
- [ ] **Step 4: Commit:** `git commit -m "spike(events): check SDK v2 holds a long-lived events/stream over stdio"`.

### Task 2: Core engine (pure)

**Files:**

- Create: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/test/events.test.ts`

**Interfaces:**

- Consumes: from `watches.ts`, `ArrivalRow`, `ArrivalSource<R>`, `WatchFilter`, `matchesSender`, `inScope` and `FileIdentity`.
- Produces:

  ```ts
  export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";
  export const EVENTS_ERRORS = {
    NotFound: -32023,
    ResourceExhausted: -32025,
    Unsupported: -32026,
  } as const;
  export type EventDescriptor = {
    name: string;
    description: string;
    delivery: ("poll" | "push")[];
    inputSchema: Record<string, unknown>;
    payloadSchema: Record<string, unknown>;
  };
  export type EventOccurrence = {
    eventId: string;
    name: string;
    timestamp: string;
    data: Record<string, unknown>;
    cursor?: string | null;
  };
  export type EventTypeAdapter<R extends ArrivalRow> = {
    descriptor: EventDescriptor;
    parseArguments(args: unknown): Promise<WatchFilter>; // throws ProtocolError InvalidParams
    occurrence(row: R): { eventId: string; timestamp: string; data: Record<string, unknown> };
    timestampMs(row: R): number | null;
    source: ArrivalSource<R>;
    ensure(): Promise<void>;
    identity(): FileIdentity | null;
    startTrigger(onChange: () => void): { stop(): void };
  };
  export const encodeCursor: (store: FileIdentity, rowid: number) => string;
  export const decodeCursor: (cursor: string) => { store: FileIdentity; rowid: number }; // throws InvalidParams
  export const resolveStart: (
    cursor: string | null | undefined,
    store: FileIdentity | null,
    head: number,
  ) => { from: number; truncated: boolean };
  export type ScanResult<R> = { rows: R[]; cursor: number; truncated: boolean; hasMore: boolean };
  export const scanEvents: <R extends ArrivalRow>(
    adapter: Pick<EventTypeAdapter<R>, "source" | "timestampMs">,
    filter: WatchFilter,
    from: number,
    opts: { maxEvents: number; scanLimit: number; floorMs?: number | undefined },
  ) => ScanResult<R>;
  ```

- [ ] **Step 1: Write the failing tests** in `packages/core/test/events.test.ts`. Use a fake `ArrivalSource` over an array, as `watches.test.ts` does.
  - `encodeCursor then decodeCursor round-trips`: `decodeCursor(encodeCursor({dev:1,ino:2},42))` deep-equals `{store:{dev:1,ino:2},rowid:42}`, and the string is `"v1.1-2.42"`.
  - `decodeCursor refuses garbage`: `"x"`, `"v2.1-2.3"`, `"v1.1-2.-4"` and `"v1.a-2.3"` each throw an error with `code === -32602`.
  - `resolveStart: null is now`: `resolveStart(null, id, 90)` gives `{from:90,truncated:false}`.
  - `resolveStart: a cursor from another store resets`: a cursor for `{dev:9,ino:9}` against store `{dev:1,ino:2}` with head 90 gives `{from:90,truncated:true}`.
  - `resolveStart: a rowid above head resets`: `encodeCursor(id,120)` with head 90 gives `{from:90,truncated:true}`.
  - `resolveStart: a valid cursor resumes`: `encodeCursor(id,40)` with head 90 gives `{from:40,truncated:false}`.
  - `scanEvents skips excluded and unmatched rows, cursor is the last row examined`: rows 41–45, where 42 is excluded, 43 is from another sender, and 44 and 45 match. The result is rows `[44,45]`, `cursor: 45`, `hasMore: false`.
  - `scanEvents stops at maxEvents with hasMore`: with 5 matching rows and `maxEvents: 2`, the result is 2 rows, `cursor` equals the second match's cursor, and `hasMore: true`.
  - `scanEvents stops at scanLimit with hasMore`: with 3 non-matching rows and `scanLimit: 2`, the result is no rows, `cursor` is the 2nd row's cursor, and `hasMore: true`.
  - `scanEvents floors by maxAge`: rows timestamped 1000, 2000 and 3000, with `floorMs: 2500`, give only the 3000 row and `truncated: true`. With `floorMs: 500` the result has all three and `truncated: false`.
- [ ] **Step 2: Run** `pnpm -C packages/core test events`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `packages/core/src/events.ts`.** `scanEvents` follows `WatchRegistry.read`: the cursor is the last row examined, not the last match. A row whose `timestampMs` is non-null and below `floorMs` is skipped, and the result is then `truncated`. Throw InvalidParams through the SDK's `ProtocolError`, imported from `@modelcontextprotocol/server` the way `watch-resources.ts` builds its `-32602`.
- [ ] **Step 4: Run** `pnpm -C packages/core test events && pnpm -C packages/core typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(core): add the events engine: cursor codec, start resolution and scan"`.

### Task 3: Register `events/list` and `events/poll`

**Files:**

- Create: `packages/core/src/event-handlers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/event-handlers.test.ts`

**Interfaces:**

- Consumes: everything in Task 2's Produces block.
- Produces:

  ```ts
  export type EventsOptions = {
    era: Era;
    adapters: EventTypeAdapter<any>[];
    nextPollMs?: number; // default 10000
    heartbeatMs?: number; // default 25000 (Task 4)
    maxStreams?: number; // default 10 (Task 4)
  };
  /** No-op on the legacy era. Returns a closer for the connection's onclose. */
  export const registerEvents: (server: McpServer, opts: EventsOptions) => { close(): void };
  ```

- [ ] **Step 1: Write the failing tests.** Use an `InMemoryTransport` pair and a modern-era client, as `packages/core/test/watch-resources.test.ts` sets up its modern case. Give it a fake adapter named `test.received`, with `parseArguments` requiring `domains`, and the fake source from Task 2.
  - `declares the extension on modern`: the server's discover result has `capabilities.extensions["io.modelcontextprotocol/events"]` deep-equal to `{}`.
  - `legacy era: nothing declared, events/list is -32601`.
  - `events/list returns the descriptor`: `events[0].name === "test.received"`, `delivery` deep-equals `["poll","push"]`, `resultType === "complete"`, and there is no `nextCursor`.
  - `poll with null cursor bootstraps`: `{events:[], cursor: encodeCursor(id, head), truncated:false, hasMore:false, nextPollMs:10000}`.
  - `poll resumes and maps occurrences`: after appending two matching rows, polling with the bootstrap cursor returns 2 events. Each has `eventId`, `name:"test.received"`, an ISO `timestamp`, and `data`. `cursor` advances.
  - `poll unknown name`: error `-32023` with `data.kind === "event"`.
  - `poll invalid arguments`: `{}` gives error `-32602`.
  - `poll caps maxEvents at 50`: with 60 matching rows and `maxEvents: 100`, the result has 50 events and `hasMore: true`.
- [ ] **Step 2: Run** `pnpm -C packages/core test event-handlers`. Expected: FAIL.
- [ ] **Step 3: Implement `registerEvents`, list and poll only.**
  - Call `server.server.registerCapabilities({extensions:{[EVENTS_EXTENSION_ID]:{}}})` on modern only.
  - Register each method with the three-argument `setRequestHandler(method, {params, result}, handler)`, using zod schemas for the params.
  - In poll: `await adapter.ensure()`, then `resolveStart`, then `scanEvents` with `scanLimit: 1000`. The cursor is `encodeCursor(identity, result.cursor)`.
- [ ] **Step 4: Run** `pnpm -C packages/core test event-handlers && pnpm -C packages/core typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(core): serve events/list and events/poll on the 2026 era"`.

### Task 4: `events/stream` (push)

**Files:**

- Modify: `packages/core/src/event-handlers.ts`
- Test: `packages/core/test/event-handlers.test.ts`

**Interfaces:**

- Consumes: Task 3's `registerEvents`, and the adapter's `startTrigger`.
- Produces: the stream behaviour. `registerEvents(...).close()` now also stops every open stream and its trigger.

- [ ] **Step 1: Write the failing tests.** Use the fake adapter, whose `startTrigger` captures `onChange` so the test can fire it. Use vitest fake timers for the heartbeat.
  - `stream sends active first`: the first frame is `notifications/events/active` with `cursor`, `truncated:false`, and `_meta["io.modelcontextprotocol/subscriptionId"]` equal to the request id.
  - `stream delivers on trigger`: after appending a matching row and calling `onChange()`, one `notifications/events/event` frame arrives with `cursor` set and the same subscription id.
  - `stream heartbeats with the scanned cursor`: advancing 25000 ms gives one `notifications/events/heartbeat` frame whose `cursor` is the current head cursor.
  - `stream rebuild resets with truncated`: make `identity()` return a new inode and fire `onChange`. Expect a fresh `notifications/events/active` with `truncated:true`. The stream stays open.
  - `stream read failure is a recoverable error`: make the source's `since` throw once and fire `onChange`. Expect one `notifications/events/error` with code `-32603`. A later `onChange` with a matching row still delivers.
  - `cancel stops delivery`: send `notifications/cancelled`, then append a matching row and fire `onChange`. Expect no further frame for that id.
  - `cancel mid-scan writes nothing after`: the source's `since` cancels the request from inside, before returning rows. Expect no event frame.
  - `eleventh stream is refused`: 10 streams open, and the 11th errors with `-32025` and `data` `{limit:"streams",max:10}`.
  - `poll-only descriptor refuses stream`: an adapter whose `delivery` is `["poll"]` gives `-32026` with `data.feature === "deliveryMode"`.
- [ ] **Step 2: Run** `pnpm -C packages/core test event-handlers`. Expected: FAIL.
- [ ] **Step 3: Implement the stream.**
  - Each stream holds its own cursor, a heartbeat `setInterval(...).unref()`, and one shared trigger per adapter. Start the trigger with the first stream and stop it with the last.
  - Each `onChange` scans every open stream of that adapter from its own cursor.
  - The handler resolves when the abort signal fires.
  - Apply any Task 1 workaround here.
- [ ] **Step 4: Run** `pnpm -C packages/core test && pnpm -C packages/core typecheck`. Expected: PASS, including the existing watch tests.
- [ ] **Step 5: Commit:** `git commit -m "feat(core): push events over a long-lived events/stream with heartbeats and cancel"`.

### Task 5: Mail adapter, gate and wiring

**Files:**

- Create: `packages/mail/src/tools/events.ts`
- Modify:
  - `packages/mail/src/tools/watch.ts`: add `identity(): FileIdentity | null`, and extract `resolveMailboxScope(mailboxes: string[]): Promise<string[]>` from `add()`. `add()` then calls it.
  - `packages/mail/src/config.ts`: add `allowEvents`, read from `APPLE_MAIL_ALLOW_EVENTS`.
  - `packages/mail/src/server.ts`: when `config.allowEvents` is on, use a **separate** `MailWatchService` and call `registerEvents`. `onclose` closes it as well as the watches.
  - `surfaces.json`: add the Mail gate `{"id":"allowEvents","envSuffix":"ALLOW_EVENTS","label":"Experimental: MCP Events for incoming mail","description":"Serves the draft MCP Events extension (mail.received) to clients on the 2026 protocol. Off by default."}`. Then run `make surfaces`.
- Test: `packages/mail/test/events.test.ts` and `scripts/mcp-era.test.mjs`.

**Interfaces:**

- Consumes: `registerEvents` and `EventTypeAdapter`, from Tasks 2–4.
- Produces: `export const mailEventAdapter: (service: MailWatchService) => EventTypeAdapter<MailArrival>`. Its descriptor `name` is `"mail.received"`. Its `inputSchema` has the properties `from`, `domains` and `mailboxes`, each an array of strings with the same descriptions as the `apple_mail_watch` tool, plus the `anyOf` from Global Constraints.

- [ ] **Step 1: Write the failing unit tests** in `packages/mail/test/events.test.ts`. Build the service as `packages/mail/test` builds `MailWatchService` for the watch tests, with a fixture index and an injected `isMailRunning`.
  - `parseArguments refuses an empty filter`: error `-32602`.
  - `parseArguments resolves mailboxes to scope keys`: `{domains:["acme.com"], mailboxes:["INBOX"]}` gives a `scope` equal to the fixture's INBOX rowid as a string.
  - `occurrence maps a row`: `eventId` is the row `key` (`global_message_id`), `timestamp` is `dateReceived`, and `data` has exactly `ref`, `mailbox`, `senderAddress`, `senderName`, `subject` and `dateReceived`.
  - `Mail closed: poll does not advance past unjudged rows` (Review Focus): with the lookup never loaded, a poll from a cursor returns no events and the same cursor.
  - `watches and events on together are independent` (Review Focus): with both gates on, a watch tool call and a poll each work, and `server.server.onclose()` closes both services' index handles.
- [ ] **Step 2: Write the failing end-to-end tests** in `scripts/mcp-era.test.mjs`, reusing `mailFixture()`, `mailEnv()` and `session()`. Set `env.APPLE_MAIL_ALLOW_EVENTS = "1"`.
  - `modern: events/poll delivers matching mail`: bootstrap poll, `fx.arrive(102)`, then polling with that cursor gives one event with `name === "mail.received"` and `data.senderAddress === "jo@acme.com"`.
  - `modern: events/stream pushes matching mail`: open a stream, wait for `active`, `fx.arrive(103)`, then expect `notifications/events/event` within 10 s. Then cancel.
  - `legacy: events/list is method not found` (`-32601`).
  - `gate off: events/list is method not found on modern` (`-32601`).
- [ ] **Step 3: Run** `pnpm -C packages/mail test events`, then build and run the end-to-end file: `pnpm -C packages/mail build && node --test --test-reporter=tap scripts/mcp-era.test.mjs`. Expected: FAIL.
- [ ] **Step 4: Implement** the adapter, the service accessors, the config, the wiring and the surfaces entry. `timestampMs` is `Date.parse(dateReceived)`, or `null`.
- [ ] **Step 5: Run** `pnpm -C packages/mail test && pnpm -C packages/mail typecheck && pnpm -C packages/mail build && node --test --test-reporter=tap scripts/mcp-era.test.mjs && make surfaces-check`. Expected: all PASS.
- [ ] **Step 6: Commit:** `git commit -m "feat(mail): serve mail.received events behind APPLE_MAIL_ALLOW_EVENTS"`.

### Task 6: Messages adapter, gate and wiring

**Files:**

- Create: `packages/messages/src/tools/events.ts`
- Modify:
  - `packages/messages/src/tools/watch.ts`: add `identity()`.
  - `packages/messages/src/config.ts`: add `allowEvents`, read from `APPLE_MESSAGES_ALLOW_EVENTS`.
  - `packages/messages/src/server.ts`: a separate `MessagesWatchService` and `registerEvents`, as Task 5.
  - `surfaces.json`: add the Messages gate, with the label "Experimental: MCP Events for incoming messages" and the matching description. Then run `make surfaces`.
- Test: `packages/messages/test/events.test.ts`

**Interfaces:**

- Consumes: Tasks 2–4.
- Produces: `export const messagesEventAdapter: (service: MessagesWatchService) => EventTypeAdapter<MessageArrival>`. Its descriptor `name` is `"messages.received"`, and its `inputSchema` has `from` and `domains` with the `apple_messages_watch` descriptions.
  - `parseArguments` normalizes `from` through `service.resolveFrom`. The poll result has no place for `unresolved` handles, so they are kept silently.

- [ ] **Step 1: Write the failing tests:**
  - `parseArguments refuses an empty filter` (`-32602`);
  - `occurrence maps a row`: `eventId` is the `guid`, and `data` has exactly `id`, `chat`, `handle` and `date`;
  - `poll delivers a matching message from a fixture chat.db`, built as the existing Messages watch tests build it;
  - `own messages and tapbacks produce no event`.
- [ ] **Step 2: Run** `pnpm -C packages/messages test events`. Expected: FAIL.
- [ ] **Step 3: Implement** the adapter, the accessor, the config, the wiring and the surfaces entry.
- [ ] **Step 4: Run** `pnpm -C packages/messages test && pnpm -C packages/messages typecheck && make surfaces-check`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(messages): serve messages.received events behind APPLE_MESSAGES_ALLOW_EVENTS"`.

### Task 7: Conformance run and field report

**Files:**

- Create: `scripts/events-conformance.mjs`. It is test-only and not part of any package's `files`.
- Modify: `docs/superpowers/reports/2026-10-27-mcp-events-field-report.md`

**Interfaces:**

- Consumes: Mail's built `dist` (`createServer` with `era`), and `createMcpHandler(factory)` from `@modelcontextprotocol/server`.
- Produces: an HTTP endpoint at `http://127.0.0.1:<port>/mcp`, and the graded results.

- [ ] **Step 1: Write the harness.**
  - It serves `createMcpHandler(() => createServer({config, era:"modern", osascript}))` through `node:http` on `127.0.0.1`, on the port in `EVENTS_PORT` (default 3917).
  - The fixture index and stub `osascript` are built the same way as `mailFixture()` in `scripts/mcp-era.test.mjs`. Lift that into a shared helper only if the duplication is more than the fixture SQL.
  - The gates are on.
  - It inserts one matching row (`jo@acme.com`) every 2 s, so the occurrence checks inside the suite's 6 s wait have an event to see.
- [ ] **Step 2: Fetch the suite** into the scratchpad (outside the repo):
  1. `gh repo clone panyam/mcpconformance <scratch>/mcpconformance`
  2. `git -C <scratch>/mcpconformance checkout 23c7c2d2f81f92ac2bcb89e1e6cb5198d6b2eced`
  3. `npm ci` there.
- [ ] **Step 3: Run each scenario** against the harness: `EVENTS_ARGUMENTS='{"mail.received":{"domains":["acme.com"]}}' npm start -- server --url http://127.0.0.1:3917/mcp --scenario <s>`, for `events-discovery`, `events-poll` and `events-push`. Save each output to the scratchpad. Expected: every non-webhook row passes or carries a stated reason.
- [ ] **Step 4: Fix any failing row that is ours,** with a test in the owning task's test file that pins it, and commit each fix on its own. A failure that comes from the suite or the SEP goes in the report instead.
- [ ] **Step 5: Complete the field report.**
  - The results table: scenario, pass, fail, untestable, excluded.
  - Each failure, with whether it is ours, the suite's or the SEP's.
  - The Task 1 findings.
  - What a local, stdio, ROWID-cursored source taught us: cursor identity across rebuilds, `maxAgeMs` against a store with full history, and the cost of the "sender required" rule against `minimalArguments`.
  - Comments on open questions 1, 2 and 5.
  - The rows on HTTP routing headers grade only the harness.
  - It ends with "Posting this is Olivier's call".
- [ ] **Step 6: Commit:** `git commit -m "test(events): grade against the SEP-3415 conformance suite and draft the field report"`.

### Task 8: Docs

**Files:**

- Modify: `README.md` (the Mail and Messages sections, beside the watch lines), `packages/mail/README.md` and `packages/messages/README.md` (configuration tables), `docs/prompts-and-resources.md` (a new "Events (experimental)" section after Watches), `CHANGELOG.md` (an Unreleased `### Added` entry marked experimental), and `apps/apple/Cupertino/Changelog.swift`, through `node scripts/generate-changelog.mjs`.

- [ ] **Step 1: Write the docs.**
  - **Gates:** both are off by default and serve the 2026 protocol only.
  - **What exists:** the two event types and their delivery modes, poll and push.
  - **Where it stands:** the extension is a draft, and no client consumes it yet. Link SEP-3415 and the field report.
  - **Watches** are unchanged.
- [ ] **Step 2: Run** `node scripts/generate-changelog.mjs && node scripts/generate-changelog.mjs --check && pnpm exec oxfmt --write <touched files> && pnpm lint && make surfaces-check`. Expected: clean.
- [ ] **Step 3: Commit:** `git commit -m "docs(events): document the experimental Events extension and its gates"`.
