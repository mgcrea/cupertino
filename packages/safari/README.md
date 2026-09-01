# @mgcrea/mcp-apple-safari

MCP server for the macOS **Safari** browser: what you have visited, what is open now, and what is on
the page in front of you.

```json
{
  "mcpServers": {
    "apple-safari": { "command": "npx", "args": ["-y", "@mgcrea/mcp-apple-safari"] }
  }
}
```

## Three lanes that are not fallbacks for each other

This is the thing to understand before anything else. Every other surface in this bundle has two
routes to the same data and the choice is about speed. Safari's lanes see almost **disjoint** things,
and each needs a different permission — so an ungranted Safari server is not a slower Safari server,
it is a different and much smaller one.

| Lane             | Needs                                          | Answers                                        |
| ---------------- | ---------------------------------------------- | ---------------------------------------------- |
| **File**         | Full Disk Access                               | the past: history, bookmarks, the Reading List |
| **Apple Events** | an Automation grant, Safari running            | the present: which tabs are open               |
| **Extension**    | the extension enabled AND allowed on that site | the page: its text, its elements, acting on it |

The extension lane needs **no TCC grant of any kind**. Safari consents to it one website at a time,
which the user can see and revoke per site.

## Tools

**Read**

| Tool                             | What                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `apple_safari_search_history`    | history by text or date range, with visit counts      |
| `apple_safari_get_page`          | one history item by ref                               |
| `apple_safari_list_tabs`         | tabs open right now, optionally enriched from history |
| `apple_safari_list_bookmarks`    | the bookmark tree                                     |
| `apple_safari_list_reading_list` | saved items, and which are unread                     |
| `apple_safari_read_page`         | a captured page as text or HTML                       |
| `apple_safari_page_elements`     | what is clickable or typeable on a live page          |
| `apple_safari_diagnostics`       | which lanes work, and why one does not                |

**Opt-in read** — `APPLE_SAFARI_ALLOW_CODES`

| Tool                      | What                                            |
| ------------------------- | ----------------------------------------------- |
| `apple_safari_find_codes` | a one-time 2FA code in the TEXT of an open page |

**Write** — `APPLE_SAFARI_ALLOW_WRITES`

| Tool                                 | What                                    |
| ------------------------------------ | --------------------------------------- |
| `apple_safari_open_url`              | open a URL, in a new tab or the current |
| `apple_safari_add_reading_list_item` | save a URL for later                    |
| `apple_safari_click`                 | click an element on a live page         |
| `apple_safari_fill`                  | type into one                           |
| `apple_safari_scroll`                | scroll a page                           |

## Configuration

| Variable                               | Default |                                                       |
| -------------------------------------- | ------- | ----------------------------------------------------- |
| `APPLE_SAFARI_ALLOW_WRITES`            | off     | Register the five write tools at all.                 |
| `APPLE_SAFARI_ALLOW_CODES`             | off     | One-time codes — see below.                           |
| `APPLE_SAFARI_LIVE_TABS`               | on      | Use the Apple Events lane. Off = no Apple Event.      |
| `APPLE_SAFARI_STORE`                   | auto    | Explicit `History.db` path.                           |
| `APPLE_SAFARI_BOOKMARKS`               | auto    | Explicit `Bookmarks.plist` path.                      |
| `APPLE_SAFARI_PAGES`                   | auto    | Explicit extension capture directory.                 |
| `APPLE_SAFARI_ACTION_TIMEOUT_MS`       | `12000` | How long an action waits for the page to answer.      |
| `APPLE_SAFARI_READING_LIST_CONFIRM_MS` | `1500`  | Beat before re-reading to confirm a Reading List add. |
| `APPLE_SAFARI_INDEX_MODE`              | `auto`  | `auto` \| `ro` \| `immutable` \| `off`.               |
| `APPLE_SAFARI_DEFAULT_RANGE_DAYS`      | `30`    | Window when only a start is given.                    |
| `APPLE_SAFARI_MAX_RANGE_DAYS`          | `3660`  | Hard ceiling on a single range.                       |
| `APPLE_SAFARI_MAX_RESULTS`             | —       | Default page size.                                    |
| `APPLE_SAFARI_EXPOSE_PROMPTS`          | off     | Register prompts and `cupertino://` resources.        |
| `APPLE_SAFARI_DEBUG`                   | off     | Verbose logging.                                      |

### `APPLE_SAFARI_ALLOW_CODES`

Two things move together when it is on: `find_codes` is registered, and `page_elements` returns the
value of a **one-time-code field**. It is a **read**, and deliberately not folded into
`ALLOW_WRITES` — reaching a read through the write gate would mean granting the right to click a
button in order to see a number.

**A credential field is withheld either way.** A password, a card number or a CVC comes back
`redacted: "credential"` with no value and no setting that returns it. This flag is named for codes
and does not widen past them. In both cases `hasValue` still says whether the field is filled, which
is usually what you needed.

**It is weaker than the Messages gate of the same name, and worth knowing which.** There, off means
the tool does not exist and the alternative is sifting whole threads. Here `read_page` stays ungated,
so off removes the targeted field read and the live DOM scan — not every byte of a page.

See `docs/passwords.md` in the repo for why the Passwords app itself is unreachable by any lane, and
why reading a code a _website shows_ is a different question from reading the vault.

## Notes that will bite you

- **An unmatched tab is normal, not an error.** The only join key between a live tab and history is
  the URL, and it is trivially lossy: measured match rates were 60.7%, 55.3% and **8.3%** across
  three runs. A single-page app reached by `pushState` commits no history row at all, so the page
  was genuinely visited and genuinely is not in the store. Treat `history: null` as NOT FOUND, never
  as "never visited".
- **An exact URL match is not proof the row is about that page.** One measured tab on
  `http://localhost:4321/` matched a history row for an entirely different project. Any local
  address carries this.
- **`read_page` is a SNAPSHOT, not a live read.** The extension captures when the page loads and
  after a route change; nothing can ask Safari for a fresh copy. Check `ageSeconds`. The acting
  tools go to the live page instead, which is why they cost about a second on a visible tab and up
  to ten on a hidden one.
- **A timeout from an action means nothing was listening** — the extension off, not allowed on that
  site, or the page closed. It never means the page refused. Commands are at-most-once: one that is
  handed out and lost is not retried, because a click that MIGHT have landed must not be repeated.
- **Element ids die on navigation.** They come from a `page_elements` call and are valid for that
  page only. Never construct one, and re-enumerate after any click that loaded something.
- **A Reading List add hits the network.** Safari fetches the URL in the background to build the
  entry, and overwrites any `withTitle` you pass with the page's own title. `verified` has three
  states and is never `false`: the file lags the add by about 2 s, and reporting an unconfirmed
  write as a failed one makes callers retry — into a list with no remove verb.
- **The write lane needs no Full Disk Access.** Both Apple Events writes work on a machine where the
  read lane does not. `APPLE_SAFARI_LIVE_TABS=false` outranks the write gate, because that flag
  promises a server that sends no Apple Event at all.
- **`open_url` accepts `http` and `https` only.** A `javascript:` URL would be `do JavaScript`
  through the front door — measured: Safari accepts one through the navigation verb — and `file:`
  is a navigation verb that reads local files.
