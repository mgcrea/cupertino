# Alternatives

What else reads Apple Mail for an assistant, what each one costs, and where Cupertino actually
differs. Recorded so the question is not re-opened, the same job
[distribution.md](distribution.md) does for the App Store.

Surveyed August 2026. Star counts and tool counts move; the shape of the argument does not.

## Short version

There is no first-party path. Anthropic ships a Gmail connector, not an Apple Mail one, so nothing
in Claude reads Mail.app out of the box. Everything below — including Cupertino — exists to fill
that hole.

Every alternative surveyed tells the user to **grant Full Disk Access to Terminal**. That is the
one thing none of them solve and the one thing this repo was started to solve. It is not the only
difference, but it is the only difference nobody else has tried to close.

Body search — the one capability a competitor genuinely had and this did not — is now
implemented, though the unbounded case is deliberately refused rather than served. See
[Where we lose](#where-we-lose).

## The baseline: what happens with no server at all

Worth stating plainly, because "just let the agent use the terminal" is the real competition and it
half works.

**Apple Events via `osascript`.** Costs one Automation prompt and no Full Disk Access, which makes
it the cheapest thing on this page. Fine for "read the newest ten in Inbox". It falls over the
moment a filter is involved: [verify.md](verify.md) measures `messages whose read status is false`
at **74 seconds**, and each additional message costs ~42 ms per field. An agent that does not know
this writes the obvious `whose` clause and hangs.

**`sqlite3` against the Envelope Index.** Fast, and genuinely what the index lane does — except
the agent has to rediscover a 54-table schema every session, and [surfaces.md](surfaces.md) records
what that costs in wrong answers rather than slow ones:

- Dividing a seconds value by 1e9 lands within a rounding error of 2001-01-01 and produces a date
  that looks entirely plausible.
- `node:sqlite` throws on an INTEGER too large for a JS double; caught, it is indistinguishable
  from "this column has no dates".
- `immutable=1` skips the `-wal`, and on a live index the two open modes disagree by exactly the
  newest message — so the most recent mail is the mail most likely to be missing.

These are _plausible-but-wrong_ answers, which is the worst failure mode an agent has. A server
earns its place by holding this knowledge so the model does not have to re-derive it, and by
reporting `indexAgeSeconds` and `walBlind` when it cannot be certain.

## The field

| Project                                                                           | Lane                                                      | Notes                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [patrickfreyer/apple-mail-mcp](https://github.com/patrickfreyer/apple-mail-mcp)   | AppleScript only                                          | The popular one (~168★). Unified search, threading, drafts, analytics — all of it through the lane measured at 74 s.                                                                                                                     |
| [imdinu/apple-mail-mcp](https://github.com/imdinu/apple-mail-mcp)                 | Envelope Index + **owned FTS5 body index** + JXA fallback | The serious technical peer. GPL-3.0, PyPI, 8 tools, **read-only**. Benchmarks itself against 6 rivals on a 73k-message mailbox and claims to be the only one with full-coverage body search.                                             |
| [LMCP](https://www.local-mcp.com/guides/best-mcp-server-mac)                      | AppleScript/JXA + FDA for the databases                   | Breadth play: 188+ tools over 25+ domains, well past Apple's own apps. Free tier.                                                                                                                                                        |
| [marius-cetanas/macos-mail-mcp](https://github.com/marius-cetanas/macos-mail-mcp) | AppleScript                                               | 20 tools, read + compose.                                                                                                                                                                                                                |
| [lionsr/mcp-apple](https://lobehub.com/mcp/lionsr-mcp-apple)                      | JXA, shipped as a `.mcpb` desktop extension               | One-click install in Claude Desktop, which is a real distribution advantage.                                                                                                                                                             |
| [peakmojo/applescript-mcp](https://github.com/peakmojo/applescript-mcp)           | arbitrary `osascript`                                     | Hands the model unbounded execution on the Mac. This is precisely the blast radius the closed table in `Surfaces.swift` exists to prevent, and it is worth naming rather than ignoring: it is easy to install and it is the wrong trade. |

Several others (sweetrb, attilagyorffy, s-morgan-jeffries, griches, falconbradley, oscar23445) are
AppleScript wrappers of varying completeness. The pattern is uniform enough that they do not each
need a row.

## Where we win

Two of these are unique, and the rest are uncommon.

**The grant lands on the right process.** Everyone else says "add Terminal to Full Disk Access".
macOS attributes file access to the _responsible process_ — the app at the top of the launch chain
— so in practice the grant lands on VS Code or Cursor, and with it every extension and task that
editor will ever run. Cupertino's launcher re-execs with
`responsibility_spawnattrs_setdisclaim` to become its own responsible process, and the signed app
holds the grant under a stable bundle identifier. Nothing else surveyed attempts this.

**The tool list is a pure function of `allowWrites`.** Writes off means the mutating tools are not
registered — invisible to the model, not merely refused. `imdinu` has no writes at all, which is
safe; the AppleScript servers have them always on, which is not.

**`APPLE_MAIL_ACCOUNTS` bounds reading, not just writing.** On Mail the larger blast radius is
reading the whole archive, and it is enforced in exactly one place so no query path escapes it. No
alternative surveyed has a read-side control.

**There is something to look at.** The Activity window records every tool call live — the name,
and the arguments it was called with — which is the answer to "what did the assistant just do with
my mail?". Message contents are blanked unless a surface is set to include them, so the default
answers the question without keeping the mail. Servers spawned inside an editor are unobservable by
construction.

**And something to keep, if you want it.** Settings › Activity turns on a durable log: append-only
segments on disk, each record carrying a hash of the one before it, with retention and export. The
chain detects an edited, removed or truncated record — it is not proof against anyone who can write
the file, and the app says so rather than implying otherwise. Getting message contents into that
file takes three separate switches. No alternative surveyed keeps a record that outlives the
process at all.

**The result says how much to trust it.** `indexAgeSeconds` and the WAL-blind warning ride along
with search results, and a missing lane returns a structured `degraded` result naming what is
absent instead of a vanished tool. Nobody else reports index staleness at all — which matters more
now that the peer servers are also index-backed, because a fast wrong answer is the failure mode
they share.

**One grant covers Mail, Notes, Reminders and Calendar.** Full Disk Access is indivisible, so a second
single-surface server buys no containment and costs another trip to System Settings.

## Where we lose

**~~Body search.~~** Closed. `search_messages` now takes a `body` term. The lane is
narrow-then-scan rather than an owned index, because the measurements said so: bounded body
queries cost 48 ms to 3 s with nothing stored, and only an unbounded one justifies the 2.2 GB and
the permanent refresh problem an FTS5 index would cost. `imdinu` still wins the unbounded case —
"search my whole archive for a word, no other filter" is a query it answers and this one refuses.
The refusal names the candidate count and the bound, which is the part that matters: it is not a
silent cap reported as an absence. See [mail-body.md](mail-body.md).

**Surface breadth.** LMCP covers 25+ domains including non-Apple apps. Cupertino covers three
surfaces deliberately — [surfaces.md](surfaces.md) records what each additional one costs and why
Terminal, Script Editor and System Settings are excluded on purpose — but "three" loses a feature
comparison to "188" and will keep doing so.

**Installation.** A `.mcpb` desktop extension installs in one click. Cupertino needs a download, a
Full Disk Access trip and a restart. The grant is the reason, and it is not going away.

**Published, with one asterisk.** The signed app ships from GitHub releases and a Homebrew tap, and
as of 2026-08-26 the packages ship too: all eight — `-core`, `-mail`, `-notes`, `-reminders`,
`-calendar`, `-contacts`, `-messages` and `-safari` — are on npm at 1.3.0. The distribution gap this
section was written about is closed.

The asterisk is `-messages` and `-safari`, and it is worth recording rather than quietly enjoying.
Both were published **from a laptop, so neither carries a provenance attestation** — the one thing
[distribution.md](distribution.md) keeps `npm.publish: false` in `.release-it.json` to prevent. npm
forbids republishing a version, so those two builds cannot be re-signed; the next release is where
the attestation comes back. The other six went through the `publish-npm` job and have one.

This section used to claim the gap was closed for both. It was written from the intent of the
`publish-npm` job rather than from the registry, which is the same mistake it criticises the
comparison table for. `npm view @mgcrea/mcp-apple-<name> version` settles it in one line; re-run it
before restating the claim.
