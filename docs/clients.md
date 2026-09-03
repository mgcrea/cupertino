# Clients

`docs/surfaces.md` describes what Cupertino serves and `docs/distribution.md` why it ships signed
rather than sandboxed. This describes the other end: the seven MCP clients Cupertino knows how to
wire, why two of them are handed a command instead, and what the client pane can and cannot tell
you about a file it does not own.

## The seven clients

| Client             | Config                                                            | Root key     | Wiring          |
| ------------------ | ----------------------------------------------------------------- | ------------ | --------------- |
| Claude Code        | `~/.claude.json`                                                  | `mcpServers` | written         |
| Claude Desktop     | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | written         |
| Cursor             | `~/.cursor/mcp.json`                                              | `mcpServers` | written         |
| LM Studio          | `~/.lmstudio/mcp.json`                                            | `mcpServers` | written         |
| Windsurf           | `~/.codeium/windsurf/mcp_config.json`                             | `mcpServers` | written         |
| Visual Studio Code | `~/Library/Application Support/Code/User/mcp.json`                | —            | `code --add-mcp` |
| Codex CLI          | `~/.codex/config.toml`                                            | —            | `codex mcp add` |

`ClientWiring.clients` is the authority; `apps/website/src/config.ts` keeps a copy for the
marketing page, and the two are kept in step by hand.

The split is not about how popular a client is. It is about **whether its config is a file we can
rewrite without destroying something the user put there.** Five are strict JSON holding nothing but
data, so they are serialised from a dictionary. VS Code's `mcp.json` is JSONC and Codex's
`config.toml` is TOML: round-tripping either through `JSONSerialization` would either throw on the
comments or, worse, succeed on a file that has none today and delete them the day one is added. So
those two are handed the lines to paste instead.

Two absences are deliberate. **ChatGPT desktop** takes remote HTTP connectors only and cannot spawn
a local stdio server at all, so it is not in the list — absence is the whole implementation, and a
greyed-out row explaining itself would be a support burden with no action attached. **Zed** and
**Goose** are absent for now rather than on principle: Zed wants a `context_servers` entry whose
shape has moved between versions, Goose a YAML `extensions:` block, and neither has a CLI to hide
behind. `.command` accommodates them the day somebody asks.

Claude Code is written rather than pasted, and that changed once. The objection was that
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
*different* copy of Cupertino, a beta in `~/Downloads` say, counts as ours and will be rewritten or
removed.

Everything else in the file is somebody else's, permanently.

`state(of:key:expectedCommand:)` is the finer partition the pane needs, and it asks a different
question first: an entry already reaching the exact command we would write is `.matches` whatever
its suffix, because `isOurs` exists to recognise entries from a bundle that has *moved* and there is
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
is a narrower window, not a closed one — which is why the audit that *notices* a clobbered write
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

| Badge              | Means                                                    |
| ------------------ | -------------------------------------------------------- |
| `configured`       | ours, reaching the bridge in this bundle                 |
| `not written`      | no entry under that key                                  |
| `points elsewhere` | ours, reaching another copy of the app — Update fixes it  |
| `taken`            | somebody else's entry under a key Configure wants         |
| `surface off`      | in the file, correct, and the server behind it is stopped |

### The whole file

`configured`, `not configured`, `stale`, `incomplete` (wired before a surface shipped), `extra`
(still wired for a surface since switched off), `unreadable`, and `unknown` for a `.command` client
whose config this app does not read. `extra` is amber rather than green: nothing is broken, and the
entry only costs an assistant definitions it will never use — but it is a state a button can finish,
and grey would file it with "nothing to do here".

### What it cannot see

- **A client that has silently dropped the config it just read.** Newer Claude Desktop builds are
  reported to respond to a config that fails validation by dropping the whole `mcpServers` map on
  load. Cupertino only ever writes valid stdio entries and so cannot cause it, and it also cannot
  *detect* it: the file audits as configured while the client runs none of it. If a client shows no
  Cupertino tools against a green pane, this is the first thing to check, and the
  `.cupertino-backup` beside the file is the recovery path.
- **Whether a server the client starts itself works.** The other-servers card says those go around
  Cupertino, which is a fact about wiring, not a health check.
- **Anything in a `.command` client's config.** VS Code and Codex report `unknown` rather than
  claiming a green check the app has not earned. Grepping the TOML for the bridge path was
  considered and rejected: a substring match cannot tell a stale entry from a missing one.

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

`make wiring-check` compiles `ClientWiringMerge.swift` beside `scripts/wiring-check.swift` with one
`swiftc` invocation and runs the result — 150 assertions against fixtures. `make wiring-check-real`
runs the same binary over the real configs on this Mac, read-only, and asserts the same guarantees
against shapes nobody thought to fixture: 77 unrelated top-level keys, 101 project blocks, an entry
that is a bare string. A file that is not on this Mac is skipped rather than failed, so it is a
developer target and not a CI one. That subtraction is the point:
`ClientWiringMerge` imports nothing but Foundation, no AppKit, no `Surface`, no `Bundle`, no
logging, so the half that touches somebody else's file is testable in a project with no test target.
Everything policy-shaped — which clients exist, which key they use, where the bridge lives — stays
in `ClientWiring`, which is not covered and is deliberately kept boring enough not to need to be.
