# Background input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive Mac apps without taking the person's focus: Cupertino types into a field in a background app, and our own Debug builds take clicks, drags, hovers and shortcuts through an in-app channel.

**Architecture:** Part 1 is Cupertino only. `apple_desktop_type` with a handle focuses the field through Accessibility, posts the text to the app's process with `CGEvent.postToPid`, and reads the field's value back. It falls back to today's bring-forward path only when nothing landed. Part 2 adds a `SupportKitDriving` product to swift-support-kit. It is compiled in Debug only and listens only when launched with `-DrivingChannel YES`. It reads JSON-line commands from a file in the app's own temporary directory and delivers them to its windows as `NSEvent`s with `NSWindow.sendEvent`. Cupertino finds that channel by pid and routes click, drag, hover, key and type through it. Verbs that cannot take the focus open the driving session without the countdown.

**Tech Stack:** Swift 6, AppKit, ApplicationServices (AX, CGEvent); swiftc-compiled checks (`make unit`, `make desktop-check`); swift-support-kit uses SwiftPM and Swift Testing.

**Spec:** the measured findings in `scripts/spike-background-input.swift` (header), and the design approved in conversation on 2026-11-11, summarised here:

- Posted from another process, keys land in a background app (AppKit, SwiftUI via `AXFocused`, TextEdit), and the window does not need to be key. Shortcuts (Cmd-A, Cmd-V) are ignored. Clicks arrive and do nothing.
- In-process `NSWindow.sendEvent` keys and clicks all land without activation, and so does `NSApp.postEvent`. An `NSButton` click needs its mouse-up queued first.
- A verb that does not take focus still opens the session (the orange card), but skips the countdown or the question. A recent no still refuses it.
- The in-app driver is Debug-only (`#if DEBUG`), listens only on a launch argument, and is never linked into Cupertino.

## Global Constraints

- Cupertino checks are compiled with `swiftc` from file lists in the `Makefile`. A new dependency-free file joins the `unit` list, and an AppKit file joins the Xcode target.
- Committed scripts and Makefile lines must work with BSD tools.
- swift-support-kit: platform floor macOS 26 / iOS 26; the new product is macOS-only code wrapped in `#if os(macOS)`; no resources and no catalog (it draws nothing); tests use Swift Testing (`import Testing`, `@Suite`, `@Test`, `#expect`).
- Coordinates on the wire are global display points with a top-left origin, the space every Cupertino tool already uses.
- Nothing is pushed or tagged without Olivier's go. swift-support-kit's release and Armada's adoption are a separate step (Task 8).

## Review Focus

1. **A secure text field**: its value reads empty or bullets, so a background type would look as if nothing landed and be typed a second time by the fallback. Expected: never typed in the background; it goes straight to today's path (Task 3 test: subrole `AXSecureTextField` routes to the foreground).
2. **A field that already contains the text** (typing "abc" into "abc"): the before and after values differ but `before` already contained the text. Expected: the verdict compares the values, not containment alone (Task 2 test `appended to identical text`).
3. **Partial landing**: some chunks land, then one does not (for example a field with a max length). Expected: no fallback, because that would type twice. The answer says `verified: false` (Task 2 test).
4. **A channel left over from a dead process**: the pid was reused, or the app crashed. Expected: the channel is ignored unless its pid is alive and is the owner's pid (Task 7 test).
5. **A channel command that never gets an ack** (app hung, or a modal tracking loop): expected, a refusal that names the timeout and the verb, never a hang (Task 7 test with a 2 s ack timeout).

---

## Part 1: Cupertino types without activating

### Task 1: Background admission

**Files:**

- Modify: `apps/apple/Cupertino/DrivingPolicy.swift` (`decide`)
- Modify: `apps/apple/Cupertino/DrivingSession.swift` (`admit`)
- Test: `scripts/unit-check.swift` (Driving policy block)

**Interfaces:**

- Produces: `DrivingPolicy.decide(_:secondsSinceInput:declinedUntil:now:background: Bool = false) -> Decision`, and `DrivingSession.admit(_ target: String, background: Bool = false, settings:secondsSinceInput:)`.

- [ ] Step 1: Add the failing checks: `decide(counting, idle: 0.5, background: true) == .open`; `decide(asking, idle: 0, background: true) == .open`; `decide(counting, idle: 0, declinedUntil: noon+10, background: true) == .declined(retryIn: 10)`.
- [ ] Step 2: `make unit` fails to compile (no `background:` label).
- [ ] Step 3: Add the parameter. A decline still returns first; `background` then returns `.open` before the active-window check. Thread it through `admit` to its one `decide` call. Doc comment: why skipping is safe (an event to a pid cannot land in the person's sentence) and why the card still shows.
- [ ] Step 4: `make unit` passes.
- [ ] Step 5: Commit `feat(desktop): a verb that cannot take the focus opens the session without a countdown`.

### Task 2: The verdict on a background type

**Files:**

- Create: `apps/apple/Cupertino/BackgroundTyping.swift` (Foundation only)
- Modify: `Makefile` (`unit` list), and the Xcode project (target membership)
- Test: `scripts/unit-check.swift`

**Interfaces:**

- Produces: `nonisolated enum BackgroundTyping { enum Verdict: Equatable { case landed(verified: Bool), nothingLanded }; static func verdict(before: String, after: String, typed: String) -> Verdict; static func eligible(role: String?, subrole: String?, value: Any?) -> Bool }`.

- [ ] Step 1: Failing checks:
  - `verdict(before: "", after: "abc", typed: "abc") == .landed(verified: true)`
  - `verdict(before: "x", after: "xabc", typed: "abc") == .landed(verified: true)`
  - `verdict(before: "abc", after: "abcabc", typed: "abc") == .landed(verified: true)` (appended to identical text)
  - `verdict(before: "abc", after: "abc", typed: "abc") == .nothingLanded`
  - `verdict(before: "", after: "ab", typed: "abcdef") == .landed(verified: false)` (partial)
  - `eligible(role: "AXTextField", subrole: "AXSecureTextField", value: "") == false`
  - `eligible(role: "AXTextArea", subrole: nil, value: "hi") == true`
  - `eligible(role: "AXWebArea", subrole: nil, value: nil) == false` (no string value to read back)
- [ ] Step 2: `make unit` fails.
- [ ] Step 3: Implement. `landed` when `after != before`. It is `verified` when `after` contains `typed` at least once more than `before` does, counted with non-overlapping occurrences. `eligible` requires a `String` value and a subrole other than `AXSecureTextField`.
- [ ] Step 4: `make unit` passes.
- [ ] Step 5: Commit `feat(desktop): decide whether text typed into a background field landed`.

### Task 3: `apple_desktop_type` types in the background

**Files:**

- Modify: `apps/apple/Cupertino/AccessibilityDriver.swift`: add `typeInBackground` beside `type(text:)`
- Modify: `apps/apple/Cupertino/DesktopServer.swift`: the `apple_desktop_type` case and its description

**Interfaces:**

- Consumes: `DrivingSession.admit(_:background:)` (Task 1), `BackgroundTyping` (Task 2).
- Produces: `static func typeInBackground(text: String, handle: String, scope: Scope) throws -> BackgroundTyping.Verdict?`. Nil means not eligible, so nothing was posted and the caller takes today's path.

- [ ] Step 1: Implement `typeInBackground`:
  1. Resolve the handle's entry, then read role, subrole and `AXValue`. Not `eligible` → return nil.
  2. Admit with `background: true`, after the scope checks and before anything is posted, as `announce` does.
  3. Focus the element, using `focus`'s write and its `holdsFocus` read-back without its admission. If the focus did not take → return nil.
  4. Post the text with `postToPid`, in the same 20-character unicode chunks `type(text:)` uses, calling `checkStillDriving` between chunks and `DriveActivity.postedInput()` after each.
  5. Poll `AXValue` every 25 ms for up to 500 ms, until it differs from the value before. Return `BackgroundTyping.verdict`.
- [ ] Step 2: In the server's `apple_desktop_type`, when `handle` is given, call `typeInBackground` first:
  - `.landed(verified)` → answer `{typed, target, lane: "background", verified}`, with no `bringForward`.
  - `.nothingLanded` or nil → today's path, answering `lane: "foreground"`. The `.nothingLanded` case also says `background: "nothing landed"`.
  - Rewrite the description: with `handle`, the text goes into that field without bringing the app forward, and the field is read back. It is brought forward only when that did not land. A secure field always comes forward.
- [ ] Step 3: Build the Debug app (`make app` or the Xcode scheme the repo uses), then `make desktop-check` and `make unit`. All pass.
- [ ] Step 4: Commit `feat(desktop): type into a field without bringing its application forward`.

### Task 4: Measured live, and written down

**Files:**

- Modify: `docs/desktop.md`: a new dated section, "Typing without the front, 2026-11-11"
- Modify: `CHANGELOG.md`: an Unreleased entry
- Keep: `scripts/spike-background-input.swift` (its header holds the measurement)

- [ ] Step 1: Use the Debug bridge over stdio (memory: drive the installed bridge to test a new tool without a restart). `apple_desktop_launch` TextEdit behind, then `make new document`. Find the `AXTextArea` handle and `apple_desktop_type` "abc" with it. Expect `lane: "background"`, `verified: true`, and TextEdit not frontmost afterwards.
- [ ] Step 2: The same against a secure field if one is reachable without real credentials (the spike target with an `NSSecureTextField` added). Expect `lane: "foreground"`. Otherwise, record that it was not measured.
- [ ] Step 3: Write the docs section: the spike's table, the verdict rules, and what is not measured (Return/Tab/Escape, Electron, web areas, input methods). Add the CHANGELOG line.
- [ ] Step 4: Commit `docs(desktop): typing without the front, measured`.

## Part 2: `SupportKitDriving`, and Cupertino's channel

### Task 5: The command model (swift-support-kit)

**Files:**

- Modify: `Package.swift`: product and target `SupportKitDriving`, test target `SupportKitDrivingTests`, and a paragraph in the header comment saying why it is its own product (it posts input, Debug only)
- Create: `Sources/SupportKitDriving/DrivingCommand.swift`
- Test: `Tests/SupportKitDrivingTests/DrivingCommandTests.swift`

**Interfaces:**

- Produces: `public enum DrivingCommand: Equatable, Sendable`, with these cases:
  - `click(point: CGPoint, button: Button, count: Int)`
  - `drag(from: CGPoint, to: CGPoint, durationMs: Int)`
  - `hover(point: CGPoint, durationMs: Int)`
  - `scroll(point: CGPoint, dx: Double, dy: Double)`
  - `type(text: String)`
  - `key(name: String, modifiers: [Modifier])`

  Also `enum Button: String { left, right }`, `enum Modifier: String { command, shift, option, control }`, `struct Envelope { seq: Int; command: DrivingCommand }`, `static func parse(line: String) throws -> Envelope`, and `static func keyCode(_ name: String) -> UInt16?`. The key table holds the same position-only keys as Cupertino's `keyCodes`, plus a–z, 0–9 by US position for shortcuts, used only together with a modifier.

- Wire format: `{"seq":1,"verb":"click","x":10,"y":20,"button":"left","count":1}`. `drag` uses `from:[x,y]` and `to:[x,y]`; `key` uses `"key":"a","modifiers":["command"]`.

- [ ] Step 1: Tests: each verb parses from its wire line. A missing `seq` throws. An unknown verb throws an error whose message names the verb. An unknown modifier throws. `keyCode("return") == 36`, and `keyCode("a") == 0`.
- [ ] Step 2: `swift test --filter SupportKitDrivingTests` fails.
- [ ] Step 3: Implement with `JSONSerialization` (no Codable boilerplate for a six-case union).
- [ ] Step 4: Tests pass. Commit in swift-support-kit on branch `feat/driving`: `feat(SupportKitDriving): the command a driving channel carries`.

### Task 6: The channel and the event synthesis (swift-support-kit)

**Files:**

- Create: `Sources/SupportKitDriving/Driving.swift`: the public entry point
- Create: `Sources/SupportKitDriving/DrivingChannel.swift`: file transport
- Create: `Sources/SupportKitDriving/EventSynthesis.swift`: `NSEvent` building and delivery
- Test: `Tests/SupportKitDrivingTests/WindowPickTests.swift`

**Interfaces:**

- Produces:
  - `@MainActor public final class Driving { public static func startIfRequested() -> Driving? }`. In a non-DEBUG build the body is `return nil` and nothing else compiles in.
  - The channel directory: `<NSTemporaryDirectory()>/SupportKitDriving/<pid>/`, holding `commands.jsonl` (Cupertino appends) and `events.jsonl` (the app appends).
  - The events: `{"kind":"ready","pid":N,"version":1}`, `{"kind":"ack","seq":n,"hit":"<class>","identifier":"<id or empty>","responder":"<class>"}`, and `{"kind":"error","seq":n,"message":"…"}`.
  - The pure helper `static func pickWindow(at: CGPoint, frames: [(number: Int, frame: CGRect)]) -> Int?`. The frames come front to back in Cocoa coordinates, and the point is already flipped.
- Delivery rules, from the spike:
  - Point verbs hit-test the app's own `NSApp.orderedWindows`, so a window covered by another app still takes the click. A miss is an `error`: "no window of this app at (x, y)".
  - Click: queue the up with `NSApp.postEvent(atStart: false)`, then `sendEvent` the down.
  - Key with modifiers: try `NSApp.mainMenu?.performKeyEquivalent(with:)` first, then the window's `performKeyEquivalent`, then `sendEvent`.
  - Type: `sendEvent` a keyDown/keyUp per grapheme to `NSApp.keyWindow ?? NSApp.mainWindow ?? orderedWindows.first(where: \.isVisible)`.
  - Hover: `mouseMoved` events in 24 steps over `durationMs`.
  - Drag: a down, then `leftMouseDragged` steps, then the up, all delivered with `sendEvent`.
  - The ack is written one run-loop turn after the effect, as `AppShotCues` does. Polled every 10 ms.

- [ ] Step 1: Window-pick tests: the front window wins when windows overlap; a point outside every frame gives nil; a point on an edge is inside.
- [ ] Step 2: Tests fail. Implement the three files. `swift build` must pass for macOS; iOS builds an empty module.
- [ ] Step 3: Tests pass. Also add a check that a Release build compiles the type to nothing: `swift build -c release`, then `nm` on the object shows no `DrivingChannel` symbol.
- [ ] Step 4: Commit `feat(SupportKitDriving): drive a Debug build through its own windows, with nothing posted to the session`.

### Task 7: Cupertino routes through the channel

**Files:**

- Create: `apps/apple/Cupertino/AppChannel.swift`: the client (find by pid, append command, wait for ack)
- Modify: `apps/apple/Cupertino/DesktopServer.swift`: `launch` takes `channel: Bool`; click, drag, hover, key and type look for a channel first
- Modify: `apps/apple/Cupertino/AccessibilityDriver.swift`: `launch(bundleId:scope:timeout:arguments:)`
- Create: `scripts/channel-fixture.swift`: a target app compiled with swift-support-kit's `SupportKitDriving` sources (`-DDEBUG`), with the spike target's controls
- Modify: `Makefile`: `channel-check` builds the fixture and drives it through `AppChannel`, posting nothing to the session
- Test: `scripts/channel-check.swift`

**Interfaces:**

- Consumes: the wire format and events from Tasks 5–6.
- Produces: `nonisolated struct AppChannel { static func find(pid: pid_t, bundleId: String) -> AppChannel?; func send(_ verb: [String: Any], timeout: TimeInterval = 2) throws -> [String: Any] }`.
  - `find` checks the container's `Data/tmp/SupportKitDriving/<pid>/` first, then this user's `NSTemporaryDirectory()`, and requires a `ready` event whose pid is alive and equals `pid`.

- [ ] Step 1: `channel-check` cases:
  - click an AppKit button and a SwiftUI button: ack, and the fixture counts 1;
  - type into a field: its value reads back;
  - Cmd-A: the selection covers the text;
  - a point outside the fixture's windows: error;
  - a stale channel directory whose pid is dead: `find` returns nil;
  - an ack that never comes (fixture told to stall): a refusal naming the 2 s timeout;
  - the session front pid never changes, read through AX across the run.
- [ ] Step 2: Implement `AppChannel`, the `launch` argument (`OpenConfiguration.arguments = ["-DrivingChannel", "YES"]`), and the routing. With a channel, a point verb skips `bringForward` and `requireOnWindow` (the app hit-tests its own windows) and admits with `background: true`. The answer gains `lane: "channel"` and the ack's `hit`. Without a channel, nothing changes.
- [ ] Step 3: `make channel-check`, `make desktop-check` and `make unit` pass. Build the Debug app.
- [ ] Step 4: Docs: a `docs/desktop.md` section "A channel into our own apps", and the tool descriptions for `launch` and the point verbs. Commit `feat(desktop): drive our own Debug builds through their channel, without the front`.

### Task 8 (needs Olivier's go): Release and adopt

- [ ] Push swift-support-kit's `feat/driving`, merge it, and tag a minor release.
- [ ] In Armada: bump the package, link `SupportKitDriving`, and call `Driving.startIfRequested()` at launch beside `AppShotCues.start`.
- [ ] Drive Armada's Debug build through Cupertino with `channel: true`, live.
