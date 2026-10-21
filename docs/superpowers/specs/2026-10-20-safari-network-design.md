# Safari network capture: design

Date: 2026-10-20. Status: approved for planning once Olivier signs off.

## Why

Two jobs, both Olivier's own words:

1. **Debugging his own web apps.** Point the agent at a tab and have it see what the page fetched:
   URL, status, timing, request and response bodies, plus the errors that go with them. No
   Web Inspector, nothing copied across by hand.
2. **Pulling a PDF out of a site.** The site fetches it with an XHR whose response is JSON with
   the PDF inside it as a base64 string. The agent should end up with a `.pdf` on disk that it can
   open and read. It should never have to carry megabytes of base64 through the conversation.

His brief on scope: "make it as flexible as possible."

## What Safari allows, and what it does not

There is no Chrome DevTools Protocol equivalent that an outside process can reach on macOS Safari,
`safaridriver` has no network log, and Safari's `webRequest` gives an extension neither response
bodies nor `filterResponseData`. So a DevTools-style log of every byte the tab loads is not
reachable.

What IS reachable, through the extension this project already ships:

- **Page-initiated `fetch` and `XMLHttpRequest`**, by wrapping both in the page's own JavaScript
  world. This gets method, URL, request and response headers (as the page sees them, so CORS
  filtering applies), status, timing and full bodies. Both jobs are covered here, and this is the
  bulk of the work.
- **Everything else the page loaded** (document, scripts, CSS, images, fonts), through
  `performance.getEntriesByType("resource")`. URL, initiator type, timing and sizes only, no
  bodies or headers. It needs no hook and goes back to page load, so it works before anything
  is armed.
- **Console errors and warnings, uncaught errors, unhandled promise rejections**, by the same kind
  of wrapping. Not network, but they are what you look at next to a failed call, and the hook
  that captures fetch captures these for free. (Agent's call, made under "as flexible as possible".)

## Goals

- Arm recording on one tab, then reload or click whatever fires the request, then list what was
  captured and pull any single response.
- List with filters that make debugging fast: failed only, status range, method, URL substring,
  kind, and a cursor so "what happened since I last looked" is one call.
- Get a response whole, a slice of it, or one field out of its JSON. Optionally base64-decode
  that field and save it as a file. The PDF job is exactly
  `jsonPath: "…", decode: "base64", saveAs: "invoice.pdf"`.
- Large bodies never land in the conversation by accident: the list shows sizes and content types,
  and `get` pages through anything over its inline cap.
- Works on the user's own `localhost` apps exactly as on any other site the extension is allowed on.

## Non-goals (v1)

- WebSocket and EventSource frames. The same hook would carry them; deferred, not refused.
- Requests made from subframes, from Web Workers or service workers, or by the browser itself
  (navigations, `<img>`, `<script>`). Subframes are the likeliest follow-up. The PDF site was
  checked and needs none of them (see Measure first, item 5).
- Bodies of the timing-only entries. Safari offers no route to them.
- Recording that survives navigation to another page, or that spans tabs.
- HAR export. Easy to add from the same buffer later.

## Anti-goals

These would make it a failure even if it technically works:

- **Breaking a site.** The wrappers must be transparent. They return what the originals return,
  rethrow what the originals throw, never delay the page's promise, never consume a stream the page
  is reading (bodies are read from `response.clone()`), and fail closed: any exception inside the
  recorder is swallowed and recording for that request is abandoned, never surfaced to the page.
- **A hook on every allowed site.** Nothing is wrapped on a tab that was not armed. The only
  always-present code is a listener that waits to be told to install.
- **Network data at rest.** Captured requests live in the tab's memory and die with the page load.
  Nothing is written to disk except a file the agent explicitly asked to save, and results crossing
  the existing `results/` channel keep its 60-second TTL.
- **Credentials in transcripts.** `Authorization`, `Proxy-Authorization` and `Cookie`/`Set-Cookie`
  headers (the last two are rarely visible to page JS anyway), and any header whose name contains
  `token`, `secret`, `api-key` or `apikey`, are returned as
  `"<redacted: 187 chars>"` whatever the settings say. This matches `page_elements` never
  returning a password. Bodies cannot be redacted this way, and the tool description says so.
  (Agent's call.)

## Consent

- A new gate on the Safari surface: `allowNetwork`, env `APPLE_SAFARI_ALLOW_NETWORK`, label
  "Read network traffic", off by default. Same pattern as `allowCodes`: a READ with its own switch,
  not folded into `allowWrites`. When it is off, the network tools are not registered.
- Underneath it, Safari's own per-site grant for the extension, unchanged. A site the extension is
  not allowed on cannot be recorded.
- `allowWrites` additionally gates the two things that change something: `reload: true` on
  `network_record` (it navigates a visible tab, like `scroll` and `click`), and `saveAs` on
  `network_get` (it puts a file on the user's disk, which is the mail `save_attachment` precedent).
  Without writes, both are refused with a message naming the setting.

## Architecture

```text
MAIN world (page)                   ISOLATED world (content script)          native / server
─────────────────                   ───────────────────────────────          ───────────────
network-hook.js                      network.js
  dormant listener ◄── "install" ──  arms on command, or at load
  wraps fetch / XHR / console        if sessionStorage flag set
  emits one record per event  ────►  ring buffer (this page load)  ◄── commands/ ── server tools
  (CustomEvent, JSON string)         answers list / get / record    ── results/ ──►
```

### Extension

- **`network-hook.js`, a new MAIN-world content script**, `run_at: "document_start"`, top frame
  only. At load it does one thing: if this tab's `sessionStorage` holds the arm flag (see below),
  it installs the wrappers immediately so the page's first requests are seen. Otherwise it only
  listens for an install event. Wrapping happens before page scripts run, so any reference a page
  takes to `fetch` is the wrapped one.
  - `fetch`: record request (method, URL, headers, body serialised best-effort: string,
    `URLSearchParams`, JSON-able; `FormData` as its field names plus file names and sizes;
    `Blob`/`ArrayBuffer` as size and type, plus content if under the body cap), then on settle
    record status, headers, timing, and body from `clone()`.
  - `XMLHttpRequest`: same fields via `open`/`setRequestHeader`/`send` and `loadend`, body from
    `response` according to `responseType`.
  - Bodies: text-like content types become text. Anything else becomes base64, marked
    `encoding: "base64"`. A body over `maxBodyBytes` is read up to the cap and marked
    `bodyTruncated`, with its full size when it is known. When `Content-Length` already exceeds
    the cap, no clone is taken at all, so a large download is never held twice in memory.
  - Console: `console.error`, `console.warn`, `error` and `unhandledrejection` events, with message
    and stack, when the `console` kind is armed.
  - Hands each record to the isolated world as a `CustomEvent` on `document` with a JSON-string
    `detail`, under an event name minted per page load. The string form avoids relying on Safari
    passing structured objects across worlds (measure; see below).
- **`network.js`, a new isolated-world script** loaded with the existing `actions.js` and
  `content.js`. It holds the ring buffer and answers three new command actions through
  `cupertinoRunCommand`:
  - `netRecord` (start / stop / clear, options, and whether to set the reload flag).
  - `netList` (metadata only, filtered, cursor-paged).
  - `netGet` (one record's headers and one byte-range slice of its body).
  - Buffer caps: a count cap (default 1,000 records) and a body-bytes cap (default 50 MB). Bodies
    are evicted oldest-first before records are, and an evicted body leaves `bodyEvicted: true`
    behind. The list result reports `dropped` counts so a short list is never silent.
- **Request ids follow the element-id rule**: `<pageToken>-r<n>`, so a `get` routes to the page
  load that holds the record and a stale id is an error, never another tab's record. Reuse
  `window.cupertinoPageToken`.
- **Arming across a reload**: `netRecord start` writes a flag (options included) to
  `sessionStorage` under a key namespaced to Cupertino. `sessionStorage` is per tab and per origin
  and survives a reload, which is what lets `reload: true` capture the page from its first request.
  `stop` removes it. A page can read and remove that key, and that is acceptable: the page already
  holds every byte this records.
  - **The flag expires.** It carries an `expiresAt`, default 15 minutes after `start`, settable via
    `armMinutes` (max 120). An expired flag is deleted at load and installs nothing. Every load in
    the window re-arms, which keeps a reload → redirect → login → app flow recorded end to end.
    A flag left behind by an agent that never called `stop` dies on its own, so a localhost app is
    not wrapped for the rest of the working day. Safari may copy `sessionStorage` into a tab opened
    from an armed one, and the expiry bounds that too. `status` reports the expiry. (Agent's call.)
- **`network.js` must run from `document_start`** so it is listening before the hook's first
  record. That means its own `content_scripts` entry, separate from `actions.js`/`content.js` at
  `document_idle`, and the page token has to be minted before either uses it. Moving token minting
  into a tiny shared `document_start` script is the obvious way.
- **Spoofing**: the page can dispatch the install event or forge records. Forged records describe
  the page's own claims about itself, and the isolated script keeps its own armed state and drops
  records while disarmed. One gap remains, found in review: the arm flag lives in the page's own
  `sessionStorage`, so a page can write one and arm its own tab from the next load. What it buys is
  small. Its own traffic is recorded into its own tab's memory, capped at the 120-minute arm
  maximum (a load-time `expiresAt` beyond now + 120 min is clamped), and it leaves the tab only when
  an agent asks that tab for it. Closing the gap needs a nonce the page cannot read, kept in
  extension storage and checked asynchronously at load. That is deferred and recorded as a ruling.
- **Pump change in `content.js`**: when a poll handled a command, poll again immediately rather
  than after the 1-second interval. This makes the chunked body transfer below (and any burst of
  commands) cost about one native round trip per chunk, not one second. The handler's
  one-command-per-poll rule is unchanged.
- Bump the manifest version through the usual `make version` path.

### Native handler

No new message kinds. `netList` and `netGet` results travel through the existing `result` path.
Two things to check:

- The handler's `JSONSerialization` round trip and the results file must carry a chunk. Chunk size
  is a server constant set from the measured native-messaging limit (below).
- `SafariCaptures` and the capture store are untouched: network data never enters `pages/`.

### Server (`packages/safari`)

New `src/tools/network.ts`, registered from `tools/index.ts` behind `ctx.allowNetwork`. The `url`
argument is the same `urlArg` the action tools use.

**`apple_safari_network_record`**

- `url`, `action`: `"start" | "stop" | "clear" | "status"`.
- `kinds`: subset of `["fetch", "xhr", "console"]`, default all three.
- `captureBodies`: default true. `bodyFilter`: optional URL substring; bodies are kept only for
  matching requests, metadata for all.
- `maxBodyBytes`: default 10 MB, max 50 MB.
- `reload`: default false. Requires `allowWrites`. Arms, then reloads, so the page is recorded from
  its first request.
- Returns the armed state, options, record counts and the page token.

**`apple_safari_network_list`**

- `url`, and filters: `kind` (`fetch | xhr | console | resource`), `urlContains`, `method`,
  `status` (exact, or a range like `"400-599"`), `failed` (network error, or status ≥ 400, or a
  console error), `after` (cursor id), `limit` (default 50, max 500).
- `resource` entries come from resource timing and are available whether or not recording is armed.
  Matched by URL against hooked requests so one request is not listed twice.
- Each entry: `id`, `seq`, `kind`, `method`, `url`, `status`, `statusText`, `ok`, `error`,
  `startedAt`, `durationMs`, `requestBytes`, `responseBytes`, `contentType`, `bodyAvailable`,
  `bodyTruncated`, `bodyEvicted`. Console entries: `level`, `message`, first line of `stack`.
- Returns `recording` state, `next` cursor, and `dropped`.

**`apple_safari_network_get`**

- `url`, `id`, `part`: `"response" | "request"` (default response), `headers` (default true).
- `jsonPath`: a dotted path with bracket indices (`data.document.content`, `items[0].pdf`),
  evaluated by the server against the full body after reassembly. On failure the error names the
  keys present at the last segment that resolved.
- `decode`: `"base64"`, applied to the selected value (or the whole body).
- `offset` / `maxChars` to page through the text of a large body inline; default inline cap 20,000
  chars, and the result says `truncated`, `totalChars` and the next `offset`.
- `saveAs`: a filename. Requires `allowWrites`. Writes into `APPLE_SAFARI_DOWNLOAD_DIR` (default
  `~/Downloads`), with the mail precedent's rules: basename only, no traversal, no overwrite
  unless `overwrite: true`. Returns the absolute path, byte count and sniffed type (`%PDF-` →
  `application/pdf`), not the bytes. A base64 body saved without `decode` is written decoded,
  because the bytes are what was meant.
- Transfer: the server pulls the body in chunks with repeated `netGet` commands (offset, length) and
  reassembles them, so no single native message or results file exceeds the chunk size whatever the
  body's size. Only `jsonPath`, `decode` and `saveAs` need the whole body. A plain inline read pulls
  only the chunks covering `offset … offset+maxChars`.

**Config** (`config.ts`): `allowNetwork` (`APPLE_SAFARI_ALLOW_NETWORK`), `downloadDir`
(`APPLE_SAFARI_DOWNLOAD_DIR`), and a `networkChunkBytes` constant or env override if the
measurement says it should be tunable.

**App** (`Surfaces.swift`): a second `Surface.Gate` on Safari for `allowNetwork`, with a comment in
the house style explaining why it is a read gate and not `allowWrites`. The `surfaces.json`
generation, if gates flow through it, follows.

## Measure first

These are a throwaway spike on macOS 26 before building. Each one changes a detail of the plan,
not its shape.

**Every live step costs a notarized build.** The `Makefile` strips the `.appex` from Debug builds,
and `docs/safari.md` records that Safari lists the extension only from a notarized, stapled app,
and that installing over a running Safari can crash it or block the extension. So the spike and the
live checks each need `make build-release` and an install. Batch all five probes into ONE build so
the spike costs one round trip, not five. Per the standing rule, nothing is installed or driven on
the real Mac without Olivier's go, so each live step is a hand-off point in the plan.

1. **MAIN-world content script from the manifest** (`"world": "MAIN"`, `document_start`) in this
   Safari. If unsupported, fall back to `scripting.registerContentScripts` with `world: "MAIN"`
   from the background (adds the `scripting` permission). If neither works, inject a
   `web_accessible_resources` script tag and record which sites' CSP blocks it.
2. **Native-messaging payload limit** in Safari, sending results through `sendNativeMessage` →
   handler → `results/`. Sets the chunk size; start probing at 256 KB and 1 MB.
3. **CustomEvent `detail` across worlds.** Does a string survive, and does an object? The design
   assumes only a string.
4. **`PerformanceResourceTiming.responseStatus`** in Safari. If absent, `resource` entries carry no
   status and `failed` cannot see them; say so in the tool description.
5. **The PDF site's request.** The site is `app.immo-sign.com`, opened from a signing link. That
   link is a bearer credential (anyone holding it can sign), so it is never written into the repo,
   a test fixture or a log. Checked read-only on 2026-10-20 through the live `read_page` path: the
   extension is already allowed on the site, and there is **no iframe**. It is an Angular app whose
   `app-continuous-pdf-renderer` draws pages into `<canvas>` in the top frame. Angular's
   `HttpClient` defaults to XHR, so the base64 JSON is expected on the XHR path. Subframes stay a
   non-goal. What is left for the spike: confirm it is XHR and not `fetch`, and find the JSON path
   to the base64 field.

Record the results in `docs/safari.md` in its "measured" style.

## Testing

- `test/network.test.ts` (server): tool registration under the gate, write-gating of `reload` and
  `saveAs`, `jsonPath` resolution and its error messages, base64 decode, chunk reassembly, inline
  paging, filename safety, using the existing fake command channel the action tests use.
- Content-script tests in the style of `test/content-script.test.ts`. Wrapper transparency
  (return values, thrown errors, streamed body still readable by the page), body caps and
  eviction, redaction, cursor paging, page-token routing of ids, arm-flag survival across a
  simulated reload, and records dropped while disarmed.
- Live check on the dev build per the `use-the-dev-build` skill: one localhost app with a failing
  call, and the PDF site end to end.

## Docs

`docs/safari.md` (measurements and the lane), `packages/safari/README.md` (tools and the gate),
`guide.ts` (a short "debugging a page" and "getting a file out of an API response" recipe),
CHANGELOG.

## Left to the builder

File and function names beyond those given, buffer default numbers within reason, the exact
redaction pattern list, how resource-timing entries are matched against hooked ones, and the order
the work lands in.
