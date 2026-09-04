# The mail query lane — projection and aggregation

**Implemented** — `apple_mail_query`, in
[`packages/mail/src/tools/query.ts`](../packages/mail/src/tools/query.ts), on every server. The
SQL lives beside the search lane in
[`envelope.ts`](../packages/mail/src/client/envelope.ts).

## The question

This started as "should we adopt Cloudflare-style Code Mode — one sandboxed `execute` tool and a
generated TypeScript API — to cut what the tool surface costs in context?"

No. The listing cost is real (93 tools across eight surfaces, ~40 KB of description prose before
schema scaffolding), but code mode relocates that cost rather than removing it: the model still
needs the API, and the win in the published versions comes from the _client_ lazily loading only
the modules a task touches — which the clients that matter already do for tool schemas. What it
would definitely cost is the thing the tool surface is _for_ here. A `run_code` tool holding Full
Disk Access and write access to Mail collapses 93 individually-permissionable operations into one
opaque call, and tool identity is what host allowlists key on, what the audit log records, and
what `allowWrites` gates on in [`config.ts`](../packages/core/src/config.ts).

One idea from it is worth having anyway: **intermediate results should not have to pass through
the context window.**

## What was actually missing

`apple_mail_search_messages` is already a declarative query tool — thirteen filters, executed
against Mail's own SQLite index. Filtering was never the gap. Three things were:

| Gap              | What it cost                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| No projection    | Every hit returned a full summary. "Who emailed me most" paid for subject, dates and flags on every row.     |
| No aggregation   | "Top ten senders", "unread per account" meant pulling rows into the context and having the model tally them. |
| No cross-surface | One process per surface, so mail × contacts cannot be joined server-side.                                    |

The third is out of scope and stays there: the surfaces are separate packages and separate
processes, and `apple_contacts_resolve_handles` already reduces that particular chain to two
calls.

## The rule this lane is built around

**Aggregation happens before `limit`, never after.**

`resolveLimit` caps every read at `maxResults`. If grouping ran over the returned page, "top
senders in 2026" would silently mean "top senders among the twenty-five rows we happened to
return" — and that answer is shaped exactly like a correct one. There is no marker on it, and no
way for a model to tell.

So `EnvelopeIndex.groupBy` issues a `GROUP BY` over the full filtered set. `limit` caps the number
of _groups_; the envelope always carries `totalRows` (messages aggregated, never capped) and
`truncated` (whether `groups` is a top-N). The test that pins this is
`"caps the number of groups without capping what was counted"` in
[`test/query.test.ts`](../packages/mail/test/query.test.ts).

Two smaller consequences of the same principle:

- `COUNT(DISTINCT x)` skips nulls, so a "no sender" group would appear in `groups` while going
  unreported in `totalGroups` — and `truncated` is derived from that number. The query adds the
  null group back explicitly.
- Unknown `select` names are reported in the result rather than dropped. A silently ignored field
  name is indistinguishable from a field that was null on every row.

Body search is deliberately **not** offered here. It is a linear file scan bounded by
`bodyScanMax` (see [mail-body.md](mail-body.md)); putting it behind an aggregate would uncap the
work with no row count to make the cost visible.

## Measured

Against a synthetic 800-message archive (40 senders over six months), through a real MCP client:

|                                                          | bytes   | ~tokens | calls |
| -------------------------------------------------------- | ------- | ------- | ----- |
| `apple_mail_query {groupBy: "sender", dateFrom: …}`      | 1,633   | 408     | 1     |
| the same answer by paging `search_messages` and tallying | 104,659 | 26,165  | 2     |

**64x** on that question — 356 matching messages never enter the context window, only the forty
groups they fall into. Projection alone, with no grouping, is **2.6x** on a 50-row listing
(`select: ["ref", "sender"]`, 14,759 B → 5,642 B).

The tool's own listing cost is 2,864 B (~716 tokens), so it repays itself several times over on a
single grouped question. That was the condition for keeping it.

## Why it was read-only servers only, and why it no longer is

Never safety — the lane reaches nothing but the index, and is `readOnlyHint: true`. Budget. Every
tool costs listing tokens on every connect, so this one had to demonstrate it saves more than the
~716 tokens it adds before it went on the surface most clients see. The numbers above are that
demonstration, so `registerTools` now registers it unconditionally and `test/tools.test.ts` pins
that it stays on the write-enabled surface.

The gate had a cost the budget argument missed: `allowWrites` is a per-surface switch, so the only
way to reach the query lane was to give up send, reply, move and delete for Mail across every
client at once. A read-only tool that a write toggle takes away is a tool most users never see.

The measurement that decides whether it spreads to the other surfaces: run the same question both
ways — `groupBy: "sender"` versus paging `search_messages` — and compare total tokens. If it does
not clearly win on mail, the richest index of the eight, it will not win anywhere.

## Where it spread, and in what shape

**Messages, as counting only** — `apple_messages_count_messages`, see
[messages.md](messages.md#the-count-lane). Asking the question above of that surface answered it
differently rather than yes or no, and the difference is worth recording before the next surface
asks:

- **Projection did not carry over.** `select` earns its 2.6x on mail because a mail row is metadata
  around a small payload. A message row's bulk is its text, and a listing without the text is not a
  question anyone asks.
- **Half the aggregate was already there.** `apple_messages_list_chats` returns per-chat counts from
  a `COUNT()` in SQL, so "which conversation is busiest" needed nothing new. What it cannot do is add
  one person's several chats together, which is what the new tool is for.
- **The filters could not carry over either.** This lane was cheap on mail because `groupBy` reuses
  a thirteen-filter WHERE clause that already existed. Messages had two filters, so its count lane
  had to bring its own — and stops at metadata, because a text filter over a store whose recent
  bodies live in a blob would return a confidently wrong number.

The general rule the two together suggest: **port the aggregate, not the tool.** Check what the
surface's existing reads already aggregate, and what its store can filter completely, before
assuming the shape that won on mail is the shape that wins.
