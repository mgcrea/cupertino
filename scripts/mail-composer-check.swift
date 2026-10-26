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
  /// Reads a paste takes to land: AX reads and HID events travel separately,
  /// so a read can come before Mail has handled the command-V.
  var lagReads = 0
  /// After a paste, every read fails for this long: a hung Mail.
  var hangsFor: TimeInterval = 0
  /// The keystroke went nowhere: the paste is "posted" and never lands.
  var pasteLost = false
  /// The window closes as the paste is posted.
  var diesOnPaste = false
  var onPaste: ((EditFake) -> Void)?
  private var pending: (land: () -> Void, reads: Int)?
  private var hungUntil = Date.distantPast
  private(set) var selection: Range<Int>?
  private(set) var log: [String] = []
  private(set) var pasted: [PasteContent] = []
  private(set) var saves = 0

  init(own: String, files: [String] = [], quote: [String] = ["On Monday, Ann wrote:", "Hi"]) {
    self.own = own
    self.ownFiles = files
    self.quote = quote
  }

  struct Hung: Error {}

  func blocks() throws -> [ComposerBlock] {
    if Date() < hungUntil {
      log.append("read-hung")
      throw Hung()
    }
    log.append("read")
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
    return out
  }

  func ownRangeText() throws -> String? {
    log.append("range")
    return rangeText ?? own
  }

  private func selecting(_ span: Range<Int>) -> String? {
    selection = span
    let utf16 = Array(own.utf16)
    let meant = String(decoding: utf16[span], as: UTF16.self)
    return readBack.map { $0(meant) } ?? meant
  }

  func selectOwn() throws -> String? {
    log.append("select")
    return selecting(0..<own.utf16.count)
  }

  func selectSubrange(_ range: Range<String.Index>, in text: String) throws -> String? {
    log.append("select")
    let span = NSRange(range, in: text)
    return selecting(span.location..<(span.location + span.length))
  }

  func selectOwnEnd() throws -> String? {
    log.append("select-end")
    return selecting(own.utf16.count..<own.utf16.count)
  }

  func activate() throws -> Bool {
    log.append("activate")
    return activates
  }

  func paste(_ content: PasteContent) throws -> Bool {
    log.append("paste")
    guard pasteTakes else { return false }
    pasted.append(content)
    if hangsFor > 0 { hungUntil = Date().addingTimeInterval(hangsFor) }
    if diesOnPaste { isAlive = false }
    guard !pasteLost else { return true }
    let span = selection ?? 0..<0
    let land = { [self] in
      log.append("landed")
      switch content {
      case .text(let text), .html(_, let text):
        var utf16 = Array(own.utf16)
        utf16.replaceSubrange(span, with: Array(text.utf16))
        own = String(decoding: utf16, as: UTF16.self)
        selection = (span.lowerBound + text.utf16.count)..<(span.lowerBound + text.utf16.count)
      case .files(let urls):
        if !ignoresFiles { ownFiles += urls.map(\.lastPathComponent) }
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

  func save() throws -> SaveOutcome {
    log.append("save")
    saves += 1
    return saveOutcome
  }
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
  func current() -> pid_t? { pid }
  func give(to pid: pid_t?) { given.append(pid) }
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
      filesTimeout: 0.2, grace: grace)
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

    // The check under every keystroke, `announceSessionInput`.
    do {
      let screen = FakeScreen(mail)
      check(
        "Mail in front at the first read posts at once",
        AccessibilityDriver.frontmostHolds(mail, grace: 0.3, read: screen.read)
          && screen.reads == 1)
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = [nil, "com.apple.WebKit.WebContent", nil]
      check(
        "a read that answers wrong for a moment is waited out, not refused",
        AccessibilityDriver.frontmostHolds(mail, grace: 0.5, read: screen.read))
    }
    do {
      let screen = FakeScreen(code)
      let started = Date()
      let held = AccessibilityDriver.frontmostHolds(mail, grace: 0.3, read: screen.read)
      check("the person moving to another app still refuses the keystroke", !held)
      check("and only once the grace has run out", Date().timeIntervalSince(started) >= 0.3)
    }
    do {
      let screen = FakeScreen(mail)
      screen.script = (0..<60).map { $0 % 2 == 0 ? nil : mail }
      check(
        "a front that keeps flickering is never taken as Mail's",
        !AccessibilityDriver.frontmostHolds(mail, grace: 0.3, read: screen.read))
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
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate)
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
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate)
      check(
        "a wrong read does not skip the hand-back", outcome == .landed && screen.front == code)
    }
    do {
      let screen = FakeScreen("com.apple.Notes")
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate, grace: 0.2)
      check(
        "a person who moved to another app is left there",
        outcome == .leftAlone && screen.activations.isEmpty)
    }
    do {
      let screen = FakeScreen(code)
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate)
      check(
        "nothing is handed back to an app already in front",
        outcome == .alreadyThere && screen.activations.isEmpty)
    }
    do {
      let screen = FakeScreen(mail)
      screen.lag = 10_000
      let outcome = LiveFront.handBack(
        to: code, driven: mail, frontmost: screen.read, activate: screen.activate, timeout: 0.3)
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
