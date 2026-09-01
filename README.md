<p align="center">
  <img src="design/cupertino-lockup.svg" alt="Cupertino" width="560">
</p>

# Cupertino

**Put your agent to work in your everyday Apple apps.**

MCP servers for the Apple apps already on your Mac, and the signed app that grants them their
permissions once instead of once each — for any agent that speaks MCP, not for one host.

> **Unofficial.** Not affiliated with Apple. These drive the apps that are already on your Mac.

## In use

> Look at how I write in my work inbox, then draft this reply in the same voice.

> Pull together everything about the Atlas launch from my mail, my notes and my calendar. What do I
> still owe people?

> Turn the action items from yesterday's client thread into reminders, due Friday.

Every one of those carries a constraint — an account, a date bound, a filter. That is the part the
naive `osascript` path answers in 74 seconds or answers wrongly, and the reason a server earns its
place: it holds what the model would otherwise re-derive every session. The measurements are in
[docs/verify.md](docs/verify.md); what the alternatives cost is in
[docs/alternatives.md](docs/alternatives.md).

The last one needs the write gate open on Reminders. Writes are off per surface until you turn them
on, and the toggle decides whether the mutating tools are registered at all — an agent with writes
off cannot see that they exist.

## Surfaces

| Surface   | Package                                    | Status                                                          |
| --------- | ------------------------------------------ | --------------------------------------------------------------- |
| Mail      | [`packages/mail`](packages/mail)           | implemented — 20 tools, search/read/attachments + gated writes  |
| Notes     | [`packages/notes`](packages/notes)         | implemented — 12 tools, search/read/attachments + gated writes  |
| Reminders | [`packages/reminders`](packages/reminders) | implemented — 11 tools, lists/search/dates + gated writes       |
| Calendar  | [`packages/calendar`](packages/calendar)   | implemented — 10 tools, ranges/search/free-time + gated writes  |
| Contacts  | [`packages/contacts`](packages/contacts)   | implemented — 7 tools, resolves handles to names + gated writes |
| Messages  | [`packages/messages`](packages/messages)   | implemented — 7 tools, chats/search/decoded text + gated send   |
| Safari    | [`packages/safari`](packages/safari)       | implemented — 6 tools, history/tabs/reading list, read-only     |
| Maps      | [`packages/maps`](packages/maps)           | implemented — 10 tools, favourites/Guides/recents, gated writes |
| —         | [`packages/core`](packages/core)           | shared: the osascript boundary, TCC-aware errors, ro SQLite     |

Each surface is its own server and its own npm package, so a host loads only the tools it wants.
They share one bundle and one Full Disk Access grant, which is the whole reason they live together
— see [docs/distribution.md](docs/distribution.md).

## Quick start

Each server is on npm and runs straight from `npx` — for Claude Code, a `.mcp.json` beside your
project:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-apple-mail"]
    },
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-apple-notes"]
    }
  }
}
```

The packages are MIT and need no licence key. What they do need is a permission, and on npm you
grant it to whatever launches them — your editor, your terminal — which is the trade the signed
[`Cupertino.app`](https://cupertino.mgcrea.io) exists to avoid: one Full Disk Access grant held by a
notarized binary, instead of one per host. See [docs/licensing.md](docs/licensing.md).

Or run them from source:

```bash
git clone https://github.com/mgcrea/cupertino.git
cd cupertino
pnpm install
pnpm build
```

then point your host at `packages/<surface>/dist/cli.js` by absolute path.

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

| Grant                                     | Needed for                                                      |
| ----------------------------------------- | --------------------------------------------------------------- |
| **Full Disk Access**                      | the index lane: Mail search, attachment bytes                   |
| **Automation** (per target app, prompted) | the Apple Events lane: accounts, mailboxes, all writes          |
| **Contacts** (prompted)                   | the Contacts surface — its store is not behind Full Disk Access |

System Settings → Privacy & Security → Full Disk Access → add the launching app, then restart it.
Granting it to Mail.app does nothing; the reader needs the permission, not Mail.

**What works without Full Disk Access:**

| Surface   | Without the grant                                                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail      | accounts, mailboxes and writes only — search falls back to Apple Events at ~74 s                                                                                                                                                                                                                                                |
| Notes     | **fully usable** below roughly 5k notes; only attachment bytes need the grant                                                                                                                                                                                                                                                   |
| Reminders | usable, but all-day dates and subtasks need the store — the container cannot even be listed without it                                                                                                                                                                                                                          |
| Calendar  | **nothing.** The only surface with no Apple Events read path fast enough to be a fallback — one 90-day range query costs 3.4 s — so every read needs the grant. Writes still work.                                                                                                                                              |
| Contacts  | **nothing** — but it does not want Full Disk Access. Its store sits behind the separate Contacts permission, which macOS _prompts_ for rather than making you find a settings pane. Writes need Automation on top.                                                                                                              |
| Messages  | **nothing at all.** No Apple Events read path exists — Messages answers "Application isn't running" even while running — so there is no second lane and no degraded mode. A send can still be attempted, but with no store to pick the target from or reconcile against, it usually cannot be addressed at all.                 |
| Safari    | **live tabs, and only those.** The one surface whose lanes are not fallbacks for each other: Apple Events sees what is open now, the file lane sees everything else. History, bookmarks and the Reading List all need the grant.                                                                                                |
| Maps      | **nothing at all.** The only surface with no second lane by construction: Maps ships no scripting dictionary, so there is no Apple Events fallback to degrade to. Without the grant this server returns an error rather than an empty list, because an empty list of favourites reads exactly like a person who has saved none. |

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

### Contacts

| Always available                                                  | Write-gated                       |
| ----------------------------------------------------------------- | --------------------------------- |
| `resolve_handles` `search_contacts` `list_contacts` `get_contact` | `create_contact` `update_contact` |
| `diagnostics`                                                     |                                   |

`resolve_handles` turns phone numbers and email addresses into names, which is what makes the
Messages surface readable at all. Read `status` on each result rather than assuming a name came
back: `unknown` is common and not an error, and `ambiguous` means two contacts share the number, so
no name is returned rather than a guess.

**There is no delete tool.** Contacts' scripting dictionary has no delete command of any kind, and
this surface's writes go through Apple Events because its store is read-only by policy. That was
true of every surface until Maps, which has no scripting dictionary to go through and writes SQL
instead. See [docs/contacts.md](docs/contacts.md).

### Messages

| Always available                               | Write-gated    |
| ---------------------------------------------- | -------------- |
| `list_chats` `list_messages` `search_messages` | `send_message` |
| `get_message` `diagnostics`                    |                |

**One write tool, because the dictionary has one usable command.** `sdef` lists `send`, `login` and
`logout`; the other two would sign the user out of iMessage on every device they own. There is no
edit, delete, mark-as-read or reaction verb to expose.

This is the only surface where Apple Events is a **write lane and nothing else** — every read
through it fails, so with `APPLE_MESSAGES_ALLOW_WRITES` off no Apple Event is ever sent and no
Automation grant is ever requested.

`send_message` prefers a `chatRef` from `list_chats` over a raw handle, because Messages refuses to
enumerate participants for a script: an existing conversation is the only target that can be
addressed reliably. Apple Events hands back no identifier for what it sent, so the result is
reconciled against `chat.db` — `reconciliation: "matched"` carries a real message ref, and
`"pending"` means Messages accepted the send but has not written the row yet. **Pending is not a
failure, and retrying it sends the message twice.**

About 3% of messages across all history keep their text only in an archived `NSArchiver` blob that
SQL cannot reach — and Apple stopped writing the plain column in early 2026, so for anything recent
it is ~100%. This server decodes them; `textSource` on every result says which lane answered. See
[docs/messages.md](docs/messages.md).

### Safari

| Always available                                   | Write-gated |
| -------------------------------------------------- | ----------- |
| `search_history` `get_page` `list_tabs`            | — none      |
| `list_bookmarks` `list_reading_list` `diagnostics` |             |

**Read-only, and the write column is empty on purpose.** Opening a URL or adding to the Reading
List is an Apple Event that navigates a real, visible browser, and no write on this surface was
ever probed.

`list_tabs` is the only tool in the whole bundle that works without Full Disk Access — it needs an
Automation grant instead, and Safari has to be running. Ask for the tab marked `frontmost` to get
the one the user is looking at: `active` means selected in its own window, so two open windows
produce two active tabs. A tab's `history` field being null means **not found in history**, never
"never visited": the match rate is a property of the tab set rather than of the surface, measured at
60.7%, 55.3% and 8.3% on three real runs. Single-page apps are the main reason — a page reached by
pushState commits no history row at all. Each match reports `historyMatch`, and even an `exact` one
can be a different site when the address is reused, as any `localhost` URL is.

**Page content comes from a Safari extension, and only for websites you allow it on.**
`apple_safari_read_page` returns a page as readable text or raw HTML. It is a snapshot taken when
the page loaded rather than a live read, so every result says when it was captured and how old it
is — a page you have navigated away from still answers, and saying so is the point.

**There is still no `do JavaScript` tool.** That verb needs "Allow JavaScript from Apple Events", a
developer-menu toggle which is not a TCC grant and whose own state cannot be read, so diagnostics
could never tell you in advance whether it would work — and it is global: any process able to send
Apple Events could then run script in any tab. Safari exposes no `AXWebArea` for page content
either, so the Accessibility lane that reaches Mail's composer does not reach a web page. The
extension is the only route, and it is the one Safari scopes per website.
See [docs/safari.md](docs/safari.md).

### Maps

| Always available                                                 | Write-gated                      |
| ---------------------------------------------------------------- | -------------------------------- |
| `list_favorites` `list_collections` `list_collection_places`     | `add_favorite` `remove_favorite` |
| `list_unfiled_places` `list_recents` `search_places` `get_place` |                                  |
| `diagnostics`                                                    |                                  |

Favourites, collections (Guides) and recents, from a Core Data store under Full Disk Access —
with real coordinates and addresses, which is what makes it worth having.

`list_unfiled_places` returns the saved places filed in **no** Guide. Maps shows them only in a
union view, and 7 of the 12 on the probed Mac appeared nowhere else in the store — not as a
favourite, not in another Guide, not in recents.

It reads **what is saved on this Mac**. It does not search Apple's map of the world, geocode an
address, or give directions; the guide says so, because answering those from general knowledge is
the most likely way for this surface to be wrong.

**It writes, and it is the only surface here that does so without an Apple Event.** Maps ships no
scripting dictionary and registers no App Intents on macOS, so `add_favorite` and `remove_favorite`
go into the Core Data store directly — which means `usesAppleEvents` stays false even with the write
gate open, and adding this surface still widens no Automation consent.

The part that cannot be faked is the GEO place record, so it never is: the place is opened through
the `maps://` URL scheme, **Maps mints the record itself**, and it is copied. Two consequences the
tools state rather than hide — saving a place the store does not already know leaves an entry in
Recents, and because the store is mirrored by `NSPersistentCloudKitContainer` the write reaches every
device on the account. There is no local-only insert here.

It was also declared impossible three times before it was found: the store has no file extension,
it sits in the one directory of Maps' container that Full Disk Access gates, and
`group.com.apple.Maps` is a decoy that is `EPERM` rather than empty. See
[docs/maps.md](docs/maps.md).

All names are prefixed `apple_mail_` / `apple_notes_` / `apple_reminders_` / `apple_calendar_` /
`apple_contacts_` / `apple_messages_` / `apple_safari_` / `apple_maps_`.

## Prompts and resources

Tools are what an agent _calls_. Two other things every server knows are the wrong shape for a tool,
because a tool result is not addressable and does not outlive the session that paid for it: the
inventory every other tool takes as an argument, and the diagnostics that get read one round trip
after the confusing answer instead of before it.

So each server also exposes **resources**:

| URI                                 | What                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `cupertino://<surface>/guide`       | the operating manual — static, so it reads with every grant denied |
| `cupertino://<surface>/diagnostics` | the live capability and permission report                          |
| `cupertino://<surface>/inventory`   | accounts and mailboxes / folders / lists / calendars               |

and **workflow prompts**, which hold the constraints a tool description cannot: not "what this call
does" but what order the calls go in. `apple_mail_triage`, `apple_mail_find_thread`,
`apple_reminders_whats_due`, `apple_calendar_whats_my_day`, `apple_messages_catch_up` and the rest,
one to three per surface. Each embeds its surface guide, so a host that expands a prompt hands the
model the reference material with it.

Write prompts follow the write tools exactly: with writes off, `apple_mail_draft_reply` is not
refused, it is **not registered**. Full design notes, and what was deliberately left out, in
[docs/prompts-and-resources.md](docs/prompts-and-resources.md).

## Configuration

Environment only — these servers hold no secret of their own, so there is no config file. Prefix
is `APPLE_MAIL_`, `APPLE_NOTES_`, `APPLE_REMINDERS_`, `APPLE_CALENDAR_`, `APPLE_CONTACTS_`,
`APPLE_MESSAGES_`, `APPLE_SAFARI_` or `APPLE_MAPS_`.

| Variable                 | Default       | What                                                           |
| ------------------------ | ------------- | -------------------------------------------------------------- |
| `*_ALLOW_WRITES`         | `false`       | register the mutating tools at all                             |
| `*_EXPOSE_PROMPTS`       | `true`        | register the workflow prompts and `cupertino://` resources     |
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

`*_EXPOSE_PROMPTS` is a cost knob, not a safety gate — which is why it defaults **on** while
writes default off. Measured across all seven servers with writes enabled, the prompt and resource
listings come to ~3.4k tokens against ~18.5k for the tool definitions, so about 18% on top of a
bill that tools dominate either way; resource _contents_ cost nothing until something reads one. If
context is the problem, running fewer servers is the far bigger lever.

Calendar takes `APPLE_CALENDAR_WORKDAY_START`, `APPLE_CALENDAR_WORKDAY_END` and
`APPLE_CALENDAR_WORKDAYS` (`mon,tue,wed,thu,fri`), which set the working day
`apple_calendar_find_availability` offers time inside when a call names no hours of its own.

## The app

The menu bar is Cupertino's whole surface — there is no Dock icon and no main window.

| Section              | What it answers                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Full Disk Access     | granted or not, with the button that opens the right Settings pane                                                         |
| One pane per surface | whether the surface is on at all, Automation status per app, the consent prompt, and the writes toggle                     |
| Connections          | which client is talking to which server right now, and how many tools it has called                                        |
| MCP clients          | one-click wiring for Claude Desktop, Cursor, LM Studio and Windsurf; a copyable command for Claude Code, VS Code and Codex |
| Activity…            | opens a window listing every tool call, live                                                                               |

The **Activity** window records tool names and the arguments each was called with. Message
contents — a mail body, a message, a note's text — are blanked unless you turn them on for that
surface, and results are recorded only for a surface that asks. Nothing is written to disk unless
you ask for it: by default the log is a bounded ring in memory, cleared when Cupertino quits.

Settings › Activity turns on a durable **audit log**: append-only JSONL under Application Support,
0600, in segments, with retention by age and size. Whether that file carries arguments is a second
switch, and whether it carries message contents is a third — getting a mail body onto disk takes
three deliberate acts, because that is what it is.

Each record carries a hash of the one before it, so an edited field, a removed record or a truncated
file can be detected. That is the whole claim: it catches tampering by something that does not know
it is a chain. It is **not** proof against anyone who can write the file, because they can recompute
it. Export writes the segments plus a manifest; signing is optional, proves the export came from
this Mac unaltered, and means nothing to a recipient who was not given the key some other way.
It is the answer to "what did the assistant just do with my mail?", and the reason the servers run
under an app you can see rather than inside whichever editor spawned them.

Writes are off per surface until you turn them on, and the toggle decides whether the mutating
tools are registered at all — an assistant with writes off cannot see that they exist.

Surfaces themselves can be switched off, from the switch in a surface's own pane or by
right-clicking its row in the sidebar. A surface that is off is not served at all: its server key
is left out of the clients Cupertino configures and pruned from the ones it has already written,
its running servers are stopped, and the bridge refuses the connection if an older config still
asks for it. That is the lever for the tool definitions you never use — eight servers wired
everywhere is a cost every session pays. Clients configured before the change keep the entry until
you press Update in **Settings › Clients**, which names the ones that still hold it. Claude Code
and Codex get a copyable removal command; Visual Studio Code has no command that removes a server,
so that one has to be edited by hand.

Everything that is true of one surface lives in that surface's pane: whether it is on, its
Automation grant, its writes toggle, its store, and what its server actually exposes. Settings
keeps only what has no surface — Full Disk Access, Accessibility and System Events — plus client
wiring and the licence.

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

|                                                                |                                               |
| -------------------------------------------------------------- | --------------------------------------------- |
| [docs/distribution.md](docs/distribution.md)                   | how this ships, and why not the App Store     |
| [docs/surfaces.md](docs/surfaces.md)                           | which surfaces, and what each one costs       |
| [docs/licensing.md](docs/licensing.md)                         | what is open, what is sold, what buys trust   |
| [docs/alternatives.md](docs/alternatives.md)                   | what else reads Apple Mail, and where we lose |
| [docs/mail-body.md](docs/mail-body.md)                         | the body-search lane, and how it is decided   |
| [docs/notes.md](docs/notes.md)                                 | Apple Notes phase-0 measurements              |
| [docs/reminders.md](docs/reminders.md)                         | Apple Reminders phase-0 measurements          |
| [docs/messages.md](docs/messages.md)                           | Apple Messages: measurements, decoder, send   |
| [docs/calendar.md](docs/calendar.md)                           | Apple Calendar phase-0 measurements           |
| [docs/safari.md](docs/safari.md)                               | Safari phase-0 measurements                   |
| [docs/maps.md](docs/maps.md)                                   | Maps phase-0 measurements                     |
| [docs/envelope-index.md](docs/envelope-index.md)               | Mail's observed `Envelope Index` schema       |
| [docs/prompts-and-resources.md](docs/prompts-and-resources.md) | what the servers expose beyond tools          |
| [docs/verify.md](docs/verify.md)                               | checking the Mail server against a real index |

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
                     #   --send-target=<handle> also checks the send lane's targeting, without sending
pnpm probe:calendar  # settles whether Calendar has a file lane at all
pnpm probe:safari    # History.db, and the Reading List hiding inside Bookmarks.plist
pnpm probe:maps      # MapsSync, the store with no file extension behind the grant
pnpm probe:contacts  # the resolver Messages needs — its own TCC grant, not Full Disk Access
```

Every probed surface now has a package. **Safari is the only read-only one** — it registers no mutating tool, and that is a recorded decision rather than an omission: opening a URL or adding to Safari's Reading List navigates a real, visible browser and was never probed. See [docs/safari.md](docs/safari.md). **Maps writes without an Apple Event at all**, which nothing else here does: it has no scripting dictionary, so `add_favorite` asks Maps to mint a place record through the `maps://` URL scheme and then writes SQL into the Core Data store. That store is CloudKit-mirrored, so the write reaches every device on the account — the only write in the bundle whose blast radius exceeds the machine. [docs/maps.md](docs/maps.md) carries the four lanes that were measured to get there. Messages registers exactly one write tool, `send_message`, which is the whole of what its scripting dictionary can do.
Every probe degrades rather than exits — an app that is not running, or a permission that is not
granted, is reported as a finding — and none of them launches an app unless you pass `--launch`.
Their shared mechanism lives in [scripts/lib/probe-kit.mjs](scripts/lib/probe-kit.mjs).

<!-- <generated:version> generated from package.json by `make version` — do not edit by hand -->

Releases are tagged per package, so a tag names what it publishes: `mail-v1.7.0`,
`reminders-v1.7.0`, `calendar-v1.7.0`, `core-v1.7.0`. The app is tagged `app-v1.7.0` and releases on its own lane —
a signed, notarized `Cupertino.zip` attached to the GitHub release, plus its SHA-256. See
[docs/distribution.md](docs/distribution.md).
<!-- </generated:version> -->

> The repo is `cupertino`; the npm packages stay `@mgcrea/mcp-apple-*`, because that is what
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
