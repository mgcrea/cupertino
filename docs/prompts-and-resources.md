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

## Resources: three per surface

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

**A failed read returns data, not a protocol error.** A tool that throws still returns its text
under `isError`. A resource read that throws becomes a JSON-RPC error and keeps nothing, which
would delete the diagnostics report at the one moment anyone wants it. So reads are wrapped: a
failure comes back shaped like the `degraded` results the tools already return, and the caller can
still tell an unreadable store from an empty one. See `guardedRead` in
[`packages/core/src/resources.ts`](../packages/core/src/resources.ts).

**Three surfaces register only two resources.** Contacts, Messages and Safari have no containers
you address by name. A contact is reached by searching, never by naming the store it lives in;
chats are unbounded and change constantly; history, tabs and the Reading List are three queries
rather than three folders. A resource that is never the same twice is a tool call wearing a URI, so
those surfaces do not register one.

## Prompts: the ordering constraints

The tools hold the constraints that are about **one call** — that a body search wants a narrowing
filter, that a ref is opaque. Prompts hold the ones that are about the **order of calls**, which
have nowhere else to live: no single tool description is the right place to say "search before you
list", "read the thread before you answer it", or "check what exists before you create a duplicate".

| Surface   | Read-only               | Write-gated                            |
| --------- | ----------------------- | -------------------------------------- |
| Mail      | `triage`, `find_thread` | `draft_reply`                          |
| Notes     | `find`                  | `capture`                              |
| Reminders | `whats_due`             | `capture_action_items`                 |
| Calendar  | `whats_my_day`          | `schedule`                             |
| Contacts  | `who_is`                | — (surface registers no mutating tool) |
| Messages  | `catch_up`              | `send`                                 |
| Safari    | `what_was_i_reading`    | — (read-only by construction)          |

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

## A known upstream sharp edge

The MCP spec makes `GetPromptRequest.params.arguments` **optional**, but the SDK parses whatever
arrives against the declared object schema, and `z.object({…}).safeParse(undefined)` fails however
optional every key is. So a prompt that declares any argument rejects a request that omits the
field entirely — even a prompt where nothing is required.

Hosts that render an argument form send `{}` and are unaffected. A host that skips the form on an
all-optional prompt (`whats_due`, `whats_my_day`, `catch_up`) would see an error instead of the
prompt. There is no way to soften this through `registerPrompt`: the parse happens inside the SDK's
own handler, before our callback is reached. The behaviour is pinned by a test in
[`packages/core/test/prompts.test.ts`](../packages/core/test/prompts.test.ts) so it is not mistaken
for a bug in this repo, and the fix belongs upstream.

## Adding a surface

Both primitives are registered from `packages/core`, so surface number eight is:

1. `src/guide.ts` — the static manual. Nothing a probe could know.
2. `src/prompts.ts` — `registerWorkflowPrompt` per workflow, write-gated ones behind the flag.
3. Export `buildDiagnostics` from `src/tools/diagnostics.ts` so the tool and the resource serve the
   same bytes rather than drifting.
4. One `registerSurfaceResources` call in `src/server.ts`.
