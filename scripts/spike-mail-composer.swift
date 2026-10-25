import AppKit
import ApplicationServices
import Foundation

/// Spike: can a Mail composer be driven natively, in one process, without the
/// keyboard walk that `packages/mail/src/client/revise.ts` uses today?
///
/// Four questions, each one an assumption in the native composer design:
///
///   1. **Text-marker selection.** `AXSelectedTextMarkerRange` is opaque over
///      JSON (docs/mail-compose.md), which is the whole reason revise.ts walks
///      the caret down a line at a time and copies after every step. In process
///      a marker is just a CFTypeRef. Can the sender's own blocks be turned into
///      one marker range, read as a string, and SET as the selection?
///   2. **Subject in place.** Does the composer's subject field honour an
///      AXValue write, where the body's web area famously does not?
///   3. **Reopening a saved draft.** Does `message://<Message-ID>` on a draft
///      open a composer, or the read-only viewer `M.open` gives?
///   4. (Measured outside this file, through the mail server: whether a draft's
///      Message-ID survives autosave.)
///
/// ## RUN 2026-10-25, macOS 27.0, on a reply composer to one's own address
///
/// 1. **Text-marker selection works, and needs no clipboard.** Mail offers
///    `AXTextMarkerRangeForUIElement` on each own block (36 TextMarker
///    parameterised attributes, but NOT `AXStart/EndTextMarkerForTextMarkerRange`
///    — the public `AXTextMarkerRangeCopyStartMarker` / `CopyEndMarker` /
///    `AXTextMarkerRangeCreate` do that job). `AXStringForTextMarkerRange` read
///    the range as exactly `"SPIKE ALPHA one\nSPIKE ALPHA two"`;
///    `AXSelectedTextMarkerRange` is settable, was honoured with Mail in the
///    BACKGROUND, and read back identical. Selection is verified by reading it,
///    not by copying it.
/// 2. **The paste needs Mail active.** command-V posted to Mail's pid while it
///    was in the background was ignored (quote intact, nothing changed). With
///    Mail activated and the event on the HID tap it landed in 65 ms and 67 ms
///    on two runs, over exactly the selection, quote kept. Every pasteboard item
///    and type was saved and put back.
/// 3. **The subject field ignores AXValue.** Settable, accepted, displayed —
///    and the window title did not change and the saved draft kept the old
///    subject. The web area's trap, in a text field. Pasting into it is
///    untested.
/// 4. **A draft's Message-ID changes on every save** (`<2FD11BF4-…>` then
///    `<B54BD10B-…>`), as does its row (209906 → 209909 → 209910). Neither is an
///    address. `X-Universally-Unique-Identifier` is present; its stability is
///    unmeasured.
/// 5. **`message://<Message-ID>` on a saved draft opens the read-only viewer**,
///    `"<subject> — Magenta (All Mail)"`, no subject field: the same dead end as
///    `M.open`.
/// 6. **A saved reply draft keeps `In-Reply-To` and `References`** pointing at
///    the original, so a rebuild can find the message to reply to.
/// 7. Pressing a saved composer's `AXCloseButton` closed it with no sheet.
///
/// `--reopen` hung once: its web-area search walked depth 8 into the main
/// viewer, 17 584 rows. It now looks only for the subject field.
///
/// ## RUN 2 2026-10-25, macOS 27.0, a fresh reply to "cupertino quote probe 1103"
///
/// SUBBLOCK = yes
/// HTML_PASTE = yes
/// XUUID_STABLE = yes
///
/// - **Sub-paragraph selection** (`--select-text "ALPHA two"`). In the own range
///   `"SPIKE ALPHA one\nSPIKE ALPHA two"` the find sat at offset 22, length 9.
///   The own range's start marker is index 0, so offsets are index-compatible.
///   `AXTextMarkerForIndex` answered AXError 0 for both ends;
///   `AXIndexForTextMarker` round-tripped 22 and 31 (wanted 22 and 31).
///   `AXSelectedTextMarkerRange` was set from `AXTextMarkerRangeCreate` and read
///   back as exactly `"ALPHA two"`. With `--replace "BETA" --activate --save` the
///   paste landed in 71 ms, quote intact. The saved draft read
///   `"SPIKE ALPHA one\nSPIKE BETA"` followed by the quote, and its HTML was
///   `<div>SPIKE ALPHA one</div><div>SPIKE BETA</div>`.
/// - **HTML paste** (`--paste-html`: `.html` plus `.string` fallback, Mail
///   active). Pasted over the own range, landed in 70 ms, quote intact. The saved
///   HTML part held `<div><div style="font-size: medium;">Plain&nbsp;<b>bold</b>&nbsp;<a href="https://example.com/">link</a></div></div>`
///   ahead of `<div class="AppleOriginalContents"><br><blockquote type="cite">`.
///   `<b>` and `<a href>` survive, and the pasted text is NOT inside a
///   `blockquote`. Mail rewrites it: spaces become `&nbsp;`, a `font-size: medium`
///   wrapper `<div>` is added, the href gains a trailing slash.
/// - **`X-Universally-Unique-Identifier` is stable across saves**:
///   `0B3369D2-E513-4069-9457-668E2F5905B7` on both saves, while Message-Id moved
///   (`<1F589F06-…>` to `<CCC5D83F-…>`) and the row went 209928 to 209929. Two
///   saves of one composer is the whole sample, so it is not yet shown to survive
///   a close and reopen.
/// - Cleanup: the draft deleted, `--close` pressed the composer's close button
///   (no sheet), and a Drafts search for the subject returned 0.
///
/// ## What makes this safe to run
///
/// The default run READS only: nothing is raised, focused, typed or saved, so
/// it can run with someone at the keyboard. Every write is behind its own flag,
/// and none of them sends mail. Target a composer you made for this, addressed
/// to yourself.
///
/// Usage (compiled, so the AX grant is the terminal's):
///   swiftc -O -o apps/apple/.build/mail-composer-spike scripts/spike-mail-composer.swift
///   apps/apple/.build/mail-composer-spike --subject "Re: Your Cupertino licence key" \
///     [--select] [--select-text FIND] [--replace TEXT] [--paste-html FILE] [--save] [--set-subject TEXT] [--reopen MESSAGE-ID]

// MARK: - Arguments

var args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> Bool {
  guard let at = args.firstIndex(of: name) else { return false }
  args.remove(at: at)
  return true
}
func option(_ name: String) -> String? {
  guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
  let value = args[at + 1]
  args.removeSubrange(at...(at + 1))
  return value
}

let subject = option("--subject")
let selectText = option("--select-text")
let htmlFile = option("--paste-html")
let htmlSource = htmlFile.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }
let htmlPlain = htmlSource.map { $0.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression) }
let replacement = option("--replace") ?? htmlPlain
let newSubject = option("--set-subject")
let reopen = option("--reopen")
let doSelect = flag("--select") || (replacement != nil && selectText == nil)
let doSave = flag("--save")
let doClose = flag("--close")
let doActivate = flag("--activate")
let previous = NSWorkspace.shared.frontmostApplication

func row(_ key: String, _ value: Any?) {
  print("\(key.padding(toLength: 34, withPad: " ", startingAt: 0)) \(value.map { "\($0)" } ?? "nil")")
}

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
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func string(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }

func find(_ el: AXUIElement, depth: Int, where test: (AXUIElement) -> Bool) -> AXUIElement? {
  if test(el) { return el }
  guard depth > 0 else { return nil }
  for child in children(el) {
    if let hit = find(child, depth: depth - 1, where: test) { return hit }
  }
  return nil
}

/// A block's text: its own value and its descendants', joined with nothing,
/// which is how `ax.ts` reads it.
func text(of el: AXUIElement, depth: Int = 8) -> String {
  var parts: [String] = []
  if let v = string(el, kAXValueAttribute) { parts.append(v) }
  if depth > 0 { for c in children(el) { parts.append(text(of: c, depth: depth - 1)) } }
  return parts.joined()
}

func squash(_ s: String) -> String {
  s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

// MARK: - Find Mail and the composer

guard AXIsProcessTrusted() else {
  print("AXIsProcessTrusted() is false: grant Accessibility to the terminal running this.")
  exit(1)
}
guard let mail = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail").first
else {
  print("Mail is not running.")
  exit(1)
}
let app = AXUIElementCreateApplication(mail.processIdentifier)

if let messageId = reopen {
  // Q3. Open the draft by its Message-ID and see what kind of window arrives.
  let before = Set(((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).compactMap { string($0, kAXTitleAttribute) })
  let bare = messageId.trimmingCharacters(in: CharacterSet(charactersIn: "<>"))
  let encoded = "%3C" + (bare.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? bare) + "%3E"
  guard let url = URL(string: "message://\(encoded)") else { print("bad Message-ID"); exit(1) }
  row("opening", url.absoluteString)
  NSWorkspace.shared.open(url)
  Thread.sleep(forTimeInterval: 3)
  for window in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
    let title = string(window, kAXTitleAttribute) ?? "?"
    let subjectField = find(window, depth: 3) { string($0, kAXIdentifierAttribute) == "Mail.subjectField" }
    row(before.contains(title) ? "window (already open)" : "window (NEW)",
        "\(title) | subjectField=\(subjectField != nil)")
  }
  exit(0)
}

guard let subject else {
  print("Pass --subject to name the composer to examine.")
  exit(1)
}

let windows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
let composers = windows.compactMap { window -> (AXUIElement, AXUIElement)? in
  guard let field = find(window, depth: 3, where: { string($0, kAXIdentifierAttribute) == "Mail.subjectField" }),
        string(field, kAXValueAttribute) == subject
  else { return nil }
  return (window, field)
}
row("Mail windows", windows.count)
row("composers titled the subject", composers.count)
guard composers.count == 1, let (window, subjectField) = composers.first else { exit(1) }
guard let web = find(window, depth: 10, where: { string($0, kAXRoleAttribute) == "AXWebArea" }) else {
  print("No AXWebArea in the composer.")
  exit(1)
}

// MARK: - Split own text from the quote

let blocks = children(web)
var own: [AXUIElement] = []
var boundaryFound = false
for block in blocks {
  let level = (attr(block, "AXBlockQuoteLevel") as? NSNumber)?.intValue
  if level == nil { print("a block's quote level is unreadable; stopping"); exit(1) }
  if level! > 0 { boundaryFound = true; break }
  own.append(block)
}
let ownText = own.map { text(of: $0) }.joined(separator: "\n")
row("blocks", blocks.count)
row("own blocks", own.count)
row("quote present", boundaryFound)
row("own text", ownText.debugDescription)

var names: CFArray?
AXUIElementCopyParameterizedAttributeNames(web, &names)
let paramNames = (names as? [String]) ?? []
row("text-marker param attributes", paramNames.filter { $0.contains("TextMarker") }.count)

// MARK: - Q1: a marker range over the sender's own blocks

guard let first = own.first, let last = own.last else {
  print("No own text to select (an empty reply).")
  exit(0)
}
let (e1, firstRange) = param(web, "AXTextMarkerRangeForUIElement", first)
let (e2, lastRange) = param(web, "AXTextMarkerRangeForUIElement", last)
row("range for first own block", e1 == .success ? "ok" : "AXError \(e1.rawValue)")
row("range for last own block", e2 == .success ? "ok" : "AXError \(e2.rawValue)")
guard let firstRange, let lastRange else { exit(1) }
print(paramNames.filter { $0.contains("TextMarker") }.sorted().joined(separator: "\n"))
// Public HIServices API: a range's ends, and a range from two markers.
let start = AXTextMarkerRangeCopyStartMarker(firstRange as! AXTextMarkerRange)
let end = AXTextMarkerRangeCopyEndMarker(lastRange as! AXTextMarkerRange)
let ownRange: CFTypeRef = AXTextMarkerRangeCreate(kCFAllocatorDefault, start, end)
row("own range", "built from public API")
let (_, ranged) = param(web, "AXStringForTextMarkerRange", ownRange)
let rangedText = (ranged as? String) ?? ""
row("string for own range", rangedText.debugDescription)
row("matches own text (squashed)", squash(rangedText) == squash(ownText))

var settable: DarwinBoolean = false
AXUIElementIsAttributeSettable(web, "AXSelectedTextMarkerRange" as CFString, &settable)
row("AXSelectedTextMarkerRange settable", settable.boolValue)

if doSelect {
  let err = AXUIElementSetAttributeValue(web, "AXSelectedTextMarkerRange" as CFString, ownRange)
  row("set selection", err == .success ? "ok" : "AXError \(err.rawValue)")
  Thread.sleep(forTimeInterval: 0.2)
  if let selected = attr(web, "AXSelectedTextMarkerRange") {
    let (_, s) = param(web, "AXStringForTextMarkerRange", selected)
    row("selection reads back as", ((s as? String) ?? "").debugDescription)
    row("selection == own text", squash((s as? String) ?? "") == squash(ownText))
  } else {
    row("selection reads back as", "unreadable")
  }
}

// MARK: - Sub-paragraph selection by character offsets

if let selectText {
  let ns = rangedText as NSString
  let hit = ns.range(of: selectText)
  row("find in own range", hit.location == NSNotFound ? "NOT FOUND" : "offset \(hit.location) length \(hit.length)")
  if hit.location != NSNotFound {
    // Offsets are relative to the own range; markers index the whole web area.
    let (_, baseIdx) = param(web, "AXIndexForTextMarker", AXTextMarkerRangeCopyStartMarker(ownRange as! AXTextMarkerRange))
    let base = (baseIdx as? NSNumber)?.intValue ?? 0
    row("own range start index", baseIdx.map { "\($0)" } ?? "nil")
    let (e3, m1) = param(web, "AXTextMarkerForIndex", NSNumber(value: base + hit.location))
    let (e4, m2) = param(web, "AXTextMarkerForIndex", NSNumber(value: base + hit.location + hit.length))
    row("AXTextMarkerForIndex start/end", "\(e3.rawValue)/\(e4.rawValue)")
    if let m1, let m2 {
      let (_, i1) = param(web, "AXIndexForTextMarker", m1)
      let (_, i2) = param(web, "AXIndexForTextMarker", m2)
      row("AXIndexForTextMarker round trip", "\(i1.map { "\($0)" } ?? "nil") \(i2.map { "\($0)" } ?? "nil") (want \(base + hit.location) \(base + hit.location + hit.length))")
      let sub: CFTypeRef = AXTextMarkerRangeCreate(kCFAllocatorDefault, m1 as! AXTextMarker, m2 as! AXTextMarker)
      let err = AXUIElementSetAttributeValue(web, "AXSelectedTextMarkerRange" as CFString, sub)
      row("set sub-range selection", err == .success ? "ok" : "AXError \(err.rawValue)")
      Thread.sleep(forTimeInterval: 0.2)
      if let selected = attr(web, "AXSelectedTextMarkerRange") {
        let (_, s) = param(web, "AXStringForTextMarkerRange", selected)
        row("sub-selection reads back as", ((s as? String) ?? "").debugDescription)
        row("sub-selection == FIND", (s as? String) == selectText)
      } else {
        row("sub-selection reads back as", "unreadable")
      }
    }
  }
}

// MARK: - Replace by paste, natively (changes the window, never saves unless --save)

func post(_ key: CGKeyCode, _ flags: CGEventFlags) {
  let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
  down?.flags = flags
  up?.flags = flags
  if doActivate {
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  } else {
    down?.postToPid(mail.processIdentifier)
    up?.postToPid(mail.processIdentifier)
  }
}

if let replacement {
  // Borrow the whole pasteboard, every item and every type, and put it back.
  let board = NSPasteboard.general
  let saved = (board.pasteboardItems ?? []).map { item -> [(NSPasteboard.PasteboardType, Data)] in
    item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
  }
  board.clearContents()
  if let htmlSource {
    board.setString(htmlSource, forType: .html)
    board.setString(replacement, forType: .string)
  } else {
    board.setString(replacement, forType: .string)
  }
  let expected = selectText.map { ownText.replacingOccurrences(of: $0, with: replacement) } ?? replacement
  let changeCount = board.changeCount

  if doActivate {
    mail.activate()
    let t = Date()
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != mail.processIdentifier, Date().timeIntervalSince(t) < 2 { Thread.sleep(forTimeInterval: 0.05) }
    row("Mail frontmost", NSWorkspace.shared.frontmostApplication?.processIdentifier == mail.processIdentifier)
  }
  // Raise the composer and post command-V to Mail alone. The selection set above
  // is what the paste replaces; the window is raised, not the app activated.
  AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(web, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  Thread.sleep(forTimeInterval: 0.15)
  let t0 = Date()
  post(9, .maskCommand)  // kVK_ANSI_V

  var landed = false
  while Date().timeIntervalSince(t0) < 5 {
    let nowOwn = children(web).prefix { ((attr($0, "AXBlockQuoteLevel") as? NSNumber)?.intValue ?? 1) == 0 }
    if squash(nowOwn.map { text(of: $0) }.joined(separator: "\n")) == squash(expected) { landed = true; break }
    Thread.sleep(forTimeInterval: 0.05)
  }
  row("paste landed", landed ? "yes, \(Int(Date().timeIntervalSince(t0) * 1000)) ms" : "NO within 5 s")
  let quoteAfter = children(web).contains { ((attr($0, "AXBlockQuoteLevel") as? NSNumber)?.intValue ?? 0) > 0 }
  row("quote still present", quoteAfter)
  row("pasteboard untouched by others", board.changeCount == changeCount)

  board.clearContents()
  let restored = saved.map { pairs -> NSPasteboardItem in
    let item = NSPasteboardItem()
    for (t, d) in pairs { item.setData(d, forType: t) }
    return item
  }
  if !restored.isEmpty { board.writeObjects(restored) }
  row("pasteboard restored items", restored.count)
}

// MARK: - Q2: the subject field

var subjectSettable: DarwinBoolean = false
AXUIElementIsAttributeSettable(subjectField, kAXValueAttribute as CFString, &subjectSettable)
row("subject field settable", subjectSettable.boolValue)
if let newSubject {
  let err = AXUIElementSetAttributeValue(subjectField, kAXValueAttribute as CFString, newSubject as CFString)
  row("set subject", err == .success ? "ok" : "AXError \(err.rawValue)")
  Thread.sleep(forTimeInterval: 0.3)
  row("subject field reads", string(subjectField, kAXValueAttribute))
  row("window title reads", string(window, kAXTitleAttribute))
}

if doSave {
  AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  post(1, .maskCommand)  // kVK_ANSI_S
  Thread.sleep(forTimeInterval: 0.5)
  row("command-S", "posted")
}

if doClose {
  // The close button, pressed through AX: no keystroke. A composer with unsaved
  // changes answers with a sheet, which is reported rather than answered.
  if let close = attr(window, kAXCloseButtonAttribute) {
    let err = AXUIElementPerformAction(close as! AXUIElement, kAXPressAction as CFString)
    Thread.sleep(forTimeInterval: 0.5)
    let sheet = find(window, depth: 1) { string($0, kAXRoleAttribute) == "AXSheet" }
    row("close", err == .success ? (sheet == nil ? "pressed" : "pressed, a SHEET is asking") : "AXError \(err.rawValue)")
  }
}

if doActivate, let previous, previous.processIdentifier != mail.processIdentifier {
  previous.activate()
  row("handed back to", previous.localizedName)
}
