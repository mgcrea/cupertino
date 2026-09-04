# Clients

`docs/surfaces.md` describes what Cupertino serves and `docs/distribution.md` why it ships signed
rather than sandboxed. This describes the other end: the seven MCP clients Cupertino knows how to
wire, why two of them are handed a command instead, and what the client pane can and cannot tell
you about a file it does not own.

## The seven clients

| Client             | Config                                                            | Root key      | Format |
| ------------------ | ----------------------------------------------------------------- | ------------- | ------ |
| Claude Code        | `~/.claude.json`                                                  | `mcpServers`  | JSON   |
| Claude Desktop     | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers`  | JSON   |
| Cursor             | `~/.cursor/mcp.json`                                              | `mcpServers`  | JSON   |
| LM Studio          | `~/.lmstudio/mcp.json`                                            | `mcpServers`  | JSON   |
| Windsurf           | `~/.codeium/windsurf/mcp_config.json`                             | `mcpServers`  | JSON   |
| Visual Studio Code | `~/Library/Application Support/Code/User/mcp.json`                | `servers`     | JSON   |
| ChatGPT & Codex    | `~/.codex/config.toml`                                            | `mcp_servers` | TOML   |

Every one of them is written by the app. Three disagreements shape the design and none is
Cupertino's to fix: clients disagree about **where servers live** in the file — `mcpServers` here,
`servers` there, `mcp_servers` in a third — about **what the file is written in**, and about
whether the app may rewrite it wholesale.

`ClientWiring.clients` is the authority; `apps/website/src/config.ts` keeps a copy for the
marketing page, and the two are kept in step by hand.

Six are strict JSON holding nothing but data, so they are serialised from a dictionary. The seventh
is not, and `ClientWiringTOML` is the answer: it locates the lines that hold MCP servers, replaces
those, and quotes every other byte of the file verbatim. A wire against the real config produces a
`diff` with one hunk in it, and that hunk is a pure addition.

**Two of these rows used to be a shell line to paste**, and both corrections are worth recording
because one was a mistake and the other was only expensive.

VS Code was refused on the grounds that its config is JSONC. It is not: `settings.json` is JSONC,
and `User/mcp.json` — a different file, which is where VS Code actually keeps MCP servers — is
strict JSON with servers under `servers`, written by VS Code itself. The residual worry, that VS
Code might tolerate a comment somebody adds later, does not survive looking at what would happen:
every write begins with a read, and `JSONSerialization` throws on a comment, so such a file reads as
`unreadable` and the write refuses. It fails closed. It cannot strip a comment it cannot parse.

Codex was refused for a real reason — it is TOML, and no serialiser can round-trip it safely — and
the answer was a paste for as long as nobody had written a splicer. Bastion had; see
[the TOML client](#the-one-toml-client).

The last row is one client rather than three. The ChatGPT desktop app, the Codex CLI and the Codex
IDE extension all read that same file — the ChatGPT app even bundles the Codex binary, at
`/Applications/ChatGPT.app/Contents/Resources/codex`, and names it in `CODEX_CLI_PATH`. Three rows
would write the same keys to the same path three times, and removing any one of them would take the
other two out.

It is worth stating what that row is **not** absent for, because the code said so for a while and it
was wrong: ChatGPT does not "take remote HTTP connectors only". Connectors are remote-only; the
Codex lane inside the same app runs local stdio servers, and ships three of its own in that file —
`node_repl`, `computer-use` and `cua_repl`, every one a `command` pointing into
`/Applications/ChatGPT.app`.

**Zed** and **Goose** are absent for now rather than on principle: Zed wants a `context_servers` entry whose
shape has moved between versions, Goose a YAML `extensions:` block, and neither has a CLI to hide
behind. `.command` accommodates them the day somebody asks.

## The one TOML client

`~/.codex/config.toml` is not like the other six. On the machine this was ported against it carries
twenty-nine `[projects."…"]` tables, a `[features]` block, a `[shell_environment_policy.set]` table
and a multi-line string full of markdown — hand-written structure and prose, with the MCP servers a
small part of it. So there is no TOML library here, and that is the same objection that keeps VS
Code on `mcp.json` rather than `settings.json`: **round-tripping somebody's hand-written file
through any serialiser reformats it and deletes its comments.**

### The invariant

> The scanner may fail to **describe** a server. It must never fail to **name** one.

A server it could see but not parse still appears in the servers dictionary, which makes `isOurs`
false, which makes `collisions` refuse to write over it. If it were dropped instead, `collisions`
would see nothing in the way, a wire would append a second `[mcp_servers.<name>]`, and **a duplicate
key does not cost one entry — it makes the whole file fail to parse**, taking every server and every
project trust level with it. That is a read bug with a catastrophic write consequence, and it is why
extents and values are two different jobs: the lexer decides where a table starts and stops and may
refuse, and the value parser is best effort and never refuses.

### What a span is

A server's lines run from its `[mcp_servers.<name>]` header to the last line under it that says
something, **not** to the next header. The blank line and the comment above the next table belong to
the next table, which is what stops an unwire eating somebody's section separator. A server can own
more than one span — `[mcp_servers.node_repl.env]` is a second one — and removing the server takes
both. New blocks land just past the last `mcp_servers` span in the file, counting the ones about to
be deleted, which is what puts a second wire in the same place as the first.

One case cannot round-trip exactly, and it is worth stating rather than glossing: a file with **no
final newline** has to gain one before anything can be appended, and an unwire has no way to know
that newline was Cupertino's.

### What the ChatGPT app does to this file

It **rewrites `config.toml` on launch**, and is reported to set `enabled = false` on a server it did
not expect ([openai/codex#34807](https://github.com/openai/codex/issues/34807)). Three consequences,
none fatal. Formatting: Cupertino's guarantee is one-directional — *Cupertino* does not reformat
this file, and if the ChatGPT app serialises and rewrites it, that is not Cupertino's doing, though
`config.toml.cupertino-backup` is then a stale snapshot. Spans moving: harmless, every read
rescans. And `enabled = false` landing on one of ours: the entry still points where it should, so
the audit says `configured` while Codex runs none of it — the Claude Desktop blind spot below,
**except detectable**, because the fact is a key in the file rather than something done quietly at
load. The row says so, and Configure re-renders the block without it.

### Per-project `.codex/config.toml` is deferred

Codex also reads a `.codex/config.toml` inside a repository, above the global file. Cupertino does
not touch it. Its `[projects."…"]` tables carry `trust_level`, **not servers**, so reading them as
an MCP project scope would be a straightforward lie — which is why the pane renders no project card
for this client rather than an empty one — and finding the per-repo files would mean crawling the
filesystem for them.

## Why Claude Code is written rather than pasted

The objection was that
`~/.claude.json` holds credentials and that running sessions write to it concurrently. Neither
survived being checked: the file mode is preserved across the swap, so a 0600 file stays 0600, and
the concurrency is the same read-modify-write `claude mcp add` performs from a second process — so
handing over the command relocated the race rather than avoiding it, while giving up the one
advantage this app has, which is that it already reads that file and can say when a write has been
clobbered.

## What goes in the file, and what never does

```json
{
  "cupertino-mail": {
    "command": "/Applications/Cupertino.app/Contents/Helpers/cupertino-bridge",
    "args": ["--server=mail"]
  }
}
```

A path and a surface name. **No credential, no token, no permission and no `env` block.** The
grants are the app's, held once by a notarized binary and revocable in System Settings, which is the
whole argument of `docs/distribution.md` stated in one entry. Writes used to be a client-side
environment variable and are now the app's own toggle, so a client cannot carry a stale copy of a
decision made somewhere else.

The bridge path is read from `Bundle.main` and never hardcoded: whichever copy of Cupertino is doing
the configuring is the copy the client should talk to, and it keeps working when the app moves to
`/Applications`.

The key is `cupertino-<surface>`. It lands in a file the user owns, next to entries this app knows
nothing about, and `configure` writes it unconditionally — so it has to be a name that cannot
collide by accident. `apple-mail` was the old spelling and is a name several public MCP servers
already use, which is why a config written before the rename is migrated rather than duplicated. The
npm packages deliberately did **not** follow: they are MIT, they run standalone with no app at all,
and naming them after the app would misdescribe them.

## Recognising Cupertino's own entries

`ClientWiringMerge.isOurs` is the load-bearing predicate. It decides what _Remove Cupertino's
entries_ takes out, what a surface being switched off prunes, and what the app refuses to touch. It
is one test: a `command` ending in `/Contents/Helpers/cupertino-bridge`.

Deliberately **not** compared against the current bridge path. An entry left by a copy of the app
that has since moved is still ours, and it is also the entry most worth cleaning up — refusing to
recognise it would leave a dead entry in somebody's config forever. One accepted consequence,
asserted in `wiring-check` since before this could delete anything: an entry pointing at a
_different_ copy of Cupertino, a beta in `~/Downloads` say, counts as ours and will be rewritten or
removed.

Everything else in the file is somebody else's, permanently.

`state(of:key:expectedCommand:)` is the finer partition the pane needs, and it asks a different
question first: an entry already reaching the exact command we would write is `.matches` whatever
its suffix, because `isOurs` exists to recognise entries from a bundle that has _moved_ and there is
nothing to infer about one that has not. Only then does the suffix decide between "ours, pointing
elsewhere" and "somebody else's".

Note what neither reads: `args`. Checking the `--server=<id>` too would catch a hand-edited
`cupertino-mail` reaching `--server=notes`, and it is left out because the key is derived from the
surface id rather than chosen by anybody — no path through the app produces that pair, and the check
has no remedy to offer that Configure does not already offer.

## The guarantees on somebody else's file

Every write goes through `ClientWiring.mergeWrite`, so the read a merge is computed from and the
swap that lands it are never separated by anything else. Four properties, the first three asserted
by `make wiring-check`:

1. **Everything that is not ours survives.** Held by `isOurs`, which is a weaker guarantee than the
   original "nothing is ever removed" and worth saying out loud.
2. **The previous contents are recoverable** — `<name>.cupertino-backup`, written before the swap.
3. **A crash mid-write cannot leave a truncated config.** Written to a temp file beside the target
   and swapped with `replaceItemAt`.
4. **A change made between the read and the write is not silently dropped.** A `Stamp` — size and
   modification date — is taken before the read and checked before the swap, and a mismatch is
   retried once from the new bytes.

The fourth narrows a risk without closing it, and the limit is worth naming: nothing here can win
against a process holding its own snapshot of the whole file. Claude Code keeps one for the length
of a session and writes it back on its own schedule, and `claude mcp add` takes no lock either. It
is a narrower window, not a closed one — which is why the audit that _notices_ a clobbered write
matters more than the stamp does.

A config we create is 0600; one we replace keeps its own mode. A repo's `.mcp.json` is the exception
and is created with the default mode, because it is an ordinary project file the user may well
commit.

## The three writes, and why they cannot do each other's job

- **Configure** — `merged`. Upserts an entry per switched-on surface, migrates a legacy `apple-*`
  key that is ours, and prunes the key of a surface that has been switched off. Removal is gated
  twice: never a key just written, and never one `isOurs` disclaims.
- **Remove Cupertino's entries** — `unmerged`. Takes out every entry `isOurs` claims and nothing
  else. User scope only: the per-folder blocks are a different scope with a different button, and a
  Remove on a client row that silently emptied ninety-eight folders would be doing far more than it
  says.
- **Remove…** on one foreign entry — `removing`. Takes out exactly one key, and **refuses a key
  `isOurs` claims**. This is the last step of moving a hand-configured server over: it is running
  through Cupertino now, and the entry that starts its own copy is still there.

## The refusal

`configure` used to write `servers[key] = entry` unconditionally, on the grounds that the
`cupertino-` namespace cannot collide by accident. That was true and it was not the whole story: for
as long as nothing checked, the accident that could not happen was also the one that would be
silently overwritten. `collisions(of:)` names the keys a foreign entry is sitting under, and
Configure refuses rather than replacing them. The asymmetry is what makes it worth an alert:
overwriting costs somebody a server, refusing costs a second press.

The alert offers _Overwrite anyway_, which skips that check and no other — the stamp, the backup,
the atomic swap and `isOurs` all still apply.

## What the client pane reports

The pane re-reads the config on **every redraw** and caches nothing. The file belongs to another
application that may have rewritten it a second ago, so a remembered status is a claim about a file
this app did not watch. It is one read per pass, though, feeding the header sentence, the per-entry
badges, the other-servers list and "is there anything of ours to remove" — four questions about one
file, which as four separate reads were four answers free to disagree.

Two things nothing in SwiftUI notices on its own, and both are subscribed to deliberately:
`ClientConfigRevision` is bumped after every write this app makes to a client config, and
`StatusModel.clients` stands in for the app's own inputs changing — what gets written is
`SurfaceSettings.enabledSurfaces`, which is a `UserDefaults` read and does not publish. Neither
value is used for its answer; the status is always computed from the file.

### Per entry

| Badge              | Means                                                     |
| ------------------ | --------------------------------------------------------- |
| `configured`       | ours, reaching the bridge in this bundle                  |
| `not written`      | no entry under that key                                   |
| `points elsewhere` | ours, reaching another copy of the app — Update fixes it  |
| `taken`            | somebody else's entry under a key Configure wants         |
| `surface off`      | in the file, correct, and the server behind it is stopped |

Plus one line no badge covers, on Codex only: `enabled = false`, which the client honours and no
JSON client has.

### The whole file

`configured`, `not configured`, `stale`, `incomplete` (wired before a surface shipped), `extra`
(still wired for a surface since switched off) and `unreadable`. There used to be an `unknown`, for
the clients whose config the app would only paste a line for; there are none. `extra` is amber rather than green: nothing is broken, and the
entry only costs an assistant definitions it will never use — but it is a state a button can finish,
and grey would file it with "nothing to do here".

### What it cannot see

- **A client that has silently dropped the config it just read.** Newer Claude Desktop builds are
  reported to respond to a config that fails validation by dropping the whole `mcpServers` map on
  load. Cupertino only ever writes valid stdio entries and so cannot cause it, and it also cannot
  _detect_ it: the file audits as configured while the client runs none of it. If a client shows no
  Cupertino tools against a green pane, this is the first thing to check, and the
  `.cupertino-backup` beside the file is the recovery path.
- **Whether a server the client starts itself works.** The other-servers card says those go around
  Cupertino, which is a fact about wiring, not a health check.
- **Whether a client has actually reloaded.** Every write ends with "restart it to pick this up",
  and nothing here can tell whether that happened.

## Project folders

Every client above is wired once per user, which is right for an app on this Mac and wrong for a CLI
run in 93 directories. Measured on a real install: 12 of them had ever called a Cupertino tool, so
87% of sessions were carrying ~73 tool definitions they never used. Wiring a folder is how somebody
opts the other 81 out without giving up the 12.

Two files, one merge, and the choice is per folder rather than a setting:

- **`local`** writes `projects[<dir>].mcpServers` inside `~/.claude.json` — the same file the client
  row writes, a different key inside it, and where `claude mcp add --scope local` would have put it.
- **`project`** writes `<dir>/.mcp.json`, which any Claude Code session opened there picks up.

The scope is a radio beside the button, not a preference, and `project` scope is why: it writes a
file into somebody's git working tree, and a preference set once and applied silently months later
is the worst possible way to make that decision. Whether that file is committed, gitignored, or
never in a repository at all is the user's call, taken after this one and somewhere else.

The card lives in Claude Code's pane because both files it writes are Claude Code's. _Forget_ drops
a folder from the list; _Unwire_ takes the entries out of the file. Those were one button for a
while, and the consequence was that a folder "removed" from the list went on giving every session
opened there a tool list nobody had asked for.

Codex also reads a `.codex/config.toml` inside a repository. Cupertino does not touch it, and the
decisive reason is not the TOML: that file lives inside a working tree, and the only entries worth
writing there would name an absolute path into an app bundle that differs per machine.

## Tests

`make wiring-check` compiles `ClientWiringMerge.swift` and `ClientWiringTOML.swift` beside
`scripts/wiring-check.swift` with one `swiftc` invocation and runs the result — 314 assertions
against fixtures. `make wiring-check-real` runs the same binary over the real configs on this Mac,
read-only, and asserts the same guarantees against shapes nobody thought to fixture: 77 unrelated
top-level keys, 101 project blocks, an entry that is a bare string, and a 248-line `config.toml`
that a wire and an unwire have to give back byte-for-byte. A file that is not on this Mac is skipped rather than failed, so it is a
developer target and not a CI one. That subtraction is the point:
`ClientWiringMerge` imports nothing but Foundation, no AppKit, no `Surface`, no `Bundle`, no
logging, so the half that touches somebody else's file is testable in a project with no test target.
Everything policy-shaped — which clients exist, which key they use, where the bridge lives — stays
in `ClientWiring`, which is not covered and is deliberately kept boring enough not to need to be.
