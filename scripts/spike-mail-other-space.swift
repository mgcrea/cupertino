import AppKit
import ApplicationServices
import Foundation

/// Spike: can a Mail composer on ANOTHER Space be found, read and written
/// without bringing Mail forward?
///
/// Why: `kAXWindows` and `AXChildren` list only the windows on the active Space.
/// With Mail full screen, or its composer on another desktop, the driver sees no
/// window at all, `list_open_drafts` says none is open, and a compose fails after
/// 8 s with "no such window was readable" (Maël Szabelski, 2026-11-02, reproduced
/// here the same day). Raising the window by its scripting id and then activating
/// Mail reaches it (measured live), but switches the person's desktop. This asks
/// whether native code can avoid the switch altogether.
///
///   1. **Find.** `_AXUIElementCreateWithRemoteToken` (private; the brute force
///      AltTab uses) builds an element from pid + element id. Does it reach the
///      windows `kAXWindows` hides? Does `_AXUIElementGetWindow` give each a
///      CGWindowID, and is that Mail's scripting `id`? Can the composer's subject
///      field, web area and quote boundary be read there?
///   2. **Write without a paste.** With Mail in the background, does setting
///      `AXSelectedTextMarkerRange` over the own text and then writing
///      `AXSelectedText` change the body? What insert/replace verbs does the web
///      area list at all?
///   3. **Keep.** Does Mail treat that write as an edit its autosave keeps?
///      (Measured outside this file, by reading the Drafts mailbox.)
///
/// ## RUN 2026-11-02, macOS 27, Mail's Inbox full screen on its own Space
///
/// Composer "Space probe 2", made by `make new outgoing message … visible:true`
/// with Mail in the background, no recipients, body "SPIKE ONE".
///
/// - **A composer made with Mail in the background opens on the ACTIVE Space**,
///   not on Mail's full-screen one: `kAXWindows` listed it, Mail stayed
///   inactive. So on this Mac a new composer is reachable; Maël's case needs more
///   than full screen (their Spaces or tabbing settings, unknown).
/// - **Its body is not in the AX tree until the window has been key once.** The
///   window's top `AXGroup` had no children: header fields, toolbar, no
///   `AXWebArea`, still none after more than a minute. After one
///   `set index … to 1` + `activate` and straight back, the web area was there
///   (8 blocks) and stayed with Mail in the background. Note `MailComposer.edit`
///   reads the body (steps 2–7) before it activates Mail (step 9).
/// - **Remote token finds windows `kAXWindows` hides.** With 0 public windows it
///   found the full-screen Inbox (element id 569) in 30 ms over ids 0..<1000; the
///   composer was element id 4012, so 0..<6000 took 109 ms and 0..<300000
///   3.5 s. Element ids grow with Mail's lifetime: the bound is a real cost.
///   `_AXUIElementGetWindow` gave 915 and 5561, **Mail's scripting window ids**.
/// - **A composer on another Space is found, read and written in place.** With
///   "Space probe 2" moved to another desktop by hand (`kAXWindows` 0, VS Code in
///   front), the token found it in 93 ms (`public=false`), its body read in full
///   (9 blocks), and an `AXTextOperation` replace ("SPIKE THREE" to "SPIKE
///   FOUR") read back in 12 ms with Mail inactive, VS Code still in front, and
///   `kAXWindows` still 0: no Space switch. No paragraph added.
/// - **`AXSelectedText` is not settable** on the web area. Settable:
///   `AXCaretBrowsingEnabled AXFocused AXPreventKeyboardDOMEventDispatch
///   AXSelectedTextMarkerRange AXValue`. Write-ish parameterised attributes:
///   `AXReplaceRangeWithText AXSearchTextWithCriteria AXSelectTextWithCriteria
///   AXTextOperation`. Actions: `AXScrollToVisible AXShowMenu AXShowWritingTools`.
/// - **`AXTextOperation` replaces text with Mail in the background**:
///   `TextOperationReplace` over the marker range of "SPIKE ONE" returned
///   `("SPIKE TWO")` and the body read it back in 17 ms. Mail stayed inactive,
///   nothing was pasted or posted. BUT it added an empty paragraph above the
///   replaced text (8 blocks to 9, `"\nSPIKE ONE"` to `"\n\nSPIKE TWO"`), and the
///   saved draft kept it. A second operation ("SPIKE TWO" to "SPIKE THREE")
///   landed in 8 ms and added NO paragraph (9 blocks stayed 9), so the first
///   one is not a per-write cost; that the body came from an AppleScript
///   `content` assignment is the likely difference, not established.
/// - `AXReplaceRangeWithText` with `[NSValue(range:), String]` answered AXError
///   -25201 (illegal argument): the parameter shape is not that. Not pursued.
/// - **Autosave did not keep it**: 4.5 min after the write, Drafts still held
///   "SPIKE ONE" (saved 21:36:03 CET, before the write). The write does not mark
///   the composer edited. `tell application "Mail" to save window id …` returns
///   and saves nothing.
/// - **The product does not hit the body-after-key gap.** Right after, with Mail
///   in the background, the installed 1.36.0's `apple_mail_send_message`
///   (`sendNow: false`, "Space probe 3") opened its composer on the active Space
///   and verified the body (90 chars). Why its composer exposed a body where the
///   scripted one did not was not established.
/// - **`--raise` (AXRaise + AXMain on the token element, then
///   `NSRunningApplication.activate()`) did not switch Spaces**: both AX calls
///   answered 0, but Mail never became active from this command-line process,
///   so it says nothing about the app's own activation. Adding `AXFrontmost`
///   on Mail (the app's own fallback) did not activate it from here either.
///
/// ## IN THE APP 2026-11-02, Debug build of fix/mail-other-spaces
///
/// Same setup, "Space probe 2" on another desktop, VS Code in front, edited
/// through `apple_mail_update_draft` (find/replace):
///
/// - `list_open_drafts` listed it `onAnotherDesktop: true, windowId: 5561`,
///   its text read in full, where the installed 1.36.0 said no compose window
///   was open.
/// - `mail_bring_forward` raising and making it main FIRST, then activating
///   Mail: did not land within 2 s ("did not come onto the shown desktop").
///   The edit still landed, through the AppleScript route then kept as a
///   fallback.
/// - Activating Mail FIRST, then `AXRaise`, `AXMain` and the app's
///   `AXFocusedWindow`: landed, "brought onto the shown desktop natively in
///   3631 ms" (admission and the Space switch included), and the edit was read
///   back and saved. The AppleScript fallback was removed after this run.
/// - **File > Save is disabled with Mail inactive** (pressing it through AX does
///   nothing). With the composer raised and Mail active it is enabled, an
///   `AXPress` on it (no keystroke) saved the draft, and Drafts then held
///   **"SPIKE TWO"** (21:43:03 CET). The written text is in Mail's document; only
///   the save needs Mail in front.
///
/// ## What makes this safe to run
///
/// The default run READS only: nothing is raised, activated, focused, typed or
/// saved, and no event is posted. `--write` changes the named composer's own
/// text through Accessibility and nothing else. Target a composer you made for
/// this, addressed to yourself.
///
/// Usage (compiled, so the AX grant is the terminal's):
///   swiftc -O -o apps/apple/.build/mail-other-space-spike scripts/spike-mail-other-space.swift
///   apps/apple/.build/mail-other-space-spike --subject "Space probe" [--find FIND] [--write TEXT] [--verb operation|replace] [--save-menu] [--raise] [--ids 1000]

// MARK: - Arguments

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
  let value = args[at + 1]
  args.removeSubrange(at...(at + 1))
  return value
}

let subject = option("--subject")
let writeText = option("--write")
let findText = option("--find")
let verb = option("--verb") ?? "operation"
let doSaveMenu = args.contains("--save-menu")
let doRaise = args.contains("--raise")
let idBound = UInt64(option("--ids") ?? "1000") ?? 1000

func row(_ key: String, _ value: Any?) {
  print(
    "\(key.padding(toLength: 34, withPad: " ", startingAt: 0)) \(value.map { "\($0)" } ?? "nil")")
}

// MARK: - Private HIServices

@_silgen_name("_AXUIElementCreateWithRemoteToken")
func _AXUIElementCreateWithRemoteToken(_ token: CFData) -> Unmanaged<AXUIElement>?

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>)
  -> AXError

// MARK: - AX helpers

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var out: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success ? out : nil
}
func param(_ el: AXUIElement, _ name: String, _ arg: CFTypeRef) -> (AXError, CFTypeRef?) {
  var out: CFTypeRef?
  let err = AXUIElementCopyParameterizedAttributeValue(el, name as CFString, arg, &out)
  return (err, out)
}
func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func string(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }

func find(_ el: AXUIElement, depth: Int, where test: (AXUIElement) -> Bool) -> AXUIElement? {
  if test(el) { return el }
  guard depth > 0 else { return nil }
  for child in children(el) {
    if let hit = find(child, depth: depth - 1, where: test) { return hit }
  }
  return nil
}

func text(of el: AXUIElement, depth: Int = 8) -> String {
  var parts: [String] = []
  if let v = string(el, kAXValueAttribute) { parts.append(v) }
  if depth > 0 { for c in children(el) { parts.append(text(of: c, depth: depth - 1)) } }
  return parts.joined()
}

func squash(_ s: String) -> String {
  s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func windowId(_ el: AXUIElement) -> CGWindowID? {
  var id: CGWindowID = 0
  return _AXUIElementGetWindow(el, &id) == .success ? id : nil
}

// MARK: - Mail

guard AXIsProcessTrusted() else {
  print("AXIsProcessTrusted() is false: grant Accessibility to the terminal running this.")
  exit(1)
}
guard
  let mail = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail").first
else {
  print("Mail is not running.")
  exit(1)
}
let pid = mail.processIdentifier
let app = AXUIElementCreateApplication(pid)
row("Mail pid", pid)
row("Mail active", mail.isActive)
row("frontmost", NSWorkspace.shared.frontmostApplication?.localizedName)

// The public view: what the driver reads today.
let publicWindows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
row("kAXWindows", publicWindows.count)
for w in publicWindows {
  row("  public", "\(windowId(w).map(String.init) ?? "?") \(string(w, kAXTitleAttribute) ?? "nil")")
}

// The window server's view, every Space: layer-0 windows Mail owns.
let cg =
  (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]]) ?? []
let cgMail = cg.filter {
  ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
}
row("CGWindowList layer-0 (all Spaces)", cgMail.count)
for w in cgMail {
  let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
  row(
    "  cg",
    "\(w[kCGWindowNumber as String] ?? "?") onscreen=\(w[kCGWindowIsOnscreen as String] ?? false)"
      + " \(b["Width"] ?? "?")x\(b["Height"] ?? "?") alpha=\(w[kCGWindowAlpha as String] ?? "?")"
      + " store=\(w[kCGWindowStoreType as String] ?? "?") sharing=\(w[kCGWindowSharingState as String] ?? "?")"
  )
}

// MARK: - Q1: find by remote token

var token = Data(count: 20)
token.replaceSubrange(0..<4, with: withUnsafeBytes(of: pid) { Data($0) })
token.replaceSubrange(4..<8, with: withUnsafeBytes(of: Int32(0)) { Data($0) })
token.replaceSubrange(8..<12, with: withUnsafeBytes(of: Int32(0x636f_636f)) { Data($0) })

var found: [AXUIElement] = []
var foundIds: [UInt64] = []
let t0 = Date()
for elementId in UInt64(0)..<idBound {
  token.replaceSubrange(12..<20, with: withUnsafeBytes(of: elementId) { Data($0) })
  guard let el = _AXUIElementCreateWithRemoteToken(token as CFData)?.takeRetainedValue(),
    string(el, kAXRoleAttribute) == (kAXWindowRole as String)
  else { continue }
  if !found.contains(where: { CFEqual($0, el) }) {
    found.append(el)
    foundIds.append(elementId)
  }
}
row(
  "remote-token windows",
  "\(found.count) in \(Int(Date().timeIntervalSince(t0) * 1000)) ms (ids 0..<\(idBound))")
for (w, elementId) in zip(found, foundIds) {
  let field = find(w, depth: 3) { string($0, kAXIdentifierAttribute) == "Mail.subjectField" }
  row(
    "  token \(elementId)",
    "\(windowId(w).map(String.init) ?? "?") \(string(w, kAXSubroleAttribute) ?? "nil") "
      + "\(string(w, kAXTitleAttribute)?.debugDescription ?? "nil") composer=\(field != nil)"
      + " public=\(publicWindows.contains { CFEqual($0, w) })")
}

guard let subject else { exit(0) }

let composers = found.compactMap { window -> (AXUIElement, AXUIElement)? in
  guard
    let field = find(
      window, depth: 3, where: { string($0, kAXIdentifierAttribute) == "Mail.subjectField" }),
    string(field, kAXValueAttribute) == subject
  else { return nil }
  return (window, field)
}
row("composers titled the subject", composers.count)
guard composers.count == 1, let (window, _) = composers.first else { exit(1) }
row("composer on the active Space", publicWindows.contains { CFEqual($0, window) })
guard let web = find(window, depth: 20, where: { string($0, kAXRoleAttribute) == "AXWebArea" })
else {
  print("No AXWebArea in the composer.")
  exit(1)
}

// The body, split as the app splits it.
func ownBlocks() -> [AXUIElement] {
  children(web).prefix { ((attr($0, "AXBlockQuoteLevel") as? NSNumber)?.intValue ?? 1) == 0 }
    .map { $0 }
}
let own = ownBlocks()
let ownText = own.map { text(of: $0) }.joined(separator: "\n")
row("blocks", children(web).count)
row("own blocks", own.count)
row("own text", ownText.debugDescription)

// What the web area offers for writing, by name.
var paramNames: CFArray?
AXUIElementCopyParameterizedAttributeNames(web, &paramNames)
var actionNames: CFArray?
AXUIElementCopyActionNames(web, &actionNames)
var attrNames: CFArray?
AXUIElementCopyAttributeNames(web, &attrNames)
let writeish = { (names: [String]) in
  names.filter { n in ["Replace", "Insert", "Text", "Value"].contains { n.contains($0) } }
    .filter { !$0.contains("TextMarker") }.sorted()
}
row(
  "param attributes (write-ish)", writeish((paramNames as? [String]) ?? []).joined(separator: " "))
row("actions", ((actionNames as? [String]) ?? []).sorted().joined(separator: " "))
let settable = ((attrNames as? [String]) ?? []).filter { name in
  var ok: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(web, name as CFString, &ok) == .success && ok.boolValue
}
row("settable attributes", settable.sorted().joined(separator: " "))

// MARK: - Raise natively: AXRaise on the token element, then activate Mail

// The AppleScript route (`set index of window id … to 1` + `activate`) is
// measured to land on the composer's Space. This asks whether the app can do
// the same with what it already holds: the element, and NSRunningApplication.
if doRaise {
  let previous = NSWorkspace.shared.frontmostApplication
  let raised = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  let main = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  row("AXRaise / AXMain", "\(raised.rawValue) / \(main.rawValue)")
  mail.activate()
  // The app's own fallback when activate() is refused (AccessibilityDriver.activate).
  let frontmost = AXUIElementSetAttributeValue(
    app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  row("AXFrontmost", frontmost.rawValue)
  let t = Date()
  var visible = false
  while Date().timeIntervalSince(t) < 3 {
    visible = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).contains {
      CFEqual($0, window)
    }
    if visible && mail.isActive { break }
    Thread.sleep(forTimeInterval: 0.05)
  }
  row(
    "composer on the active Space",
    visible ? "yes, \(Int(Date().timeIntervalSince(t) * 1000)) ms" : "NO within 3 s")
  row("Mail active", mail.isActive)
  let focused = attr(app, kAXFocusedWindowAttribute).map {
    string($0 as! AXUIElement, kAXTitleAttribute) ?? "nil"
  }
  row("focused window", focused ?? "nil")
  Thread.sleep(forTimeInterval: 0.5)
  previous?.activate()
  row("handed back to", previous?.localizedName)
  exit(0)
}

// MARK: - Q3: save without a keystroke

// File > Save, pressed through the menu bar's AX tree with Mail in the
// background. Whether the item even validates for an inactive Mail is the
// first question.
if doSaveMenu {
  let bar = attr(app, kAXMenuBarAttribute).map { $0 as! AXUIElement }
  let file = bar.flatMap { b in children(b).first { string($0, kAXTitleAttribute) == "File" } }
  let menu = file.flatMap { children($0).first }
  let save = menu.flatMap { m in children(m).first { string($0, kAXTitleAttribute) == "Save" } }
  row("File > Save found", save != nil)
  if let save {
    row("Mail active at save", mail.isActive)
    row("Save enabled", (attr(save, kAXEnabledAttribute) as? Bool) ?? false)
    // The composer must be Mail's main window for the menu to aim at it.
    row("composer is main", (attr(window, kAXMainAttribute) as? Bool) ?? false)
    let err = AXUIElementPerformAction(save, kAXPressAction as CFString)
    row("press Save", err == .success ? "ok" : "AXError \(err.rawValue)")
    Thread.sleep(forTimeInterval: 0.5)
    row("Mail active after save", mail.isActive)
  }
  exit(0)
}

// MARK: - Q2: write without a paste

guard let writeText else { exit(0) }
guard let first = own.first, let last = own.last else {
  print("No own text to select: type a line into the composer first.")
  exit(1)
}
let (_, firstRange) = param(web, "AXTextMarkerRangeForUIElement", first)
let (_, lastRange) = param(web, "AXTextMarkerRangeForUIElement", last)
guard let firstRange, let lastRange else {
  print("No text-marker range for the own blocks.")
  exit(1)
}
let ownRange: CFTypeRef = AXTextMarkerRangeCreate(
  kCFAllocatorDefault,
  AXTextMarkerRangeCopyStartMarker(firstRange as! AXTextMarkerRange),
  AXTextMarkerRangeCopyEndMarker(lastRange as! AXTextMarkerRange))
let (_, ranged) = param(web, "AXStringForTextMarkerRange", ownRange)
let rangedText = (ranged as? String) ?? ""
let (_, baseIdx) = param(
  web, "AXIndexForTextMarker", AXTextMarkerRangeCopyStartMarker(ownRange as! AXTextMarkerRange))
let base = (baseIdx as? NSNumber)?.intValue ?? 0

// The span to replace: FIND inside the own range, or the whole own range.
var target = ownRange
var span = NSRange(location: base, length: (rangedText as NSString).length)
if let findText {
  let hit = (rangedText as NSString).range(of: findText)
  guard hit.location != NSNotFound else {
    print("FIND is not in the own text.")
    exit(1)
  }
  span = NSRange(location: base + hit.location, length: hit.length)
  let (_, m1) = param(web, "AXTextMarkerForIndex", NSNumber(value: span.location))
  let (_, m2) = param(web, "AXTextMarkerForIndex", NSNumber(value: span.location + span.length))
  guard let m1, let m2 else {
    print("No markers for FIND.")
    exit(1)
  }
  target = AXTextMarkerRangeCreate(kCFAllocatorDefault, m1 as! AXTextMarker, m2 as! AXTextMarker)
}
let (_, targetString) = param(web, "AXStringForTextMarkerRange", target)
row("target reads", ((targetString as? String) ?? "").debugDescription)
row("target index range", "\(span.location) length \(span.length)")
let expected =
  findText.map { rangedText.replacingOccurrences(of: $0, with: writeText) } ?? writeText

let t1 = Date()
switch verb {
case "operation":
  // WebKit's text operation, as Voice Control drives it.
  let operation: [String: Any] = [
    "AXTextOperationMarkerRanges": [target],
    "AXTextOperationType": "TextOperationReplace",
    "AXTextOperationReplacementString": writeText,
  ]
  let (err, result) = param(web, "AXTextOperation", operation as CFDictionary)
  row(
    "AXTextOperation",
    err == .success ? "ok -> \(result.map { "\($0)" } ?? "nil")" : "AXError \(err.rawValue)")
case "replace":
  let (err, result) = param(
    web, "AXReplaceRangeWithText", [NSValue(range: span), writeText] as CFArray)
  row(
    "AXReplaceRangeWithText",
    err == .success ? "ok -> \(result.map { "\($0)" } ?? "nil")" : "AXError \(err.rawValue)")
default:
  print("--verb is operation or replace")
  exit(1)
}

var landed = false
var nowText = ""
while Date().timeIntervalSince(t1) < 3 {
  let (_, r) = param(
    web, "AXStringForTextMarkerRange",
    AXTextMarkerRangeCreate(
      kCFAllocatorDefault,
      AXTextMarkerRangeCopyStartMarker(
        param(web, "AXTextMarkerRangeForUIElement", ownBlocks().first!).1 as! AXTextMarkerRange),
      AXTextMarkerRangeCopyEndMarker(
        param(web, "AXTextMarkerRangeForUIElement", ownBlocks().last!).1 as! AXTextMarkerRange)))
  nowText = (r as? String) ?? ""
  if squash(nowText) == squash(expected) {
    landed = true
    break
  }
  Thread.sleep(forTimeInterval: 0.05)
}
row("own text now", nowText.debugDescription)
row(
  "write landed", landed ? "yes, \(Int(Date().timeIntervalSince(t1) * 1000)) ms" : "NO within 3 s")
row("Mail active after", mail.isActive)
row("frontmost after", NSWorkspace.shared.frontmostApplication?.localizedName)
