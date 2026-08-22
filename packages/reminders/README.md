# @mgcrea/mcp-apple-reminders

Model Context Protocol server for the macOS **Apple Reminders** app.

> **Unofficial.** Not affiliated with Apple. It drives the Reminders app that is already on your Mac.

## Two lanes

- **Apple Events lane** — accounts, lists, reminders, and every mutation. Reminders' scripting
  dictionary is complete enough that this alone is a working server.
- **Index lane** — read-only SQLite over the Group Containers store, for the things the dictionary
  does not expose. Needs Full Disk Access.

Like Notes and unlike Mail, **the Apple Events lane alone is usable**. You can install this, use it,
and only then decide whether to grant Full Disk Access. `apple_reminders_diagnostics` tells you
which lane is answering.

| Permission                 | Needed for        | Without it                                      |
| -------------------------- | ----------------- | ----------------------------------------------- |
| **Automation → Reminders** | everything        | nothing works; you get a `-1743` error          |
| **Full Disk Access**       | tags, attachments | the server still runs, on the Apple Events lane |

Neither is granted to Reminders.app — it is the _reader_ that needs permission. Grant it to whatever
launches the server (Terminal, iTerm, VS Code, Claude), then restart it.

## Tools

Read: `diagnostics`, `list_accounts`, `list_lists`, `list_reminders`, `search_reminders`,
`get_reminder`.

Write, registered **only** when `APPLE_REMINDERS_ALLOW_WRITES=1` — with the flag off they are
invisible to the model, not merely refused: `create_reminder`, `update_reminder`,
`complete_reminders`, `move_reminders`, `delete_reminders`.

## Configuration

| Variable                                 | Default       |                                              |
| ---------------------------------------- | ------------- | -------------------------------------------- |
| `APPLE_REMINDERS_ALLOW_WRITES`           | off           | Register the mutating tools.                 |
| `APPLE_REMINDERS_ACCOUNTS`               | all           | Read-side allowlist, comma-separated.        |
| `APPLE_REMINDERS_LISTS`                  | all           | Read-side allowlist, comma-separated.        |
| `APPLE_REMINDERS_DEFAULT_LIST`           | Reminders'    | List a new reminder goes to when none named. |
| `APPLE_REMINDERS_INCLUDE_COMPLETED`      | off           | Include completed reminders in reads.        |
| `APPLE_REMINDERS_INDEX_MODE`             | `auto`        | `auto` \| `ro` \| `immutable` \| `off`.      |
| `APPLE_REMINDERS_STORE`                  | auto          | Explicit store path.                         |
| `APPLE_REMINDERS_DEGRADED_MAX_REMINDERS` | `500`         | Cap when running without the index.          |
| `APPLE_REMINDERS_SEARCH_CACHE_TTL_MS`    | `30000`       | How long the corpus stays warm.              |
| `APPLE_REMINDERS_ATTACHMENT_DIR`         | `~/Downloads` | The only directory attachments may reach.    |
| `APPLE_REMINDERS_OSASCRIPT_TIMEOUT_MS`   | `30000`       | Sized for the first-run permission prompt.   |

## Notes that will bite you

- **`~/Library/Reminders` does not exist.** Reminders lives under
  `~/Library/Group Containers/group.com.apple.reminders/`. The path commonly cited elsewhere is
  wrong on a current macOS.
- **Writes always go through Apple Events**, never the store. The Reminders app holds the SQLite
  file open and reconciles it against a server, so writing to it corrupts sync state.
- **Completed reminders are excluded by default.** A search that "loses" a reminder has usually
  just found it completed; set `APPLE_REMINDERS_INCLUDE_COMPLETED=1`.

## Licence

[MIT](LICENSE).
