# @mgcrea/mcp-apple-mail

Model Context Protocol server for the macOS **Apple Mail** app. Read, search and act on the mail
that is already synced to your Mac — no IMAP credentials, no OAuth, no mail leaving the machine.

> **Unofficial.** Not affiliated with Apple. It drives the Mail app that is already on your Mac.

## Status

Search, listing, counting, threading and every mutation are implemented. Reading message _bodies_
is the one remaining lane — see [Roadmap](#roadmap).

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

Two separate macOS permissions, doing different jobs. Neither is granted to Mail.app — it is the
_reader_ that needs permission, not Mail.

| Permission            | Needed for                          | Without it                                                                      |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| **Automation → Mail** | everything                          | the server cannot do anything; you get a `-1743` error                          |
| **Full Disk Access**  | search, message bodies, attachments | the server still runs: accounts, mailboxes, counts and capped listings all work |

**Automation** is granted to the app that launches the server (Terminal, iTerm, VS Code, Claude…).
macOS prompts for it on the first Apple Event, so usually you just click Allow.

**Full Disk Access** is the awkward one, and the reason this package ships a launcher.

### Why you should not just grant it to your editor

macOS attributes a process's file access to its _responsible process_ — the app at the top of the
launch chain. When Claude spawns this server the chain is:

```
launchd → Visual Studio Code.app → Code Helper → claude → node dist/cli.js
```

so the grant would have to go to **VS Code**, and with it every extension, task and terminal command
that editor ever runs would gain read access to your entire disk: Messages, Safari history, SSH
keys, other apps' containers. That is a much larger permission than "may search my mail", and it
defeats `APPLE_MAIL_ACCOUNTS`, which exists to bound exactly this.

You cannot avoid it by granting the permission to `.mcp.json` (it is data, not code) or to `node`
(it is not the responsible process, and it is shared by every node program on the machine).

### The launcher

`scripts/install-wrapper.sh` builds a small signed launcher that re-execs itself with
`responsibility_spawnattrs_setdisclaim`, making it its own responsible process, and starts the
server beneath it. Full Disk Access then goes to **that one binary** and nothing else.

```bash
pnpm build
./scripts/install-wrapper.sh
```

Grant Full Disk Access to the path it prints, and point `.mcp.json` at it instead of `node`:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "/Users/YOU/Library/Application Support/apple-mail-mcp/bin/apple-mail-mcp",
      "env": { "APPLE_MAIL_ALLOW_WRITES": "1" }
    }
  }
}
```

Verified on macOS 26.6: the launcher reads Mail's index while plain `node` in the same shell stays
denied, so the grant really is scoped. `apple_mail_diagnostics` will confirm it.

Three things worth knowing:

- **It is not a general-purpose "run X with Full Disk Access" tool.** The node and server paths are
  compiled in and `argv` is never consulted for what to execute. A launcher that ran whatever it was
  told would let any local process read your whole disk using a permission you granted for mail.
- **Install it once, outside the repo.** macOS ties the grant to a file path, so a launcher living in
  `node_modules` or an `npx` cache would silently lose its permission on the next version bump.
- **`responsibility_spawnattrs_setdisclaim` is a private API.** It has been stable since 10.14, and
  if it ever disappears the launcher says so on stderr and starts the server anyway — you lose the
  search and body lanes, not the server. The fallback is granting Full Disk Access to the host app.

Restart your MCP host after granting. `apple_mail_diagnostics` reports which permission is missing
and what it is blocking.

A wrinkle worth knowing: `stat()` on a TCC-protected file **succeeds** — you can see the size and
mtime of the index without Full Disk Access, and only reading it is denied. So "the file is there"
is not evidence that the permission is granted; `access(R_OK)` is.

This install flow is a stopgap. [docs/distribution.md](../../docs/distribution.md) covers where it
goes next — a signed, notarized app so the grant survives updates and no one needs a compiler —
and why the App Store cannot host any of it.

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

### Attachments

Mail almost always stores attachment bodies _outside_ the message file, in a sidecar tree — on a
real mail store, none of the attachments sampled were inline. So an attachment's size and whether it
can be fetched cannot be answered by parsing the message alone, and two plausible shortcuts are both
wrong:

- A non-empty MIME part does **not** mean the bytes are there. Stripping leaves a byte of delimiter
  whitespace behind, which reads as a present, 1-byte attachment.
- `X-Apple-Content-Length` is **not** a byte size. It records the base64-encoded length, so a
  164,156-byte PDF advertises 224,634.

`list_attachments` therefore reports `sizeBytes` from the file on disk and a `retrievable` flag
saying whether `save_attachment` will actually succeed, rather than guessing from the message.

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

**Attachments.** `save_attachment` can only write inside `APPLE_MAIL_ATTACHMENT_DIR`, and the
filename is reduced to its basename first — a sender who names their attachment
`../../../.ssh/authorized_keys` gets a file called `authorized_keys` in your downloads folder and
nothing else. Existing files are never overwritten unless you ask.

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
- **The on-disk layout nests too, and the ref cannot see it.** `All Mail` is not at
  `<account>/All Mail.mbox` — it is at `<account>/[Gmail].mbox/All Mail.mbox`, and a label like
  `Work/Projects` nests two deep. The index knows the full path, but the ladder above strips it
  down to the leaf before the ref is minted, so the file lane gets `All Mail` and nothing else.
  It therefore resolves the name by walking `*.mbox` directories under the account root (never
  into `Data/`) and, when a leaf name is ambiguous, picks the container that actually holds the
  rowid. A flat join here silently disabled every message-file capability on Gmail accounts.
- **`existsSync` succeeds on a TCC-protected path.** It is stat-based, so it answers "is it
  there", not "may I read it" — `readdirSync` and `readFileSync` are the calls that return
  `EPERM`. Existence and readability are different questions, which is why
  `apple_mail_diagnostics` reads a byte of a real message file rather than statting it, and why
  a lookup can distinguish "wrong path" from "no permission" instead of blaming Full Disk Access
  for both.
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
