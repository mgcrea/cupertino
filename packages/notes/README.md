# @mgcrea/mcp-apple-notes

Model Context Protocol server for the macOS **Apple Notes** app.

> **Unofficial.** Not affiliated with Apple. It drives the Notes app that is already on your Mac.

## Two lanes

- **Apple Events lane** — accounts, folders, bodies, and every mutation. Always the authority:
  after a write, the result is what Notes re-read.
- **Index lane** — read-only SQLite over `NoteStore.sqlite`, for search and metadata at a scale
  Apple Events cannot reach. Needs Full Disk Access.

Unlike Mail, **the Apple Events lane alone is a working server**. Measured on a 921-note library, a
full-text search takes 97 ms — against the 74 s that forced Mail onto its index. So you can install
this, use it, and only then decide whether to grant Full Disk Access.

It does not scale for ever: there is no index behind it, so every query pays the full cost again.
The wall is around 5–10k notes. `apple_notes_diagnostics` tells you which lane is answering.

| Permission             | Needed for                         | Without it                                      |
| ---------------------- | ---------------------------------- | ----------------------------------------------- |
| **Automation → Notes** | everything                         | nothing works; you get a `-1743` error          |
| **Full Disk Access**   | search at scale, `save_attachment` | the server still runs, on the Apple Events lane |

Neither is granted to Notes.app — it is the _reader_ that needs permission.

## Tools

Read: `diagnostics`, `list_accounts`, `list_folders`, `list_notes`, `search_notes`, `get_note`,
`list_attachments`, `save_attachment`.

Write, registered **only** when `APPLE_NOTES_ALLOW_WRITES=1` — with the flag off they are invisible
to the model, not merely refused: `create_note`, `update_note`, `move_note`, `delete_notes`,
`add_attachment`.

`add_attachment` is the only way to put an image in a note. An `<img>` tag in a note's body creates
an attachment whose bytes Notes never loads — see [docs/notes.md](../../docs/notes.md).

## Configuration

| Variable                           | Default       |                                                   |
| ---------------------------------- | ------------- | ------------------------------------------------- |
| `APPLE_NOTES_ALLOW_WRITES`         | off           | Register the mutating tools.                      |
| `APPLE_NOTES_ACCOUNTS`             | all           | Read-side allowlist, comma-separated.             |
| `APPLE_NOTES_INDEX_MODE`           | `auto`        | `auto` \| `ro` \| `immutable` \| `off`.           |
| `APPLE_NOTES_STORE`                | auto          | Explicit `NoteStore.sqlite` path.                 |
| `APPLE_NOTES_SEARCH_CACHE_TTL_MS`  | `60000`       | How long the body corpus stays warm.              |
| `APPLE_NOTES_ATTACHMENT_DIR`       | `~/Downloads` | The only directory attachments may be saved into. |
| `APPLE_NOTES_BODY_MAX_BYTES`       | `262144`      | Body truncation, to protect the context window.   |
| `APPLE_NOTES_OSASCRIPT_TIMEOUT_MS` | `30000`       | Sized for the first-run permission prompt.        |

## Notes that will bite you

- **Notes takes a note's title from the first line of its body.** Setting `name` is silently
  ignored, so `create_note` prepends the title as a heading instead.
- **Password-protected notes cannot be read at all.** Their text is AES ciphertext at rest, which
  is why `ZICNOTEDATA` carries crypto columns; no permission makes it readable.
- **Folders nest.** A folder map has to recurse even if your own library happens to be flat.
- **Search caches on a TTL, not on invalidation.** Checking whether the cache is stale costs _more_
  over Apple Events (128 ms) than redoing the scan (97 ms), so bounded staleness is the honest
  trade. See [docs/notes.md](../../docs/notes.md).
