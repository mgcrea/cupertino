import Foundation

/// A composer that is not Mail's: lets the registry and the listing be asserted
/// with no Accessibility and no Mail running.
final class FakeComposer: ComposerWindow {
  var subject: String
  var to: [String]
  var cc: [String] = []
  var bcc: [String]? = nil
  var from: String? = nil
  var isMain = false
  var body: [ComposerBlock]
  var isAlive = true
  init(subject: String, recipients: [String] = [], body: [ComposerBlock] = []) {
    self.subject = subject
    self.to = recipients
    self.body = body
  }
  func blocks() throws -> [ComposerBlock] { body }
  // The listing never edits; these answer "could not" so nothing reads as done.
  func ownRangeText() throws -> String? { nil }
  func selectOwn() throws -> String? { nil }
  func selectSubrange(_ range: Range<String.Index>, in own: String) throws -> String? { nil }
  func selectOwnEnd() throws -> String? { nil }
  func selectionReachesQuote() throws -> Bool? { false }
  func activate() throws -> Bool { false }
  func paste(_ content: PasteContent) throws -> Bool { false }
  func save() throws -> SaveOutcome { .refused }
}

/// A composer with a text model: own text (blocks split on newlines), files on
/// the last own block, and a quote. A selection is UTF-16 offsets into the own
/// text, as the live type's are into the web area; a paste replaces it.
///
/// The hooks are how a check plays the person at the keyboard, or Mail
/// misbehaving: `onPaste` runs after each paste lands, `readBack` maps what a
/// selection was meant to read as to what it reads as.
final class EditFake: ComposerWindow {
  var subject = "Re: plans"
  var to: [String] = []
  var cc: [String] = []
  var bcc: [String]? = nil
  var from: String? = nil
  var isMain = false
  var own: String
  var ownFiles: [String]
  var quote: [String]
  var unreadableLevel = false
  var isAlive = true
  var rangeText: String?
  var readBack: ((String) -> String?)?
  var activates = true
  var pasteTakes = true
  var saveOutcome = SaveOutcome.pressed
  var ignoresFiles = false
  /// How a pasted file's element reads. MEASURED, LIVE RUN 5: an attachment is
  /// an AXButton with an empty title and the description "name, 6 bytes".
  var fileLabel: (String) -> String = { $0 }
  /// Reads a paste takes to land: AX reads and HID events travel separately,
  /// so a read can come before Mail has handled the command-V.
  var lagReads = 0
  /// After a paste, every read fails for this long: a hung Mail.
  var hangsFor: TimeInterval = 0
  /// The keystroke went nowhere: the paste is "posted" and never lands.
  var pasteLost = false
  /// The window closes as the paste is posted.
  var diesOnPaste = false
  /// What the quote guard finds at each selection: true is a caret Mail resolved
  /// inside the quoted original (LIVE RUN 2's forward), nil one it would not
  /// resolve at all.
  var caretInQuote: Bool? = false
  /// Answers for the guard one call at a time, before `caretInQuote` takes over.
  var caretScript: [Bool?] = []
  /// Pastes after this many are refused as the window not taking the keyboard.
  var refusesPasteAfter: Int?
  /// A text paste lands at the start of the first quoted block instead of over
  /// the selection: what LIVE RUN 2's forward did, guard or no guard.
  var landsInQuote = false
  private(set) var quoteChecks = 0
  var onPaste: ((EditFake) -> Void)?
  /// After each read of the body, with what it read: the person acting between reads.
  var onRead: ((EditFake) -> Void)?
  /// As Mail comes forward, step 9.
  var onActivate: ((EditFake) -> Void)?
  /// The window holding this composer as one of its tabs; nil for a window of
  /// its own. Every read and write below then reaches the tab the window SHOWS,
  /// which is what Accessibility gives: one window element, the selected tab's
  /// content.
  var group: FakeTabGroup?
  /// What a read or a paste reaches: this composer, or the tab its window shows.
  private var shown: EditFake { group?.shown ?? self }
  private var pending: (land: () -> Void, reads: Int)?
  private var hungUntil = Date.distantPast
  private(set) var selection: Range<Int>?
  private(set) var log: [String] = []
  private(set) var pasted: [PasteContent] = []
  /// Changed and not saved since: the window's `AXEdited`.
  var dirty = false
  fileprivate(set) var saves = 0

  init(own: String, files: [String] = [], quote: [String] = ["On Monday, Ann wrote:", "Hi"]) {
    self.own = own
    self.ownFiles = files
    self.quote = quote
  }

  struct Hung: Error {}

  var tab: ComposerTab? { group?.state(of: self) }
  var sharesTabTitle: Bool {
    guard let group else { return false }
    return group.tabs.filter { $0.subject == subject }.count > 1
  }
  func pressTab() throws -> Bool { group?.press(self) ?? false }
  func shownTab() -> ComposerWindow? {
    guard let group, group.valueAnswers else { return nil }
    return group.tabs[group.flagged]
  }
  func bringForward() throws -> Bool {
    note("forward")
    return group?.forward() ?? activates
  }
  /// The window's body: the content shown, whichever tab that is.
  func windowBody() -> AnyObject? {
    guard let group else { return self }
    return group.body()
  }
  /// The window's `AXEdited` while it shows this composer: nil otherwise, or
  /// when it does not answer.
  func edited() -> Bool? {
    guard let group else { return nil }
    group.tick()
    guard group.editedAnswers, group.state(of: self) == .selected else { return nil }
    return group.shown.dirty
  }

  private func note(_ event: String) {
    log.append(event)
    group?.events.append("\(group?.tabs.firstIndex { $0 === self } ?? -1):\(event)")
  }

  func blocks() throws -> [ComposerBlock] {
    if shown !== self { return try shown.blocks() }
    if Date() < hungUntil {
      note("read-hung")
      throw Hung()
    }
    note("read")
    if let waiting = pending {
      if waiting.reads <= 1 {
        pending = nil
        waiting.land()
      } else {
        pending = (waiting.land, waiting.reads - 1)
      }
    }
    var out: [ComposerBlock] = []
    if !own.isEmpty || !ownFiles.isEmpty {
      let lines = own.components(separatedBy: "\n")
      for (i, line) in lines.enumerated() {
        out.append(
          ComposerBlock(
            text: line, quoteLevel: 0, fileNames: i == lines.count - 1 ? ownFiles : []))
      }
    }
    for (i, line) in quote.enumerated() {
      out.append(
        ComposerBlock(text: line, quoteLevel: unreadableLevel && i == 0 ? nil : 1, fileNames: []))
    }
    onRead?(self)
    return out
  }

  func ownRangeText() throws -> String? {
    if shown !== self { return try shown.ownRangeText() }
    note("range")
    return rangeText ?? own
  }

  private func selecting(_ span: Range<Int>) -> String? {
    selection = span
    let utf16 = Array(own.utf16)
    let meant = String(decoding: utf16[span], as: UTF16.self)
    return readBack.map { $0(meant) } ?? meant
  }

  func selectOwn() throws -> String? {
    if shown !== self { return try shown.selectOwn() }
    note("select")
    return selecting(0..<own.utf16.count)
  }

  func selectSubrange(_ range: Range<String.Index>, in text: String) throws -> String? {
    if shown !== self { return try shown.selectSubrange(range, in: text) }
    note("select")
    let span = NSRange(range, in: text)
    let end = min(span.location + span.length, own.utf16.count)
    return selecting(min(span.location, end)..<end)
  }

  func selectOwnEnd() throws -> String? {
    if shown !== self { return try shown.selectOwnEnd() }
    note("select-end")
    return selecting(own.utf16.count..<own.utf16.count)
  }

  func selectionReachesQuote() throws -> Bool? {
    if shown !== self { return try shown.selectionReachesQuote() }
    quoteChecks += 1
    return caretScript.isEmpty ? caretInQuote : caretScript.removeFirst()
  }

  func activate() throws -> Bool {
    if shown !== self { return try shown.activate() }
    note("activate")
    onActivate?(self)
    return activates
  }

  func focus() throws -> Bool {
    if shown !== self { return try shown.focus() }
    note("focus")
    onActivate?(self)
    return activates && group?.mailFront != false
  }

  func paste(_ content: PasteContent) throws -> Bool {
    if shown !== self { return try shown.paste(content) }
    note("paste")
    guard pasteTakes else { return false }
    if let limit = refusesPasteAfter, pasted.count >= limit { return false }
    pasted.append(content)
    if hangsFor > 0 { hungUntil = Date().addingTimeInterval(hangsFor) }
    if diesOnPaste { isAlive = false }
    guard !pasteLost else { return true }
    let span = selection ?? 0..<0
    let land = { [self] in
      note("landed")
      switch content {
      case .text(let text), .html(_, let text):
        if landsInQuote {
          if quote.isEmpty { quote = [text] } else { quote[0] = text + quote[0] }
          break
        }
        var utf16 = Array(own.utf16)
        utf16.replaceSubrange(span, with: Array(text.utf16))
        own = String(decoding: utf16, as: UTF16.self)
        dirty = true
        selection = (span.lowerBound + text.utf16.count)..<(span.lowerBound + text.utf16.count)
      case .files(let urls):
        if !ignoresFiles { ownFiles += urls.map { fileLabel($0.lastPathComponent) } }
      }
      onPaste?(self)
    }
    if lagReads > 0 {
      pending = (land, lagReads)
    } else {
      land()
    }
    return true
  }

  /// command-S goes to the window, which saves the tab it shows.
  func save() throws -> SaveOutcome {
    if shown !== self { return try shown.save() }
    note("save")
    // command-S goes by HID and can be handled after an AX press that follows
    // it: it then saves whichever tab the window shows when it lands.
    if let group, group.saveLag > 0 {
      group.postSave()
    } else {
      saves += 1
      dirty = false
    }
    return saveOutcome
  }
}

/// One window holding several composers as tabs: Mail with "Prefer tabs:
/// Always" (LIVE RUN 3, 2026-10-26). Accessibility lists the window ONCE, and
/// whatever is read or pasted through it reaches the tab it shows, so a read
/// "of" a background tab answers another draft's text. What can be told apart
/// is the tab buttons, and those can be pressed.
///
/// The unmeasured parts are knobs, so each can be played wrong: `valueAnswers`
/// is whether a tab reads as selected at all (its role and `AXValue`),
/// `pressSelects` whether `AXPress` selects it, `pressRefused` a tab that is not
/// the role a press is allowed on.
final class FakeTabGroup {
  let tabs: [EditFake]
  /// The tab whose button reads `AXValue` 1.
  var flagged: Int
  /// The tab whose content the window shows: its subject field and body.
  var content: Int
  /// The person picking a tab: its flag and its content move together.
  var selected: Int {
    get { content }
    set {
      flagged = newValue
      content = newValue
    }
  }
  var valueAnswers = true
  var pressSelects = true
  var pressRefused = false
  /// MEASURED, LIVE RUN 4: a press flips the tab's `AXValue` at once, but the
  /// window's content swaps to it only while Mail is frontmost. Pressed with
  /// Mail in the background, it never swaps.
  var mailFront = false
  /// Mail comes forward when asked.
  var comesForward = true
  /// With Mail in front, whether the content follows the flag at all.
  var contentSwaps = true
  /// Reads of a tab's state the content takes to swap after a press.
  var selectLag = 0
  private var landing: (index: Int, reads: Int)?
  /// Reads a command-S takes to land, in whatever tab is shown by then.
  var saveLag = 0
  private var saving: Int?
  /// Whether the window answers `AXEdited`.
  var editedAnswers = true
  /// The window's body element, per tab: replaced when activation rebuilds it.
  private var bodies: [Int: NSObject] = [:]
  var bodyReadable = true
  /// Mail coming forward rebuilds the body element of the tab it shows.
  var forwardRebuildsBody = false
  /// The body stops answering once Mail comes forward.
  var bodyUnreadableAfterForward = false
  /// Every press, by tab index, in order.
  private(set) var presses: [Int] = []
  /// Presses and each tab's reads and writes, `"<index>:<event>"`, in order.
  var events: [String] = []

  init(_ tabs: [EditFake], selected: Int) {
    self.tabs = tabs
    self.flagged = selected
    self.content = selected
    for tab in tabs { tab.group = self }
  }

  var shown: EditFake { tabs[content] }

  func press(_ fake: EditFake) -> Bool {
    guard !pressRefused, let index = tabs.firstIndex(where: { $0 === fake }) else { return false }
    presses.append(index)
    events.append("press \(index)\(mailFront ? "" : " (Mail in the background)")")
    guard pressSelects else { return true }
    flagged = index
    guard mailFront, contentSwaps else { return true }
    if selectLag > 0 { landing = (index, selectLag) } else { content = index }
    return true
  }

  func forward() -> Bool {
    events.append("forward")
    if comesForward { mailFront = true }
    if comesForward, forwardRebuildsBody { bodies[content] = NSObject() }
    if comesForward, bodyUnreadableAfterForward { bodyReadable = false }
    return comesForward
  }

  func body() -> AnyObject? {
    guard bodyReadable else { return nil }
    if let known = bodies[content] { return known }
    let made = NSObject()
    bodies[content] = made
    return made
  }

  func postSave() {
    events.append("command-S posted")
    saving = saveLag
  }

  /// A read goes by: whatever was in flight lands one read nearer.
  func tick() {
    if let pending = landing {
      if pending.reads <= 1 {
        content = pending.index
        landing = nil
      } else {
        landing = (pending.index, pending.reads - 1)
      }
    }
    if let left = saving {
      if left <= 1 {
        saving = nil
        shown.saves += 1
        shown.dirty = false
        events.append("saved \(content)")
      } else {
        saving = left - 1
      }
    }
  }

  /// As the live type reads it: the one tab reading `AXValue` 1 is this one,
  /// and the subject field (the content's) reads as its title. Two tabs under
  /// one title cannot be told apart by that alone.
  func state(of fake: EditFake) -> ComposerTab {
    tick()
    let shows = tabs[flagged] === fake && shown.subject == fake.subject
    return valueAnswers && shows ? .selected : .background
  }
}

/// A window of tabs whose buttons Mail RE-MINTS on every tab opened or closed
/// (MEASURED, LIVE RUN 5: after a third tab opened, no earlier button was
/// `CFEqual` to itself). For the registry only: a tab is its button id.
final class MintWindow {
  private var next = 0
  private(set) var tabs: [(title: String, button: Int)] = []
  var isAlive = true
  func add(_ title: String) {
    tabs.append((title, 0))
    remint()
  }
  func remove(_ title: String) {
    tabs.removeAll { $0.title == title }
    remint()
  }
  private func remint() {
    tabs = tabs.map { tab in
      next += 1
      return (tab.title, next)
    }
  }
  func listing() -> [MintTab] { tabs.map { MintTab(self, button: $0.button) } }
}

final class MintTab: ComposerWindow {
  let host: MintWindow
  let button: Int
  let listedTitle: String
  let uniqueAtSighting: Bool
  init(_ host: MintWindow, button: Int) {
    self.host = host
    self.button = button
    let title = host.tabs.first { $0.button == button }?.title ?? ""
    listedTitle = title
    uniqueAtSighting = host.tabs.filter { $0.title == title }.count == 1
  }
  var subject: String { listedTitle }
  var to: [String] = []
  var cc: [String] = []
  var bcc: [String]? = nil
  var from: String? = nil
  var isMain = false
  var isAlive: Bool { host.isAlive && host.tabs.contains { $0.button == button } }
  func isSame(as other: ComposerWindow) -> Bool {
    (other as? MintTab).map { $0.host === host && $0.button == button } ?? false
  }
  var tab: ComposerTab? { .background }
  func rebound() -> ComposerWindow? {
    guard host.isAlive,
      let live = AXComposerWindow.rebind(
        title: listedTitle, uniqueThen: uniqueAtSighting, among: host.tabs.map(\.button),
        title: { b in self.host.tabs.first { $0.button == b }?.title })
    else { return nil }
    return MintTab(host, button: live)
  }
  func blocks() throws -> [ComposerBlock] { [] }
  func ownRangeText() throws -> String? { nil }
  func selectOwn() throws -> String? { nil }
  func selectSubrange(_ range: Range<String.Index>, in own: String) throws -> String? { nil }
  func selectOwnEnd() throws -> String? { nil }
  func selectionReachesQuote() throws -> Bool? { nil }
  func activate() throws -> Bool { false }
  func paste(_ content: PasteContent) throws -> Bool { false }
  func save() throws -> SaveOutcome { .refused }
}

/// The person's clipboard, and every write over it.
final class FakeBoard: Pasteboard {
  var contents: [String] = ["the person's clipboard"]
  private(set) var changeCount = 0
  private(set) var snapshots = 0
  private(set) var restores = 0
  private(set) var writes: [PasteContent] = []
  /// Called as a restore happens, to see what Mail had been through by then.
  var onRestore: (() -> Void)?
  func snapshot() -> Any {
    snapshots += 1
    return contents
  }
  func restore(_ saved: Any) {
    onRestore?()
    restores += 1
    changeCount += 1
    contents = saved as? [String] ?? []
  }
  /// Writes that clear the board, then refuse, as `LivePasteboard.write` can:
  /// `clearContents` moves the count before `writeObjects` says no.
  var refuses: (PasteContent) -> Bool = { _ in false }
  struct Refused: Error {}
  func write(_ content: PasteContent) throws {
    writes.append(content)
    changeCount += 1
    contents = []
    guard !refuses(content) else { throw Refused() }
    contents = ["ours"]
  }
  /// The person copies something while the edit runs.
  func personCopies(_ text: String) {
    changeCount += 1
    contents = [text]
  }
  /// Restored to what the person had, after being borrowed.
  var untouchedOrRestored: Bool { contents == ["the person's clipboard"] }
}

final class FakeFront: Front {
  let pid: pid_t? = 4242
  private(set) var given: [pid_t?] = []
  var onGive: (() -> Void)?
  /// Whether Mail is in front: then the front is Mail (pid 7777), and a front
  /// read then would hand the front back to Mail itself.
  var mailFront: () -> Bool = { false }
  func current() -> pid_t? { mailFront() ? 7777 : pid }
  func give(to pid: pid_t?) {
    onGive?()
    given.append(pid)
  }
}

/// What the window server answers for "which application is frontmost", read
/// by read: the seam `frontmostBundleId` is in the live code.
///
/// `script` is answered first, one entry per read (nil is a read that failed);
/// after it, `front`. An activation is a REQUEST: it lands `lag` reads later,
/// which is how a hand-back that lands after the call returned is played.
final class FakeScreen {
  var front: String?
  var script: [String?] = []
  var lag = 0
  private(set) var reads = 0
  private(set) var activations: [String] = []
  private var landing: (app: String, in: Int)?
  /// Applications with a Dock icon, as `NSApplication.ActivationPolicy.regular`.
  /// Anything else read here is a helper: WebKit's WebContent, a view service.
  var regular: Set<String> = ["com.apple.mail", "com.microsoft.VSCode", "com.apple.Notes"]
  func isRegular(_ app: String) -> Bool { regular.contains(app) }

  init(_ front: String?) { self.front = front }

  func read() -> String? {
    reads += 1
    if let pending = landing {
      if pending.in <= 0 {
        front = pending.app
        landing = nil
      } else {
        landing = (pending.app, pending.in - 1)
      }
    }
    if !script.isEmpty { return script.removeFirst() }
    return front
  }

  /// `AccessibilityDriver.handBack`'s request, without its own wait.
  func activate(_ app: String) -> Bool {
    activations.append(app)
    if lag == 0 { front = app } else { landing = (app, lag) }
    return true
  }
}

/// Asserts the pure text core of the native Mail composer: how a find/replace
/// edit is located in a draft's own text, and when it is refused.
///
/// Nothing here touches Mail or Accessibility; it is text in, text out, plus the
/// registry and dispatch over fake composers. Every `tools/call` to the server
/// is a refusal path, so nothing reaches Accessibility.
///
/// Run with `make mail-composer-check`.
@main
struct MailComposerCheck {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  typealias Edit = MailComposerText.Edit

  /// The result of an `.ok` outcome, nil for any refusal.
  static func result(_ edits: [Edit], _ own: String) -> String? {
    if case .ok(let result, _) = MailComposerText.apply(edits, to: own) { return result }
    return nil
  }

  static func registryChecks() {
    print("\nregistry and listing")
    let a = FakeComposer(
      subject: "Hello", recipients: ["Ann", "Bob"],
      body: [
        ComposerBlock(text: "one", quoteLevel: 0, fileNames: ["a.pdf"]),
        ComposerBlock(text: "two", quoteLevel: 0, fileNames: []),
        ComposerBlock(text: "On Monday, X wrote:", quoteLevel: 1, fileNames: ["quoted.png"]),
      ])
    let b = FakeComposer(subject: "Hello")
    let listed = MailComposer.listing([a, b])
    let handles = listed.compactMap { $0["composer"] as? String }
    check("two same-titled windows list as two entries", listed.count == 2)
    check(
      "with distinct handles", Set(handles).count == 2 && handles.allSatisfy { $0.hasPrefix("mc-") }
    )
    check(
      "own text joins blocks with newlines, stopping at the quote",
      listed[0]["text"] as? String == "one\ntwo")
    check("quoted is true when a quote follows", listed[0]["quoted"] as? Bool == true)
    check("files come from own blocks only", listed[0]["files"] as? [String] == ["a.pdf"])
    check("recipients are listed", listed[0]["recipients"] as? [String] == ["Ann", "Bob"])
    check("an empty composer is not quoted", listed[1]["quoted"] as? Bool == false)
    check(
      "registering the same window again keeps its handle",
      MailComposer.register([b, a]) == [handles[1], handles[0]])
    check("resolve returns the window", MailComposer.resolve(handles[0]) === a)

    let odd = FakeComposer(
      subject: "Odd",
      body: [
        ComposerBlock(text: "kept", quoteLevel: 0, fileNames: []),
        ComposerBlock(text: "unknown", quoteLevel: nil, fileNames: []),
        ComposerBlock(text: "later", quoteLevel: 0, fileNames: []),
      ])
    let oddEntry = MailComposer.listing([odd])[0]
    check("an unreadable level makes quoted null", oddEntry["quoted"] is NSNull)
    check("and own text stops before that block", oddEntry["text"] as? String == "kept")

    // The sender, the split recipients, the quote and the front window.
    let rich = FakeComposer(
      subject: "Rich", recipients: ["Ann"],
      body: [
        ComposerBlock(text: "mine", quoteLevel: 0, fileNames: []),
        ComposerBlock(text: "On Monday, X wrote:", quoteLevel: 1, fileNames: []),
        ComposerBlock(text: "the original text", quoteLevel: 1, fileNames: []),
      ])
    rich.cc = ["Cy"]
    rich.bcc = []
    rich.from = "Me – me@example.com"
    rich.isMain = true
    let full = MailComposer.listing([rich])[0]
    check(
      "from, main, to and cc are listed",
      full["from"] as? String == "Me – me@example.com" && full["main"] as? Bool == true
        && full["to"] as? [String] == ["Ann"] && full["cc"] as? [String] == ["Cy"])
    check("recipients stay to plus cc", full["recipients"] as? [String] == ["Ann", "Cy"])
    check("a shown but empty bcc is an empty list", full["bcc"] as? [String] == [])
    check(
      "the quote is every block from the boundary, joined",
      full["quote"] as? String == "On Monday, X wrote:\nthe original text"
        && full["quoteTruncated"] as? Bool == false)
    let cut = MailComposer.listing([rich], quoteChars: 10)[0]
    check(
      "a quote past quoteChars is cut and says so",
      cut["quote"] as? String == "On Monday," && cut["quoteTruncated"] as? Bool == true)
    let none = MailComposer.listing([rich], quoteChars: 0)[0]
    check(
      "quoteChars 0 means no quote",
      none["quote"] is NSNull && none["quoteTruncated"] as? Bool == false)
    check("a hidden bcc is null", listed[1]["bcc"] is NSNull && listed[1]["from"] is NSNull)
    check("an unquoted window has no quote", listed[1]["quote"] is NSNull)
    check("an unreadable level has no quote", oddEntry["quote"] is NSNull)

    a.isAlive = false
    check("a dead window no longer resolves", MailComposer.resolve(handles[0]) == nil)
    check("the other still does", MailComposer.resolve(handles[1]) === b)
    check("an unknown handle does not resolve", MailComposer.resolve("mc-9999") == nil)
    let c = FakeComposer(subject: "New")
    let fresh = MailComposer.register([c])[0]
    check("handle numbers are never reused", !handles.contains(fresh) && fresh != "mc-1")
  }

  typealias Request = MailComposer.EditRequest

  /// One edit against a fake, with a short read-back so a refusal at step 10
  /// does not hold the run for five seconds.
  static func run(
    _ fake: EditFake, _ request: Request, board: FakeBoard = FakeBoard(),
    front: FakeFront = FakeFront(), grace: TimeInterval = 0.3
  ) -> (result: [String: Any], board: FakeBoard, front: FakeFront) {
    let result = MailComposer.edit(
      fake, request: request, board: board, front: front, readbackTimeout: 0.2,
      filesTimeout: 0.2, grace: grace, tabTimeout: 0.6, saveTimeout: 0.4)
    return (result, board, front)
  }

  static func capability(_ result: [String: Any]) -> String? {
    result["replaced"] as? Bool == false ? result["capability"] as? String : nil
  }

  /// Refused before step 8: nothing pasted, the board never borrowed, Mail never
  /// brought forward, nothing saved.
  static func untouched(_ fake: EditFake, _ board: FakeBoard, _ front: FakeFront) -> Bool {
    fake.pasted.isEmpty && board.writes.isEmpty && board.snapshots == 0
      && !fake.log.contains("activate") && fake.saves == 0 && front.given.isEmpty
  }

  /// Refused after step 8: the board and the front are handed back, nothing saved.
  static func handedBack(_ fake: EditFake, _ board: FakeBoard, _ front: FakeFront) -> Bool {
    board.restores == (board.writes.isEmpty ? 0 : 1) && board.untouchedOrRestored
      && front.given == [4242] && fake.saves == 0
  }

  /// `a` happened, and before the first `b`.
  static func before(_ a: String, _ b: String, in log: [String]) -> Bool {
    guard let i = log.firstIndex(of: a), let j = log.firstIndex(of: b) else { return false }
    return i < j
  }

  static func tempFile(_ name: String) -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("mail-composer-check-\(getpid())")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent(name)
    FileManager.default.createFile(atPath: url.path, contents: Data("x".utf8))
    return url
  }

  static func editChecks() {
    print("\nedit")

    // The happy path: body over own text, quote left alone.
    do {
      let fake = EditFake(own: "Old line one\nOld line two")
      let (result, board, front) = run(fake, Request(body: "New text"))
      check("a body replaces own text", result["replaced"] as? Bool == true)
      check("and says how", result["method"] as? String == "inPlace")
      check("the text read back is the new text", result["text"] as? String == "New text")
      check("the quote is kept", result["quoteKept"] as? Bool == true)
      check("the quote is untouched", fake.quote == ["On Monday, Ann wrote:", "Hi"])
      check("it is saved", result["saved"] as? Bool == true && fake.saves == 1)
      check("no files were added", result["filesAdded"] as? [String] == [])
      check("the board is restored after success", board.restores == 1 && board.untouchedOrRestored)
      check("the front goes back to the app that had it after success", front.given == [4242])
      check("the paste was the body, as text", board.writes == [.text("New text")])
      check(
        "Mail is activated once, after the selection is checked",
        fake.log.filter { $0 == "activate" }.count == 1
          && before("select", "activate", in: fake.log))
      check("saved only after the paste", before("paste", "save", in: fake.log))
    }

    // Review Focus 1: the person types between selection and paste.
    do {
      let fake = EditFake(own: "Old")
      fake.onPaste = { $0.own += " and what they typed" }
      let (result, board, front) = run(fake, Request(body: "New"))
      check(
        "a read-back that differs is refused as confirmation", capability(result) == "confirmation")
      check("and save is never called", fake.saves == 0 && !fake.log.contains("save"))
      check(
        "the refusal says it was not saved",
        (result["reason"] as? String ?? "").lowercased().contains("this did not save it"))
      check(
        "the board is restored after a step-10 refusal",
        board.restores == 1 && board.untouchedOrRestored)
      check("the front goes back after a step-10 refusal (RF5)", front.given == [4242])
    }

    // Review Focus 3: non-ASCII round-trips exactly.
    do {
      let body = "Désolé — ça marche 👍"
      let fake = EditFake(own: "Old")
      let (result, board, _) = run(fake, Request(body: body))
      check("a non-ASCII body reads back equal", result["text"] as? String == body)
      check("byte for byte in the window", fake.own == body)
      check("and went on the board unchanged", board.writes == [.text(body)])
    }

    // Mail's line breaks differ from the caller's: compared folded.
    do {
      let fake = EditFake(own: "Old")
      fake.onPaste = { $0.own = $0.own.replacingOccurrences(of: " ", with: "\n") }
      let (result, _, _) = run(fake, Request(body: "one two"))
      check(
        "a read-back differing only in line breaks is accepted", result["replaced"] as? Bool == true
      )
    }

    // Olivier's call: a body over own text holding files.
    do {
      let fake = EditFake(own: "See attached", files: ["a.pdf"])
      let (result, board, front) = run(fake, Request(body: "New"))
      check("a body over own files is refused as files", capability(result) == "files")
      check("naming the file", (result["reason"] as? String ?? "").contains("a.pdf"))
      check("and nothing is pasted", untouched(fake, board, front))
    }

    // Edits that cannot be placed.
    do {
      let fake = EditFake(own: "one two")
      let (result, board, front) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "three", replace: "3")]))
      check("an edit not found is refused as edits", capability(result) == "edits")
      check("echoing its find", result["find"] as? String == "three")
      check("with nothing pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "one one")
      let (result, board, front) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "one", replace: "1")]))
      check("an ambiguous edit is refused as edits", capability(result) == "edits")
      check(
        "echoing its find and count",
        result["find"] as? String == "one" && result["count"] as? Int == 2)
      check("with nothing pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "a b c")
      let (result, board, front) = run(
        fake,
        Request(edits: [
          MailComposerText.Edit(find: "a b", replace: "x"),
          MailComposerText.Edit(find: "b c", replace: "y"),
        ]))
      check("overlapping edits are refused as edits", capability(result) == "edits")
      check("with nothing pasted", untouched(fake, board, front))
    }

    // The old sameDraft.
    do {
      let fake = EditFake(own: "Dear Ann,\nthe plans")
      let (result, board, front) = run(
        fake, Request(body: "New", expectHead: "Dear Bob, the plans"))
      check("an expectHead mismatch is refused as identity", capability(result) == "identity")
      check("with nothing pasted", untouched(fake, board, front))
      let (ok, _, _) = run(
        EditFake(own: "Dear Ann,\nthe plans"), Request(body: "New", expectHead: "Dear Ann,  the"))
      check("an expectHead differing only in whitespace passes", ok["replaced"] as? Bool == true)
    }

    // The quote goes with the paste.
    do {
      let fake = EditFake(own: "Old")
      fake.onPaste = { $0.quote = [] }
      let (result, board, front) = run(fake, Request(body: "New"))
      check(
        "a quote gone after the paste is refused as confirmation",
        capability(result) == "confirmation")
      check("and not saved, board and front handed back", handedBack(fake, board, front))
      let edited = EditFake(own: "Old")
      edited.onPaste = { $0.quote[1] = "Hi, changed" }
      let (changed, _, _) = run(edited, Request(body: "New"))
      check(
        "a quote changed by the paste is refused too",
        capability(changed) == "confirmation" && edited.saves == 0)
    }

    // The checks before anything destructive.
    do {
      let fake = EditFake(own: "Old")
      fake.isAlive = false
      let (result, board, front) = run(fake, Request(body: "New"))
      check("a dead window is a composer refusal", capability(result) == "composer")
      check("with nothing pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Old")
      fake.unreadableLevel = true
      let (result, board, front) = run(fake, Request(body: "New"))
      check("an unreadable quote level is refused", capability(result) == "selection")
      check("with nothing pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Old text")
      fake.rangeText = "Old text and more"
      let (result, board, front) = run(fake, Request(body: "New"))
      check("a marker range that is not the own text is refused", capability(result) == "selection")
      check("with nothing pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Old text")
      fake.readBack = { _ in "Old text\nOn Monday, Ann wrote:" }
      let (result, board, front) = run(fake, Request(body: "New"))
      check(
        "a selection that reads back wider than own text is refused",
        capability(result) == "selection")
      check("with nothing pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Old")
      let missing = URL(fileURLWithPath: "/nonexistent/mail-composer-check/b.pdf")
      let (result, board, front) = run(fake, Request(body: "New", files: [missing]))
      check("a missing attachment is refused as files", capability(result) == "files")
      check("naming it", (result["reason"] as? String ?? "").contains("b.pdf"))
      check("with nothing pasted", untouched(fake, board, front))
    }

    // Refusals after step 8 each hand the board and the front back.
    do {
      let fake = EditFake(own: "Old")
      fake.activates = false
      let (result, board, front) = run(fake, Request(body: "New"))
      check(
        "Mail that will not come forward is a composer refusal", capability(result) == "composer")
      check(
        "nothing pasted, board and front handed back",
        fake.pasted.isEmpty && handedBack(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Old")
      fake.pasteTakes = false
      let (result, board, front) = run(fake, Request(body: "New"))
      check("a paste Mail will not take is a composer refusal", capability(result) == "composer")
      check("board and front handed back", handedBack(fake, board, front))
    }
    do {
      // Right before activation the selection read fine; after it, it does not.
      let fake = EditFake(own: "Old")
      var reads = 0
      fake.readBack = { meant in
        reads += 1
        return reads == 1 ? meant : "something else"
      }
      let (result, board, front) = run(fake, Request(body: "New"))
      check(
        "a selection lost on activation is refused before the paste",
        capability(result) == "selection")
      check(
        "nothing pasted, board and front handed back",
        fake.pasted.isEmpty && handedBack(fake, board, front))
    }

    // Ruling 4: a reply with nothing written yet.
    do {
      let fake = EditFake(own: "")
      let (result, _, _) = run(fake, Request(body: "Thanks!"))
      check("a body goes into an empty reply", result["replaced"] as? Bool == true)
      check("above the quote", fake.own == "Thanks!" && result["quoteKept"] as? Bool == true)
    }

    // Sub-range edits, highest offset first, each one gated.
    do {
      let fake = EditFake(own: "Hello Ann,\nsee you Monday at noon.")
      let (result, board, front) = run(
        fake,
        Request(edits: [
          MailComposerText.Edit(find: "Ann", replace: "Anne"),
          MailComposerText.Edit(find: "Monday at", replace: "Tuesday   at"),
        ]))
      check(
        "edits replace only their matches", fake.own == "Hello Anne,\nsee you Tuesday   at noon.")
      check("and report the text read back", result["text"] as? String == fake.own)
      check(
        "the later match is pasted first",
        board.writes == [.text("Tuesday   at"), .text("Anne")])
      check(
        "Mail is activated once for every paste", fake.log.filter { $0 == "activate" }.count == 1)
      check(
        "saved, board and front handed back",
        result["saved"] as? Bool == true && board.untouchedOrRestored && front.given == [4242])
      check(
        "every selection is checked before the first paste",
        fake.log.prefix(while: { $0 != "activate" }).filter { $0 == "select" }.count == 2)
    }
    do {
      let fake = EditFake(own: "Hello Ann,\nsee you Monday.")
      fake.readBack = { $0 == "Ann" ? "Ann," : $0 }
      let (result, board, front) = run(
        fake,
        Request(edits: [
          MailComposerText.Edit(find: "Ann", replace: "Anne"),
          MailComposerText.Edit(find: "Monday", replace: "Tuesday"),
        ]))
      check(
        "a sub-range that reads back wrong is refused as selection",
        capability(result) == "selection")
      check("before any paste, even of the edit that read fine", untouched(fake, board, front))
    }
    do {
      // Both read fine before activation; the second fails after the first paste.
      let fake = EditFake(own: "Hello Ann,\nsee you Monday.")
      var annReads = 0
      fake.readBack = { meant in
        guard meant == "Ann" else { return meant }
        annReads += 1
        return annReads == 1 ? meant : "nn,"
      }
      let (result, board, front) = run(
        fake,
        Request(edits: [
          MailComposerText.Edit(find: "Ann", replace: "Anne"),
          MailComposerText.Edit(find: "Monday", replace: "Tuesday"),
        ]))
      check("a gate failing mid-way is refused as selection", capability(result) == "selection")
      check("with no paste after it", board.writes == [.text("Tuesday")] && fake.pasted.count == 1)
      check(
        "saying an earlier edit is in the window unsaved",
        (result["reason"] as? String ?? "").lowercased().contains("this did not save it"))
      check("board and front handed back, not saved", handedBack(fake, board, front))
    }
    do {
      let fake = EditFake(own: "one two")
      fake.onPaste = { $0.own += "!" }
      let (result, board, front) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "two", replace: "2")]))
      check(
        "an edit that does not read back is refused as confirmation",
        capability(result) == "confirmation")
      check("not saved, board and front handed back", handedBack(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Désolé, ça ne marche pas")
      let (result, _, _) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "ne marche pas", replace: "marche 👍")]))
      check(
        "a non-ASCII edit lands exactly",
        fake.own == "Désolé, ça marche 👍" && result["replaced"] as? Bool == true)
    }
    do {
      let fake = EditFake(own: "See attached", files: ["a.pdf"])
      let (result, _, _) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "See", replace: "Find")]))
      check("an edit over own text holding files is allowed", result["replaced"] as? Bool == true)
      check("and leaves the file", fake.ownFiles == ["a.pdf"] && fake.own == "Find attached")
    }

    // Files, after the text, at the end of own text.
    do {
      let pdf = tempFile("c.pdf")
      let fake = EditFake(own: "Old")
      let (result, board, front) = run(fake, Request(body: "Here it is", files: [pdf]))
      check(
        "files are pasted after the text", board.writes == [.text("Here it is"), .files([pdf])])
      check("at a collapsed selection at the end of own text", fake.log.contains("select-end"))
      check(
        "and reported",
        result["filesAdded"] as? [String] == ["c.pdf"] && result["saved"] as? Bool == true)
      check("board and front handed back", board.untouchedOrRestored && front.given == [4242])
      let ignored = EditFake(own: "Old")
      ignored.ignoresFiles = true
      let (missed, missedBoard, missedFront) = run(ignored, Request(body: "Here", files: [pdf]))
      check(
        "files that never show are refused as confirmation", capability(missed) == "confirmation")
      check("not saved, board and front handed back", handedBack(ignored, missedBoard, missedFront))
      let alone = EditFake(own: "Kept")
      let (only, onlyBoard, _) = run(alone, Request(files: [pdf]))
      check(
        "files alone leave the text as it is",
        only["replaced"] as? Bool == true && alone.own == "Kept")
      check("and paste only the files", onlyBoard.writes == [.files([pdf])])
    }

    // Saving.
    do {
      let fake = EditFake(own: "Old")
      let (result, _, _) = run(fake, Request(body: "New", save: false))
      check("save: false does not save", result["saved"] as? Bool == false && fake.saves == 0)
      let gone = EditFake(own: "Old")
      gone.saveOutcome = .gone
      let (vanished, _, front) = run(gone, Request(body: "New"))
      check(
        "a window gone at save is replaced but not saved, and says so",
        vanished["replaced"] as? Bool == true && vanished["saved"] as? Bool == false
          && (vanished["note"] as? String ?? "").contains("went"))
      check("the front is still handed back", front.given == [4242])
    }

    fixRoundChecks()

    check("a busy AX read is not a dead window", AXComposerWindow.alive(after: .cannotComplete))
    check("an invalid element is", !AXComposerWindow.alive(after: .invalidUIElement))
    check("a successful read is alive", AXComposerWindow.alive(after: .success))
  }

  /// Review round 1: a read-back a paste could not have changed, an unnamed
  /// inline image, and the pasteboard around a late or lost command-V.
  static func fixRoundChecks() {
    print("\nedit: read-backs the paste must be able to change")

    // CRITICAL 1. A change only in whitespace folds equal to the text before
    // the paste, so its read-back "matches" before command-V is handled.
    do {
      let fake = EditFake(own: "That is the end.\nNext time, then.")
      fake.lagReads = 3
      let (result, board, front) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "end.\nNext", replace: "end. Next")]))
      check("a whitespace-only edit is refused as edits", capability(result) == "edits")
      check("echoing its find", result["find"] as? String == "end.\nNext")
      check("before anything is pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Fix  the double space")
      let (result, board, front) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "Fix  the", replace: "Fix the")]))
      check("fixing a double space is refused as edits", capability(result) == "edits")
      check("before anything is pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "One paragraph.\nAnother one.")
      fake.lagReads = 3
      let (result, board, front) = run(fake, Request(body: "One paragraph. Another one."))
      check("a body that only reflows the text is refused", capability(result) == "confirmation")
      check("saying why", (result["reason"] as? String ?? "").contains("whitespace"))
      check("before anything is pasted", untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Same words")
      let (result, board, _) = run(fake, Request(body: "Same words", html: "<b>Same</b> words"))
      check("an HTML body with the same text is refused too", capability(result) == "confirmation")
      check("before anything is pasted", fake.pasted.isEmpty && board.writes.isEmpty)
      let plain = EditFake(own: "Same words")
      let (unchanged, plainBoard, _) = run(plain, Request(body: "Same words"))
      check(
        "a body equal to the text pastes nothing and says so",
        unchanged["replaced"] as? Bool == true && plain.pasted.isEmpty && plainBoard.writes.isEmpty)
    }
    do {
      // A paste that lands three reads late: nothing is saved before it does.
      let fake = EditFake(own: "Old text")
      fake.lagReads = 3
      let (result, _, _) = run(fake, Request(body: "New text"))
      check(
        "a late paste is waited for", result["replaced"] as? Bool == true && fake.own == "New text")
      check("and saved only once it landed", before("landed", "save", in: fake.log))
      let edits = EditFake(own: "Hello Ann,\nsee you Monday.")
      edits.lagReads = 2
      let (both, _, _) = run(
        edits,
        Request(edits: [
          MailComposerText.Edit(find: "Ann", replace: "Anne"),
          MailComposerText.Edit(find: "Monday", replace: "Tuesday"),
        ]))
      let afterActivate = edits.log.drop { $0 != "activate" }.filter {
        ["select", "paste", "landed", "save"].contains($0)
      }
      check("late edits land each before the next is selected", both["replaced"] as? Bool == true)
      check(
        "in order: select, paste, landed, twice, then save",
        Array(afterActivate)
          == ["select", "paste", "landed", "select", "paste", "landed", "save"])
    }

    // IMPORTANT 1. An inline image with no name is still a file.
    do {
      let fake = EditFake(own: "Look:  here")
      fake.rangeText = "Look: \u{FFFC} here"
      let (result, board, front) = run(fake, Request(body: "New"))
      check(
        "a body over an unnamed inline image is refused as files", capability(result) == "files")
      check(
        "naming it as an inline image",
        (result["reason"] as? String ?? "").contains("an inline image"))
      check("before anything is pasted", untouched(fake, board, front))
    }

    // IMPORTANT 2a. The person copies something during the edit.
    do {
      let board = FakeBoard()
      let fake = EditFake(own: "Old")
      fake.onPaste = { _ in board.personCopies("copied mid-edit") }
      let (result, _, _) = run(fake, Request(body: "New"), board: board)
      check("an edit the person copied during still succeeds", result["replaced"] as? Bool == true)
      check(
        "and their copy is not clobbered by the restore",
        board.contents == ["copied mid-edit"] && board.restores == 0)
      let refused = EditFake(own: "Old")
      refused.activates = false
      let (_, untouchedBoard, _) = run(refused, Request(body: "New"))
      check(
        "a board never written is never restored",
        untouchedBoard.restores == 0 && untouchedBoard.snapshots == 0)
    }

    // IMPORTANT 2b. A command-V Mail may still handle after the timeout.
    do {
      // Mail answered nothing: the board holds our text through the grace.
      let fake = EditFake(own: "Old")
      fake.hangsFor = 60
      fake.pasteLost = true
      let started = Date()
      let (result, board, front) = run(fake, Request(body: "New"), grace: 0.4)
      let took = Date().timeIntervalSince(started)
      check("a hung Mail is a confirmation refusal", capability(result) == "confirmation")
      check("the board is held through the grace before it is restored", took >= 0.55)
      check("and then restored, front handed back", handedBack(fake, board, front))
    }
    do {
      // Mail comes back during the grace: restored once it answers.
      let fake = EditFake(own: "Old")
      fake.hangsFor = 0.35
      fake.pasteLost = true
      var readsAtRestore: [String] = []
      let board = FakeBoard()
      board.onRestore = { readsAtRestore = fake.log.filter { $0.hasPrefix("read") } }
      let started = Date()
      let (result, _, _) = run(fake, Request(body: "New"), board: board, grace: 3)
      let took = Date().timeIntervalSince(started)
      check("a Mail that hangs past the read-back is refused", capability(result) == "confirmation")
      check(
        "the board is restored only after Mail answered a read",
        readsAtRestore.last == "read" && readsAtRestore.contains("read-hung"))
      check("and without waiting out the whole grace", took < 2)
    }
    do {
      // Mail answered and the text never moved: the keystroke went nowhere.
      let fake = EditFake(own: "Old")
      fake.pasteLost = true
      let started = Date()
      let (result, board, _) = run(fake, Request(body: "New"), grace: 3)
      check("a lost paste is refused as confirmation", capability(result) == "confirmation")
      check(
        "and the board restored at once",
        Date().timeIntervalSince(started) < 1.5 && board.untouchedOrRestored
          && board.restores == 1)
    }

    // Round 2. A write that clears the board and then throws.
    do {
      let board = FakeBoard()
      board.refuses = { _ in true }
      let fake = EditFake(own: "Old")
      let (result, _, front) = run(fake, Request(body: "New"), board: board)
      check("a first write that fails is a composer refusal", capability(result) == "composer")
      check("with nothing pasted", fake.pasted.isEmpty)
      check(
        "and the person's clipboard restored after it",
        board.contents == ["the person's clipboard"] && board.restores == 1
          && front.given == [4242])
    }
    do {
      let pdf = tempFile("d.pdf")
      let board = FakeBoard()
      board.refuses = { if case .files = $0 { return true } else { return false } }
      let fake = EditFake(own: "Old")
      let (result, _, _) = run(fake, Request(body: "New", files: [pdf]), board: board)
      check(
        "a files write failing after the body is a refusal, not saved",
        capability(result) == "composer" && fake.saves == 0)
      check(
        "and the person's clipboard restored after it",
        board.contents == ["the person's clipboard"] && board.restores == 1)
    }

    // IMPORTANT 2c. Nothing read the draft on disk back.
    do {
      let fake = EditFake(own: "Old")
      fake.onPaste = { $0.own += " typed" }
      let (result, _, _) = run(fake, Request(body: "New"))
      let reason = result["reason"] as? String ?? ""
      check(
        "a refusal says this did not save it, not what the disk holds",
        reason.lowercased().contains("this did not save it") && !reason.contains("on disk"))
    }

    // A window that closes under the paste is named as closed.
    do {
      let fake = EditFake(own: "Old")
      fake.pasteLost = true
      fake.diesOnPaste = true
      let (result, _, _) = run(fake, Request(body: "New"))
      check(
        "a window gone during the read-back is named as closed",
        capability(result) == "confirmation"
          && (result["reason"] as? String ?? "").contains("closed"))
    }
  }

  static let surface = Surface.named("desktop")!

  static func ask(
    _ method: String, params: [String: Any]? = nil, writes: Bool, scope: AccessibilityDriver.Scope
  ) -> [String: Any]? {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": 1, "method": method]
    if let params { message["params"] = params }
    let line = String(data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard
      let reply = DesktopServer.handle(line, surface: surface, writesAllowed: writes, scope: scope),
      let data = reply.data(using: .utf8)
    else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  static func call(
    _ name: String, args: [String: Any] = [:], writes: Bool, scope: AccessibilityDriver.Scope
  ) -> (String, Bool) {
    let reply = ask(
      "tools/call", params: ["name": name, "arguments": args], writes: writes, scope: scope)
    let result = reply?["result"] as? [String: Any]
    let text = ((result?["content"] as? [[String: Any]])?.first?["text"] as? String) ?? ""
    return (text, result?["isError"] as? Bool ?? false)
  }

  /// The front, as the window server reports it, around one edit and between
  /// two. LIVE RUN 1 (2026-10-26) refused a forward with "Mail is no longer
  /// frontmost" while LaunchServices had Mail in front for the whole edit, so
  /// these play a read that answers wrong for a moment, a hand-back that lands
  /// late, and the person moving to another app, which must still refuse.
  static func frontChecks() {
    print("\nthe front, as the window server reports it")
    let mail = "com.apple.mail"
    let code = "com.microsoft.VSCode"

    // The check under every keystroke, `announceSessionInput`, played through
    // `confirmFront`. A throw is a refusal: nothing is posted.
    struct Confirmed {
      var posted = false
      var text = ""
      var logs: [String] = []
      var elapsed: TimeInterval = 0
    }
    func confirm(
      _ screen: FakeScreen, grace: TimeInterval = 0.4, still: @escaping () -> Bool = { true },
      stopped: Bool = false
    ) -> Confirmed {
      var out = Confirmed()
      let started = Date()
      do {
        try AccessibilityDriver.confirmFront(
          mail, grace: grace, read: screen.read, isRegularApp: screen.isRegular, still: still,
          stillDriving: {
            if stopped { throw AccessibilityDriver.Failure.refused("stopped part of the way") }
          },
          log: { out.logs.append($0) })
        out.posted = true
      } catch AccessibilityDriver.Failure.refused(let text) {
        out.text = text
      } catch {
        out.text = "\(error)"
      }
      out.elapsed = Date().timeIntervalSince(started)
      return out
    }
    do {
      let screen = FakeScreen(mail)
      let result = confirm(screen)
      check(
        "Mail in front at the first read posts at once, unlogged",
        result.posted && screen.reads == 1 && result.logs.isEmpty)
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = [nil, nil]
      let result = confirm(screen)
      check("a read with no answer, then Mail, posts", result.posted)
      check(
        "and the wait is logged with the first wrong read, though it posted",
        result.logs.count == 1 && result.logs[0].contains("first answered no answer")
          && result.logs[0].contains("posting"))
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = ["com.apple.WebKit.WebContent", nil]
      let result = confirm(screen)
      check("a helper process read, then Mail, posts", result.posted)
      check(
        "and the log names the helper",
        result.logs.first?.contains("com.apple.WebKit.WebContent") == true)
    }
    do {
      let screen = FakeScreen(code)
      let result = confirm(screen)
      check("another regular app in front refuses", !result.posted)
      check("at once, with no wait", result.elapsed < 0.1 && screen.reads == 1)
      check("naming it", result.text.contains(code))
    }
    do {
      // The person flicks to their editor and back into Mail inside the grace.
      let screen = FakeScreen(mail)
      screen.script = [nil, code, code]
      let result = confirm(screen)
      check("a switch and return through a regular app is refused", !result.posted)
      check(
        "and the refusal reports the FIRST wrong read, then what came after",
        result.text.contains("could not say") && result.text.contains(code))
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = [nil, nil]
      let result = confirm(screen, still: { false })
      check("the composer losing its focus during a wait is refused", !result.posted)
      check("saying so", result.text.contains("no longer had the focus"))
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = [nil, nil]
      let result = confirm(screen, stopped: true)
      check(
        "Stop pressed during a wait posts nothing",
        !result.posted && result.text.contains("stopped"))
    }
    do {
      let screen = FakeScreen(nil)
      let result = confirm(screen, grace: 0.3)
      check("a front that never answers refuses", !result.posted)
      check("once the grace has run out", result.elapsed >= 0.3)
      check("and the refusal is logged", result.logs.first?.contains("refused") == true)
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = (0..<60).map { $0 % 2 == 0 ? nil : mail }
      check("a front that keeps flickering is never taken as Mail's", !confirm(screen).posted)
    }

    // Activation, `AXComposerWindow.activate`.
    do {
      let screen = FakeScreen(code)
      screen.lag = 3
      _ = screen.activate(mail)
      let settled = AXComposerWindow.settled(
        timeout: 1, focused: { true }, frontmost: screen.read)
      check(
        "activation waits until Mail holds the front, not only the window's focus",
        settled && screen.front == mail)
    }
    do {
      // The previous edit's hand-back, landing while this one activates.
      let screen = FakeScreen(mail)
      screen.lag = 2
      _ = screen.activate(code)
      check(
        "a hand-back landing during activation is not pasted over",
        !AXComposerWindow.settled(timeout: 0.4, focused: { true }, frontmost: screen.read))
    }
    do {
      let screen = FakeScreen(mail)
      check(
        "a window that is not Mail's focused one is not settled",
        !AXComposerWindow.settled(timeout: 0.3, focused: { false }, frontmost: screen.read))
    }

    // The hand-back at the end of an edit, `LiveFront.give`.
    do {
      let screen = FakeScreen(mail)
      screen.lag = 4
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate,
        isRegularApp: screen.isRegular)
      check(
        "the hand-back is waited for until it lands", outcome == .landed && screen.front == code)
      // The next edit brings Mail forward: nothing of this hand-back is left to land.
      screen.front = mail
      check(
        "so a late hand-back cannot land in the next edit",
        AXComposerWindow.settled(timeout: 0.5, focused: { true }, frontmost: screen.read))
      check("and the front was asked for once", screen.activations == [code])
    }
    do {
      // LIVE RUN 1 again: the read gating the hand-back answered wrong, and the
      // person's editor stayed behind Mail until the session ended 11 s later.
      let screen = FakeScreen(mail)
      screen.script = [nil, nil]
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate,
        isRegularApp: screen.isRegular)
      check(
        "a wrong read does not skip the hand-back", outcome == .landed && screen.front == code)
    }
    do {
      let screen = FakeScreen("com.apple.Notes")
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate,
        isRegularApp: screen.isRegular, grace: 0.2)
      check(
        "a person who moved to another app is left there, at once",
        outcome == .leftAlone && screen.activations.isEmpty && screen.reads <= 2)
    }
    do {
      let screen = FakeScreen(code)
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate,
        isRegularApp: screen.isRegular)
      check(
        "nothing is handed back to an app already in front",
        outcome == .alreadyThere && screen.activations.isEmpty)
    }
    do {
      let screen = FakeScreen(mail)
      screen.lag = 10_000
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate,
        isRegularApp: screen.isRegular, timeout: 0.3)
      check("a hand-back that never lands says so", outcome == .didNotLand)
      check("and is asked for once", screen.activations == [code])
    }

    // One hand-back per edit, whichever way it ends.
    do {
      let done = EditFake(own: "Old")
      let (result, _, front) = run(done, Request(body: "New"))
      check(
        "an edit that saved hands the front back once",
        result["replaced"] as? Bool == true && front.given == [4242])
      let refused = EditFake(own: "Old")
      refused.pasteTakes = false
      let (_, _, refusedFront) = run(refused, Request(body: "New"))
      check("an edit refused at the paste hands it back once", refusedFront.given == [4242])
    }
  }

  /// LIVE RUN 2 (2026-10-26): a forward's own area is a bare `<br>` Mail does not
  /// expose as a block, so its first block is the quote, and a caret placed at
  /// that block's start pasted the note INSIDE the quoted original. Mail then
  /// autosaved it. These pin the guard, the quote-text poll and the wording.
  static func quoteChecks() {
    print("\nthe quote a draft forwards or replies to")
    let forwarded = [
      "Begin forwarded message:", "From: Ann", "Subject: Project status and ETAs",
    ]

    // A forward: no own block at all, the first block is level 1.
    do {
      let fake = EditFake(own: "", quote: forwarded)
      fake.caretInQuote = true
      let (result, board, front) = run(fake, Request(body: "A note above the forward."))
      check(
        "a caret Mail places inside a forward's quote is refused as selection",
        capability(result) == "selection")
      check("with nothing pasted, borrowed or saved", untouched(fake, board, front))
      check(
        "saying the caret would land in the quote",
        (result["reason"] as? String ?? "").contains("inside the quoted original"))
    }
    do {
      let fake = EditFake(own: "", quote: forwarded)
      fake.caretInQuote = nil
      let (result, board, front) = run(fake, Request(body: "A note above the forward."))
      check(
        "a caret Mail will not place is refused the same way",
        capability(result) == "selection" && untouched(fake, board, front))
    }
    do {
      let fake = EditFake(own: "", quote: forwarded)
      let (result, _, _) = run(fake, Request(body: "A note above the forward."))
      check(
        "a forward whose caret resolves outside the quote is pasted and saved",
        result["replaced"] as? Bool == true && fake.saves == 1
          && fake.own == "A note above the forward." && fake.quote == forwarded)
      check("its selection was checked before and at the paste", fake.quoteChecks == 2)
    }
    // A reply with text of its own still works, and is checked too.
    do {
      let fake = EditFake(own: "Thanks, see below.")
      let (result, _, _) = run(fake, Request(body: "Thanks, all good."))
      check(
        "a reply with its own text is pasted and saved as before",
        result["replaced"] as? Bool == true && fake.saves == 1 && fake.quoteChecks == 2)
    }
    do {
      let fake = EditFake(own: "Meet Monday.")
      let (result, _, _) = run(
        fake, Request(edits: [MailComposerText.Edit(find: "Monday", replace: "Tuesday")]))
      check(
        "an edit's selection is checked against the quote too",
        result["replaced"] as? Bool == true && fake.quoteChecks == 2)
    }
    do {
      let fake = EditFake(own: "Here")
      let file = tempFile("q.pdf")
      fake.caretInQuote = nil
      let (result, board, front) = run(fake, Request(files: [file]))
      check(
        "the caret files go to is checked too",
        capability(result) == "selection" && untouched(fake, board, front))
    }

    // The paste went into the quote anyway: the poll sees the quote text change.
    do {
      let fake = EditFake(own: "", quote: forwarded)
      fake.landsInQuote = true
      let started = Date()
      let (result, board, front) = run(fake, Request(body: "A note above the forward."))
      let reason = result["reason"] as? String ?? ""
      check(
        "text pasted into the quote is refused as confirmation",
        capability(result) == "confirmation")
      check("and never saved", fake.saves == 0 && !fake.log.contains("save"))
      check("as soon as the quote reads differently", Date().timeIntervalSince(started) < 0.15)
      check("board and front handed back", handedBack(fake, board, front))
      check(
        "saying Mail may have autosaved it, and to check Drafts",
        reason.contains("autosaves") && reason.lowercased().contains("this did not save it")
          && (result["hint"] as? String ?? "").contains("WITHOUT saving")
          && (result["hint"] as? String ?? "").contains("Drafts"))
    }
    do {
      // A reply whose first quote block gains the pasted text.
      let fake = EditFake(own: "Old")
      fake.landsInQuote = true
      let (result, _, _) = run(fake, Request(body: "New"))
      check(
        "a reply's quote gaining the text is refused too",
        capability(result) == "confirmation" && fake.saves == 0)
    }

    // Fix round 3: a refusal between pastes says what was verified, and to
    // discard rather than retry.
    func reason(_ r: [String: Any]) -> String { r["reason"] as? String ?? "" }
    func hint(_ r: [String: Any]) -> String { r["hint"] as? String ?? "" }
    func discards(_ r: [String: Any]) -> Bool {
      hint(r).contains("WITHOUT saving") && hint(r).contains("Drafts")
        && !hint(r).contains("Try again")
    }
    do {
      let fake = EditFake(own: "Meet Ann on Monday.")
      fake.refusesPasteAfter = 1
      let (result, board, front) = run(
        fake,
        Request(edits: [
          MailComposerText.Edit(find: "Ann", replace: "Anne"),
          MailComposerText.Edit(find: "Monday", replace: "Tuesday"),
        ]))
      check(
        "the window refusing the keyboard at a second edit is a composer refusal",
        capability(result) == "composer" && fake.pasted.count == 1 && fake.saves == 0)
      check(
        "saying the first edit was pasted and read back, and nothing after it",
        reason(result).contains("The edit of \"Monday\" was pasted and read back")
          && reason(result).contains("Nothing after that was pasted")
          && reason(result).lowercased().contains("this did not save it"))
      check("telling the person to discard and check Drafts, not to retry", discards(result))
      check("board and front handed back", handedBack(fake, board, front))
    }
    do {
      let fake = EditFake(own: "Old")
      fake.refusesPasteAfter = 1
      let (result, _, _) = run(fake, Request(body: "New", files: [tempFile("late.pdf")]))
      check(
        "the window refusing the keyboard at the files, after the body, is refused",
        capability(result) == "composer" && fake.saves == 0)
      check(
        "saying the new body was pasted and read back",
        reason(result).contains("The new body was pasted and read back"))
      check("and to discard and check Drafts", discards(result))
    }
    do {
      let fake = EditFake(own: "Old")
      fake.pasteTakes = false
      let (result, _, _) = run(fake, Request(body: "New"))
      check(
        "a window refusing the very first paste still says to try again",
        hint(result).contains("Try again") && !reason(result).contains("autosave"))
    }
    do {
      // The guard passes for the body, before and at its paste, then trips at
      // the caret the files go to.
      let fake = EditFake(own: "Old")
      fake.caretScript = [false, false, true]
      let (result, board, front) = run(fake, Request(body: "New", files: [tempFile("q2.pdf")]))
      check(
        "the quote guard tripping only at the files, after the body, refuses as selection",
        capability(result) == "selection" && fake.quoteChecks == 3 && fake.saves == 0)
      check(
        "saying the body was verified and the files were not pasted",
        reason(result).contains("inside the quoted original")
          && reason(result).contains("The new body was pasted and read back")
          && reason(result).contains("Nothing after that was pasted"))
      check("and to discard and check Drafts", discards(result))
      check(
        "with only the body pasted, board and front handed back",
        fake.pasted == [.text("New")] && handedBack(fake, board, front))
    }

    // The walk the live guard takes from a caret's element up to the body.
    do {
      // 0 body; 1 own block (level 0) > 2 inline run (no level);
      // 3 a block that will not say > 4 inline; 5 quote block (1) > 6 inline;
      // 7 an element with no parent.
      let parents: [Int: Int] = [1: 0, 2: 1, 3: 0, 4: 3, 5: 0, 6: 5]
      let levels: [Int: Int] = [1: 0, 5: 1]
      func walk(_ from: Int) -> Bool? {
        AXComposerWindow.walkReachesQuote(
          from: from, isBody: { $0 == 0 }, level: { levels[$0] }, parent: { parents[$0] })
      }
      check("a caret in an own block's inline run is outside the quote", walk(2) == false)
      check("a caret on the body itself is outside the quote", walk(0) == false)
      check("a caret in a quoted block's inline run is inside it", walk(6) == true)
      check(
        "a block of the body that will not say its level is refused, not taken as level 0",
        walk(3) == nil && walk(4) == nil)
      check("a walk that never reaches the body is refused", walk(7) == nil)
    }

    // Every refusal once a paste reached Mail says Mail may have autosaved.
    do {
      let fake = EditFake(own: "Old")
      fake.onPaste = { $0.own += " and what they typed" }
      let (result, _, _) = run(fake, Request(body: "New"))
      check(
        "an unconfirmed paste says Mail may have autosaved it",
        (result["reason"] as? String ?? "").contains("autosaves")
          && (result["hint"] as? String ?? "").contains("Drafts"))
    }
    do {
      let fake = EditFake(own: "Old")
      fake.pasteLost = true
      let (result, _, _) = run(fake, Request(body: "New"))
      check(
        "so does a paste that never read back",
        (result["reason"] as? String ?? "").contains("autosaves"))
    }
    do {
      let fake = EditFake(own: "Old")
      fake.activates = false
      let (result, _, _) = run(fake, Request(body: "New"))
      check(
        "a refusal before any paste does not mention autosave",
        !(result["reason"] as? String ?? "").contains("autosave"))
    }
  }

  /// Three composers as tabs of one window: two titled "Dup" (alpha, beta),
  /// one "Other" (gamma). Beta is shown.
  static func tabbed() -> (group: FakeTabGroup, alpha: EditFake, beta: EditFake, gamma: EditFake) {
    let alpha = EditFake(own: "ALPHA text")
    alpha.subject = "Dup"
    let beta = EditFake(own: "BETA text")
    beta.subject = "Dup"
    beta.to = ["Ann"]
    beta.from = "Me – me@example.com"
    beta.isMain = true
    let gamma = EditFake(own: "GAMMA text")
    gamma.subject = "Other"
    gamma.to = ["Cy"]
    return (FakeTabGroup([alpha, beta, gamma], selected: 1), alpha, beta, gamma)
  }

  /// LIVE RUN 3 (2026-10-26): with "Prefer tabs: Always", Mail opens every
  /// composer as a tab of one window. Accessibility lists that window once,
  /// with the selected tab's content only, so a window-keyed handle followed
  /// whichever tab was selected and two same-titled tabs listed as one.
  static func tabChecks() {
    print("\ncomposers in tabs")
    func reason(_ r: [String: Any]) -> String { r["reason"] as? String ?? "" }

    // Listing: every tab, background ones with nothing read.
    do {
      let (group, alpha, beta, gamma) = tabbed()
      let alone = EditFake(own: "Alone")
      alone.subject = "Alone"
      let listed = MailComposer.listing([alpha, beta, gamma, alone])
      let handles = listed.compactMap { $0["composer"] as? String }
      check("every tab of the window is listed", listed.count == 4 && Set(handles).count == 4)
      check(
        "two tabs under one title get two handles",
        handles[0] != handles[1] && listed[0]["subject"] as? String == "Dup"
          && listed[1]["subject"] as? String == "Dup")
      let shown = listed[1]
      check(
        "the selected tab reads as before, and says it is the selected tab",
        shown["tab"] as? String == "selected" && shown["text"] as? String == "BETA text"
          && shown["quoted"] as? Bool == true && shown["to"] as? [String] == ["Ann"]
          && shown["from"] as? String == "Me – me@example.com" && shown["main"] as? Bool == true)
      for (label, entry) in [("alpha", listed[0]), ("gamma", listed[2])] {
        check(
          "a background tab (\(label)) gives its title and nothing it cannot read",
          entry["tab"] as? String == "background" && entry["text"] is NSNull
            && entry["quote"] is NSNull && entry["quoted"] is NSNull
            && entry["recipients"] is NSNull && entry["from"] is NSNull && entry["to"] is NSNull
            && entry["cc"] is NSNull && entry["bcc"] is NSNull
            && entry["files"] as? [String] == [] && entry["main"] as? Bool == false
            && entry["quoteTruncated"] as? Bool == false)
      }
      check("gamma's title is its subject", listed[2]["subject"] as? String == "Other")
      check("an untabbed window says tab null", listed[3]["tab"] is NSNull)
      check(
        "listing switched no tab and read the window once, for the selected tab",
        group.presses.isEmpty && group.selected == 1
          && group.events.filter { $0.hasSuffix(":read") } == ["1:read"])
      check(
        "listing again keeps every tab's handle",
        MailComposer.register([gamma, alpha, beta]) == [handles[2], handles[0], handles[1]])
      check("a tab's handle resolves to that tab", MailComposer.resolve(handles[2]) === gamma)
      group.selected = 2
      let again = MailComposer.listing([alpha, beta, gamma])
      check(
        "once another tab is selected, the handles stay with their tabs",
        again.compactMap { $0["composer"] as? String } == Array(handles.prefix(3))
          && again[1]["tab"] as? String == "background"
          && again[2]["tab"] as? String == "selected"
          && again[2]["text"] as? String == "GAMMA text")
      let none = tabbed()
      none.group.valueAnswers = false
      let blind = MailComposer.listing([none.alpha, none.beta, none.gamma])
      check(
        "tabs none of which reads as selected all list as background, with nothing read",
        blind.allSatisfy { $0["tab"] as? String == "background" && $0["text"] is NSNull }
          && none.group.events.isEmpty)
    }

    // A front that answers Mail's pid while Mail is in front, and puts Mail
    // in the background when it is handed back.
    func tabRun(_ group: FakeTabGroup, _ fake: EditFake, _ request: Request)
      -> (result: [String: Any], board: FakeBoard, front: FakeFront)
    {
      let front = FakeFront()
      front.mailFront = { group.mailFront }
      front.onGive = {
        group.events.append("front given back")
        group.mailFront = false
      }
      return run(fake, request, front: front)
    }
    // Refused once Mail was brought forward: nothing pasted, borrowed or
    // saved, and the front handed back to the app that had it, not to Mail.
    func backedOut(
      _ fakes: [EditFake], _ group: FakeTabGroup, _ board: FakeBoard, _ front: FakeFront
    )
      -> Bool
    {
      fakes.allSatisfy { $0.pasted.isEmpty && $0.saves == 0 } && board.writes.isEmpty
        && board.snapshots == 0 && front.given == [4242] && !group.mailFront
    }

    // LIVE RUN 4: the flag flips with Mail in the background, the content does not.
    do {
      let (group, _, _, gamma) = tabbed()
      _ = group.press(gamma)
      let stuck = (0..<5).map { _ in group.state(of: gamma) }
      check(
        "the fake: a tab pressed with Mail in the background is flagged but never shown",
        group.flagged == 2 && group.content == 1 && stuck.allSatisfy { $0 == .background })
      _ = group.forward()
      _ = group.press(gamma)
      check(
        "the fake: pressed with Mail in front, it is shown", group.state(of: gamma) == .selected)
    }

    // Editing a background tab: Mail forward, select, verify, edit, save,
    // reselect, front back.
    do {
      let (group, _, beta, gamma) = tabbed()
      group.selectLag = 3
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a background tab is edited and saved",
        result["replaced"] as? Bool == true && result["saved"] as? Bool == true
          && gamma.own == "New gamma" && gamma.saves == 1)
      check(
        "Mail is brought forward before its tab is pressed, and nothing is read before both",
        group.events.prefix(3) == ["2:forward", "forward", "press 2"]
          && !group.events.contains { $0.contains("Mail in the background") }
          && group.events.dropFirst(3).first == "2:read")
      check(
        "Mail is brought forward once: the paste only focuses the window",
        group.events.filter { $0 == "forward" }.count == 1
          && !group.events.contains { $0.hasSuffix(":activate") }
          && group.events.contains("2:focus"))
      check(
        "the front read before Mail came forward is the one handed back",
        front.given == [4242])
      // The hand-back's press lands as late as the first one did.
      for _ in 0..<3 { _ = group.state(of: beta) }
      check(
        "the shown tab is selected again while Mail is in front, before the front goes back",
        group.presses == [2, 1] && group.content == 1 && group.flagged == 1
          && (group.events.firstIndex(of: "press 1") ?? 0)
            > (group.events.firstIndex(of: "2:save") ?? Int.max)
          && (group.events.firstIndex(of: "front given back") ?? 0)
            > (group.events.firstIndex(of: "press 1") ?? Int.max)
      )
      check(
        "the other tabs are untouched",
        beta.own == "BETA text" && beta.pasted.isEmpty && beta.saves == 0
          && board.untouchedOrRestored)
    }
    do {
      let (group, alpha, beta, _) = tabbed()
      let (result, _, _) = tabRun(
        group, alpha, Request(body: "New alpha", expectHead: "ALPHA text"))
      check(
        "a background tab sharing its title is edited once expectHead proves it",
        result["replaced"] as? Bool == true && alpha.own == "New alpha"
          && beta.own == "BETA text" && group.presses == [0, 1])
    }
    do {
      let (group, _, beta, _) = tabbed()
      let (result, _, _) = tabRun(group, beta, Request(body: "New beta"))
      check(
        "the selected tab is edited with no press and no early bring-forward",
        result["replaced"] as? Bool == true && beta.own == "New beta" && group.presses.isEmpty
          && !group.events.contains("forward"))
    }

    // Review Minor (a): two tabs under one title, the flag flipped and the
    // content not swapped. The title still matches, and so does an expectHead
    // naming what the window still shows: only the body element can tell.
    do {
      let (group, alpha, beta, _) = tabbed()
      group.contentSwaps = false
      let (result, board, front) = tabRun(
        group, alpha, Request(body: "Into the wrong draft", expectHead: "BETA text"))
      check(
        "a same-titled tab whose content never swapped is refused as composer",
        capability(result) == "composer" && beta.own == "BETA text" && alpha.own == "ALPHA text")
      check(
        "with nothing pasted into the draft the window still shows",
        backedOut([alpha, beta], group, board, front)
          && group.events.allSatisfy { !$0.hasSuffix(":read") })
      check(
        "and the flag put back on the shown tab", group.presses == [0, 1] && group.flagged == 1)
    }

    // A tab that will not come up.
    for (label, setUp) in [
      ("AXPress does not select it", { (g: FakeTabGroup) in g.pressSelects = false }),
      ("it never reads as selected", { (g: FakeTabGroup) in g.valueAnswers = false }),
      ("it selects too late", { (g: FakeTabGroup) in g.selectLag = 1000 }),
    ] {
      let (group, alpha, beta, gamma) = tabbed()
      setUp(group)
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a tab that will not come up is refused as composer (\(label))",
        capability(result) == "composer" && reason(result).contains("tab"))
      check(
        "with nothing read, pasted, borrowed or saved, and the front handed back (\(label))",
        backedOut([alpha, beta, gamma], group, board, front)
          && group.events.allSatisfy { !$0.hasSuffix(":read") })
      check(
        "its flag put back only if it moved and a tab read as shown before (\(label))",
        group.presses == (label == "it selects too late" ? [2, 1] : [2])
          // With no tab answering AXValue there was no shown tab to go back to.
          && group.content == (label == "it never reads as selected" ? 2 : 1))
    }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.pressRefused = true
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a tab that cannot be pressed is refused as composer, nothing pressed, front back",
        capability(result) == "composer" && group.presses.isEmpty
          && backedOut([beta, gamma], group, board, front))
    }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.comesForward = false
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "Mail that will not come forward is refused before its tab is pressed",
        capability(result) == "composer" && group.presses.isEmpty
          && backedOut([beta, gamma], group, board, front))
    }

    // Refusals before the switch switch nothing and bring nothing forward.
    do {
      let (group, alpha, beta, _) = tabbed()
      let (result, board, front) = tabRun(group, alpha, Request(body: "New alpha"))
      check(
        "a background tab sharing its title, with no expectHead, is refused as identity",
        capability(result) == "identity")
      check(
        "before Mail is brought forward or its tab pressed",
        group.presses.isEmpty && !group.events.contains("forward")
          && untouched(alpha, board, front) && untouched(beta, board, front))
    }
    do {
      let (group, alpha, beta, _) = tabbed()
      let (result, board, front) = tabRun(
        group, alpha, Request(body: "New alpha", expectHead: "BETA text"))
      check(
        "an expectHead the selected tab's text fails is refused as identity",
        capability(result) == "identity" && alpha.own == "ALPHA text"
          && backedOut([alpha, beta], group, board, front))
      check(
        "after the switch, and the shown tab is selected again",
        group.presses == [0, 1] && group.content == 1)
    }
    do {
      let (group, _, _, gamma) = tabbed()
      gamma.isAlive = false
      let (dead, _, _) = tabRun(group, gamma, Request(body: "x"))
      let missing = URL(fileURLWithPath: "/nonexistent/mail-composer-check/t.pdf")
      let other = tabbed()
      let (absent, _, _) = tabRun(other.group, other.gamma, Request(files: [missing]))
      check(
        "a closed tab, or a missing file, is refused with no press and nothing brought forward",
        capability(dead) == "composer" && capability(absent) == "files"
          && group.presses.isEmpty && other.group.presses.isEmpty
          && !group.events.contains("forward") && !other.group.events.contains("forward"))
    }

    // The person switches tabs during the edit.
    do {
      let (group, alpha, _, gamma) = tabbed()
      gamma.onRead = { fake in if fake.own == "New gamma" { group.selected = 0 } }
      let (result, _, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a tab switch after the read-back stops the save",
        result["replaced"] as? Bool == true && result["saved"] as? Bool == false
          && gamma.saves == 0 && alpha.saves == 0
          && (result["note"] as? String ?? "").contains("tab"))
      check(
        "and the tab they chose is left selected, the front handed back",
        group.presses == [2] && group.selected == 0 && alpha.pasted.isEmpty
          && front.given == [4242])
    }
    do {
      // Their tab holds the same words, so no read can tell: only the tab can.
      let (group, alpha, _, gamma) = tabbed()
      alpha.own = "Same words"
      gamma.own = "Same words"
      gamma.onActivate = { _ in group.selected = 0 }
      let (result, board, front) = tabRun(group, gamma, Request(body: "New words"))
      check(
        "a tab switch the reads cannot see is refused before the paste",
        capability(result) == "composer" && alpha.pasted.isEmpty && gamma.pasted.isEmpty
          && alpha.saves == 0 && board.writes.isEmpty)
      check(
        "with no reselect, and the front handed back",
        group.presses == [2] && group.selected == 0 && front.given == [4242])
    }
    do {
      // Refused after the paste: the shown tab still comes back.
      let (group, _, _, gamma) = tabbed()
      gamma.pasteLost = true
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a refusal after the switch still selects the shown tab again",
        capability(result) == "confirmation" && group.presses == [2, 1] && group.content == 1
          && handedBack(gamma, board, front))
    }
    do {
      // Review Minor (b): a command-V Mail never answered may still land, in
      // whatever tab is shown when it does.
      let (group, _, beta, gamma) = tabbed()
      gamma.hangsFor = 60
      gamma.pasteLost = true
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "after an unanswered paste the shown tab is NOT selected again",
        capability(result) == "confirmation" && group.presses == [2] && group.content == 2
          && beta.pasted.isEmpty)
      check("and the board and the front are still handed back", handedBack(gamma, board, front))
    }

    // Fix round 2, IMPORTANT: command-S goes by HID and the reselect's AX press
    // by Mach message, so the press can be handled first, and command-S then
    // saves the PREVIOUS tab's draft. The save is the point; the reselect waits
    // for the window's AXEdited to clear, or does not happen.
    func index(_ event: String, _ group: FakeTabGroup) -> Int {
      group.events.firstIndex(of: event) ?? Int.max
    }
    func note(_ r: [String: Any]) -> String { r["note"] as? String ?? "" }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.saveLag = 3
      let (result, _, front) = tabRun(group, gamma, Request(body: "New gamma"))
      for _ in 0..<5 { group.tick() }
      check(
        "a late command-S is waited for: it saves this draft before the shown tab comes back",
        result["saved"] as? Bool == true && gamma.saves == 1 && beta.saves == 0
          && group.presses == [2, 1] && index("saved 2", group) < index("press 1", group))
      check("and the front is handed back after", front.given == [4242])
    }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.saveLag = 3
      group.editedAnswers = false
      let (result, _, _) = tabRun(group, gamma, Request(body: "New gamma"))
      for _ in 0..<5 { group.tick() }
      check(
        "with no readable edited state, this draft's tab is left shown after command-S",
        group.presses == [2] && group.content == 2 && gamma.saves == 1 && beta.saves == 0)
      check(
        "and the note says so",
        result["saved"] as? Bool == true && note(result).contains("left this draft's tab shown"))
    }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.saveLag = 100_000
      let (result, _, _) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a save that never shows is not reported saved, and no tab is switched",
        result["replaced"] as? Bool == true && result["saved"] as? Bool == false
          && group.presses == [2] && beta.saves == 0
          && note(result).contains("left this draft's tab shown"))
    }
    do {
      // Already clean when command-S goes: nothing could show the save landing.
      let (group, _, beta, gamma) = tabbed()
      gamma.onPaste = { $0.dirty = false }
      let (result, _, _) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a window not dirty before command-S proves nothing: no reselect",
        group.presses == [2] && beta.saves == 0
          && note(result).contains("left this draft's tab shown"))
    }
    do {
      // An untabbed window and the selected tab save as before, with no wait.
      let fake = EditFake(own: "Old")
      let (result, _, _) = run(fake, Request(body: "New"))
      let (group, _, beta, _) = tabbed()
      let (shown, _, _) = tabRun(group, beta, Request(body: "New beta"))
      check(
        "a window of its own, or the tab shown, saves as before",
        result["saved"] as? Bool == true && !note(result).contains("tab")
          && shown["saved"] as? Bool == true && !note(shown).contains("left this draft"))
    }

    // Fix round 2, promoted Minor: the body before the press is read AFTER
    // Mail comes forward, since activation could rebuild it.
    do {
      let (group, alpha, beta, _) = tabbed()
      group.contentSwaps = false
      group.forwardRebuildsBody = true
      let (result, board, front) = tabRun(
        group, alpha, Request(body: "Into the wrong draft", expectHead: "BETA text"))
      check(
        "a body rebuilt by activation is not taken for a switch to the tab",
        capability(result) == "composer" && beta.own == "BETA text"
          && backedOut([alpha, beta], group, board, front))
    }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.bodyReadable = false
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a body that cannot be read refuses before Mail comes forward",
        capability(result) == "composer" && !group.events.contains("forward")
          && group.presses.isEmpty && untouched(gamma, board, front)
          && untouched(beta, board, front))
    }
    do {
      let (group, _, beta, gamma) = tabbed()
      group.bodyUnreadableAfterForward = true
      let (result, board, front) = tabRun(group, gamma, Request(body: "New gamma"))
      check(
        "a body that stops answering once Mail is forward refuses before the press, front back",
        capability(result) == "composer" && group.events.contains("forward")
          && group.presses.isEmpty && backedOut([beta, gamma], group, board, front))
    }

    // Fix round 3: Mail re-mints every tab button when a tab opens or closes.
    do {
      let window = MintWindow()
      for title in ["Alpha", "Dup", "Dup", "Beta"] { window.add(title) }
      let first = window.listing()
      let handles = MailComposer.register(first)
      window.add("Gamma")
      let second = window.listing()
      let again = MailComposer.register(second)
      check(
        "a unique-titled tab keeps its handle when Mail re-mints the buttons",
        again[0] == handles[0] && again[3] == handles[3]
          && (MailComposer.resolve(handles[0]) as? MintTab)?.button == second[0].button)
      check(
        "a same-titled tab's handle dies, and its tabs get new ones",
        MailComposer.resolve(handles[1]) == nil && MailComposer.resolve(handles[2]) == nil
          && !again.contains(handles[1]) && !again.contains(handles[2]) && again[1] != again[2])
      window.remove("Gamma")
      check(
        "a handle is re-bound on resolve too, with no listing in between",
        (MailComposer.resolve(handles[3]) as? MintTab)?.button == window.tabs[3].button)
    }
    do {
      let window = MintWindow()
      for title in ["Same", "Same", "Lone"] { window.add(title) }
      let handles = MailComposer.register(window.listing())
      window.remove("Lone")
      let left = MintWindow()
      left.add("Solo")
      let solo = MailComposer.register(left.listing())[0]
      left.add("Solo")
      check(
        "a title unique now but not when last seen does not re-bind",
        { () -> Bool in
          let t = MintWindow()
          for title in ["Twin", "Twin"] { t.add(title) }
          let h = MailComposer.register(t.listing())
          t.remove("Twin")
          t.add("Twin")
          return MailComposer.resolve(h[0]) == nil && MailComposer.resolve(h[1]) == nil
        }())
      check(
        "nor one unique when last seen but shared now",
        MailComposer.resolve(solo) == nil && MailComposer.resolve(handles[2]) == nil)
      let gone = MintWindow()
      gone.add("Away")
      let away = MailComposer.register(gone.listing())[0]
      gone.add("Other")
      gone.isAlive = false
      check("nor one whose window is gone", MailComposer.resolve(away) == nil)
      check(
        "the rule: unique then and now, by title",
        AXComposerWindow.rebind(
          title: "A", uniqueThen: true, among: [7, 8], title: { $0 == 7 ? "A" : "B" }) == 7
          && AXComposerWindow.rebind(
            title: "A", uniqueThen: false, among: [7, 8], title: { $0 == 7 ? "A" : "B" }) == nil
          && AXComposerWindow.rebind(
            title: "A", uniqueThen: true, among: [7, 8], title: { _ in "A" }) == nil
          && AXComposerWindow.rebind(
            title: "", uniqueThen: true, among: [7], title: { _ in "" }) == nil
      )
    }

    // Fix round 3: a file in the own text reads "name, 6 bytes" (LIVE RUN 5).
    do {
      check(
        "a file label matches its name, or its name and a size",
        MailComposer.fileMatches("probe-note.txt", "probe-note.txt")
          && MailComposer.fileMatches("probe-note.txt, 6 bytes", "probe-note.txt")
          && !MailComposer.fileMatches("probe-note.txt.bak, 6 bytes", "probe-note.txt")
          && !MailComposer.fileMatches("probe-note.txt.bak", "probe-note.txt")
          && !MailComposer.fileMatches("xprobe-note.txt, 6 bytes", "probe-note.txt"))
      check(
        "an attachment button's description reads as its name",
        AXComposerWindow.fileName(
          role: "AXButton", title: "", description: "probe-note.txt, 6 bytes")
          == "probe-note.txt"
          && AXComposerWindow.fileName(
            role: "AXButton", title: nil, description: "a, b.txt, 1,2 Ko") == "a, b.txt"
          && AXComposerWindow.fileName(role: "AXButton", title: "", description: "odd name")
            == "odd name"
          && AXComposerWindow.fileName(role: "AXImage", title: "photo, 2026.png", description: nil)
            == "photo, 2026.png"
          && AXComposerWindow.fileName(role: "AXImage", title: "", description: "") == nil)
      let pdf = tempFile("probe-note.txt")
      let fake = EditFake(own: "Here")
      fake.fileLabel = { "\($0), 6 bytes" }
      let (result, _, _) = run(fake, Request(files: [pdf]))
      check(
        "files whose elements read \"name, 6 bytes\" read back and are saved",
        result["replaced"] as? Bool == true && result["saved"] as? Bool == true
          && result["filesAdded"] as? [String] == ["probe-note.txt"])
      let wrong = EditFake(own: "Here")
      wrong.fileLabel = { "\($0).bak, 6 bytes" }
      let (missed, _, _) = run(wrong, Request(files: [pdf]))
      check(
        "a longer name that only begins with it does not",
        capability(missed) == "confirmation" && wrong.saves == 0)
    }

    // An untabbed window has no tab to press.
    do {
      let fake = EditFake(own: "Old")
      check(
        "an untabbed window reads as no tab",
        fake.tab == nil && !fake.sharesTabTitle && (try? fake.pressTab()) == false
          && fake.shownTab() == nil)
    }

    // The rules the live type keeps, on stand-in elements.
    do {
      // Window 1 holds tabs 10 and 11; window 2 is a window of its own.
      let same = { (a: (window: Int, tab: Int?), b: (window: Int, tab: Int?)) in
        AXComposerWindow.sameComposer(a, b, equal: ==)
      }
      check("a tab is itself", same((1, 10), (1, 10)))
      check("two tabs of one window are two composers", !same((1, 10), (1, 11)))
      check(
        "a tab is never the window that holds it",
        !same((1, 10), (1, nil)) && !same((1, nil), (1, 10)))
      check("a tab moved to another window is still itself", same((1, 10), (3, 10)))
      check("a window of its own is itself", same((2, nil), (2, nil)) && !same((2, nil), (4, nil)))

      // A tab: (role, AXValue, title).
      let tabs: [Int: (String?, Int?, String?)] = [
        0: ("AXRadioButton", 0, "Dup"), 1: ("AXRadioButton", 1, "Dup"),
        2: ("AXRadioButton", 0, "Other"), 3: ("AXButton", nil, ""), 4: ("AXRadioButton", 0, nil),
      ]
      func titled(_ children: [Int]) -> [Int] {
        AXComposerWindow.titledTabs(children, title: { tabs[$0]?.2 })
      }
      func shows(
        _ tab: Int, _ children: [Int], subject: String?, map: [Int: (String?, Int?, String?)]
      )
        -> Bool
      {
        AXComposerWindow.shows(
          tab, among: children, subject: subject, equal: ==, role: { map[$0]?.0 },
          value: { map[$0]?.1 }, title: { map[$0]?.2 })
      }
      check("untitled children are not tabs", titled([0, 1, 2, 3, 4]) == [0, 1, 2])
      check(
        "the selected tab, its title in the subject field, is shown",
        shows(1, [0, 1, 2], subject: "Dup", map: tabs))
      check("a tab not selected is not", !shows(2, [0, 1, 2], subject: "Dup", map: tabs))
      check(
        "nor a selected tab the subject field does not name",
        !shows(1, [0, 1, 2], subject: "Something else", map: tabs)
          && !shows(1, [0, 1, 2], subject: nil, map: tabs))
      var odd = tabs
      odd[1] = ("AXTab", 1, "Dup")
      check(
        "nor one of a role a press is not trusted on",
        !shows(1, [0, 1, 2], subject: "Dup", map: odd))
      odd = tabs
      odd[0] = ("AXRadioButton", 1, "Dup")
      check(
        "nor any, when two read as selected",
        !shows(1, [0, 1, 2], subject: "Dup", map: odd)
          && !shows(0, [0, 1, 2], subject: "Dup", map: odd))
      odd = tabs
      odd[1] = ("AXRadioButton", nil, "Dup")
      check("nor one whose value does not answer", !shows(1, [0, 1, 2], subject: "Dup", map: odd))
      check(
        "only a radio button is pressed",
        AXComposerWindow.pressable(role: "AXRadioButton")
          && !AXComposerWindow.pressable(role: "AXButton") && !AXComposerWindow.pressable(role: nil)
      )
    }
  }

  static func dispatchChecks() {
    print("\ndispatch")
    let mail = AccessibilityDriver.Scope.only(["com.apple.mail"])
    let scopes: [(String, AccessibilityDriver.Scope)] = [
      ("brokered", .brokered), ("any", .any), ("mail", mail),
      ("other app", .only(["com.apple.notes"])),
    ]
    for (label, scope) in scopes {
      for writes in [false, true] {
        let reply = ask("tools/list", writes: writes, scope: scope)
        let tools = ((reply?["result"] as? [String: Any])?["tools"] as? [[String: Any]]) ?? []
        let names = tools.compactMap { $0["name"] as? String }
        check(
          "tools/list names no mail verb (\(label), writes \(writes))",
          !tools.isEmpty && !names.contains { $0.hasPrefix("apple_desktop_mail_") })
      }
    }
    for scope in [AccessibilityDriver.Scope.brokered, .any, .only(["com.apple.notes"])] {
      let (text, isError) = call("apple_desktop_mail_composers", writes: true, scope: scope)
      check(
        "composers is refused as unknown outside the Mail scope (\(scope))",
        isError && text.contains("unknown tool"))
      let (editText, editError) = call(
        "apple_desktop_mail_composer_edit", writes: true, scope: scope)
      check(
        "edit is refused as unknown outside the Mail scope (\(scope))",
        editError && editText.contains("unknown tool"))
    }
    for scope in [AccessibilityDriver.Scope.brokered, .any, .only(["com.apple.notes"])] {
      for name in ["apple_desktop_mail_composers", "apple_desktop_mail_composer_edit"] {
        let (text, isError) = call(name, writes: false, scope: scope)
        check(
          "\(name) with writes off is unknown outside the Mail scope (\(scope))",
          isError && text.contains("unknown tool") && !text.contains("switched off"))
      }
    }
    let (off, offError) = call("apple_desktop_mail_composer_edit", writes: false, scope: mail)
    check("edit with writes off is refused before AX", offError && off.contains("switched off"))
    let (missing, missingError) = call(
      "apple_desktop_mail_composer_edit", writes: true, scope: mail)
    check(
      "edit without a composer is an argument error",
      missingError && missing.contains("'composer'"))
    let (both, bothError) = call(
      "apple_desktop_mail_composer_edit",
      args: ["composer": "mc-1", "body": "a", "edits": [["find": "a", "replace": "b"]]],
      writes: true, scope: mail)
    check("body and edits together is an argument error", bothError && both.contains("not both"))
    let (bare, bareError) = call(
      "apple_desktop_mail_composer_edit", args: ["composer": "mc-1"], writes: true, scope: mail)
    check("an edit with nothing to do is an argument error", bareError && bare.contains("'body'"))
    let (html, htmlError) = call(
      "apple_desktop_mail_composer_edit", args: ["composer": "mc-1", "html": "<b>x</b>"],
      writes: true, scope: mail)
    check("html without its body is an argument error", htmlError && html.contains("'html'"))
    let (gone, goneError) = call(
      "apple_desktop_mail_composer_edit", args: ["composer": "mc-999999", "body": "x"],
      writes: true, scope: mail)
    let goneResult = (try? JSONSerialization.jsonObject(with: Data(gone.utf8))) as? [String: Any]
    check(
      "an unknown handle is a composer refusal, answered as a result",
      !goneError && goneResult?["replaced"] as? Bool == false
        && goneResult?["capability"] as? String == "composer"
        && goneResult?["degraded"] as? Bool == true && goneResult?["method"] as? String == "inPlace"
    )
  }

  static func main() {
    print("mail-composer-check")

    check(
      "a single edit replaces its match in place",
      result([Edit(find: "two", replace: "2")], "one\ntwo") == "one\n2")
    check(
      "a find spanning a line break matches across paragraphs",
      result([Edit(find: "one two", replace: "x")], "one\ntwo") == "x")
    check(
      "a find matches through a run of blank lines",
      result([Edit(find: "one two", replace: "x")], "one\n\n  \ntwo") == "x")
    check(
      "a repeated find is ambiguous, with its count",
      MailComposerText.apply([Edit(find: "a", replace: "b")], to: "a a")
        == .ambiguous(find: "a", count: 2))
    check(
      "a missing find is not found",
      MailComposerText.apply([Edit(find: "z", replace: "b")], to: "a") == .notFound(find: "z"))
    check(
      "an empty find is not found",
      MailComposerText.apply([Edit(find: "", replace: "b")], to: "a b") == .notFound(find: ""))
    check(
      "edits whose matches intersect are overlapping",
      MailComposerText.apply(
        [Edit(find: "a b", replace: "x"), Edit(find: "b c", replace: "y")], to: "a b c")
        == .overlapping)
    check(
      "edits that only touch are not overlapping",
      result([Edit(find: "a ", replace: "x"), Edit(find: "b", replace: "y")], "a b") == "xy")
    check(
      "several edits apply right to left against the original text",
      result(
        [Edit(find: "one", replace: "1111"), Edit(find: "three", replace: "3")],
        "one two\nthree") == "1111 two\n3")
    check(
      "matches index the original text, in edit order",
      {
        let own = "x\ny z"
        guard
          case .ok(_, let matches) = MailComposerText.apply(
            [Edit(find: "z", replace: "Z"), Edit(find: "x y", replace: "Q")], to: own)
        else { return false }
        return matches.map { String(own[$0]) } == ["z", "x\ny"]
      }())
    check(
      "non-ASCII text matches and keeps its surroundings",
      result([Edit(find: "ça", replace: "ok")], "Désolé — ça marche") == "Désolé — ok marche")
    check(
      "a quote header is the same quote across a line break",
      MailComposerText.sameQuote("On 22 Oct, X wrote:\nHi", "On 22 Oct, X wrote: Hi"))
    check(
      "different quotes are not the same",
      !MailComposerText.sameQuote("On 22 Oct, X wrote:\nHi", "On 23 Oct, X wrote: Hi"))

    registryChecks()
    editChecks()
    frontChecks()
    quoteChecks()
    tabChecks()
    dispatchChecks()

    print("\(checks) checks, \(failures) failures")
    if failures > 0 { exit(1) }
  }
}

/// `AppInfo` reaches for screenshot-mode state, which pulls half the app in; the
/// server only asks it for a version string. Same stub as `desktop-check.swift`.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
