# macOS 27 Follow-ups Implementation Plan (Foundation Models, SDK deprecations, passwords probe)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS 27, a Chat pane conversation that outgrows the model's window should trim its oldest turns and retry, as it already does on macOS 26. Today it ends in a failure row. Also clear the two deprecation warnings the Xcode 27.1 SDK raises.

**Architecture:** One error classifier, in the file that already owns everything that touches `FoundationModels` (`ChatModelTool.swift`). It recognises an overflow under both the macOS 27 type (`LanguageModelError.contextSizeExceeded`) and the macOS 26 one (`LanguageModelSession.GenerationError.exceededContextWindowSize`). `ChatConversation.respond` asks the classifier instead of pattern-matching one type. The two deprecations are local renames.

**Tech Stack:** Swift 6.0, `MainActor` default isolation, `FoundationModels`, standalone `swiftc` check binaries (the Xcode project has no test target).

**Source:** `.idea/feature-scout/2026-10-24b.md` (Required changes 1 and 2) and `.idea/feature-scout/2026-10-24.md` (Required change 2, Task 5 here).

## Global Constraints

- Deployment target stays macOS 26.0. Anything that names `LanguageModelError` sits behind `if #available(macOS 27.0, *)`, and the `GenerationError` path stays as the macOS 26 fallback. Don't delete it.
- No behaviour change on macOS 26. The trim-and-retry runs at most once per question (`retrying`), exactly as now.
- `scripts/chat-check.swift` stays Foundation-only. Its header explains why (CI has no Apple Intelligence, and `ChatTools.swift` imports Foundation alone). The new check is a separate binary.
- Comment density and voice match the surrounding files: long "why" comments on every non-obvious decision.

## Evidence (why this is real, not inferred)

- Xcode 27.1 SDK, `FoundationModels.swiftinterface`: `LanguageModelSession.GenerationError` is `@available(macOS, introduced: 26.0, deprecated: 27.0)`. `exceededContextWindowSize` says "Use `LanguageModelError/contextSizeExceeded(_:)` instead". `LanguageModelError` is macOS 27.0+.
- Apple's `LanguageModelError` documentation: apps deploying to 26 should check `#available(macOS 27.0)` and cast to `LanguageModelError`, falling back to `GenerationError` below 27.
- **Measured 2026-10-24 on macOS 27.0.1 (26A434):** a probe built with `-target arm64-apple-macos26.0` overflowed a `LanguageModelSession` and printed `dynamic type: LanguageModelError`, `is GenerationError: false`. Task 1 Step 1 carries the probe.
- The compiler doesn't warn, because availability deprecations only fire at a deployment target of 27 or higher. `make chat-check` runs no model.
- On the same Mac, `SystemLanguageModel.default.contextSize` is **8192**. The SDK's back-deployed `contextSize` returns a hard-coded 4096 below 27 and asks the system on 27+.

## Review Focus

1. **macOS 27, overflow:** the classifier answers true for `LanguageModelError.contextSizeExceeded`, and `respond` trims and retries once. Test in Task 1.
2. **macOS 27, every other `LanguageModelError`** (`guardrailViolation`, `refusal`, `timeout`, …): answers false and reaches `fail`. Test in Task 1.
3. **macOS 26 path:** `GenerationError.exceededContextWindowSize` still answers true. Construct it in the check, inside `if #unavailable(macOS 27.0)` or unconditionally, since the type still exists on 27.
4. **A stopped turn:** cancellation still never writes a failure (`fail`'s guard). Unchanged code; read it once after the edit.

---

### Task 1: Recognise overflow under both error types

**Files:**

- Modify: `apps/apple/Cupertino/ChatModelTool.swift` (add the classifier)
- Modify: `apps/apple/Cupertino/ChatConversation.swift:497-509` (use it)
- Create: `scripts/chat-overflow-check.swift`
- Modify: `Makefile` (a `chat-overflow-check` target beside `chat-check` at `:418`)

**Interfaces:**

- Produces: `ChatModelTool.isContextOverflow(_ error: any Error) -> Bool`. It is `nonisolated` and makes no other decision. On macOS 27+ it first tries `error as? LanguageModelError` with `case .contextSizeExceeded`. Otherwise it tries `error as? LanguageModelSession.GenerationError` with `case .exceededContextWindowSize`.

- [ ] **Step 1: Reproduce.** On a macOS 27 Mac with Apple Intelligence on, build this as `probe.swift` in a scratch directory (`swiftc -parse-as-library -target arm64-apple-macos26.0 probe.swift -o probe && ./probe`). Expected: `LanguageModelError`. If it prints `GenerationError`, stop: the premise has changed.

  ```swift
  import FoundationModels

  @main struct Probe {
    static func main() async {
      let s = LanguageModelSession()
      do { _ = try await s.respond(to: String(repeating: "lorem ipsum dolor sit amet ", count: 4000)) }
      catch { print(type(of: error), error is LanguageModelSession.GenerationError) }
    }
  }
  ```
- [ ] **Step 2: Write the failing check.** `scripts/chat-overflow-check.swift`, in the same `check(label, condition)` style as `chat-check.swift`:
  - `LanguageModelError.contextSizeExceeded(.init(contextSize: 8192, tokenCount: 9000, debugDescription: "x"))` → true (macOS 27 only, inside `#available`).
  - `LanguageModelError.timeout(…)` or `.guardrailViolation(…)` → false. Build them from their public inits; check the interface for each one's fields.
  - `LanguageModelSession.GenerationError.exceededContextWindowSize(.init(debugDescription: "x"))` → true.
  - `GenerationError.guardrailViolation(.init(debugDescription: "x"))` → false.
  - `CancellationError()` → false.
- [ ] **Step 3: Run to verify it fails.** Compile it with `ChatModelTool.swift` plus whatever that file needs (`ChatTools.swift` at least; confirm by compiling). Expected: FAIL (`isContextOverflow` not found).
- [ ] **Step 4: Implement the classifier.** Put the "why" in its doc comment: the type changed under a 26.0 target with no warning, and the measurement.
- [ ] **Step 5: Use it in `respond`.** Replace the `catch let error as LanguageModelSession.GenerationError` arm with a general `catch` that asks `ChatModelTool.isContextOverflow(error)` under the same `!retrying, stamp == era, trimTranscript()` conditions, then falls through to `fail(error.localizedDescription, …)`. That leaves one `catch` instead of two.
- [ ] **Step 6: Run the check.** Expected: PASS. Then `make chat-check`, unchanged and still passing.
- [ ] **Step 7: Hand check (needs a person on a macOS 27 Mac with Apple Intelligence).** Open the Chat pane on Mail and ask questions that each pull a large tool result until the window fills. Before the fix: a failure row reading "The session's transcript exceeded the model's context size." After it: the trim note, and an answer.

### Task 2: Correct the 4096 comments

**Files:**

- Modify: `apps/apple/Cupertino/ChatConversation.swift:15,171`, `apps/apple/Cupertino/ChatTools.swift:95,335`

- [ ] **Step 1:** Each comment states 4096 as a fact. Make it "4096 on macOS 26, larger on some macOS 27 Macs (8192 measured 2026-10-24)". The arithmetic already scales (`ChatBudget.budget`, `ChatTools.swift:107`), so no code changes. `scripts/chat-check.swift:180-232` pins the 4096 case on purpose; leave it alone.
- [ ] **Step 2:** `DemoSeed` keeps 4096 (`ChatConversation.swift:41`). Screenshot plates must not depend on the Mac that takes them. No change.

### Task 3: `GenerationOptions(sampling:)` → `samplingMode:`

**Files:**

- Modify: `apps/apple/Cupertino/ChatConversation.swift:192-193`

- [ ] **Step 1:** Rename the label. `init(samplingMode:temperature:maximumResponseTokens:)` is `@available(macOS 26.0)` with `@backDeployed(before: macOS 27.0)`, so it needs no availability fence.
- [ ] **Step 2:** Run a clean build. Expected: the `#DeprecatedDeclaration` warning at `:192` is gone.

### Task 4: `String(cString:)` on `[CChar]`

**Files:**

- Modify: `apps/apple/Cupertino/AccessibilityDriver.swift:498`

- [ ] **Step 1:** Replace `String(cString: path)` with a decode that stops at the first NUL, as the deprecation message suggests:
  `String(decoding: path.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)`.
  This runs once per pid in `proc_listallpids`'s result, so the map's allocation is fine. Say so in a comment only if a reviewer asks.
- [ ] **Step 2:** `make desktop-check` (or whichever check covers the pid lookup) still passes. A clean build shows no `#DeprecatedDeclaration` warnings.

### Task 5: `probe:passwords` reads Full Disk Access from a file that macOS 27 deleted

**Source:** macOS 27 release notes, TCC: "Apps can no longer access the local TCC database directly. (90775556)". Shipped 2026-09-14. On this Mac, `~/Library/Application Support/com.apple.TCC/` does not exist. The app already handles this: `apps/apple/Cupertino/Permissions.swift:161-211` ("Gone on macOS 27"; the rule is `diskAccess()` at `:200`). The probe does not.

**Files:**

- Modify: `scripts/probe-passwords.mjs:82-102` (the oracle), and the three readers of `hasFda`: `:246`, `:255`, `:337`

**What is wrong today, on every macOS 27 Mac:** `readable(TCC_DB)` is false whatever the grant, so `hasFda` is always false. That breaks three things:

- The calibration line says "not granted".
- `findings.lanes.file.openedWithoutFda` is `true`, and the opened line says "WITHOUT full disk access". The probe's own conclusion rests on this claim.
- The closing "load-bearing line" says "NO full disk access" in a process that may hold it.

The comment at `:82` ("the one `Permissions.swift` uses") is no longer true either.

- [ ] **Step 1:** Port the app's rule as written. If `TCC_DB` exists, ask it. Otherwise, ask the first store that exists among `mail, messages, safari, notes, calendar` (`Permissions.swift:173-175`, the measured FDA-only list; not AddressBook). With no store at all, report `unknown` rather than `not granted`. Note that the morning report's "stat-free readability of a shipped store" means `readable()` from `scripts/lib/probe-kit.mjs:84`, which the probe already uses. Never `stat(2)`.
- [ ] **Step 2:** Say which oracle answered: `(oracle: TCC.db)` or `(oracle: Mail store, TCC.db gone on macOS 27)`. The output is evidence other docs cite, so make it name its source.
- [ ] **Step 3:** If the oracle is `unknown`, `openedWithoutFda` and the closing line must not claim either way. Use `null` in `--json`, and "full disk access unknown" in the text.
- [ ] **Step 4:** Re-run `pnpm probe:passwords` on macOS 27, once from a shell without the grant and once from one with it (the bridge, or a terminal that holds it). The two calibration lines must differ. Then check whether `docs/passwords.md` quotes a run taken on macOS 27. If it does, re-run it and update the quote.

### Task 6: Record it

- [ ] **Step 1:** CHANGELOG entry under Unreleased/Fixed: on macOS 27, a long Chat pane conversation now trims and carries on instead of stopping with "exceeded the model's context size". Keep it to the user-visible effect.
- [ ] **Step 2:** In `.idea/feature-scout/2026-10-24b.md`, nothing to edit. The next scout run reads this plan and the commit, and moves the item to standing context.

## Deviations from the report (planner's calls)

- The report said "add a branch before the existing one". This plan extracts a classifier instead, so the decision is testable without a model, and `ChatConversation` keeps one `catch`.
- `LanguageModelError.ContextSizeExceeded` carries `contextSize` and `tokenCount`, which could size the trim. Left out: `trimTranscript` already works, and sizing it is a separate change with its own behaviour.
