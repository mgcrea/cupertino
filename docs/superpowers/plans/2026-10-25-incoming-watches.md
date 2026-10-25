# Incoming Watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP session can register "tell me when mail (or a message) arrives from these people or domains", subscribe to the handle it gets back, and receive `notifications/resources/updated` when a match lands. This works for 2025-era and 2026-era clients alike.

**Architecture:** A surface-agnostic watch registry, arrival trigger and MCP wiring live in core (`packages/core/src/watches.ts`, `watch-resources.ts`). Each surface supplies an arrival source, which is a `ROWID`-ordered query on its store, plus two tools. Delivery is SDK v2's job on a modern connection. On a legacy connection, the server's own `resources/subscribe` handlers gate it. The app records subscriptions and pushes in the Activity log.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` 2.x (`serveStdio`, `ResourceTemplate`, `sendResourceUpdated`), `node:sqlite`, `node:fs` `watch`, vitest, zod 4. Swift 6 for `CallCapture` and `RequestObserver`.

**Spec:** `docs/superpowers/specs/2026-10-25-incoming-watches-design.md`

## Global Constraints

- **Precondition:** Phases 1 and 2 of `docs/superpowers/plans/2026-10-25-mcp-v2-dual-era.md` are merged. Imports, error classes and test clients follow whatever that migration left in the neighbouring files. Where this plan names `McpServer`, `ResourceTemplate` or the SDK's protocol error, it means the v2 export of that name. Core's own `ProtocolError` in `errors.ts` is a different class.
- A sender filter is required: `from` or `domains` non-empty. There is no "all incoming" watch.
- At most 10 watches per connection. A read returns at most 50 matches, and one scan covers at most 1,000 rows.
- Trigger: `fs.watch` on the store's directory, filtered to the store and its `-wal`, debounced 500 ms, plus a 60 s poll.
- The store is opened `mode=ro` only. If only `immutable=1` opens, `watch` refuses with that reason.
- A watch read returns envelope metadata only, never bodies.
- An unknown watch id is a protocol error with code `-32602`. A failure reading a watch that exists is a `degraded` result via `guardedRead`.
- Gate `allowWatches`, OFF by default, env `APPLE_<SURFACE>_ALLOW_WATCHES`, declared in `surfaces.json`. It is independent of `exposePrompts`.
- URIs: `cupertino://<surface>/watch/<id>`, template `cupertino://<surface>/watch/{id}{?after}`. Ids look like `w_` plus 8 hex digits. Watch URIs never appear in `resources/list`.
- Comment density and voice match the surrounding files. Each task ends green on `pnpm -r test` and `pnpm lint`.

## Review Focus

1. **The server factory runs more than once.** `serveStdio` builds and discards an instance for a `server/discover` probe. A discarded instance must start no watcher and hold no file handle, so the trigger starts on the first `add`, never at construction. Task 4 pins it.
2. **A rebuilt store.** An index rebuilt with lower `ROWID`s must reset the mark without notifying, and must keep firing for later arrivals. Task 2 pins it with a source whose head drops below the mark.
3. **Your own reply in Gmail.** A domain watch on a correspondent's domain must not fire on mail you sent, which Gmail files under All Mail. Task 5 pins it.
4. **A burst of arrivals.** A 40-message sync must produce one notification per watch, not 40. Task 3 pins the debounce and Task 2 pins the one-notify-per-tick rule.
5. **Unsubscribed legacy URIs.** On a 2025 connection, a watch nobody subscribed to must send nothing. Task 4 pins it.

---

### Task 1: Measure first

**Files:**

- Create: `scripts/spike-watch-arrivals.mjs`
- Modify: `docs/superpowers/specs/2026-10-25-incoming-watches-design.md` (the "Measure first" section)

- [ ] **Step 1: Write the spike.** Write `scripts/spike-watch-arrivals.mjs <dir> <db>`. It runs `fs.watch(dir)`, logs `{ at, event, filename }` for every event, and on each event (debounced 500 ms) opens `<db>` with `mode=ro` and times `SELECT max(ROWID) FROM messages` (Mail) or `FROM message` (Messages). It takes no Apple Events and does no driving.
- [ ] **Step 2: Run it against Mail.** Run `node scripts/spike-watch-arrivals.mjs ~/Library/Mail/V10/MailData "~/Library/Mail/V10/MailData/Envelope Index"` from a terminal holding Full Disk Access. Ask Olivier to send himself one mail. Record whether `Envelope Index-wal` fires, the delay from the mail showing in Mail to the event, and the query time.
- [ ] **Step 3: Run it against Messages.** Same as Step 2 with `~/Library/Messages` and `chat.db`, and one iMessage to self.
- [ ] **Step 4: Check whether Claude Code delivers updates.** Ask Olivier before touching any client config. Write a throwaway 20-line v2 server in the scratchpad that declares `resources.subscribe`, serves one resource and sends `notifications/resources/updated` for it every 60 s. Add it to Claude Code with `claude mcp add --scope local`, run a session for 3 minutes, and record whether anything reaches the model or the UI. Then remove the server.
- [ ] **Step 5: Confirm v2 has no built-in subscribe handler.** In the installed `@modelcontextprotocol/server`, find whether `McpServer` registers a `resources/subscribe` handler when `capabilities.resources.subscribe` is set. Record the file and line either way.
- [ ] **Step 6: Record and commit.** Write the four answers into the spec's "Measure first" items. If `fs.watch` never fired in Step 2 or 3, change the 60 s poll to 15 s in the spec and in this plan's Global Constraints before going on.

```bash
git add scripts/spike-watch-arrivals.mjs docs/superpowers/specs/2026-10-25-incoming-watches-design.md docs/superpowers/plans/2026-10-25-incoming-watches.md
git commit -m "docs(watches): measure arrival triggers and update delivery"
```

### Task 2: Watch filter and registry

**Files:**

- Create: `packages/core/src/watches.ts`
- Modify: `packages/core/src/index.ts` (export everything below)
- Test: `packages/core/test/watches.test.ts`

**Interfaces:**

- Produces:

```ts
export type WatchFilter = { from: string[]; domains: string[] };
export const normalizeFilter: (input: { from?: string[]; domains?: string[] }) => WatchFilter;
export const matchesSender: (filter: WatchFilter, sender: string | null) => boolean;
export const watchUri: (surface: string, id: string) => string; // surfaceUri(surface, `watch/${id}`)

/** `excluded` rows advance the cursor but never match: own mail, tapbacks, Junk. */
export type ArrivalRow = { cursor: number; key: string; sender: string | null; excluded?: boolean };
export type ArrivalSource<R extends ArrivalRow> = {
  /** Highest cursor in the store now. */
  head(): number;
  /** Rows with cursor > after, ascending, at most `limit`. */
  since(after: number, limit: number): R[];
};
export type Watch = { id: string; uri: string; filter: WatchFilter; createdAt: number };
export type WatchRead<R> = {
  watch: string;
  filter: WatchFilter;
  cursor: number;
  messages: R[];
  more: boolean;
};
export type WatchRegistryOptions<R extends ArrivalRow> = {
  surface: string;
  source: ArrivalSource<R>;
  onUpdate: (uri: string) => void;
  /** Task 3's trigger. Started on the first add, stopped on the last remove. */
  startTrigger?: (onChange: () => void) => { stop(): void };
  maxWatches?: number; // 10
  scanLimit?: number; // 1000
  readLimit?: number; // 50
  mintId?: () => string; // `w_${randomBytes(4).toString("hex")}`
};
export class WatchRegistry<R extends ArrivalRow> {
  constructor(opts: WatchRegistryOptions<R>);
  add(filter: WatchFilter): Watch;
  remove(id: string): boolean;
  read(id: string, after?: number): WatchRead<R> | null; // null = unknown id
  tick(): void;
  close(): void;
  get size(): number;
}
```

- [ ] **Step 1: Write the failing tests** in `packages/core/test/watches.test.ts`. Use an in-memory `ArrivalSource` over an array of rows the test can push to and delete from.
  - `normalizeFilter`: `{ from: [" Jo@Acme.com "], domains: ["@ACME.com", "acme.com"] }` → `{ from: ["jo@acme.com"], domains: ["acme.com"] }`. `{}` and `{ from: [], domains: [] }` throw `PreconditionError` with a message naming `from` and `domains`. More than 50 entries in total throws.
  - `matchesSender`: with `domains: ["acme.com"]`, `jo@acme.com` and `jo@eu.acme.com` match. `jo@notacme.com` and `acme.com@evil.io` do not. Matching is case-insensitive. `null` never matches.
  - `add`: returns `uri === "cupertino://mail/watch/w_00000001"` with an injected `mintId`, and `createdAt === source.head()`. The 11th `add` throws `PreconditionError` containing `"10 watches"`.
  - `tick`: push 40 rows, 3 of them matching watch A and none matching B. One `tick()` calls `onUpdate` exactly once, with A's URI.
  - `tick` with `excluded: true` on a matching row: no `onUpdate`. The next `tick` does not re-scan that row.
  - **Rebuilt store:** the source is at head 10 and a watch exists. Empty it and push 3 matching rows. `tick()` calls nothing. One more matching row, then `tick()` calls `onUpdate` once.
  - `read(id)`: returns matches after `createdAt`, oldest first. With 60 matches it returns 50, `more: true`, and `cursor` equals the 50th row's cursor. With 1,200 rows of which 2 match, it returns the matches found in the first 1,000 rows, `more: true`, and `cursor` equals row 1,000's cursor (the last row scanned). `read(id, cursor)` resumes after it.
  - `read("w_nope")` returns `null`.
  - `startTrigger` is called once on the first `add` and its `stop` once when `remove` brings `size` to 0. Constructing a registry never calls it.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-core test -- watches`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `watches.ts`.** `tick` loops `since(mark, scanLimit)` in batches until a batch comes back short, then sets the mark to the last cursor scanned. If `head()` is below the mark the store was rebuilt, so it resets the mark and notifies nothing.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/watches.ts packages/core/src/index.ts packages/core/test/watches.test.ts
git commit -m "feat(core): watch registry over a ROWID-ordered arrival source"
```

### Task 3: Arrival trigger

**Files:**

- Modify: `packages/core/src/watches.ts`
- Test: `packages/core/test/watches.test.ts`

**Interfaces:**

- Produces:

```ts
export type TriggerOptions = {
  dir: string;
  /** Basenames that count, e.g. ["chat.db", "chat.db-wal"]. */
  names: string[];
  debounceMs?: number; // 500
  pollMs?: number; // 60_000 (or the value Task 1 settled on)
  watch?: typeof import("node:fs").watch; // injected by tests
  logger?: Logger;
};
export const fileTrigger: (opts: TriggerOptions) => (onChange: () => void) => { stop(): void };
```

- [ ] **Step 1: Write the failing tests.** Use `vi.useFakeTimers()` and a fake `watch` returning an `EventEmitter` with a `close` spy.
  - Five `change` events for `chat.db-wal` within 100 ms produce one `onChange` 500 ms after the last event.
  - An event for `chat.db-shm` or any other name produces nothing.
  - With no events, `onChange` fires at 60 s and again at 120 s.
  - A `watch` that throws is logged once through `logger.warn`, and the poll still fires.
  - `stop()` closes the watcher, clears both timers, and no `onChange` follows.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-core test -- watches`. Expected: FAIL, `fileTrigger` is not exported.
- [ ] **Step 3: Implement `fileTrigger`.** Call `fs.watch(dir, { persistent: false })`, so a watch never keeps the process alive after stdin closes. Filter on `filename`, debounce, and run an independent `setInterval` poll with `unref()`.
- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/watches.ts packages/core/test/watches.test.ts
git commit -m "feat(core): debounced file trigger with a polling floor"
```

### Task 4: MCP wiring for watches, and the era reaching the server

**Files:**

- Create: `packages/core/src/watch-resources.ts`
- Modify: `packages/core/src/resources.ts` (export `guardedRead`), `packages/core/src/cli.ts` (era into `start`), `packages/core/src/index.ts`
- Test: `packages/core/test/watch-resources.test.ts`

**Interfaces:**

- Consumes: `WatchRegistry`, `ArrivalSource`, `fileTrigger` from Tasks 2–3.
- Produces:

```ts
export type Era = "legacy" | "modern";
export type WatchesOptions<R extends ArrivalRow> = {
  surface: string;
  displayName: string;
  era: Era;
  source: ArrivalSource<R>;
  startTrigger?: WatchRegistryOptions<R>["startTrigger"];
};
/** Registers the template, declares resources.subscribe, adds legacy subscribe handlers. */
export const createWatches: <R extends ArrivalRow>(
  server: McpServer,
  opts: WatchesOptions<R>,
) => WatchRegistry<R>;
```

- `StdioServerOptions.start` becomes `(logger: Logger, ctx: { era: Era }) => Promise<{ server: McpServer; banner: string }>`.

- [ ] **Step 1: Write the failing tests** in `watch-resources.test.ts`. Use the in-memory client pair the v2 migration left in `resources.test.ts`, which connects in the legacy era, plus a fake source.
  - `listResources()` contains no `/watch/` URI after `add`. `listResourceTemplates()` contains `cupertino://widget/watch/{id}{?after}`.
  - The server's declared capabilities include `resources.subscribe: true`.
  - `readResource({ uri: "cupertino://widget/watch/w_nope" })` rejects with code `-32602`.
  - A source whose `since` throws makes `readResource` on a live watch resolve to `degraded: true`, not reject.
  - `readResource` on `…/watch/<id>?after=5` returns only rows with cursor > 5.
  - **Legacy, subscribed:** the client calls `subscribeResource({ uri })`, the source gains a match, and `registry.tick()` causes exactly one `notifications/resources/updated` with that URI.
  - **Legacy, not subscribed:** the same arrival with no subscribe produces no notification. After `unsubscribeResource`, none either.
  - **Modern:** with `era: "modern"`, a spy on the server's `sendResourceUpdated` is called on every update, unconditionally. Filtering is the SDK router's job.
  - Constructing via `createWatches` without any `add` never calls `startTrigger`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-core test -- watch-resources`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `createWatches`.**
  - Register a `ResourceTemplate` with `list: undefined`.
  - The read callback parses `after` as a non-negative integer. A bad `after` is `-32602`.
  - `read` returning `null` throws the SDK protocol error `-32602 "Resource not found"`, and `guardedRead` wraps everything else.
  - Declare the capability with `server.server.registerCapabilities`.
  - In the legacy era only, set request handlers for `resources/subscribe` and `resources/unsubscribe` over a `Set<string>`.
  - `onUpdate` sends when `era === "modern"` or the set has the URI.
- [ ] **Step 4: Move the server build into the factory.** In `cli.ts`, build the server inside `serveStdio`'s factory: `(ctx) => opts.start(logger, { era: ctx.era })`, logging the banner there. Remove the v2 plan's "factory called once" assertion and replace it with a test that a second factory call (the discover probe) builds a second server and starts nothing.
- [ ] **Step 5: Run the core tests and confirm they pass.** Run `pnpm --filter @mgcrea/mcp-apple-core test`. Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): serve watches as subscribable resources in both eras"
```

### Task 5: Mail arrival source

**Files:**

- Create: `packages/mail/src/client/watch.ts`
- Modify: `packages/mail/src/client/envelope.ts` (two methods on `EnvelopeIndex`)
- Test: `packages/mail/test/watch.test.ts` (seeded from `fixtures/envelope-index.sql` the way `envelope.test.ts` seeds it)

**Interfaces:**

- Produces:

```ts
// envelope.ts
export type ArrivalScanRow = {
  rowid: number; key: string; mailboxRowid: number; mailboxUrl: string;
  subject: string | null; senderAddress: string | null; senderName: string | null; dateReceived: number;
};
EnvelopeIndex.prototype.headRowid(): number;
EnvelopeIndex.prototype.arrivalsAfter(after: number, limit: number): ArrivalScanRow[]; // ROWID ASC

// watch.ts
export type MailArrival = ArrivalRow & {
  ref: string; mailbox: string; senderAddress: string | null; senderName: string | null;
  subject: string | null; dateReceived: string;
};
export const isUnwatchedMailbox: (mailboxUrl: string) => boolean;
export class MailArrivalSource implements ArrivalSource<MailArrival> {
  constructor(opts: { index: EnvelopeIndex; ownAddresses: Iterable<string>; mailboxRowids?: number[] });
}
export const isMailRunning: (exec?: ExecImpl) => Promise<boolean>; // `/usr/bin/pgrep -x Mail`, exit 0
```

- [ ] **Step 1: Write the failing tests.**
  - `isUnwatchedMailbox` is true for URL leaves `Sent Messages`, `Sent`, `Sent Mail`, `Sent Items`, `Drafts`, `Junk`, `Junk E-mail`, `Spam`, `Trash`, `Deleted Messages`, `Deleted Items`, `Bin`. It decodes percent-escapes and ignores case, including `imap://…/%5BGmail%5D/Sent%20Mail`. It is false for `INBOX`, `Archive` and `[Gmail]/All Mail`.
  - `arrivalsAfter(101, 10)` on the fixture returns rowids 102 onwards, ascending, with sender joined. `headRowid()` equals the max seeded ROWID.
  - The source marks `excluded: true` on a row in `Sent Messages`, and on a row in `[Gmail]/All Mail` whose sender is `me@icloud.com` when `ownAddresses` holds `ME@icloud.com`. An inbox row from `sam@example.com` is not excluded.
  - With `mailboxRowids: [2]`, every row outside mailbox 2 is excluded.
  - A test pins that the fixture's `messages` table is `AUTOINCREMENT`: a deleted top row's id is not reused by the next insert.
  - `key` is the row's `global_message_id`. `ref` is built the way search results build theirs (`client/ref.ts`), and `dateReceived` is rendered the way search renders it.
  - `isMailRunning` resolves true on exit 0 and false on exit 1, with an injected `exec`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-mail test -- watch`. Expected: FAIL.
- [ ] **Step 3: Implement.** `arrivalsAfter` reuses the `LEFT JOIN` set and subject expression `envelope.ts` already builds for listings, with `WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?`.
- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/mail/src/client packages/mail/test/watch.test.ts
git commit -m "feat(mail): arrival source over the Envelope Index"
```

### Task 6: Mail watch tools, gate and guide

**Files:**

- Create: `packages/mail/src/tools/watch.ts`
- Modify: `packages/mail/src/config.ts`, `packages/mail/src/server.ts`, `packages/mail/src/cli.ts`, `packages/mail/src/guide.ts`, `surfaces.json`, then the generated regions via `make surfaces`
- Test: `packages/mail/test/tools.test.ts`, `packages/mail/test/surface.test.ts`, `packages/mail/test/config.test.ts`

**Interfaces:**

- Consumes: `createWatches`, `normalizeFilter`, `fileTrigger` (core) and `MailArrivalSource`, `isMailRunning` (Task 5).
- Produces: `Config.allowWatches: boolean` from `APPLE_MAIL_ALLOW_WATCHES`, and `CreateServerOptions.era: Era` (default `"legacy"`, so existing tests are unchanged). Tools:
  - `apple_mail_watch({ from?: string[]; domains?: string[]; mailboxes?: string[] })` returns `{ watch, uri, filter, cursor, note? }`.
  - `apple_mail_unwatch({ watch: string })` returns `{ removed: boolean }`.
  - Both carry `readOnlyHint: true`.

- [ ] **Step 1: Write the failing tests.**
  - `config.test.ts`: `allowWatches` defaults to false, and `APPLE_MAIL_ALLOW_WATCHES=1` sets it.
  - `tools.test.ts`: with the gate off, neither tool is listed and capabilities have no `resources.subscribe`. With it on, both are listed even when `APPLE_MAIL_EXPOSE_PROMPTS=0`.
  - With the gate on and an empty filter, `watch` returns an error result naming `from` and `domains`.
  - With the gate on and the index opened `immutable` (fixture opened with `indexMode: "immutable"`), `watch` returns an error result containing `WAL`.
  - With the gate on and `isMailRunning` false, the result carries `note` saying Mail must be running for mail to arrive.
  - `mailboxes: ["Archive"]` resolves through the same resolver `searchMessages` uses for `mailbox`. An unknown name is an error result naming it.
  - `surface.test.ts`: after `watch`, `readResource(uri)` returns the shape the spec shows (`watch`, `filter`, `cursor`, `messages`, `more`).
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-mail test`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
  - `createServer` calls `createWatches` only when `config.allowWatches`. The source is a `MailArrivalSource` over `await client.index()`, created lazily on the first `watch` call so a discarded instance opens nothing.
  - `ownAddresses` comes from `client.accounts()` `emailAddresses`.
  - The trigger is `fileTrigger({ dir: dirname(envelopeIndexPath), names: ["Envelope Index", "Envelope Index-wal"] })`.
  - `cli.ts` passes `ctx.era` through.
  - In `surfaces.json` under mail, add `{ "id": "allowWatches", "envSuffix": "ALLOW_WATCHES", "label": "Watch for incoming mail", "description": "Lets a client register a watch on senders or domains and be notified when matching mail arrives. Off by default." }`. Run `make surfaces`, and check `make surfaces-check` and `pnpm test:scripts`.
- [ ] **Step 4: Add a guide section.** In `guide.ts`, add a "Watches" section: the filter is required; the host subscribes, not the model; `after` is the caller's to keep; Mail must be running; reads carry no bodies, so use `get_message`.
- [ ] **Step 5: Run the tests and confirm they pass.** Run `pnpm --filter @mgcrea/mcp-apple-mail test && make surfaces-check`. Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add packages/mail surfaces.json apps/apple/Cupertino/Surfaces.swift README.md Makefile
git commit -m "feat(mail): watch for incoming mail from chosen senders, behind allowWatches"
```

(Stage whatever `make surfaces` regenerated. The list above is the usual set.)

### Task 7: Messages arrival source

**Files:**

- Create: `packages/messages/src/client/watch.ts`
- Modify: `packages/messages/src/client/store.ts`
- Test: `packages/messages/test/watch.test.ts` (seeded from `fixtures/chat-db.sql` the way `store.test.ts` seeds it)

**Interfaces:**

- Produces:

```ts
// store.ts
MessagesStore.prototype.headRowid(): number;
MessagesStore.prototype.arrivalsAfter(after: number, limit: number): (MessageRow & { rowid: number })[]; // ROWID ASC, reactions included

// watch.ts
/** No `text`: a message's text is its body, and watch reads carry metadata only. */
export type MessageArrival = ArrivalRow & { id: string; chat: string | null; handle: string | null; date: string };
export class MessagesArrivalSource implements ArrivalSource<MessageArrival> {
  constructor(opts: { store: MessagesStore });
}
```

- [ ] **Step 1: Write the failing tests.**
  - `arrivalsAfter` returns rows past the cursor, ascending, with `handle` joined.
  - The source marks `excluded: true` on `is_from_me = 1` rows and on tapbacks (`associated_message_type != 0`).
  - `key` is the message `guid`. A test pins that the fixture's `message` table is `AUTOINCREMENT`: a deleted top row's id is not reused by the next insert.
  - No arrival carries a `text` field, even for a row whose `text` column is set. The body stays behind `get_message`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-messages test -- watch`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `#messageColumns()` and `#joins()` with `WHERE m."ROWID" > ? ORDER BY m."ROWID" LIMIT ?`.
- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/messages/src/client packages/messages/test/watch.test.ts
git commit -m "feat(messages): arrival source over chat.db"
```

### Task 8: Messages watch tools, gate and guide

**Files:**

- Create: `packages/messages/src/tools/watch.ts`
- Modify: `packages/messages/src/config.ts`, `server.ts`, `cli.ts`, `tools/index.ts` (ToolContext), `guide.ts`, `client/messages.ts`, `surfaces.json`, then the generated regions
- Test: `packages/messages/test/tools.test.ts`, `surface.test.ts`, `config.test.ts`

**Interfaces:**

- Consumes: core watches, and `MessagesArrivalSource` from Task 7.
- Produces: `Config.allowWatches` from `APPLE_MESSAGES_ALLOW_WATCHES`. Tools:
  - `apple_messages_watch({ from?: string[]; domains?: string[] })` returns `{ watch, uri, filter, cursor, unresolved: string[] }`.
  - `apple_messages_unwatch({ watch })`.
  - `AppleMessagesClient.storeHandlesFor(typed: string): string[]` wraps the existing `#handlesLike`.

- [ ] **Step 1: Write the failing tests.**
  - Gate off: no tools. Gate on: both are listed.
  - A typed `"+33 6 12 34 56 78"` that matches a store handle `+33612345678` is stored in the filter as `+33612345678`.
  - A typed handle the store does not hold is kept lowercased in `from` and listed in `unresolved`.
  - `domains` match email handles only. A phone handle never matches a domain.
  - After `watch`, reading the URI returns `messages` with `id`, `handle`, `chat` and `date`, and no `text`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @mgcrea/mcp-apple-messages test`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
  - Wire it as in Task 6, with trigger `fileTrigger({ dir: dirname(storePath), names: ["chat.db", "chat.db-wal"] })`.
  - Add the gate to `surfaces.json` under messages, next to `allowCodes`, with label "Watch for incoming messages" and the matching description. Run `make surfaces`.
  - Add the guide section, which says Messages need not be running.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm --filter @mgcrea/mcp-apple-messages test && make surfaces-check`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/messages surfaces.json apps/apple/Cupertino/Surfaces.swift README.md Makefile
git commit -m "feat(messages): watch for incoming messages from chosen handles, behind allowWatches"
```

### Task 9: The app records subscriptions and pushes

**Files:**

- Modify: `apps/apple/Cupertino/CallCapture.swift`, `apps/apple/Cupertino/RequestObserver.swift:115-144` (`answered`/`reply`) and `:190-210` (the `waiting` append)
- Test: `scripts/unit-check.swift` (run by `make unit`)

**Interfaces:**

- Produces, in `CallCapture`:

```swift
static func isSubscription(_ method: String) -> Bool // "subscriptions/listen" || "resources/subscribe"
static func subscribedUris(_ params: [String: Any]?) -> [String] // listen: notifications.resourceSubscriptions; legacy: [uri]
static func pushedUri(_ object: [String: Any]) -> String? // uri of a notifications/resources/updated, else nil
```

- [ ] **Step 1: Write the failing checks** in `scripts/unit-check.swift`:
  - `isSubscription` is true for both methods and false for `resources/read`.
  - `subscribedUris` reads both param shapes, and returns `[]` for a listen with only `toolsListChanged`.
  - `pushedUri` returns the URI for an updated notification, and `nil` for a response or for a `notifications/progress`.
- [ ] **Step 2: Run the checks and confirm they fail.** Run `make unit`. Expected: compile error, members missing.
- [ ] **Step 3: Implement the helpers.**
- [ ] **Step 4: Change `RequestObserver`.**
  - A subscription request is logged as `hostLog(surface.id, .info, "subscribed <uris>")` and never appended to `waiting`.
  - In `answered`, check the chunk for the bytes `notifications/resources/updated` before the mode guard, and only then split lines. For each line where `pushedUri` is non-nil, record a `hostCall` row named `pushed <uri>` with no arguments, so it reaches the Activity log and the audit file in every capture mode.
  - The no-match path must stay the `responses.skip(chunk)` it is today.
- [ ] **Step 5: Run the checks and build.** Run `make unit && make app`. Expected: PASS, then a successful build.
- [ ] **Step 6: Commit.**

```bash
git add apps/apple/Cupertino/CallCapture.swift apps/apple/Cupertino/RequestObserver.swift scripts/unit-check.swift
git commit -m "feat(app): log subscriptions and pushed resource updates"
```

### Task 10: Verify live, then document

**Files:**

- Modify: `docs/prompts-and-resources.md`, `docs/alternatives.md` ("No channel lane"), `README.md` (the Mail and Messages paragraphs), `CHANGELOG.md` (Unreleased)

- [ ] **Step 1: Verify against the dev build.** Load the `use-the-dev-build` skill, run `make dev-config run`, and turn on `allowWatches` for Mail in the surface pane.
  - From a 2025-era SDK client script in the scratchpad: `watch({ domains: [<a domain Olivier picks>] })`, `subscribeResource(uri)`, then wait. Olivier sends a mail from that domain.
  - Expected: one `notifications/resources/updated` within the trigger delay Task 1 measured. A read with `after` returns the mail. The Activity log shows `subscribed …` and `pushed …`.
  - Repeat with a 2026-era client using `subscriptions/listen`.
  - Repeat once for Messages.
- [ ] **Step 2: Write the docs.**
  - `prompts-and-resources.md`: a "Watches" section saying a watch is the named exception to "a tool call wearing a URI", and why (`subscriptions/listen` names only URIs; watches stay out of `resources/list`).
  - `alternatives.md`: the protocol-native half is decided and shipped. The channel half stays open, citing Task 1 Step 4's finding.
  - README: one sentence per surface naming the gate.
  - CHANGELOG: an Unreleased entry in the file's voice.
- [ ] **Step 3: Run the full suite.** Run `pnpm -r test && pnpm lint && pnpm format:check && make surfaces-check`. Expected: PASS.
- [ ] **Step 4: Commit.**

```bash
git add docs README.md CHANGELOG.md
git commit -m "docs(watches): document incoming watches and narrow the channel gap"
```
