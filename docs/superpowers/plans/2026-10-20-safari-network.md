# Safari Network Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Safari MCP server record a tab's `fetch`/XHR traffic and console errors through the Cupertino extension, list it, and return or save any single body. This includes pulling one base64 field out of a JSON response and saving it as a file.

**Architecture:** A MAIN-world content script (`network-hook.js`) wraps `fetch`/XHR/console once armed and hands JSON records to an isolated-world script (`network.js`). That script holds a per-page-load ring buffer and answers three new commands (`netRecord`, `netList`, `netGet`) over the existing file-based command channel. The server adds three tools behind a new `allowNetwork` gate. It pulls bodies in chunks and does JSON-path, base64 and save work on its side.

**Tech Stack:** Plain JS content scripts (no build step), TypeScript MCP server (`packages/safari`, zod, vitest), `node:vm` stubs for content-script tests, Swift only for the gate entry.

**Spec:** `docs/superpowers/specs/2026-10-20-safari-network-design.md`

## Global Constraints

- New gate: id `allowNetwork`, env `APPLE_SAFARI_ALLOW_NETWORK`, label "Read network traffic", default off. Network tools are not registered when it is off.
- `reload: true` and `saveAs` additionally require `allowWrites`. Without it, refuse with a message naming `APPLE_SAFARI_ALLOW_WRITES`.
- Save destination: `APPLE_SAFARI_DOWNLOAD_DIR`, default `join(homedir(), "Downloads")`, written only through core's `writeConfinedFile` (basename only, no overwrite unless `overwrite: true`).
- Defaults: `maxBodyBytes` 10 MiB (max 50 MiB). Buffer: 1,000 records and 50 MiB of bodies. Arm window 15 min (`armMinutes` max 120). List `limit` 50 (max 500). `get` inline cap 20,000 chars.
- Always-redacted headers: name equals `authorization`, `proxy-authorization`, `cookie` or `set-cookie`, or contains `token`, `secret`, `api-key` or `apikey` (case-insensitive). The value becomes `<redacted: N chars>`.
- Request ids are `<pageToken>-r<n>` (resource-timing entries `<pageToken>-t<n>`, console `<pageToken>-c<n>`). Ids die with the page load.
- Nothing is wrapped on a tab that was not armed. Nothing is written to disk except an explicit `saveAs`.
- The signing link for the PDF site is a bearer credential: it must never appear in the repo, tests, fixtures or commit messages. Use the host `app.immo-sign.com` only.
- Comment density and voice match the surrounding files: long "why" comments in the existing house style on every non-obvious decision.

## Review Focus

1. **A page that reads the response body itself after the wrapper ran** (`res.json()` after our `clone()`): the page must still get the full body. Test in Task 2.
2. **XHR with `responseType` `"arraybuffer"`, `"blob"` or `"json"`**: the body must be captured as base64 or JSON text, and the page's `xhr.response` must be untouched. Test in Task 2.
3. **A body bigger than `maxBodyBytes` with no `Content-Length`** (chunked transfer): it is captured up to the cap and marked `bodyTruncated`, and the page still receives everything. Test in Task 2.
4. **A `jsonPath` that misses** (`data.document.contnet`): the error names the last segment that resolved and the keys available there. A path into an array with an out-of-range index says so. Test in Task 1.
5. **A `get` on an id from a previous page load, after a reload**: it fails with "this request was recorded by a page load that has since gone", not a timeout and not another record. Tests in Task 3 (content side) and Task 5 (server message).

---

### Task 1: Pure helpers: JSON path, base64, type sniffing, redaction

**Files:**

- Create: `packages/safari/src/client/network.ts`
- Test: `packages/safari/test/network-helpers.test.ts`

**Interfaces:**

- Produces:
  - `resolveJsonPath(root: unknown, path: string): { ok: true; value: unknown } | { ok: false; error: string }`. Grammar: optional leading `$`, dotted keys, `[n]` indices, `["quoted.key"]`.
  - `decodeBase64(text: string): Buffer`. Accepts standard and URL-safe alphabets and an optional `data:*;base64,` prefix. Throws `PreconditionError` on characters outside the alphabet (Node's `Buffer.from` silently skips them, so validate first).
  - `sniffType(bytes: Buffer): string | null`. `%PDF-` → `application/pdf`, plus PNG, JPEG, GIF, ZIP and `{`/`[` → `application/json`.
  - `REDACTED_HEADER: RegExp` and `redactHeaders(h: Record<string,string>): Record<string,string>`. These are the server's copy. The content script keeps its own (Task 3) because it cannot import TS, so a test asserts the two patterns agree.

- [ ] **Step 1: Write the failing tests**
  - `resolveJsonPath({data:{document:{content:"QQ=="}}}, "data.document.content")` → `{ok:true, value:"QQ=="}`.
  - `resolveJsonPath({items:[{pdf:"x"}]}, "$.items[0].pdf")` → `"x"`. `resolveJsonPath({"a.b":1}, '["a.b"]')` → `1`.
  - `resolveJsonPath({data:{document:{content:1}}}, "data.document.contnet")`: `ok:false`, and the error contains `data.document` and `content`.
  - `resolveJsonPath({items:[1]}, "items[3]")`: the error contains `index 3` and `length 1`.
  - `decodeBase64("JVBERi0=")` → bytes starting with `%PDF-`. `decodeBase64("data:application/pdf;base64,JVBERi0=")` gives the same. `decodeBase64("JVBER*")` throws.
  - `sniffType(Buffer.from("%PDF-1.7"))` → `"application/pdf"`. Unknown bytes → `null`.
  - `redactHeaders({Authorization:"Bearer abc", "X-Api-Key":"k", "Content-Type":"a/b"})` → `{Authorization:"<redacted: 10 chars>", "X-Api-Key":"<redacted: 1 chars>", "Content-Type":"a/b"}`.

- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @mgcrea/mcp-apple-safari test -- network-helpers`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the four exports in `client/network.ts`.** The path parser is a small hand tokenizer. No dependency.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(safari): json path, base64 and redaction helpers for network capture"`

---

### Task 2: `network-hook.js`, the MAIN-world recorder

**Files:**

- Create: `apps/apple/CupertinoSafariExtension/Resources/network-hook.js`
- Test: `packages/safari/test/network-hook.test.ts` (`node:vm`, hand-rolled stubs in the `content-script.test.ts` style, no jsdom)

**Interfaces:**

- Produces, as DOM events on `document`, every `detail` a JSON **string**:
  - Listens: `cupertino:net-install`, detail `{"kinds":["fetch","xhr","console"],"captureBodies":true,"bodyFilter":null,"maxBodyBytes":10485760}`. Installs the wrappers (idempotent: a second install only updates the options). `cupertino:net-uninstall` restores the originals.
  - Emits: `cupertino:net-ready`, detail `{"installed":bool}`, once at load and after each install.
  - Emits: `cupertino:net-record`, detail one record:
    `{kind:"fetch"|"xhr", phase:"start"|"end", ref:number, method, url, startedAt:number(epoch ms), requestHeaders, requestBody:{encoding:"text"|"base64"|"summary", data, bytes}|null, status, statusText, responseHeaders, contentType, durationMs, error:string|null, body:{encoding:"text"|"base64", data, bytes, truncated:boolean, totalBytes:number|null}|null}`.
    `ref` is the hook's own counter, correlating `start` and `end`. Console records: `{kind:"console", level:"error"|"warn", message, stack, startedAt}`.
  - At load: reads `sessionStorage["__cupertino_net"]`, JSON `{expiresAt:number, kinds, captureBodies, bodyFilter, maxBodyBytes}`. If present and unexpired, installs immediately with those options. If expired, removes it.
  - **World self-check:** if `typeof browser !== "undefined"` or `typeof chrome?.runtime?.id === "string"`, this copy is running in the isolated world (Safari ignored `world: "MAIN"`). Do nothing, so the background fallback in Task 4 is the copy that works. A `window.__cupertinoNetHook` symbol guard makes a double injection a no-op.

- [ ] **Step 1: Write the failing tests.** Stub a `window` with a fake `fetch` returning a fake `Response` that has `clone()`, `headers`, a stream-less `arrayBuffer()`/`text()`, a fake `XMLHttpRequest` class, `console`, `sessionStorage`, and a `document` with an `addEventListener`/`dispatchEvent` event bus. Tests:
  - `does nothing until installed`: `window.fetch` is still the original function.
  - `installs at load from an unexpired flag`, and `removes an expired flag and stays dormant`.
  - `fetch transparency`: the resolved value is the same Response object, and `await res.json()` still yields the body after the hook read its clone. A rejected fetch rejects with the same error and emits an `end` record with `error`.
  - `fetch records request and response`: method, url, string body, headers object, status, `contentType`, `body.encoding:"text"` for `application/json`.
  - `binary body is base64`: `application/pdf` gives `encoding:"base64"`, and the data decodes back to the bytes.
  - `body cap without Content-Length`: 12 bytes with `maxBodyBytes:8` gives `truncated:true` and `bytes:8`, and the page still reads all 12.
  - `Content-Length over cap skips the clone`: `clone` is never called and the record says `truncated:true, totalBytes:<len>`.
  - `xhr responseType arraybuffer|blob|json|text`: each captured, and `xhr.response` unchanged for the page.
  - `bodyFilter`: a non-matching URL gives `body:null` with metadata intact.
  - `console.error` emits a console record and still calls the original console with the same arguments. So do `error` and `unhandledrejection` events.
  - `an exception inside the recorder never reaches the page`: make `JSON.stringify` throw for one record, and the fetch still resolves.
  - `isolated-world copy bails`: with `browser` defined in the context, nothing is wrapped, even after an install event.
  - `uninstall restores the originals`.
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @mgcrea/mcp-apple-safari test -- network-hook`. Expected: FAIL (file missing).
- [ ] **Step 3: Implement `network-hook.js`.** One IIFE. Wrappers keep references to the originals captured at script start. Body reading is fire-and-forget on the clone, never awaited by the page's promise chain. Text-like means `text/*`, `json`, `xml`, `javascript`, `x-www-form-urlencoded`. Request bodies: string → text. `URLSearchParams` → text. `FormData` → summary `[{name, file?:{name,size,type}}]`. `Blob`/`ArrayBuffer`/typed array → base64 under the cap, else a summary.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(safari-extension): main-world fetch/xhr/console recorder"`

---

### Task 3: `network.js`, the isolated-world buffer and the three commands

**Files:**

- Create: `apps/apple/CupertinoSafariExtension/Resources/network.js`
- Modify: `apps/apple/CupertinoSafariExtension/Resources/actions.js:60-65` (reuse an existing `window.cupertinoPageToken` instead of always minting one) and `:746-805` (dispatch `netRecord`/`netList`/`netGet` to `window.cupertinoNetwork.run(command)`. If it is absent: `{ok:false, error:"The network recorder did not load on this page."}`)
- Test: `packages/safari/test/network-buffer.test.ts` (vm. Load `network.js` then `actions.js` into one context, as Safari's shared isolated world does)

**Interfaces:**

- Consumes: the Task 2 event protocol.
- Produces `window.cupertinoNetwork.run(command) → {ok, data}|{ok:false, error}`. It is synchronous, because `cupertinoRunCommand` is synchronous. Commands:
  - `{action:"netRecord", op:"start"|"stop"|"clear"|"status", kinds?, captureBodies?, bodyFilter?, maxBodyBytes?, armMinutes?, reload?}` → `data: {recording:boolean, page, expiresAt:string|null(ISO), options, counts:{records, bodies, bodyBytes}, dropped:{records, bodies}, hook:{installed:boolean}, resourceStatusSupported:boolean}`.
    - `start`: writes the `__cupertino_net` flag with `expiresAt = now + armMinutes*60_000` and dispatches `cupertino:net-install`. With `reload`, it calls `setTimeout(() => location.reload(), 50)` after building the result, so the answer leaves first.
    - `stop`: removes the flag and dispatches uninstall. The buffer is kept.
    - `clear`: empties the buffer.
  - `{action:"netList", filter?:{kind?, urlContains?, method?, statusMin?, statusMax?, failed?}, after?:string, limit}` → `data: {recording, page, entries:Entry[], next:string|null, dropped}`.
    - Entry: `{id, seq, kind, method, url, status, statusText, ok, error, startedAt(ISO), durationMs, requestBytes, responseBytes, contentType, bodyAvailable, bodyTruncated, bodyEvicted}`. Console: `{id, seq, kind:"console", level, message, stack(first line), startedAt}`.
  - `{action:"netGet", id, part:"response"|"request", headers:boolean, offset:number, length:number}` → `data: {entry:Entry, headers?:Record<string,string>(redacted), encoding:"text"|"base64"|"summary"|null, totalChars:number, offset, slice:string, done:boolean}`.
    - Unknown id from this page: `ok:false`, "no request <id> on this page". An id whose token is not this page's never reaches here (the existing `command.page` check in `cupertinoRunCommand` refuses it), so give that refusal network wording: when `command.action` starts with `net`, say "recorded by a page load that has since gone (reloaded, navigated or closed); list again".
- Rules:
  - Records are accepted only while this script's own `recording` is true. Recording is true after `start`, or at load when the flag is unexpired, and stays true until `stop` or the flag's `expiresAt` passes (check on every event).
  - `failed` = `error != null || status >= 400 || (kind==="console" && level==="error")`.
  - Eviction: bodies go oldest-first once total body chars exceed 50 MiB (the entry stays, with `bodyEvicted:true`, and `dropped.bodies++`). Records go oldest-first past 1,000 (`dropped.records++`).
  - Resource timing: on every `netList`/`netRecord`, ingest `performance.getEntriesByType("resource")` entries beyond the last index seen, as `kind:"resource"` with ids `-t<n>`. Skip `initiatorType` `fetch`/`xmlhttprequest` whose URL matches a hooked record. `status` = `responseStatus` when the property exists, else null. Resource entries are ingested whether or not recording is armed.
  - Redaction is applied when headers leave in `netGet` (same pattern as Task 1. A test asserts the regex source matches `REDACTED_HEADER.source`).
  - Must mint `window.cupertinoPageToken` (8 hex chars, same as `actions.js` today) if absent, because this script loads first at `document_start`.

- [ ] **Step 1: Write the failing tests.** Drive it by dispatching `cupertino:net-record` events on the stub `document`:
  - `drops records while disarmed`, then `start` accepts them.
  - `start writes an expiring flag` (`armMinutes:15` gives `expiresAt` 15 min ahead). An expired flag at load gives `recording:false`.
  - `ids carry the page token`: `/^[0-9a-f]{8}-r1$/`, and it is the same token `actions.js` hands out in `-e` ids.
  - `start/end correlate on ref`: one entry with `durationMs`.
  - `list filters`: `failed`, `statusMin/Max`, `method`, `urlContains`, `kind:"console"`.
  - `list cursor`: `after` returns only newer entries, and `next` is null at the end.
  - `get pages a body`: a 10-char body with `length:4` takes three calls with `done` on the last, and the concatenated slices equal the body.
  - `get redacts headers`.
  - `eviction keeps the entry and marks bodyEvicted`. `dropped` counts.
  - `resource timing entries listed while disarmed`, deduped against a hooked fetch to the same URL.
  - `stale id refusal wording`: `cupertinoRunCommand({action:"netGet", page:"deadbeef", id:"deadbeef-r1"})` gives an error containing "since gone".
  - `reload schedules after the answer`: a stub `location.reload` is not called synchronously and is called after timers run.
  - `existing page-token tests still pass` (run the whole content-script suite).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `network.js` and the two `actions.js` edits.**
- [ ] **Step 4: Run the new suite and `content-script.test.ts`.** Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(safari-extension): network buffer and netRecord/netList/netGet commands"`

---

### Task 4: Manifest, background fallback, faster pump

**Files:**

- Modify: `apps/apple/CupertinoSafariExtension/Resources/manifest.json`
- Modify: `apps/apple/CupertinoSafariExtension/Resources/background.js`
- Modify: `apps/apple/CupertinoSafariExtension/Resources/content.js:200-235` (`pump`)
- Test: `packages/safari/test/extension-manifest.test.ts` (new), plus a `pump` test in `network-buffer.test.ts` or a new vm test

**Interfaces:**

- Manifest `content_scripts` becomes three entries:
  1. `{"matches":["<all_urls>"], "js":["network-hook.js"], "run_at":"document_start", "all_frames":false, "world":"MAIN"}`
  2. `{"matches":["<all_urls>"], "js":["network.js"], "run_at":"document_start", "all_frames":false}`
  3. The existing `actions.js`/`content.js` entry, unchanged.
- `"permissions": ["nativeMessaging", "scripting"]`.
- `background.js`: on `runtime.onInstalled` and on startup, call `browser.scripting.registerContentScripts([{id:"cupertino-net-hook", matches:["<all_urls>"], js:["network-hook.js"], runAt:"document_start", world:"MAIN", persistAcrossSessions:true}])`. Ignore a "duplicate id" error, and catch and `console.error` anything else. The hook's symbol guard makes the double registration harmless, and its world self-check silences whichever copy landed in the isolated world. This fallback exists because Safari's support for `world` in manifest `content_scripts` is undocumented (an Apple forum thread confirms only `registerContentScripts` with MAIN since 16.4). It costs one permission and saves a notarization round trip if the manifest key is ignored.
- `content.js` `pump`: when the poll returned at least one command, schedule the next poll with `setTimeout(pump, 0)` instead of the interval.

- [ ] **Step 1: Write the failing tests.**
  - The manifest test asserts the three entries above, in that order, with the `world` values, the `scripting` permission, and that every named file exists (mirror `scripts/verify-extension.sh`).
  - `pump re-polls immediately after a command`: stub `browser.runtime.sendMessage` to return one command, then none. The second poll is scheduled with delay 0, and the third with 1000.
  - Background: evaluate `background.js` in vm with a stub `browser.scripting.registerContentScripts`. Expect one call with `world:"MAIN"` on `onInstalled`, and a rejected "duplicate" error swallowed.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement the three edits.**
- [ ] **Step 4: Run, then `make verify-extension APP_PATH=<any built app>` if one exists.** Otherwise defer that to Task 7. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(safari-extension): load the network scripts, fall back to scripting registration"`

---

### Task 5: Server client: config, routing, chunked pull, save

**Files:**

- Modify: `packages/safari/src/config.ts` (add `allowNetwork`, `downloadDir`, `networkChunkChars`)
- Modify: `packages/safari/src/client/actions.ts` (`Command.action` gains `"netRecord" | "netList" | "netGet"`, plus the fields below. Add `pageOfRequest`)
- Modify: `packages/safari/src/client/safari.ts` (new methods next to `pageAction`)
- Test: `packages/safari/test/network-client.test.ts` (the fake-extension pattern from `actions.test.ts`: a loop that answers files in `commands/` by writing `results/`)

**Interfaces:**

- Config: `allowNetwork: z.boolean().default(false)` ← `APPLE_SAFARI_ALLOW_NETWORK`. `downloadDir: z.string().default(join(homedir(), "Downloads"))` ← `APPLE_SAFARI_DOWNLOAD_DIR`. `networkChunkChars: z.number().int().min(16_384).max(8_388_608).default(262_144)` ← `APPLE_SAFARI_NETWORK_CHUNK_CHARS`. The default is a guess until Task 7 measures Safari's native-message limit, so leave a comment saying so.
- `pageOfRequest(id: string): string | null` matches `/^([0-9a-f]{8})-[rtc]\d+$/`.
- `AppleSafariClient` methods (each uses `runCommand` with `actionTimeoutMs`):
  - `networkRecord(input: {url: string; op: "start"|"stop"|"clear"|"status"; kinds?; captureBodies?; bodyFilter?; maxBodyBytes?; armMinutes?; reload?: boolean}): Promise<RecordState>`. It throws `PreconditionError` naming `APPLE_SAFARI_ALLOW_WRITES` when `reload && !allowWrites`.
  - `networkList(input: {url; filter?; after?; limit?}): Promise<ListResult>`.
  - `networkGet(input: {url; id; part?: "response"|"request"; headers?: boolean; jsonPath?: string; decode?: "base64"; offset?: number; maxChars?: number; saveAs?: string; overwrite?: boolean}): Promise<GetResult>`.
    - Routes with `page = pageOfRequest(id)`. A malformed id gives `PreconditionError` ("not a request id from apple_safari_network_list").
    - Without `jsonPath`/`decode`/`saveAs`: pull only the chunks covering `[offset, offset+maxChars)`. Return `{entry, headers, encoding, text, offset, totalChars, truncated, nextOffset}`.
    - With any of them: pull every chunk (`networkChunkChars` each) and reassemble. `jsonPath` needs text that parses as JSON, otherwise error "body is not JSON (content-type …)". `decode` applies to the selected value, which must be a string. A body with `encoding:"base64"` saved without `decode` is decoded anyway.
    - `saveAs`: `PreconditionError` if `!allowWrites`. Else `writeConfinedFile({root: downloadDir, name: saveAs, bytes, overwrite, settingName: "APPLE_SAFARI_DOWNLOAD_DIR"})`. Returns `{saved:{path, bytes, type: sniffType(bytes)}}` and never the bytes.
    - With `jsonPath` but no save: return the selected value as JSON text under the same inline cap and paging.
    - A command timeout on the 2nd+ chunk throws with "the page stopped answering partway through the body (chunk k of n)".

- [ ] **Step 1: Write the failing tests** against a fake extension that serves a canned record and answers `netGet` slices honestly:
  - Config: env parsing for the three keys, and the defaults.
  - `pageOfRequest` accepts `3f9a2c1d-r12`/`-t3`/`-c1` and rejects `3f9a2c1d-e12`.
  - `chunked reassembly`: a 600,000-char body with `networkChunkChars:262144` gives 3 `netGet` commands, and the reassembled text equals the body.
  - `inline paging`: `offset:0,maxChars:20000` sends one command for the first chunk only, and returns `truncated:true, nextOffset:20000`.
  - **The PDF path:** body `{"data":{"document":{"content":"<base64 of a 5-byte %PDF- blob>"}}}`, with `jsonPath:"data.document.content", decode:"base64", saveAs:"doc.pdf"`, gives a file in a temp `downloadDir` whose bytes equal the blob, with `type:"application/pdf"`.
  - `saveAs refuses without writes`, and the message names `APPLE_SAFARI_ALLOW_WRITES`. `reload refuses without writes`.
  - `saveAs will not overwrite` unless `overwrite:true`. `saveAs:"../x.pdf"` lands inside `downloadDir`, or is refused, never outside.
  - `jsonPath miss propagates the helper's message`.
  - `stale id`: the fake answers `ok:false` with the "since gone" text, and the client surfaces it verbatim.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement config, `actions.ts` additions, the three client methods.**
- [ ] **Step 4: Run to verify they pass.** Then run the full safari suite: `pnpm --filter @mgcrea/mcp-apple-safari test`.
- [ ] **Step 5: Commit.** `git commit -m "feat(safari): network client with chunked body pull and confined save"`

---

### Task 6: Tools, gate, guide and docs

**Files:**

- Create: `packages/safari/src/tools/network.ts`
- Modify: `packages/safari/src/tools/index.ts` (`ToolContext.allowNetwork`, register `registerNetworkTools(server, client, {allowWrites})` when on), `packages/safari/src/server.ts:59-62` (pass `allowNetwork: config.allowNetwork`)
- Modify: `surfaces.json` (add the gate to Safari), then `make surfaces` to regenerate the copies. Modify `apps/apple/Cupertino/Surfaces.swift` (add `Surface.Gate(id: "allowNetwork", envSuffix: "ALLOW_NETWORK", label: "Read network traffic", description: "Lets Safari tools record what a page you have allowed the extension on fetches, and read the responses. Off by default.")`, with a house-style comment on why it is a read gate and why bodies cannot be redacted) if `make surfaces` does not generate it
- Modify: `packages/safari/src/guide.ts` (a "Debugging a page / getting a file out of an API response" section), `packages/safari/README.md` (tools + gate + env), `docs/safari.md` (a "Network capture" section: the lane, its limits, and a placeholder table for Task 7's measurements)
- Test: `packages/safari/test/tools.test.ts` (registration), `packages/safari/test/network-client.test.ts` (one end-to-end call per tool through the MCP client)

**Interfaces:**

- Tool names, exactly: `apple_safari_network_record`, `apple_safari_network_list`, `apple_safari_network_get`. Argument names and defaults as in Task 5 and the spec. `url` reuses the `urlArg` description pattern from `tools/actions.ts`, and descriptions go through the same `describeReach` wording (copy it or export it from `actions.ts`).
- `network_list` takes `status` as a string: `"404"` (exact) or `"400-599"` (inclusive range). The tool parses it into `statusMin`/`statusMax`. A malformed value fails validation with an example. Test both forms in Step 1.
- Annotations: `record` `{readOnlyHint:false, idempotentHint:false, openWorldHint:true}`. `list` `{readOnlyHint:true, openWorldHint:true}`. `get` `{readOnlyHint:false, destructiveHint:false, openWorldHint:true}` (it can save a file).
- Descriptions must say: what Safari cannot capture (no subframes, workers, `<img>`/`<script>` bodies, WebSockets); that bodies are NOT redacted, only the listed headers; that ids die on reload; that `reload`/`saveAs` need writes; and the PDF recipe in one sentence (`jsonPath` → `decode:"base64"` → `saveAs`).

- [ ] **Step 1: Write the failing tests.** Gate off gives none of the three tools in `listTools`. Gate on with writes off gives all three, `reload:true` → `isError` naming `APPLE_SAFARI_ALLOW_WRITES`, and `saveAs` → the same. Gate on with writes on runs the PDF path end to end through `callTool`, with a fake extension, into a temp `APPLE_SAFARI_DOWNLOAD_DIR`. `allowCodes` and `allowNetwork` are independent (each on alone registers only its own tools).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `tools/network.ts`, the wiring, the gate and the docs.**
- [ ] **Step 4: Verify.** `pnpm --filter @mgcrea/mcp-apple-safari test`, `make surfaces-check`, `make readme-check`, `pnpm -r typecheck` (or the repo's lint/typecheck script), and `make format-swift-check` if Swift changed. Expected: all clean.
- [ ] **Step 5: Commit.** `git commit -m "feat(safari): network_record, network_list and network_get behind allowNetwork"`

---

### Task 7: Notarized build, live measurement, end-to-end

Live on Olivier's Mac. He authorized builds and installs for this project on 2026-10-20. Follow the `use-the-dev-build` and `cut-a-release` skills' guidance on which app the session's tools reach. Quit Safari before installing (`docs/safari.md`, "Replacing the app under a running Safari can crash Safari"): tabs restore on relaunch.

**Files:**

- Modify: `docs/safari.md` (fill in the measurement table), `packages/safari/src/config.ts` (set the `networkChunkChars` default from the measurement)

- [ ] **Step 1: Build.** `make build-release`, then `make verify-extension`. Expected: notarized and stapled, manifest resources all present.
- [ ] **Step 2: Install.** Quit Safari, `make install-release`, relaunch Cupertino and Safari. Point the MCP session at the new build (`use-the-dev-build`). Enable "Read network traffic" and writes for Safari in Cupertino's settings, if they are not already on.
- [ ] **Step 3: Measure the five spec items** and record each in `docs/safari.md`:
  1. Which copy of the hook installed: `network_record status` → `hook.installed`, and whether the manifest `world` or the background registration delivered it (temporarily log which in the console, or check with the background registration removed in a later build only if it matters).
  2. Native-message ceiling: `network_get` the largest available body with `APPLE_SAFARI_NETWORK_CHUNK_CHARS` at 262,144, 1,048,576 and 4,194,304 (env change, no rebuild). Record the largest that works and set the default to half of it.
  3. CustomEvent detail across worlds: implied by records arriving at all.
  4. `responseStatus`: `resourceStatusSupported` from `status`.
  5. The PDF site: confirm XHR vs fetch, and find the JSON path.
- [ ] **Step 4: End to end on a local app.** Serve a page from `localhost` (any of Olivier's apps, or a scratch `node` server in the scratchpad) that makes one 200 call, one 500 call and one `console.error`. Then: `record start reload:true`, `list failed:true`, which shows the 500 and the console error. `get` the 500's body.
- [ ] **Step 5: End to end on the PDF site.** The `app.immo-sign.com` tab: `record start reload:true`, `list urlContains:<api fragment> kind:"xhr"`, then `get` with `jsonPath`, `decode:"base64"` and `saveAs:"mandat.pdf"`. Open the saved file and confirm it is the mandate.
- [ ] **Step 6: Commit measurements and the chunk default.** `git commit -m "docs(safari): measure the network lane on a notarized build"`

---

## Deviations from the spec (planner's calls)

- **The spike is folded into the first real notarized build (Task 7)**, not run as a separate probe build first. None of the five measurements changes the code's shape. The `world: "MAIN"` uncertainty is covered by shipping both injection routes (manifest key plus `registerContentScripts`), the hook silencing whichever copy lands in the wrong world, and the chunk size being an env-tunable config value. This saves one notarization round trip.
- **Event names are fixed** (`cupertino:net-*`), not minted per page load: the MAIN world cannot learn a name minted in the isolated world without a fixed channel anyway, and the spec's spoofing analysis already accepts that the page can see and forge these.
