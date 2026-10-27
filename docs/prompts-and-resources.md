# Prompts and resources

Every server in this repo exposed tools and nothing else until 1.3. This document is why that was a
gap, what fills it, and which things were deliberately left out.

## The gap

A tool is a thing the model decides to call. That is the right shape for an action, and the wrong
shape for two kinds of knowledge the servers already hold:

**Knowledge that is re-derived every session.** `apple_mail_list_accounts` returns the account and
mailbox names that every other Mail tool takes as an argument. It is cheap — 0.6s, `O(mailboxes)`
not `O(messages)` — and it is paid again in every new conversation, because a tool result exists
only inside the session that spent a call on it.

**Knowledge that is read after the failure instead of before it.** `apple_mail_diagnostics` names
the exact System Settings pane to open. It gets called once something has already returned
`degraded: true`, which is one round trip and one confusing answer too late.

Neither is fixed by writing better tool descriptions, because the problem is not what the
descriptions say — it is that a description is not addressable and a tool result is not durable.

## Resources: up to three per surface

| URI                                 | What                                      | Can it fail?        |
| ----------------------------------- | ----------------------------------------- | ------------------- |
| `cupertino://<surface>/guide`       | the operating manual, static markdown     | no                  |
| `cupertino://<surface>/diagnostics` | the live capability and permission report | yes, and it says so |
| `cupertino://<surface>/inventory`   | the containers you address by name        | yes, and it says so |

**The scheme is `cupertino://`, not `apple://`.** The tools are named `apple_mail_*` because that
says what they drive. A URI scheme is a different kind of claim — it is a namespace — and taking
Apple's would read as exactly the affiliation the README spends a line disclaiming. The authority
is the surface id, and the scheme is the project's own name, already in the bundle identifier.

**The guide is static on purpose.** It is a string in the bundle: no permission, no running app and
no readable store stands between a caller and it. That matters because the moment its contents are
most worth reading is the moment everything else is denied. The rule that keeps it that way: it may
contain nothing only a probe could know. No account names, no counts, no permission verdicts —
those belong to the other two resources, which are allowed to fail.

Desktop's guide is the one that varies, and only on the two switches: writes and reach. Both are
settings this app owns, readable with every grant denied, so the rule above still holds — the guide
never reports what a probe found, only what the caller is allowed to ask for. Its paragraph about
driving an iOS Simulator was gated on the reach while Simulator.app was not a brokered application;
the `simulator` surface made it one, so the paragraph is unconditional now and points at that
surface. Simulator's own guide varies on writes alone. See [`simulator.md`](simulator.md).

**A failed read returns data, not a protocol error.** A tool that throws still returns its text
under `isError`. A resource read that throws becomes a JSON-RPC error and keeps nothing, which
would delete the diagnostics report at the one moment anyone wants it. So reads are wrapped: a
failure comes back shaped like the `degraded` results the tools already return, and the caller can
still tell an unreadable store from an empty one. See `guardedRead` in
[`packages/core/src/resources.ts`](../packages/core/src/resources.ts).

**Four surfaces register only two resources.** Contacts, Messages, Safari and Maps have no
containers you address by name. A contact is reached by searching, never by naming the store it
lives in; chats are unbounded and change constantly; history, tabs and the Reading List are three
queries rather than three folders, and favourites, collections and recents are three more. A
resource that is never the same twice is a tool call wearing a URI, so those surfaces do not
register one.

**Desktop registers one.** It has no store to report on and nothing to inventory — what it can
reach is decided by two switches the guide already states — so it serves a guide and no
`diagnostics` URI. The tool of that name still answers; the resource is the thing that would have
had nothing to add.

## Watches

Mail and Messages can register one more kind of resource, and it is the named exception to "a
resource that is never the same twice is a tool call wearing a URI". It exists only behind
`APPLE_MAIL_ALLOW_WATCHES` / `APPLE_MESSAGES_ALLOW_WATCHES` (off by default; the gate registers the
two tools and the template together, and declares `resources.subscribe`).

**Why a URI at all.** The only way a server speaks unprompted in the 2026-07-28 protocol is
`notifications/resources/updated`, and that carries a URI and nothing else. `subscriptions/listen`
names URIs, never tools. So the thing a host subscribes to has to be a resource, and a tool call
(`apple_mail_watch`, `apple_messages_watch`) is what mints it: it takes the sender filter, returns a
handle such as `cupertino://mail/watch/w_7f3a`, and the server keeps the filter in-process. The
filter cannot ride in the URI. SDK v2's `serveStdio` matches subscriptions by exact URI and never
tells the server what anyone subscribed to, so a URI that encoded the filter would leave the server
not knowing which filters to evaluate.

**Why it is not listed.** `resources/list` must not vary per connection or as a side effect of
other requests, and a watch is created by a tool call. The template
`cupertino://<surface>/watch/{id}{?after}` is registered without a list callback, so a handle is
readable and subscribable by whoever holds the URI and never enumerable.

**What a read returns.** `watch` (the id), `filter`, `cursor`, `messages` and `more`. The messages
are what arrived since the watch began, or since `after`, oldest first, at most 50, and carry the
surface's fields only: Mail's `ref`, `mailbox`, `senderAddress`, `senderName`, `subject` and
`dateReceived`; Messages' `id`, `chat`, `handle` and `date`. No bodies and no message text, which stay
a `get_message` call away, and none of the scan's own bookkeeping. The `cursor` is the last row
_scanned_, so reading again with `after=cursor` resumes exactly, and `more` says to. An `after` below
where the watch began is raised to it, so a read never pages through mail that predates the watch.
The cursor is the client's to keep; the server holds no per-client read state. An unknown handle is
`-32602` not-found, which is what a reconnect looks like: handles live as long as the stdio
connection that made them. A query other than one `after` (`?foo=1`, `?after=5&x=1`) is `-32602`
too, but as a bad query, so a client is never told to re-create a watch that exists. A read fails
like any other surface resource (`guardedRead`) when the store itself is unreadable.

**Limits.** Ten watches per connection; the eleventh is refused with the count. At most 50 entries
across `from` and `domains` in one filter, and at most 20 `mailboxes` per Mail watch. A read returns
at most 50 matches and scans at most 1,000 rows; `more` says when either stopped it.

**What fires it.** One watcher per process, started by the first watch and stopped by the last
unwatch. The trigger watches each store file (`Envelope Index` and its `-wal`; `chat.db` and its
`-wal`) _and_ the directory: a directory watch alone does not fire when SQLite appends to an
existing `-wal` (measured on macOS), and a file watch goes quiet when SQLite replaces the file, so
the directory watch and the poll re-arm the file watchers. It is debounced 500 ms, but fires at most
3 s after the first event of a burst, so a long sync does not leave its arrivals to the 60 s poll
that runs beneath it for dropped events. One tick scans at most ten batches of 1,000 rows and leaves
the rest of a backlog to the next trigger, so a large sync never holds the process. The cursor is
the message table's ROWID, which both stores declare `AUTOINCREMENT`, so a row can never land below a
cursor that has passed it. The one way the mark goes backwards is a store rebuilt from scratch, and
then it resets to the new head and notifies nothing. A rebuild usually writes a new file and renames
it over the old one, and a connection keeps reading the inode it opened, so each watch holds its own
handle on the store, compares the file's inode on every trigger, and reopens before the tick when it
changed; that tick is the one that sees the lower head. The store opens read-only and never
`immutable`, which cannot see the WAL where the newest row is; if only `immutable` opens, the watch
tool refuses and says why.

**What a trigger costs.** An idle trigger is one `MAX(ROWID)` on the store. Mail's lookup of
mailboxes and own addresses comes from an Apple Event, and it is refreshed only when rows are waiting
to be judged and the lookup is past its TTL (`APPLE_MAIL_MAILBOX_CACHE_TTL_MS`) or has never loaded,
or when a row sits in a mailbox created since the last refresh. A refresh or a tick that fails is
logged once until one succeeds.

**What a watch may follow.** A sender filter is required: `from`, `domains`, or both. There is no
watch on everything, and the filter is the trust boundary, a line in a tool call the user can see
saying whose messages may arrive unasked. Scope is per watch and core knows it only as opaque keys.
Mail's `mailboxes` resolve to Envelope Index rowids, and each row carries its own mailbox and its
Gmail labels as keys; a watch with none takes every mailbox but Sent, Drafts, Junk and Trash, and
mail from the account's own addresses never matches. Naming mailboxes needs Mail running, since
Mail is what resolves them; a watch without them works with Mail closed, though nothing arrives
until Mail fetches. Messages needs no running app, skips your own messages, tapbacks and group
events (a rename, someone joining or leaving), and wants phone numbers in international form (`+33612345678`): an entry the store does not hold is reported
as `unresolved`, with `suggestions` when it holds near misses.

**Both eras.** On a 2026-era connection the router does the matching and the server sends
`notifications/resources/updated` per fired watch. On a 2025-era connection the router passes
notifications through unsolicited, so the server keeps the subscribed URIs itself, and only in that
era. MCP SDK v2 has no built-in `resources/subscribe` handler: `McpServer` answers `-32601` until
one is registered, even with `subscribe: true` declared, so the watch module registers both methods
by name.

**The model does not subscribe.** `subscriptions/listen` is a message the host sends, not a tool.
A host that never subscribes still has a working watch, since a read is "what came in since I last
asked", but nothing is pushed. Claude Code is such a host: on 2.1.311 it opens
`subscriptions/listen` for the list-changed notifications only and never asks for
`resourceSubscriptions`, and on a 2025-era connection it never sends `resources/subscribe`. Its
agents read the watch instead, which works. See [alternatives.md](alternatives.md).

In the app, a `subscriptions/listen` is logged as a subscription rather than a call that never
returns, and the Activity log shows it as `subscribed …`. Each pushed
`notifications/resources/updated` is a row (`pushed …`) in both the Activity log and the audit file,
so "what did Cupertino push into this session" has the
same answer as "what did it call". The design is in
[the incoming-watches spec](superpowers/specs/2026-10-25-incoming-watches-design.md).

## Prompts: the ordering constraints

The tools hold the constraints that are about **one call** — that a body search wants a narrowing
filter, that a ref is opaque. Prompts hold the ones that are about the **order of calls**, which
have nowhere else to live: no single tool description is the right place to say "search before you
list", "read the thread before you answer it", or "check what exists before you create a duplicate".

| Surface   | Read-only               | Write-gated             |
| --------- | ----------------------- | ----------------------- |
| Mail      | `triage`, `find_thread` | `draft_reply`           |
| Notes     | `find`                  | `capture`               |
| Reminders | `whats_due`             | `capture_action_items`  |
| Calendar  | `whats_my_day`          | `schedule`              |
| Contacts  | `who_is`                | — (no write prompt yet) |
| Messages  | `catch_up`              | `send`                  |
| Safari    | `what_was_i_reading`    | — (no write prompt yet) |
| Maps      | `where_was_that_place`  | — (no write prompt yet) |
| Screen    | —                       | —                       |
| Sound     | —                       | —                       |
| Desktop   | —                       | —                       |
| Simulator | —                       | —                       |

The four Swift surfaces are served in-process by the app and answer `prompts/list` with an empty
list.

All are namespaced like the tools: `apple_mail_triage`, not `triage`.

**Every prompt embeds its surface guide.** A prompt returns messages, and the first is the
`cupertino://<surface>/guide` resource. That is the coupling that makes the two primitives worth
more than either alone — the guide is the reference, the prompt is the task, and a host expanding
the prompt gets both without the model having to know the guide exists.

**Write prompts follow the write tools.** With `ALLOW_WRITES` off they are not registered at all,
for the same reason the mutating tools are not: the invariant is that a closed gate makes writes
_invisible_, not merely refused. A visible `draft_reply` on a read-only server is an offer the
server cannot keep.

## What each prompt is actually protecting against

These are not summaries of the tools. Each carries one failure that was observed or is structurally
easy to hit:

- **`apple_mail_draft_reply`** — `apple_mail_reply_to_message` called without a `body` leaves an
  _empty_ draft with the original quoted beneath. That is a blank page, and reporting it as a
  written reply is a lie the user does not discover until they open Mail.
- **`apple_reminders_capture_action_items`** — nothing on this surface deduplicates. Running a
  capture twice over the same thread is the normal way a reminders list fills with pairs.
- **`apple_calendar_schedule`** — this server has no `attendees` parameter anywhere, on purpose,
  because adding one sends mail to a person. "Scheduled with Ana" must not stand when Ana was never
  told.
- **`apple_contacts_who_is`** — an ambiguous handle returns _no name_ by design. The failure is a
  model helpfully picking the first of three matches, and a confidently wrong name is the outcome
  nobody catches.
- **`apple_messages_send`** — the only genuinely irreversible action in the bundle. No draft state,
  no undo. And `reconciliation: "pending"` means the message **was** sent; retrying sends it twice.
- **`apple_safari_what_was_i_reading`** — history, open tabs and the Reading List are three stores
  answering three questions. Picking one produces a confident answer to a question nobody asked.

## The bridge needed no changes

`cupertino-bridge` relays bytes between stdin and a unix socket and never parses JSON-RPC — see the
header of [`main.swift`](../apps/apple/CupertinoBridge/main.swift). Prompts and resources therefore
reach hosts through Cupertino.app exactly as they do over plain stdio, with no Swift change and
nothing to add to `surfaces.json`.

## Omitted prompt arguments

The MCP spec makes `GetPromptRequest.params.arguments` **optional**. Version 1 of the SDK parsed
whatever arrived against the declared object schema, and `z.object({…}).safeParse(undefined)` fails
however optional every key is, so a prompt that declared any argument rejected a request that
omitted the field entirely, even a prompt where nothing is required. Version 2 accepts the omission
and runs the callback with no arguments, so a host that skips the argument form on an all-optional
prompt (`whats_due`, `whats_my_day`, `catch_up`) gets the prompt rather than an error. The behaviour
is pinned by a test in
[`packages/core/test/prompts.test.ts`](../packages/core/test/prompts.test.ts) so it does not
regress.

## What it costs

Measured against the built servers, all eight with writes on, `JSON.stringify` length of each
listing at ~4 chars per token:

| Surface   | tools       | prompts    | resources  | one expansion |
| --------- | ----------- | ---------- | ---------- | ------------- |
| mail      | 21 · ~6,266 | 3 · ~437   | 3 · ~279   | ~988          |
| notes     | 13 · ~1,936 | 2 · ~232   | 3 · ~281   | n/a           |
| reminders | 11 · ~2,674 | 2 · ~293   | 3 · ~292   | ~694          |
| calendar  | 10 · ~3,384 | 2 · ~269   | 3 · ~291   | ~864          |
| contacts  | 7 · ~1,859  | 1 · ~90    | 2 · ~191   | n/a           |
| messages  | 8 · ~2,749  | 2 · ~241   | 2 · ~191   | ~1,275        |
| safari    | 13 · ~4,605 | 1 · ~124   | 2 · ~187   | ~2,018        |
| maps      | 10 · ~1,859 | 1 · ~89    | 2 · ~183   | ~1,051        |
| **total** | **~25,330** | **~1,773** | **~1,893** | —             |

Re-measured 2026-09-05, and the previous figures were stale by roughly half: the table said
~18,453 tokens for seven servers while Mail had grown 19 → 21 tools and Maps had shipped. The
expansion column is the largest prompt that expands with no arguments; Notes and Contacts declare
arguments on every prompt, so those two have no argument-free expansion to measure, which is not an
omission.

Three things follow, and they are why `exposePrompts` defaults on:

**The listings are ~3.7k tokens, about 14% on top of tools.** Not free, and not where the context
goes: Mail's tool list alone outweighs every prompt and resource on all eight servers combined. The
levers that matter for context are running fewer servers and `*_LAZY_TOOLS`, which addresses the
~25k directly — see the README's configuration table.

**Resource contents cost nothing until read.** A listing carries name, URI, description and
mimeType. The 2.6 KB Mail guide enters context only when something reads it.

**The ~950-token expansion is the guide, and it is the trade being made.** Pay it once instead of
having the model re-derive "search before you list", "degraded is not empty" and "a body-less reply
is a blank page" every session — which it does otherwise, sometimes wrongly.

One caveat these numbers cannot settle: whether a host puts the _listings_ in the prompt at all.
Tools always are. Prompts and resources vary — some hosts inject the list, some fetch it lazily on
`/` or `@`. The figures above are what the servers emit, not what every host does with them.

`APPLE_<SURFACE>_EXPOSE_PROMPTS=0` turns both off. It is deliberately **not** modelled on the write
gate: that one is a safety invariant with a claim behind it, this one is a cost knob in the family
of `maxResults`, and conflating them would muddy the one that matters. One flag rather than two,
because a prompt embeds its surface guide — prompts without resources would name a
`cupertino://<surface>/guide` that nothing serves. With it off the capability is never declared, so
a client asking gets "method not found" rather than an empty list, which is the same shape the
write gate already uses: absent, not present-and-empty.

## Adding a surface

Both primitives are registered from `packages/core`, so the ninth node surface is:

1. `src/guide.ts` — the static manual. Nothing a probe could know.
2. `src/prompts.ts` — `registerWorkflowPrompt` per workflow, write-gated ones behind the flag.
3. Export `buildDiagnostics` from `src/tools/diagnostics.ts` so the tool and the resource serve the
   same bytes rather than drifting.
4. One `registerSurfaceResources` call in `src/server.ts`.
