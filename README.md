# @mgcrea/mcp-apple-mail

Model Context Protocol server for the macOS **Apple Mail** app. Read, search and act on the mail
that is already synced to your Mac — no IMAP credentials, no OAuth, no mail leaving the machine.

> **Unofficial.** Not affiliated with Apple. It drives the Mail app that is already on your Mac.

## Status

The AppleScript lane (reads and all mutations) is implemented and working. The search and body
lanes are next — see [Roadmap](#roadmap).

## How it works

Apple Mail exposes two very different surfaces, and this server uses each for what it is good at.
The split is not a preference; it comes from measurements on a real 29,617-message mailbox:

| Operation                                   | Apple Events (AppleScript/JXA)  | Verdict       |
| ------------------------------------------- | ------------------------------- | ------------- |
| List 4 accounts + every mailbox             | **0.6 s**                       | fine          |
| Mailbox total / unread count                | 295 ms / 76 ms                  | fine          |
| Resolve one message by id in a 29 k mailbox | **0.10 s**                      | fine          |
| Fetch N messages, per field                 | ~130 ms + **42 ms per message** | usable to ~50 |
| Read one property per message in a loop     | ~250 ms each                    | never do this |
| `messages whose read status is false`       | **74 seconds**                  | unusable      |

So searching cannot go through Apple Events at all. It has to read Mail's own SQLite index
(`~/Library/Mail/V10/MailData/Envelope Index`), which is what Mail itself searches. That gives
three lanes:

- **AppleScript lane** — accounts, mailboxes, counts, message-by-id, and every mutation. This is
  also the _authority_ lane: after a write, the result is what Mail re-read, never what the index
  says.
- **Index lane** — read-only SQLite for search and filtering. Needs Full Disk Access.
- **Body lane** — `.emlx` files on disk for message bodies and attachments. Needs Full Disk Access,
  and falls back to a per-message Apple Event.

The index is never written to. Mail owns it, holds it open, and reconciles it against IMAP; a write
there is corruption with a delay fuse.

## Permissions

Two separate macOS permissions, doing different jobs. Both are granted to **the app that launches
this server** (Terminal, iTerm, VS Code, Claude…), never to Mail.app.

| Permission            | Needed for                          | Without it                                                                      |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| **Automation → Mail** | everything                          | the server cannot do anything; you get a `-1743` error                          |
| **Full Disk Access**  | search, message bodies, attachments | the server still runs: accounts, mailboxes, counts and capped listings all work |

Grant them in System Settings → Privacy & Security → **Automation** and → **Full Disk Access**,
then **restart** the app you granted it to. `apple_mail_diagnostics` reports exactly which of the
two is missing and what it is blocking.

A wrinkle worth knowing: `stat()` on a TCC-protected file **succeeds** — you can see the size and
mtime of the index without Full Disk Access, and only reading it is denied. So "the file is there"
is not evidence that the permission is granted; `access(R_OK)` is.

## Quick start

```bash
# A. from npm
npx -y @mgcrea/mcp-apple-mail

# B. from source
pnpm install && pnpm build && node dist/cli.js
```

Wire it into Claude Code (`.mcp.json`) or Claude Desktop:

```jsonc
{
  "mcpServers": {
    "apple-mail": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-apple-mail"],
      "env": {
        // Off by default. With it off the write tools are not registered at all.
        "APPLE_MAIL_ALLOW_WRITES": "0",
      },
    },
  },
}
```

Inspect the tools directly:

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

| Tool                        | Does                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apple_mail_diagnostics`    | What the server can currently do and why. **Call this first when anything looks wrong** — it names the exact System Settings pane to open. |
| `apple_mail_list_accounts`  | Accounts with UUIDs, addresses and mailbox names. Start here.                                                                              |
| `apple_mail_list_mailboxes` | Mailboxes, optionally with counts (~0.3 s each).                                                                                           |
| `apple_mail_list_messages`  | Newest N of one mailbox, with a `ref` per message.                                                                                         |
| `apple_mail_count_messages` | Totals and unread, labelled by source.                                                                                                     |

Every message carries an opaque `ref` (`m1:<accountUuid>/<mailbox>#<id>`) which the read and action
tools take. It is versioned and carries its mailbox, so a row id can never be applied to the wrong
mailbox. Do not construct one by hand.

## Security

**Blast radius.** This server can read your entire mail archive and, with writes on, send mail as
you. Two independent controls:

- `APPLE_MAIL_ALLOW_WRITES` (default off) gates every mutation. With it off the write tools are not
  registered — they are invisible to the model, not merely refused.
- `APPLE_MAIL_ACCOUNTS` restricts which accounts are visible at all. This is the _read_-side
  control, and `ALLOW_WRITES` does not cover it. It is enforced in one place, so no query path can
  escape it.

Once implemented, sending will default to leaving a **draft** open for review; actually sending
requires both `ALLOW_WRITES` and an explicit `confirm: true`.

**No secrets.** The server holds no credential of any kind — its access is the macOS permission you
granted the host app. There is nothing here to leak, and nothing is sent anywhere: no network calls
are made at all.

**No shell.** The one place this package spawns a process uses `execFile`, never `exec`, and no
caller input is ever interpolated into script text. Scripts are static constants piped to
`osascript` over stdin; every value travels as a JSON argument. A mailbox named
`"; do shell script "touch /tmp/pwned"; //` is data, not syntax — there is a test for exactly that,
and a tripwire that refuses to run any script containing a `${`.

**Dependencies.** Two: the MCP SDK and zod. SQLite comes from `node:sqlite`, built into Node 24.

## Configure

| Variable                           | Default       | Notes                                                                           |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `APPLE_MAIL_ALLOW_WRITES`          | `0`           | Register the mutating tools.                                                    |
| `APPLE_MAIL_ACCOUNTS`              | all           | Comma-separated account names or UUIDs.                                         |
| `APPLE_MAIL_DEBUG`                 | off           | Verbose logging to stderr.                                                      |
| `APPLE_MAIL_INDEX_MODE`            | `auto`        | `auto` \| `ro` \| `immutable` \| `off`. `off` disables the index lane entirely. |
| `APPLE_MAIL_ROOT`                  | auto          | Override Mail's data root. Normally discovered from Mail itself.                |
| `APPLE_MAIL_ENVELOPE_INDEX`        | auto          | Explicit index path, for tests and forensic copies.                             |
| `APPLE_MAIL_OSASCRIPT_TIMEOUT_MS`  | `30000`       | Sized for the first-run permission prompt, which blocks.                        |
| `APPLE_MAIL_DEGRADED_MAX_MESSAGES` | `50`          | Cap for the Apple Events listing lane.                                          |
| `APPLE_MAIL_MAX_RESULTS`           | `200`         | Ceiling for search results.                                                     |
| `APPLE_MAIL_BODY_MAX_BYTES`        | `262144`      | Body truncation, to protect the context window.                                 |
| `APPLE_MAIL_ATTACHMENT_DIR`        | `~/Downloads` | The only directory attachments may be saved into.                               |
| `APPLE_MAIL_MAILBOX_CACHE_TTL_MS`  | `60000`       | How long the account/mailbox map is cached.                                     |

## Notes

Things that will bite you, documented so nobody has to rediscover them:

- **`unread count` from Mail can be flatly wrong.** On this machine a mailbox reported
  `unreadCount = 0` while `messages whose read status is false` counted 1618 and Mail's own badge
  showed 37 — three numbers for one mailbox. It is a cached value. Counts are therefore reported
  with their source rather than merged.
- **Gmail accounts keep everything in `[Gmail]/All Mail`.** INBOX membership is a _label_, so the
  obvious index query (`WHERE mailbox = ?`) returns an empty inbox. Mailbox names are resolved
  through a ladder that strips the `[Gmail]/` prefix.
- **`immutable=1` is the wrong way to open the index**, even though it is the common advice. It
  tells SQLite to ignore the `-wal` file, and Mail runs in WAL mode, so a read can miss whatever has
  not been checkpointed yet — precisely the recent mail an agent is usually asked about. Note this
  is a race, not a certainty: probing both modes on a live 437 MB index with a 1 MB `-wal` present
  returned the _same_ `MAX(ROWID)`, because the newest message happened to be checkpointed already.
  `mode=ro` is the default because it removes the question, not because staleness was observed.
- **Reading a message does not launch Mail.** If Mail is not running, read tools fail cleanly rather
  than launching it, because launching Mail steals focus and starts a sync.

## Roadmap

Phase 0 is a read-only spike (`pnpm probe`) that answers the questions nobody can answer without
Full Disk Access — chiefly whether the index's `ROWID` is the same integer as the AppleScript
message id, which is what lets a search result be acted on. Phases 2–5 are gated on it.

| Phase                                 | Status                                          |
| ------------------------------------- | ----------------------------------------------- |
| 0 · spike                             | script ready, **needs Full Disk Access to run** |
| 1 · AppleScript lane                  | done                                            |
| 2 · index lane (search)               | blocked on phase 0                              |
| 3 · body lane (`.emlx`)               | blocked on phase 0                              |
| 4 · write lane (flag/move/delete)     | ready to start                                  |
| 5 · compose lane (send/reply/forward) | ready to start                                  |

## Develop

```bash
pnpm install
pnpm dev            # tsdown --watch
pnpm test           # vitest, fully offline
pnpm typecheck
pnpm lint && pnpm format:check
pnpm probe          # the phase 0 spike (needs Full Disk Access)
```

Tests are offline and hermetic: the process boundary is injected, so the queue, the injection
tripwire and the envelope handling all run for real without spawning `osascript` or touching Mail.

## License

MIT
