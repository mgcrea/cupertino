# Native Mail Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mail draft creation and editing reliable. A native Swift composer driver in the app replaces the Node keystroke sequence, closed drafts are rebuilt faithfully, and `update_draft` gains find/replace edits.

**Architecture:** The app serves a few coarse Mail-composer verbs on the internal AX channel, which `ServerHost` already lends to the Mail server scoped to `com.apple.mail`. They select the sender's own text with AX text markers in the background, paste once with Mail briefly active, verify and save. The Node Mail server keeps tool schemas, send gates, Apple Events (opening composers, recipients, threading) and the System Events fallback, and calls the verbs instead of walking the caret. Closed drafts go through one rebuild path built from the saved emlx.

**Tech Stack:** Swift 6 (app, `swiftc` check scripts), TypeScript + vitest (`packages/mail`), JXA via the existing runner, macOS Accessibility (`AXTextMarker*`), `NSPasteboard`, `CGEvent`.

**Spec:** [docs/superpowers/specs/2026-10-25-native-mail-composer-design.md](../specs/2026-10-25-native-mail-composer-design.md). Spike and its measurements: [scripts/spike-mail-composer.swift](../../../scripts/spike-mail-composer.swift).

## Global Constraints

- Nothing reports a draft edited, saved or rebuilt unless that was **read back from Mail**.
- Never touch the quoted original (blocks with `AXBlockQuoteLevel` > 0), and never act on a composer other than the one addressed.
- Nothing is sent. Every path ends at a saved draft unless the existing `sendNow` + `confirm` gates say otherwise.
- The pasteboard is restored **every item and every type**, and the app that was frontmost gets the front back.
- Never move the person's viewer or message list. No `message://`, no `M.open` on drafts.
- The new verbs are answered **only** on the channel lent to Mail (`scope == .only(["com.apple.mail"])`), never listed in `tools/list`, and refused with writes off.
- Refusals keep the existing shape: `{ replaced: false, degraded: true, method, capability, reason, hint }`.
- A server started without Cupertino (npm, `CUPERTINO_AX_SOCKET` unset) behaves exactly as today: the System Events path and `UPDATE_DRAFT` are untouched.
- Olivier's calls: a full `body` over own text holding files or inline images is **refused, naming them**. A closed draft with formatting is **refused** if HTML paste does not hold.
- Swift passes `make format-swift-check`. Mail package passes `pnpm --filter @mgcrea/mcp-apple-mail test` and `typecheck`.
- Live Mail runs (Tasks 1 and 10) need Olivier's go first. Say what moves on screen and wait (memory: ask-before-live-driving).

## Review Focus

1. **The person types in the composer between selection and paste.** The read-back differs from the expected text, so the edit is not saved and the refusal says the window holds unverified text. Pinned in Task 4.
2. **The composer closes, or Mail quits, between listing and editing.** A dead handle gets a `composer` refusal that names the window as gone. It never acts on whichever window took its place. Pinned in Task 3.
3. **Non-ASCII text** (`Désolé — ça marche`, an emoji) round-trips byte-exact through the native pasteboard. That is the 2026-09 MacRoman bug class. Pinned in Task 4.
4. **A `find` spanning two paragraphs**, or differing from the window only in line breaks, matches once under whitespace-insensitive matching. Pinned in Task 2.
5. **The person was in another app.** After the edit the front returns to that app, not to Mail, including when the edit refuses midway. Pinned in Task 4.

---

### Task 1: Measure the two open questions (live, needs Olivier's go)

**Files:**

- Modify: `scripts/spike-mail-composer.swift`

**Interfaces:**

- Produces: two recorded answers in the spike's header that decide Task 2 (`edits` mode) and Task 8 (formatted rebuild): `SUBBLOCK = yes|no` and `HTML_PASTE = yes|no`.

- [ ] **Step 1: Add `--select-text FIND`.** Locate `FIND` in the own range's string, convert its character offsets to markers with `AXTextMarkerForIndex`, check them with `AXIndexForTextMarker`, build the range with `AXTextMarkerRangeCreate`, set `AXSelectedTextMarkerRange`, and print what `AXStringForTextMarkerRange` reads back for the selection.
- [ ] **Step 2: Add `--paste-html FILE`.** Same as `--replace`, but write the file to the pasteboard as `.html` plus a `.string` fallback.
- [ ] **Step 3: Ask Olivier for a go.** Say: one reply draft to his own address, Mail forward about 4 times, under a minute. Run against a fresh reply to "cupertino quote probe 1103" (Trash, own address):
  - `--select-text "ALPHA two"`, then `--replace "BETA"` with `--activate --save`.
  - Read the saved draft. Expect `"SPIKE ALPHA one\nSPIKE BETA"`, quote intact.
  - `--paste-html` with `<div>Plain <b>bold</b> <a href="https://example.com">link</a></div>`, then `--save`.
  - Read the saved source. Expect `<b>` and `<a>` in the HTML part, and no `blockquote` around the pasted text.
  - Between two of those saves, read `X-Universally-Unique-Identifier` from the saved source and record whether it stayed the same. Nothing in this plan depends on the answer. It only decides whether a later change can address saved drafts by it.
- [ ] **Step 4: Clean up.** Delete the test draft and close its window, as in the first run.
- [ ] **Step 5: Record the readings** under a `## RUN 2 2026-10-…` heading and commit.

```bash
git add scripts/spike-mail-composer.swift
git commit -m "test(mail): measure sub-paragraph selection and HTML paste in the composer"
```

### Task 2: Edit matching, pure Swift

**Files:**

- Create: `apps/apple/Cupertino/MailComposerText.swift`
- Create: `scripts/mail-composer-check.swift`
- Modify: `Makefile`: add a `mail-composer-check` target compiling the two files above (plus later tasks' files) and add it to the aggregate check list beside `desktop-check`.

**Interfaces:**

- Produces:
  - `nonisolated enum MailComposerText`.
  - `struct Edit: Equatable { let find: String; let replace: String }`.
  - `enum Matched: Equatable { case ok(result: String, matches: [Range<String.Index>]); case notFound(find: String); case ambiguous(find: String, count: Int); case overlapping }`. `matches` index the original `own`, in edit order.
  - `static func apply(_ edits: [Edit], to own: String) -> Matched`. Matching folds every whitespace run, newlines included, to one space on both sides. Ranges map back to the **original** `own` string. Edits are applied right to left.
  - `static func sameQuote(_ a: String, _ b: String) -> Bool`, comparing whitespace-folded strings.

- [ ] **Step 1: Write the failing checks** in `scripts/mail-composer-check.swift`, using `desktop-check.swift`'s `check(_:_:)` style:
  - `apply([Edit(find: "two", replace: "2")], to: "one\ntwo")` gives `.ok` with `result` "one\n2".
  - `apply([Edit(find: "one two", replace: "x")], to: "one\ntwo")` gives `.ok` with `result` "x". This is the cross-paragraph case (Review Focus 4).
  - `apply([Edit(find: "a", replace: "b")], to: "a a")` gives `.ambiguous(find: "a", count: 2)`.
  - `apply([Edit(find: "z", replace: "b")], to: "a")` gives `.notFound(find: "z")`.
  - Two edits whose matches overlap give `.overlapping`.
  - `apply([Edit(find: "ça", replace: "ok")], to: "Désolé — ça marche")` gives `.ok` with `result` "Désolé — ok marche".
  - `sameQuote("On 22 Oct, X wrote:\nHi", "On 22 Oct, X wrote: Hi")` is true.
- [ ] **Step 2: Run `make mail-composer-check`.** Expected: compile FAIL, `MailComposerText` not found.
- [ ] **Step 3: Implement `MailComposerText`** with the signatures above.
- [ ] **Step 4: Run `make mail-composer-check`.** Expected: all checks pass, 0 failures.
- [ ] **Step 5: Commit.**

```bash
git add apps/apple/Cupertino/MailComposerText.swift scripts/mail-composer-check.swift Makefile
git commit -m "feat(app): match draft edits once each, ignoring line breaks"
```

### Task 3: Composer registry and the list verb

**Files:**

- Create: `apps/apple/Cupertino/MailComposer.swift`
- Modify: `apps/apple/Cupertino/DesktopServer.swift`. In `call(...)`, add the two cases below, answered only when `scope == .only(["com.apple.mail"])` and otherwise refused as an unknown tool. They are never added to `tools(...)`. Add `apple_desktop_mail_composer_edit` to the `driving` list.
- Modify: `scripts/mail-composer-check.swift`, `Makefile` (add `MailComposer.swift` and DesktopServer's dependencies, as `desktop-check` lists them).

**Interfaces:**

- Produces:
  - `protocol ComposerWindow: AnyObject`. This is the seam the checks fake. Members:
    - `var subject: String { get }`;
    - `var recipientNames: [String] { get }`;
    - `func blocks() throws -> [ComposerBlock]`, where `struct ComposerBlock { let text: String; let quoteLevel: Int?; let fileNames: [String] }`;
    - `var isAlive: Bool { get }`.
  - `nonisolated enum MailComposer`:
    - `static func register(_ windows: [ComposerWindow]) -> [String]` mints handles `mc-<n>` and keeps existing ones for the same window, compared by identity (`CFEqual` on the `AXUIElement` in the live type).
    - `static func resolve(_ handle: String) -> ComposerWindow?` returns nil once the window is gone.
    - `static func listing(_ windows: [ComposerWindow]) -> [[String: Any]]`. Each entry is `composer` (handle), `subject`, `recipients`, `text` (own text, blocks joined with `\n`), `quoted` (Bool or NSNull when a level was unreadable), `files`.
  - `final class AXComposerWindow: ComposerWindow`, the live implementation, found by `Mail.subjectField` at depth 3 as in the spike. Recipients are read as `ax.ts` `listComposers` reads them.
  - Verb `apple_desktop_mail_composers` with no args returns `{ composers: [...] }`.

- [ ] **Step 1: Write the failing checks.**
  - With a fake of two windows titled the same, `listing` returns two entries with distinct handles.
  - Registering the same fake twice keeps its handle.
  - After the fake's `isAlive = false`, `resolve(handle)` is nil (Review Focus 2).
  - `DesktopServer.handle` with `scope: .brokered` and `apple_desktop_mail_composers` returns an error, and `tools/list` under every scope contains no `apple_desktop_mail_` name.
  - With writes off and the Mail scope, `apple_desktop_mail_composer_edit` is refused before reaching AX.
- [ ] **Step 2: Run `make mail-composer-check`.** Expected: FAIL to compile.
- [ ] **Step 3: Implement** the registry, the listing, `AXComposerWindow`, and the dispatch cases.
- [ ] **Step 4: Run** `make mail-composer-check desktop-check dispatch-check`. Expected: all pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/apple/Cupertino/MailComposer.swift apps/apple/Cupertino/DesktopServer.swift scripts/mail-composer-check.swift Makefile
git commit -m "feat(app): list Mail composers by handle on the channel lent to Mail"
```

### Task 4: The edit verb

**Files:**

- Modify: `apps/apple/Cupertino/MailComposer.swift`, `apps/apple/Cupertino/DesktopServer.swift`, `scripts/mail-composer-check.swift`

**Interfaces:**

- Consumes: `MailComposerText.apply`, `MailComposer.resolve`, `ComposerWindow`.
- Produces:
  - Extend `ComposerWindow` with the steps the sequence needs:
    - `func ownRangeText() throws -> String?`, the marker-range string;
    - `func selectOwn() throws -> Bool`;
    - `func selectSubrange(_ range: Range<String.Index>, in own: String) throws -> Bool`, used only when Task 1 found `SUBBLOCK = yes`;
    - `func activateAndPaste(_ content: PasteContent) throws -> Bool`, where `enum PasteContent { case text(String); case html(String, fallback: String); case files([URL]) }`;
    - `func save() throws -> SaveOutcome` (`.pressed`, `.gone`, `.refused`).
  - `protocol Pasteboard { func snapshot() -> Any; func restore(_: Any); func write(_ c: PasteContent) }`, with a live `NSPasteboard` version that keeps every item and type.
  - `protocol Front { func current() -> pid_t?; func give(to: pid_t?) }`.
  - `static func edit(_ w: ComposerWindow, request: EditRequest, board: Pasteboard, front: Front, readbackTimeout: TimeInterval = 5) -> [String: Any]`, where `struct EditRequest { var body: String?; var html: String?; var edits: [MailComposerText.Edit]?; var files: [URL]; var save: Bool }`.
  - Results:
    - success `{ replaced: true, method: "inPlace", text: <own text read back>, quoteKept: Bool, filesAdded: [String], saved: Bool }`;
    - otherwise the refusal shape with `capability` set to `composer` (gone or unfocusable), `identity`, `files` (Olivier's call), `edits` (not found, ambiguous or overlapping, with `find` echoed), `selection` or `confirmation`.
  - Verb `apple_desktop_mail_composer_edit` takes args `composer`, `body?`, `html?`, `edits?: [{find, replace}]`, `attachments?: [path]`, `save?` (default true), `expectHead?` (120 chars to match before acting, the old `sameDraft`).
- Sequence, in order, with every check before anything destructive:
  1. resolve;
  2. read blocks and require quote levels to be readable;
  3. `expectHead` (whitespace-folded);
  4. for `body` over own text holding files, refuse;
  5. compute the new text, or the sub-ranges for `edits`;
  6. `ownRangeText == own text`;
  7. select;
  8. snapshot the board and note the front;
  9. activate and paste;
  10. poll the read-back until the new own text matches and the quote is still present;
  11. paste files and verify their names appear in own blocks;
  12. save;
  13. restore the board and give the front back. Step 13 runs on every exit path after step 8.
  - Without `SUBBLOCK`, `edits` repaste the whole own text, and are refused as `capability: "edits"` when own text holds files or formatting (any block whose attributed string carries a link or bold run).

- [ ] **Step 1: Write the failing checks** against a fake window, board and front:
  - Replaces own text and leaves the quote. Expect `saved: true` and `quoteKept: true`.
  - The read-back differs, because the fake mutates the text during paste: refused as `confirmation`, `save()` never called (Review Focus 1).
  - Body `"Désolé — ça marche 👍"` reads back equal (Review Focus 3).
  - The front was another app: after success and after a refusal at step 10, `front.give` was called with the original pid (Review Focus 5).
  - The board is restored on success and on every refusal after step 8.
  - A body over own text with `fileNames: ["a.pdf"]` is refused as `capability: "files"` with `a.pdf` in `reason`, and nothing is pasted.
  - Edits `notFound` and `ambiguous` are refused as `capability: "edits"`, nothing pasted.
  - `expectHead` mismatch is refused as `identity`, nothing pasted.
  - The quote is gone after the paste: refused as `confirmation`, not saved.
- [ ] **Step 2: Run `make mail-composer-check`.** Expected: FAIL.
- [ ] **Step 3: Implement** `edit`, the live `AXComposerWindow` methods (spike calls: `AXTextMarkerRangeForUIElement`, `AXTextMarkerRangeCopyStartMarker`/`CopyEndMarker`, `AXTextMarkerRangeCreate`, `AXSelectedTextMarkerRange`, activate plus a `.cghidEventTap` ⌘V / ⌘S), the live board, front, and the dispatch case. Driving goes through the existing `DrivingSession` admission like every other driving verb.
- [ ] **Step 4: Run** `make mail-composer-check desktop-check format-swift-check`. Expected: all pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/apple/Cupertino/MailComposer.swift apps/apple/Cupertino/DesktopServer.swift scripts/mail-composer-check.swift
git commit -m "feat(app): edit a Mail composer in one verified native step"
```

### Task 5: Node lane calls the verbs, in-place edits use them

**Files:**

- Modify: `packages/mail/src/client/ax.ts`. Add the two methods below and keep the old composer methods until Task 6 removes their last callers.
- Modify: `packages/mail/src/client/revise.ts`. `reviseDraftInPlace` becomes find-by-content plus one `editComposer` call. Delete `selectOwnText`, `awaitCopy`, `awaitOwnText` and the clipboard borrowing.
- Modify: `packages/mail/test/revise.test.ts`. The fake channel answers `apple_desktop_mail_composers` and `apple_desktop_mail_composer_edit`. Drop the keystroke-walk cases.

**Interfaces:**

- Produces in `MailAxLane`:
  - `composers(): Promise<NativeComposer[]>`, where `type NativeComposer = { composer: string; subject: string; recipients: string[]; text: string; quoted: boolean | null; files: string[] }`.
  - `editComposer(args: { composer: string; body?: string; html?: string; edits?: { find: string; replace: string }[]; attachments?: string[]; save?: boolean; expectHead?: string }): Promise<Record<string, unknown>>`. It returns the verb's JSON verbatim.
- `reviseDraftInPlace(lane, facts, opts)` keeps its signature, plus `opts.edits` and `opts.composer`. Null still means "no composer open".
  - With `opts.composer`, edit that handle.
  - Otherwise the candidates are composers whose `subject === facts.subject` and whose text matches `facts.contentHead`. Exactly one is used, none gives null, and several give the existing `identity` refusal reworded as "several windows hold this draft's text".

- [ ] **Step 1: Write the failing tests** in `revise.test.ts`:
  - "edits the one composer whose text matches when two share the subject". The edit call carries that handle.
  - "passes the native refusal through unchanged". The fake answers a `confirmation` refusal and the result deep-equals it.
  - "answers null when no composer matches".
  - "sends edits, not a body, when given edits".
- [ ] **Step 2: Run** `pnpm --filter @mgcrea/mcp-apple-mail test -- revise`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @mgcrea/mcp-apple-mail test && pnpm --filter @mgcrea/mcp-apple-mail typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/mail/src/client/ax.ts packages/mail/src/client/revise.ts packages/mail/test/revise.test.ts
git commit -m "refactor(mail): edit drafts through the native composer verb"
```

### Task 6: Composing fills through the verb

**Files:**

- Modify: `packages/mail/src/client/compose.ts`. In `composeNatively`, keep `OPEN_COMPOSER`. Take `composers()` before and after, so the new composer is the handle absent before (polled up to `COMPOSER_TIMEOUT_MS`). Fill with `editComposer({ composer, body, attachments, save: !sendNow })`. Keep `sentVerdict` and the send shortcut path for `sendNow`.
- Delete from `compose.ts`: the "already open under this title" refusals, `paste`, `awaitBody`, `awaitFiles`, `pasteFiles` and the clipboard borrowing. Then delete the now-unused composer methods in `ax.ts`.
- Modify: `packages/mail/test/compose.test.ts`, `packages/mail/test/open-composer.test.ts`

**Interfaces:**

- Consumes: `MailAxLane.composers`, `MailAxLane.editComposer`.
- `ComposeResult` keeps its fields. `bodyVerified` comes from the verb's read-back `text`.

- [ ] **Step 1: Write the failing tests.**
  - "fills the new composer when one with the same subject was already open". The edit targets the handle that appeared.
  - "reports no composer when none appears within the timeout", with the existing note text kept.
  - "a sendNow compose still waits for the Sent verdict".
- [ ] **Step 2: Run** `pnpm --filter @mgcrea/mcp-apple-mail test -- compose open-composer`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full package test and typecheck. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/mail/src/client/compose.ts packages/mail/src/client/ax.ts packages/mail/test/compose.test.ts packages/mail/test/open-composer.test.ts
git commit -m "feat(mail): fill new composers natively and stop refusing a shared subject"
```

### Task 7: Tool surface

**Files:**

- Modify: `packages/mail/src/tools/compose.ts`. Add to `apple_mail_update_draft`:
  - `edits`: an array of `{ find: string.min(1), replace: string }`, max 50, mutually exclusive with `body`;
  - `composer`: a string.

  Make `ref` optional. Rewrite the description: drop the paragraphs explaining recreate refusals that no longer exist, and keep the "REFUSES rather than doing damage" contract.

- Modify: `packages/mail/src/client/mail.ts`. `updateDraft(target: { ref?: string; composer?: string }, opts: { body?; edits?; subject?; attachments? })`:
  - with neither `ref` nor `composer`, use the single open composer, or refuse when there are zero or several and list their subjects and handles;
  - with `composer`, go straight to the native edit;
  - with `ref`, as today, then route B (Task 8).
- Modify: `listOpenDrafts` so each draft carries `composer` (handle), from `composers()`.
- Modify: `packages/mail/test/update-draft.test.ts`, `packages/mail/test/tools.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - The schema rejects `body` together with `edits`.
  - No target with one open composer edits it.
  - No target with two refuses, naming both handles.
  - `list_open_drafts` entries carry `composer`.
- [ ] **Step 2: Run** the package tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the package tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/mail/src/tools/compose.ts packages/mail/src/client/mail.ts packages/mail/test/update-draft.test.ts packages/mail/test/tools.test.ts
git commit -m "feat(mail): edit a draft by find and replace, by composer handle or the one open"
```

### Task 8: Rebuild a closed draft (route B)

**Files:**

- Create: `packages/mail/src/client/rebuild.ts`
- Modify: `packages/mail/src/client/envelope.ts`. Add `findByMessageIdHeader(header: string): Promise<string | null>`, which returns a ref, using `message_global_data.message_id_header` (`schema.ts` already detects the column as `messageIdHeader`). It returns null when the column is absent.
- Modify: `packages/mail/src/client/jxa/write.ts`. `OPEN_COMPOSER` accepts `recipients?: { to; cc; bcc }` and `subject?` overrides, applied to the outgoing message before its window is shown.
- Modify: `packages/mail/src/client/mail.ts`. `updateDraft` with `ref` and no matching composer calls `rebuildDraft`, which replaces `#recreateNatively`. Delete `STAGE_REPLACEMENT` and keep `COMMIT_REPLACEMENT`'s confirm-then-delete.
- Create: `packages/mail/test/rebuild.test.ts`
- Create: `packages/mail/src/client/edits.ts` (`applyEdits(edits, own)`: the TS twin of `MailComposerText.apply`, same matching rules) and `packages/mail/test/edits.test.ts` (Task 2's seven cases, ported). Write and pass these first.

**Interfaces:**

- Consumes: `editComposer({ html | body, edits, attachments })`, `composers()`, `MailComposerText` semantics (the Node side reuses a TS port, `applyEdits`, only to build the HTML-free plain case). `emlx.ts`/`mime.ts` parse the draft.
- Produces: `rebuildDraft(deps, target, opts): Promise<Record<string, unknown>>` in `rebuild.ts`. Steps, each refusing with the shape and leaving the original untouched:
  1. **Preflight.**
     - Refuse if any open composer's subject equals the draft's, naming it (_"close that window first"_).
     - Refuse if not in Drafts.
     - Refuse if the draft is a forward. A forward has no `In-Reply-To` but a subject starting with a localised forward prefix. To be safe, treat any draft with `References` and no `In-Reply-To` as a forward and refuse.
  2. **Parse the saved draft.** Take recipients, subject and `In-Reply-To` from the headers. The **own HTML** is the HTML part's body content before `<div class="AppleOriginalContents"`; the whole body when that div is absent. The **old quote text** is everything from that div, as text. Attachments are written to `mkdtemp(join(tmpdir(), "cupertino-rebuild-"))`.
  3. **Formatting.** If Task 1 found `HTML_PASTE = no` and the own HTML has any tag other than `div`, `br`, `p` or `span` without style, refuse as `capability: "formatting"` (Olivier's call).
  4. **Open the new composer.**
     - For a reply: `findByMessageIdHeader(In-Reply-To)`, refusing if not found, then `OPEN_COMPOSER` with `mode: "reply"`, the original's ref, and the recipient and subject overrides.
     - Otherwise: `OPEN_COMPOSER` with `mode: "new"`.

     The new handle is the one that appears, as in Task 6.

  5. **Compare quotes.** `sameQuote(new composer quote, old quote text)`, or refuse with `capability: "quote"`. The new composer stays open and the refusal says to close it without saving.
  6. **Fill.** `editComposer` with `html` (own HTML with `edits` applied to its text nodes) or `body`, plus the extracted attachments, `save: true`.
  7. **Commit.** Confirm the new draft in Drafts by `In-Reply-To` (or subject) plus content head, then delete the original. If it can't be confirmed, keep both and say "two drafts now exist".
  8. **Clean up.** Remove the temp directory on every exit path.

- [ ] **Step 1: Write the failing tests** with a fixture emlx: copy the shape of the spike's saved draft source (headers `In-Reply-To`, `References`, `X-Uniform-Type-Identifier: com.apple.mail-draft`, the `AppleOriginalContents` div) into `packages/mail/test/fixtures/reply-draft.emlx`.
  - "rebuilds a closed reply draft as a reply to its original, with its recipients". This asserts the `OPEN_COMPOSER` args and the commit order (edit before delete).
  - "refuses while a composer with the same subject is open".
  - "refuses when the regenerated quote differs", and the original is not deleted.
  - "refuses a forward draft".
  - "re-attaches the draft's own attachments and removes the temp directory".
  - "keeps both drafts and says so when the new one cannot be confirmed".
  - "applies edits to the own HTML's text, not its tags".
- [ ] **Step 2: Run** `pnpm --filter @mgcrea/mcp-apple-mail test -- rebuild`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full package tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/mail/src/client/rebuild.ts packages/mail/src/client/envelope.ts packages/mail/src/client/jxa/write.ts packages/mail/src/client/mail.ts packages/mail/test/rebuild.test.ts packages/mail/test/fixtures/reply-draft.emlx
git add packages/mail/src/client/edits.ts packages/mail/test/edits.test.ts
git commit -m "feat(mail): rebuild a closed draft as a reply to its original, files and all"
```

### Task 9: Missing Accessibility is named once, and shown in the app

**Files:**

- Modify: `packages/mail/src/client/ax.ts`. `MailAxLane.grantMessage(mode)` returns one text for every mode, starting "Cupertino needs Accessibility to write Mail drafts." and naming System Settings › Privacy & Security › Accessibility. Every draft refusal with `capability: "accessibility"` uses it.
- Modify: `apps/apple/Cupertino/Permissions.swift` and the view that renders permission rows. When the Mail surface has writes on and `AccessibilityStatus` is not granted, show the row with the message _"Mail drafts need Accessibility."_ and the existing `openAccessibilitySettings()` button.
- Modify: `packages/mail/test/accessibility.test.ts`

- [ ] **Step 1: Write the failing test.** Every compose and update entry point, with `reach().ok === false`, returns or throws exactly `grantMessage`'s text.
- [ ] **Step 2: Run** the package tests. Expected: FAIL.
- [ ] **Step 3: Implement** both halves. Build the app with `make app`.
- [ ] **Step 4: Run** the package tests and `make format-swift-check`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/mail/src/client/ax.ts packages/mail/test/accessibility.test.ts apps/apple/Cupertino/Permissions.swift
git commit -m "feat(mail): say once that drafts need Accessibility, in the tool and the app"
```

### Task 10: Live verification, docs, changelog (live, needs Olivier's go)

**Files:**

- Modify: `scripts/verify-mail-ax.mjs`. Under `--compose`, add cases against drafts addressed to the user's own account, as the existing forward case is:
  1. `update_draft` with `edits` on the open forward;
  2. two composers under one subject, the right one edited;
  3. close the forward, reply-draft a self-sent message, close it, `update_draft` by `ref` rebuilds it, and the saved source keeps `In-Reply-To`;
  4. a rebuild refused when the quote was edited by hand. Skip this one: it needs a person, so print it as manual.

  Clean every draft up.

- Modify: `docs/mail-compose.md`. Add a dated section, _"The composer moved into the app"_: what the spike measured, the verbs, route B. Amend "Still open" accordingly.
- Modify: `CHANGELOG.md`, under Unreleased, in the house style: one bold sentence per user-visible change. Use no em dashes in new copy: rewrite as sentences or parentheses (see the `humanize-ui-copy` skill).

- [ ] **Step 1: Run the non-live gates.**
  - `make app mail-composer-check desktop-check dispatch-check format-swift-check`
  - `pnpm --filter @mgcrea/mcp-apple-mail test`
  - `pnpm --filter @mgcrea/mcp-apple-mail typecheck`

  Expected: all pass.

- [ ] **Step 2: Ask Olivier for a go.** Run `node scripts/verify-mail-ax.mjs --compose` against the Debug build (see the `use-the-dev-build` skill). Expected: every case PASS, and no draft left in Drafts with the test subjects.
- [ ] **Step 3: Write the docs and changelog.**
- [ ] **Step 4: Commit.**

```bash
git add scripts/verify-mail-ax.mjs docs/mail-compose.md CHANGELOG.md
git commit -m "docs(mail): record the native composer and verify it live"
```
