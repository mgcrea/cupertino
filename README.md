# Cupertino

MCP servers for the Apple apps already on your Mac, and the signed app that grants them their
permissions once instead of once each.

> **Unofficial.** Not affiliated with Apple. These drive the apps that are already on your Mac.

## Surfaces

| Surface   | Package                                    | Status                                                         |
| --------- | ------------------------------------------ | -------------------------------------------------------------- |
| Mail      | [`packages/mail`](packages/mail)           | implemented — 18 tools, search/read/attachments + gated writes |
| Notes     | [`packages/notes`](packages/notes)         | implemented — 12 tools, search/read/attachments + gated writes |
| Reminders | [`packages/reminders`](packages/reminders) | implemented — 11 tools, lists/search/dates + gated writes      |
| Calendar  | [`packages/calendar`](packages/calendar)   | implemented — 9 tools, ranges/search/recurrence + gated writes |
| Messages  | —                                          | not started                                                    |
| —         | [`packages/core`](packages/core)           | shared: the osascript boundary, TCC-aware errors, ro SQLite    |

Each surface is its own server and its own npm package, so a host loads only the tools it wants.
They share one bundle and one Full Disk Access grant, which is the whole reason they live together
— see [docs/distribution.md](docs/distribution.md).

## Quick start

**Nothing is published to npm yet.** Both servers run from source today; the signed `Cupertino.app`
and the `@mgcrea/mcp-apple-*` packages land together at the first release.

```bash
git clone https://github.com/mgcrea/mcp-cupertino.git
cd mcp-cupertino
pnpm install
pnpm build
```

Point your MCP host at the built CLIs — for Claude Code, a `.mcp.json` beside your project:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/abs/path/to/mcp-cupertino/packages/mail/dist/cli.js"]
    },
    "apple-notes": {
      "command": "node",
      "args": ["/abs/path/to/mcp-cupertino/packages/notes/dist/cli.js"]
    }
  }
}
```

Writes are off unless you ask for them — see [Configuration](#configuration).

Running through the menu bar app instead routes every server through the bridge, so Full Disk
Access is granted to Cupertino rather than to whichever editor spawned the server:

```bash
make run      # build Cupertino.app, point it at packages/*/dist, launch it
make smoke    # handshake every server through the bridge
```

The repo's checked-in [`.mcp.json`](.mcp.json) is wired for that path. `make` on its own lists
every target.

Note the different server names. Wired by hand as above, a server is `apple-mail` and runs under
whatever grant its host process has. Wired by Cupertino it is `cupertino-mail`, because that entry
points at the app's bridge and runs under the app's grant. Two names for two deployments, and you
can have both. The app only ever touches its own `cupertino-*` keys — an `apple-mail` entry
belonging to some other server is left alone.

Cupertino is machine configuration, not a project dependency, so it belongs in a per-user config:
one file each for Claude Desktop, Cursor, LM Studio and Windsurf, and `--scope user` for the CLIs,
which is what the app's copyable commands use. Deliberately **not** `--scope project`, which writes
an `.mcp.json` meant to be committed — that entry is an absolute path into a bundle on one Mac,
backed by one person's Full Disk Access grant, and it would be useless to a teammate and unwise to
offer them.

Which clients get written and which get a command is not about popularity. The app merges into a
config only when it is strict JSON with servers under `mcpServers`; Visual Studio Code's is JSONC
and Codex's is TOML, and re-serialising either would delete the comments in a file maintained by
hand. Claude Code's `~/.claude.json` is strict JSON, but it holds credentials and running sessions
write to it concurrently, so a read-modify-write from a menu bar could drop somebody else's change.
Those three get a line to paste. ChatGPT is absent entirely: it takes remote HTTP connectors and
cannot spawn a local stdio server at all.

This repo's own [`.mcp.json`](.mcp.json) is the exception, and it names its servers
`cupertino-*-dev` on purpose: it points at `apps/apple/.build`, so working on the app means having
the development build and the installed one side by side. Claude Code reports servers of the same
name in two scopes as a conflict rather than picking one, so the suffix is what keeps both usable.

`Cupertino.app` needs **macOS 26 or later** — its icon is an Icon Composer bundle, which nothing
older can render. The servers themselves are plain Node and carry no such floor; only the menu bar
app does.

## Permissions

Two separate macOS grants, and they land on **whatever process launched the server** — your
editor, your terminal, or Cupertino — never on Mail, Notes or Reminders themselves.

| Grant                                     | Needed for                                             |
| ----------------------------------------- | ------------------------------------------------------ |
| **Full Disk Access**                      | the index lane: Mail search, attachment bytes          |
| **Automation** (per target app, prompted) | the Apple Events lane: accounts, mailboxes, all writes |

System Settings → Privacy & Security → Full Disk Access → add the launching app, then restart it.
Granting it to Mail.app does nothing; the reader needs the permission, not Mail.

**What works without Full Disk Access:**

| Surface   | Without the grant                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail      | accounts, mailboxes and writes only — search falls back to Apple Events at ~74 s                                                                                                   |
| Notes     | **fully usable** below roughly 5k notes; only attachment bytes need the grant                                                                                                      |
| Reminders | usable, but all-day dates and subtasks need the store — the container cannot even be listed without it                                                                             |
| Calendar  | **nothing.** The only surface with no Apple Events read path fast enough to be a fallback — one 90-day range query costs 3.4 s — so every read needs the grant. Writes still work. |

Tools that need the index don't disappear when it's missing — the tool list is a pure function of
`allowWrites` and nothing else, because MCP clients cache it. They return a structured `degraded`
result naming what's absent. `apple_mail_diagnostics` / `apple_notes_diagnostics` report which lane
is live and how to grant what's missing.

## Tools

Read tools are always registered. Write tools are **invisible unless writes are enabled** — not
merely refused.

### Mail

| Always available                                                | Write-gated                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `search_messages` `list_messages` `count_messages` `get_thread` | `set_message_flags` `move_messages` `delete_messages` `check_for_new_mail` |
| `get_message` `get_message_source` `list_attachments`           | `send_message` `reply_to_message` `forward_message`                        |
| `list_accounts` `list_mailboxes` `diagnostics`                  | `save_attachment`                                                          |

### Notes

| Always available                                          | Write-gated                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `list_notes` `search_notes` `get_note` `list_attachments` | `create_note` `update_note` `move_note` `delete_notes` `save_attachment` |
| `list_accounts` `list_folders` `diagnostics`              |                                                                          |

### Reminders

| Always available                                                | Write-gated                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `list_reminders` `search_reminders` `get_reminder` `list_lists` | `create_reminder` `update_reminder` `complete_reminders` `move_reminders` `delete_reminders` |
| `list_accounts` `diagnostics`                                   |                                                                                              |

### Calendar

| Always available                                           | Write-gated                                   |
| ---------------------------------------------------------- | --------------------------------------------- |
| `list_events` `search_events` `get_event` `list_calendars` | `create_event` `update_event` `delete_events` |
| `list_accounts` `diagnostics`                              |                                               |

`list_events` expands repeating events, so a weekly standup is returned once per week. Every result
carries the window the expansion is known to cover, and sets `truncated` when a range runs past it
rather than coming back short — a short list of events is indistinguishable from a free afternoon.

All names are prefixed `apple_mail_` / `apple_notes_` / `apple_reminders_` / `apple_calendar_`.

## Configuration

Environment only — these servers hold no secret of their own, so there is no config file. Prefix
is `APPLE_MAIL_`, `APPLE_NOTES_`, `APPLE_REMINDERS_` or `APPLE_CALENDAR_`.

| Variable                 | Default       | What                                                           |
| ------------------------ | ------------- | -------------------------------------------------------------- |
| `*_ALLOW_WRITES`         | `false`       | register the mutating tools at all                             |
| `*_ACCOUNTS`             | all           | account allowlist (names or UUIDs) — the **read**-side control |
| `*_ATTACHMENT_DIR`       | `~/Downloads` | the only directory attachments may be written into             |
| `*_MAX_RESULTS`          | `200`         | cap on any listing                                             |
| `*_INDEX_MODE`           | `auto`        | `auto` \| `ro` \| `immutable` \| `off`                         |
| `*_OSASCRIPT_TIMEOUT_MS` | `30000`       | per-Apple-Events-call timeout                                  |
| `*_DEBUG`                | `false`       | verbose logging to stderr                                      |

`allowWrites` gates mutation, but on Mail the larger blast radius is _reading_ an entire archive —
that is what `*_ACCOUNTS` is for, and it is enforced in exactly one place so no query path escapes
it. Mail also takes `*_ROOT`, `*_ENVELOPE_INDEX`, `*_DEGRADED_MAX_MESSAGES`, `*_BODY_MAX_BYTES`,
`*_BODY_SCAN_MAX`, `*_BODY_SCAN_BYTES` and `*_MAILBOX_CACHE_TTL_MS`; see [`packages/mail/src/config.ts`](packages/mail/src/config.ts).

## The app

The menu bar is Cupertino's whole surface — there is no Dock icon and no main window.

| Section                             | What it answers                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Full Disk Access                    | granted or not, with the button that opens the right Settings pane                                                         |
| Mail / Notes / Reminders / Calendar | Automation status per app, the consent prompt, and the writes toggle                                                       |
| Connections                         | which client is talking to which server right now, and how many tools it has called                                        |
| MCP clients                         | one-click wiring for Claude Desktop, Cursor, LM Studio and Windsurf; a copyable command for Claude Code, VS Code and Codex |
| Activity…                           | opens a window listing every tool call, live                                                                               |

The **Activity** window records tool _names_ only — never arguments, message contents or results.
It is the answer to "what did the assistant just do with my mail?", and the reason the servers run
under an app you can see rather than inside whichever editor spawned them.

Writes are off per surface until you turn them on, and the toggle decides whether the mutating
tools are registered at all — an assistant with writes off cannot see that they exist.

## Why a single app

Full Disk Access is one indivisible whole-disk grant. Granting it per surface buys no containment
and costs a System Settings trip each time, so every surface ships inside one signed, notarized app
called Cupertino. [docs/distribution.md](docs/distribution.md) also records why the Mac App Store
cannot host any of this, so the question does not get re-opened.

But the grant is not the only thing the app holds, and it is not the only reason to run the servers
under it rather than under an editor:

|                                        |                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **The grant lands on Cupertino**       | not on whichever editor spawned the server, and with it every extension and task that editor runs      |
| **A visible audit trail**              | the Activity window lists every tool call, live; a server inside an editor is unobservable             |
| **Writes are off, per surface**        | and the toggle decides whether the mutating tools are registered at all                                |
| **`*_ACCOUNTS` bounds reading**        | the blast radius on Mail is the archive, not the mutations                                             |
| **Results say how much to trust them** | `indexAgeSeconds`, a WAL-blind warning, and a structured `degraded` result rather than a vanished tool |
| **Four surfaces, one grant**           | which is the actual payoff of the indivisibility above                                                 |

[docs/alternatives.md](docs/alternatives.md) is the honest version of that list: what else reads
Apple Mail for an assistant, and where those tools are ahead.

## Documentation

|                                                  |                                               |
| ------------------------------------------------ | --------------------------------------------- |
| [docs/distribution.md](docs/distribution.md)     | how this ships, and why not the App Store     |
| [docs/surfaces.md](docs/surfaces.md)             | which surfaces, and what each one costs       |
| [docs/licensing.md](docs/licensing.md)           | what is open, what is sold, what buys trust   |
| [docs/alternatives.md](docs/alternatives.md)     | what else reads Apple Mail, and where we lose |
| [docs/mail-body.md](docs/mail-body.md)           | the body-search lane, and how it is decided   |
| [docs/notes.md](docs/notes.md)                   | Apple Notes phase-0 measurements              |
| [docs/reminders.md](docs/reminders.md)           | Apple Reminders phase-0 measurements          |
| [docs/messages.md](docs/messages.md)             | Apple Messages phase-0 measurements           |
| [docs/calendar.md](docs/calendar.md)             | Apple Calendar phase-0 measurements           |
| [docs/safari.md](docs/safari.md)                 | Safari phase-0 measurements                   |
| [docs/envelope-index.md](docs/envelope-index.md) | Mail's observed `Envelope Index` schema       |
| [docs/verify.md](docs/verify.md)                 | checking the Mail server against a real index |

## Working on it

```bash
pnpm build          # every package
pnpm test           # every package
pnpm typecheck
pnpm lint
pnpm format
```

The marketing site is its own workspace, and deploys by hand:

```bash
pnpm --filter @mgcrea/cupertino-website dev     # astro dev
pnpm --filter @mgcrea/cupertino-website build   # static build
```

It is built from the design canvas in `.idea/design/`, and reads its tool counts from
`packages/*/src/tools/` rather than from this file — see [apps/website](apps/website/AGENTS.md).

The Swift half is `xcodebuild`, named by the Makefile rather than wrapped by it:

```bash
make app            # build Cupertino.app (Debug)
make run            # build, point at packages/*/dist, launch
make smoke          # handshake every server through the bridge
make stop           # quit and remove the socket
```

The app's screenshots are captured rather than taken by hand — `apps/apple/Screenshots/` holds the
config and the committed goldens, and the website renders the output:

```bash
make screenshots          # capture, gate against the goldens, compose both sets
make screenshots-check     # gate only — fails if the UI drifted
make screenshots-update    # accept the captures as the new goldens (review the diffs first)
make screenshots-selftest  # prove the gate fails when it should
```

A run takes over the pointer and the active app at the moment of each shot, so do not use the
machine while it runs. It needs Screen Recording permission for the **terminal**, never for
Cupertino itself. `make screenshots-doctor` checks that and the two other things that otherwise
fail silently: whether the caption font resolves, and whether the output size is one a store would
accept.

What the screenshots show is fixture data from `apps/apple/Cupertino/DemoSeed.swift`, not this Mac:
in `-ScreenshotMode` the app starts no host, seeds its own log and sessions, and answers the
permission and store questions from a table. Without that the images would report one laptop's TCC
state and print its home directory into the marketing site.

Phase-0 probes are repo-wide and read-only. They need the permission of the surface they measure,
and redact their output to counts, timings and DDL:

```bash
pnpm probe:mail      # Envelope Index — needs Full Disk Access
pnpm probe:mail-body # which lane can search message bodies — needs Full Disk Access
pnpm probe:notes     # Notes — the Apple Events half runs without it
pnpm probe:reminders # Reminders — the store path is a glob, so finding it is itself privileged
pnpm probe:messages  # chat.db — no Apple Events read lane exists, so this one needs the grant
pnpm probe:calendar  # settles whether Calendar has a file lane at all
pnpm probe:safari    # History.db, and the Reading List hiding inside Bookmarks.plist
```

Messages and Safari are **probed but unbuilt**: there is a phase-0 probe and no package.
Every probe degrades rather than exits — an app that is not running, or a permission that is not
granted, is reported as a finding — and none of them launches an app unless you pass `--launch`.
Their shared mechanism lives in [scripts/lib/probe-kit.mjs](scripts/lib/probe-kit.mjs).

Releases are tagged per package, so a tag names what it publishes: `mail-v0.1.0`,
`reminders-v0.1.0`, `calendar-v0.1.0`, `core-v0.1.0`. The app is tagged `app-v1.0.0` and releases on its own lane —
a signed, notarized `Cupertino.zip` attached to the GitHub release, plus its SHA-256. See
[docs/distribution.md](docs/distribution.md).

> The repo is `mcp-cupertino`; the npm packages stay `@mgcrea/mcp-apple-*`, because that is what
> people search npm for. Neither name is load-bearing. The bundle identifier `io.mgcrea.cupertino`
> is the string that actually matters, because changing it would invalidate every user's Full Disk
> Access grant.

## Licence

Two, because the halves are not the same thing.

| Part                        | Licence                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/*`, `scripts/`    | [MIT](LICENSE) — libraries, vendor them freely                                                |
| `apps/apple/`               | [source-available](apps/apple/LICENSE) — read, audit, compile; binary redistribution reserved |
| the signed, notarized build | sold, under the [EULA](apps/apple/EULA) shipped with it                                       |

Cupertino asks for Full Disk Access, so the source stays readable — that is what such a grant is
owed, and reading it is the point. Running it is a separate question: the licence check lives in the
source, so any build asks for a key, yours or ours. What is sold is the notarized binary and the
maintenance behind it. The servers are MIT and run on their own with no key at all. The reasoning is
in [docs/licensing.md](docs/licensing.md).
