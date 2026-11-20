# Safari Extension Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking Cupertino's toolbar icon in Safari opens a popover that says whether the tab in
front can reach Cupertino, shows and stops its network recording, and lists what agents did on it.

**Architecture:** A web-extension popover (`action.default_popup`) that talks only to the tab's
content script through `browser.tabs.sendMessage`, never through the background worker. The
content script keeps poll bookkeeping (`content.js`) and a ring of the last ten commands
(`actions.js`); the background worker leaves the page a note for the cookie commands it answers
itself. `popup.js` turns the content script's answer into a view model, which a thin renderer draws.

**Tech Stack:** Plain JavaScript (no build step) in
`apps/apple/CupertinoSafariExtension/Resources/`, Safari Web Extension API (Manifest V3); vitest
tests in `packages/safari/test/` that run the real files in `node:vm` with hand-rolled stubs (no
jsdom: see the header of `content-script.test.ts`).

**Spec:** `docs/superpowers/specs/2026-11-20-safari-popover-design.md`

## Global Constraints

- `manifest.json` `permissions` stays exactly `["nativeMessaging", "cookies"]`; no `activeTab`, no
  `tabs`, no `host_permissions`, no `optional_host_permissions`.
- The popover never shows page text, HTML, a field's value, a cookie name or value, a request URL,
  body or id. Agent actions show verb and element label only.
- No popover call goes through `background.js`: only `browser.tabs.query`, `browser.tabs.sendMessage`,
  `browser.tabs.reload` and `browser.runtime.getManifest`.
- Thresholds: Ready/Stalled at 15 s since the last successful poll; Connecting while no successful
  poll and less than 15 s since the pump started; the popover gives `tabs.sendMessage` 1.5 s.
- Labels are cut to 60 characters. The ring holds 10 entries, newest first.
- New resource files go flat in `Resources/` (a synchronized Xcode group: no project edit).
- Run tests from `packages/safari`. In a fresh worktree build the workspace core first:
  `pnpm install --frozen-lockfile && pnpm --filter @mgcrea/mcp-apple-core build`.
- Format with `npx oxfmt`, lint with `npx oxlint packages/safari`, from the repo root. No
  `Co-Authored-By` trailers on commits.

## Review Focus

- **A tab running a content script from before this build** has no listener, and Safari may never
  settle the `sendMessage` promise: the popover must show "Not here" after 1.5 s, never hang on a
  blank popover. Pinned in Task 4.
- **A message from somewhere other than the popover** (a web page relaying through another
  extension, or anything with `sender.tab` set) asking `popupStatus` or `popupNetwork`: no reply, and
  no recording stopped. Pinned in Task 3.
- **The recorder did not load** (`window.cupertinoNetwork` missing): status carries `network: null`,
  the section is hidden, and a `popupNetwork` answers `{ ok: false, error }` rather than throwing.
  Pinned in Task 3.
- **A label that is long or multi-line** (a button whose label is a paragraph): one line, at most
  60 characters, in the ring and so in the popover. Pinned in Task 1.
- **The tab navigates while the popover is open**, so Stop or Clear lands on a page with no
  recording or no content script: the popover redraws from the new answer or shows "Not here",
  never a stale "Recording". Pinned in Task 4.

---

### Task 1: The recent-commands ring in `actions.js`

**Files:**

- Modify: `apps/apple/CupertinoSafariExtension/Resources/actions.js` (`window.cupertinoRunCommand`, around line 998)
- Test: `packages/safari/test/recent-commands.test.ts` (new; load `actions.js` the way `content-script.test.ts` does)

**Interfaces:**

- Produces:
  - `window.cupertinoNoteCommand(entry: { action: string, op?: string, ok: boolean, label?: string }): void`, which stamps `at: Date.now()` and adds the entry.
  - `window.cupertinoRecentCommands(): Array<{ at: number, action: string, op?: string, ok: boolean, label?: string }>`, newest first, at most 10, a copy.

- [ ] **Step 1: Write the failing tests**

Each test runs commands through `cupertinoRunCommand` with the DOM stub from `content-script.test.ts`, then reads `cupertinoRecentCommands()`:

- `it("lists a click by the label it had before the click")`: one entry `{ action: "click", ok: true, label: <the element's label> }`.
- `it("lists a fill by its field's label and never the text filled")`: fill with text `"hunter2"`; `JSON.stringify(recent)` does not contain `"hunter2"`; the entry has `label` equal to the field's label.
- `it("lists a submit by its button")`: `label` is the result's `button`.
- `it("keeps a netRecord's op")`: a `netRecord` command with `op: "stop"` (stub `window.cupertinoNetwork.run` to return `{ ok: true, data: {} }`) is listed as `{ action: "netRecord", op: "stop", ok: true }`.
- `it("lists a refused command as failed, with no label")`: a click whose `page` is another load's token gives `{ action: "click", ok: false }` and no `label` key.
- `it("keeps the last ten, newest first")`: 12 `scroll` commands; length is 10, and `at` does not increase down the list.
- `it("cuts a label to one line of at most 60 characters")`: a button whose label is 200 characters with a newline; the stored `label` has no `\n` and `length <= 60`.
- `it("takes a note from outside the runner")`: `cupertinoNoteCommand({ action: "cookies", ok: true })` appears first.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/recent-commands.test.ts`
Expected: FAIL, `cupertinoRecentCommands is not a function`.

- [ ] **Step 3: Implement the ring in `actions.js`**

Keep the ring in the IIFE that defines `cupertinoRunCommand`. Wrap the existing body so every return path, including the two early refusals and the `catch`, calls the internal note with `{ action: command.action, op: command.action === "netRecord" ? command.op : undefined, ok: result.ok === true, label }`. `label` comes from `result.data.label` for click and fill, `result.data.button` for submit, and is otherwise left out. Collapse whitespace runs to one space, trim, and cut to 60 characters. Omit undefined keys, so `"label" in entry` is false when there is none.

- [ ] **Step 4: Run the tests and the existing actions tests**

Run: `npx vitest run test/recent-commands.test.ts test/content-script.test.ts test/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/CupertinoSafariExtension/Resources/actions.js packages/safari/test/recent-commands.test.ts
git commit -m "feat(safari): the content script keeps the last ten commands agents ran on the page"
```

### Task 2: The background's note for cookie commands

**Files:**

- Modify: `apps/apple/CupertinoSafariExtension/Resources/background.js` (`answerHere`, around line 59)
- Test: `packages/safari/test/extension-background.test.ts`

**Interfaces:**

- Produces: a poll reply that carried cookie commands comes back as `{ ...reply, commands: forPage, ran: Array<{ action: "cookies" | "cookieProbe", ok: boolean }> }`; `ran` is absent when the reply carried none.

- [ ] **Step 1: Write the failing tests** in the existing `load()` harness:
- `it("leaves the page a note of each cookie command it answered, without names or values")`: native returns `{ commands: [{ id: "k1", action: "cookies", url, valuesFor: ["sid"] }, { id: "c2", action: "click" }] }`; the reply's `commands` is `[{ id: "c2", action: "click" }]`, `ran` is `[{ action: "cookies", ok: <result.ok> }]`, and `JSON.stringify(reply.ran)` contains no `"sid"` and no URL.
- `it("adds no note when no cookie command came")`: `"ran" in reply` is false.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/extension-background.test.ts`
Expected: FAIL on `ran`.

- [ ] **Step 3: Implement** by collecting `{ action: command.action, ok: result?.ok === true }` in `answerHere`, and setting `ran` only when non-empty.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/extension-background.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/CupertinoSafariExtension/Resources/background.js packages/safari/test/extension-background.test.ts
git commit -m "feat(safari): the background tells the page which cookie reads it answered"
```

### Task 3: Poll bookkeeping and the popover's listener in `content.js`

**Files:**

- Modify: `apps/apple/CupertinoSafariExtension/Resources/content.js` (the pump IIFE, lines ~203-325)
- Test: `packages/safari/test/content-popup.test.ts` (new; use the stub context from `content-pump.test.ts`, adding `browser.runtime.id: "ext"` and `browser.runtime.onMessage.addListener` that captures the listener)

**Interfaces:**

- Consumes: `window.cupertinoNoteCommand` and `window.cupertinoRecentCommands` (Task 1); the reply's `ran` (Task 2); `window.cupertinoNetwork.run({ action: "netRecord", op })` returning `{ ok, data: state() }` (existing, `network.js`).
- Produces: a `browser.runtime.onMessage` listener answering:
  - `{ kind: "popupStatus" }` → `{ ok: true, host: location.host, page: window.cupertinoPageToken ?? null, extensionVersion: string | null, startedAt: number, lastPollOkAt: number | null, failedPolls: number, network: object | null, recent: Array<...> }`;
  - `{ kind: "popupNetwork", op: "stop" | "clear" }` → `{ ok: true, network: object }` or `{ ok: false, error: string }`.

- [ ] **Step 1: Write the failing tests:**
- `it("counts a poll that came back with a reply as a successful check-in")`: after one poll answering `{ commands: [] }`, `popupStatus` gives `lastPollOkAt` as a number, `failedPolls: 0`, and `startedAt <= lastPollOkAt`.
- `it("does not count a poll the background answered with nothing")`: the poll resolves `undefined` twice; `lastPollOkAt: null`, `failedPolls: 2`.
- `it("does not count a poll whose message was lost")`: `sendMessage` returns a never-settling promise and the test fires the `WAIT_MS` timer; `failedPolls: 1`.
- `it("adds the background's cookie notes to the page's list")`: a poll reply `{ commands: [], ran: [{ action: "cookies", ok: true }] }` puts `{ action: "cookies", ok: true }` at the top of `recent` (with the real `actions.js` loaded first, or a stub ring).
- `it("reports the recording through the recorder's own status")`: `cupertinoNetwork.run` stub returns `{ ok: true, data: { recording: true } }` for `op: "status"`; `network` is `{ recording: true }`.
- `it("stops and clears the recording for the popover")`: `popupNetwork` `op: "stop"` calls `run({ action: "netRecord", op: "stop" })` and answers `{ ok: true, network: <data> }`.
- `it("answers network null, and refuses to stop, when the recorder did not load")`: no `cupertinoNetwork`; `popupStatus.network` is `null`; `popupNetwork` answers `{ ok: false, error: <string> }`.
- `it("answers no one but the extension's own popover")`: with `sender.id: "other"`, and with `sender.id: "ext"` plus `sender.tab: { id: 1 }`, the listener returns `undefined` and the recorder stub's `run` is not called.
- `it("leaves every other message alone")`: `{ kind: "poll" }` from the popover's sender returns `undefined`.
- `it("does not list the person's own Stop as something an agent did")`: with the real `actions.js` loaded first, a `popupNetwork` `op: "stop"` leaves `cupertinoRecentCommands()` unchanged. The listener calls `cupertinoNetwork.run` directly, never `cupertinoRunCommand`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/content-popup.test.ts`
Expected: FAIL, no listener registered.

- [ ] **Step 3: Implement in the pump IIFE.**
- Set `startedAt` when the pump first runs.
- In `pump`, a response that is a non-null object sets `lastPollOkAt = Date.now()` and `failedPolls = 0`. `undefined` or a rejection increments `failedPolls`.
- Each `response.ran` entry goes to `window.cupertinoNoteCommand?.(entry)`.
- Register the listener with `browser.runtime.onMessage?.addListener`. The optional call keeps `content-pump.test.ts`'s stubs, which have no `onMessage`, working.
- The listener answers only when `sender?.id === browser.runtime.id && !sender?.tab`. It returns a value (or a promise) only for the two kinds.

- [ ] **Step 4: Run the new and existing content tests**

Run: `npx vitest run test/content-popup.test.ts test/content-pump.test.ts test/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/apple/CupertinoSafariExtension/Resources/content.js packages/safari/test/content-popup.test.ts
git commit -m "feat(safari): the content script tells the popover how its polls are going"
```

### Task 4: The popover, its manifest entry, and the docs

**Files:**

- Create: `apps/apple/CupertinoSafariExtension/Resources/popup.html`, `popup.css`, `popup.js`
- Modify: `apps/apple/CupertinoSafariExtension/Resources/manifest.json` (`action.default_popup`)
- Modify: `packages/safari/test/extension-manifest.test.ts`
- Test: `packages/safari/test/popup.test.ts` (new)
- Modify: `docs/safari.md` (a new section after "Open pages can also go silent"), `CHANGELOG.md` (Unreleased, `### Added`)

**Interfaces:**

- Consumes: the `popupStatus` / `popupNetwork` answers (Task 3); ring entries (Task 1).
- Produces, on `globalThis`, for the tests:
  - `cupertinoPopupView(input: { answer: object | null, error: "no-tab" | "not-here" | null, now: number }) => View`;
  - `cupertinoPopupLoad(): Promise<View>`, which queries, messages and builds the view;
  - `cupertinoPopupNetwork(op: "stop" | "clear"): Promise<View>`;
  - `cupertinoPopupReload(): Promise<void>`.
- `View`:

  ```js
  {
    version: string,
    host: string | null,
    state: "ready" | "connecting" | "stalled" | "not-here" | "no-tab",
    headline: string,
    detail: string | null,
    reload: boolean,
    network: null | { line: string, stop: boolean, clear: boolean },
    recent: string[],
  }
  ```

- [ ] **Step 1: Write the failing view tests** (`popup.test.ts`, vm with `browser.runtime.getManifest` and no `document`, so the renderer must not run at load when `document` is absent):
- `it("is Ready within 15 s of a successful poll")`: `lastPollOkAt: now - 15_000` gives `state: "ready"`, `headline: "Agents can read and act on this page."`, `reload: false`.
- `it("is Stalled past 15 s, with how long since the last check-in")`: `now - 120_000` gives `state: "stalled"`, a headline starting `"This page can't reach Cupertino"`, a detail containing `"2 min ago"`, and `reload: true`.
- `it("is Connecting before the first poll, then Stalled")`: `lastPollOkAt: null` with `startedAt: now - 5_000` gives `"connecting"`; with `startedAt: now - 15_000` it gives `"stalled"`, and the detail contains `"never"`.
- `it("is Not here when the page did not answer, and names the three reasons")`: `error: "not-here"` gives `reload: true`; the detail mentions Settings, an update or a tab open from before, and pages Safari does not run extensions on.
- `it("is No tab with nothing to do")`: `error: "no-tab"` gives `reload: false`.
- `it("shows an armed recording with Stop and Clear")`: `network: { recording: true, counts: { records: 33 }, expiresAt: <iso> }`; the line contains `"33 requests"` and `"stops at HH:MM"` (local time, computed in the test with the same `getHours`/`getMinutes`); `stop` and `clear` are both true.
- `it("keeps a stopped recording with records, with Clear only")`: `recording: false, counts.records: 33` gives the line `"Stopped · 33 requests kept"`, `stop: false`, `clear: true`.
- `it("hides the recording section when there is nothing recorded")`: `recording: false, records: 0` gives `network: null`.
- `it("words each command as a verb, with its label, and marks failures")`: the ring `[{ at, action: "fill", ok: true, label: "Nom" }, { at, action: "cookies", ok: true }, { at, action: "netRecord", op: "start", ok: false }]` gives lines ending `filled "Nom"`, `read cookies`, `started recording (failed)`, each starting with `HH:MM `.
- `it("never shows anything but verbs and labels")`: an answer whose ring entries carry extra keys (`text`, `url`) produces no line containing them.

- [ ] **Step 2: Write the failing controller tests** (stub `browser.tabs`):
- `it("asks the tab in front, not the background")`: `cupertinoPopupLoad()` calls `tabs.query({ active: true, currentWindow: true })`, then `tabs.sendMessage(7, { kind: "popupStatus" })`, and never `runtime.sendMessage`.
- `it("gives a page 1.5 s and then says Not here")`: `sendMessage` never settles; after the 1.5 s timer fires, the view is `"not-here"`.
- `it("says Not here when sendMessage rejects")`.
- `it("says No tab when the window has none")`: `query` resolves `[]`.
- `it("redraws from the page's answer after Stop")`: `cupertinoPopupNetwork("stop")` sends `{ kind: "popupNetwork", op: "stop" }` and returns a view built from the returned `network`.
- `it("shows Not here when the page has gone since the popover opened")`: `sendMessage` for `popupNetwork` rejects, and the view is `"not-here"`, not a recording.
- `it("reloads the tab and closes")`: `cupertinoPopupReload()` calls `tabs.reload(7)` then `window.close()`.

- [ ] **Step 3: Update `extension-manifest.test.ts`**: the permissions assertion stays `["nativeMessaging", "cookies"]`; add `it("opens a popover from the toolbar icon")` asserting `manifest.action.default_popup === "popup.html"`. The existing "names only files the bundle carries" test then checks `popup.html` exists.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run test/popup.test.ts test/extension-manifest.test.ts`
Expected: FAIL, `popup.js` missing and `default_popup` undefined.

- [ ] **Step 5: Implement `popup.js`, `popup.html`, `popup.css` and the manifest entry.**
- **Copy.** Use the spec's copy and verbs exactly, "The states" and "What agents did here". Unknown actions read `ran <action>`. A `netRecord` with op `status` reads `checked the recording`, and `cookieProbe` reads `checked a cookie`.
- **Ages:** under 60 s as `N s ago`, otherwise `N min ago`.
- **Rendering** builds nodes with `textContent` only, never `innerHTML`, so a label cannot inject markup.
- **Loading:** `popup.html` loads `popup.css` and `popup.js` with no inline script. A page CSP forbids inline scripts in extension pages.
- **Startup:** `popup.js` calls `cupertinoPopupLoad()` and renders on `DOMContentLoaded`, only when `document` exists.
- **Styling:** about 300 px wide, the system font, light and dark through `prefers-color-scheme`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/popup.test.ts test/extension-manifest.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the docs.**
- **`docs/safari.md`:** a section "The popover". It covers what it shows and the states with their thresholds, that it adds no permission and why not `activeTab`, what it never shows, and the five "To measure" items from the spec, each marked unmeasured.
- **`CHANGELOG.md`:** under Unreleased › Added, one entry in the house style, opening `**Click Cupertino's icon in Safari to see the tab in front.**`.

- [ ] **Step 8: Full check and commit**

Run: `npx vitest run` (from `packages/safari`), `npx tsc --noEmit -p .`, then from the repo root `npx oxlint packages/safari` and `npx oxfmt --check` on every file touched.
Expected: all green, test count up by the new tests.

```bash
git add apps/apple/CupertinoSafariExtension/Resources/popup.html apps/apple/CupertinoSafariExtension/Resources/popup.css apps/apple/CupertinoSafariExtension/Resources/popup.js apps/apple/CupertinoSafariExtension/Resources/manifest.json packages/safari/test/popup.test.ts packages/safari/test/extension-manifest.test.ts docs/safari.md CHANGELOG.md
git commit -m "feat(safari): the toolbar icon opens a popover on the tab in front"
```

### After the tasks: the signed build (Olivier, by hand)

This is not a code task. It follows the spec's "Done" section and needs a notarized build installed
in `/Applications`. On a healthy geneanet tab, check:

- the popover opens and says Ready;
- an agent's `page_elements`, `fill` and `click` appear in the list;
- `network_record start` shows the recording, and Stop then Clear work;
- Reload reloads the tab;
- on a site the extension is not allowed on, note what Safari shows when the icon is clicked;
- on a tab open from before the update, the popover says Not here.

Record the results in `docs/safari.md`. The stalled case stays open until the next stall happens
on its own.
