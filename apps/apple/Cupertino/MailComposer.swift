import AppKit
import ApplicationServices
import Foundation

/// A Mail compose window, as far as listing and editing need to know it.
///
/// The seam the checks fake: everything above it (handles, the listing's shape,
/// the order of the edit's checks) is plain Swift and can be asserted without
/// Mail running.
///
/// `nonisolated` because the app target defaults to the main actor, and these
/// are read on the connection thread that serves the channel lent to Mail.
nonisolated protocol ComposerWindow: AnyObject {
  var subject: String { get }
  /// Display names, never addresses: Mail's recipient tokens carry only the name.
  var to: [String] { get }
  var cc: [String] { get }
  /// Nil when the Bcc field is not shown, which is not the same as empty.
  var bcc: [String]? { get }
  /// The account picker's value, `Name – address`.
  var from: String? { get }
  /// Whether Mail considers this its main window (the one in front, when Mail is).
  var isMain: Bool { get }
  /// The body's top-level blocks, in order, quote included.
  func blocks() throws -> [ComposerBlock]
  /// False once the window has been sent or closed.
  var isAlive: Bool { get }
  /// Whether `other` is this same window. Identity for a fake; `CFEqual` on the
  /// `AXUIElement` for the live type, since AX hands back a new wrapper on every read.
  func isSame(as other: ComposerWindow) -> Bool

  // ─── editing ─────────────────────────────────────────────────────────────
  //
  // Every `select…` returns what the selection READS BACK as once set, or nil
  // when it could not be set. The caller compares it with what it meant to
  // select, so the gate before a paste lives in `MailComposer.edit`, where the
  // checks can reach it, rather than inside the live type.

  /// The sender's own blocks as one text-marker range, read as a string. Empty
  /// for a reply with nothing written; nil when the range could not be built.
  func ownRangeText() throws -> String?
  /// Select the own blocks. Empty own text selects a collapsed range at the
  /// start of the body's first block, so a paste lands above the quote.
  func selectOwn() throws -> String?
  /// Select `range` of `own`, the string `ownRangeText` answered.
  func selectSubrange(_ range: Range<String.Index>, in own: String) throws -> String?
  /// A collapsed selection at the end of the own text, where files go.
  func selectOwnEnd() throws -> String?
  /// Bring Mail and this window to the front, ready to take a paste. Once per
  /// edit: a second activation would pull Mail back over an app the person
  /// moved to in between.
  func activate() throws -> Bool
  /// Paste what the pasteboard holds over the selection. `content` is what was
  /// written there; the live type does not need it, a fake does.
  func paste(_ content: PasteContent) throws -> Bool
  func save() throws -> SaveOutcome
}

extension ComposerWindow {
  /// To and Cc together, as the listing's `recipients` has always been.
  nonisolated var recipientNames: [String] { to + cc }
  func isSame(as other: ComposerWindow) -> Bool { self === other }
}

nonisolated struct ComposerBlock {
  let text: String
  /// `AXBlockQuoteLevel`; nil when Mail would not say.
  let quoteLevel: Int?
  /// Names of images and attachments inside the block.
  let fileNames: [String]
}

nonisolated enum PasteContent: Equatable {
  case text(String)
  /// `.html` with a `.string` fallback, on one pasteboard item. Mail rewrites
  /// pasted HTML (`&nbsp;`, a font-size wrapper, an href's trailing slash), so
  /// what lands is verified as `fallback`, by text.
  case html(String, fallback: String)
  case files([URL])
}

nonisolated enum SaveOutcome {
  case pressed
  /// The window went before command-S could be pressed.
  case gone
  /// Mail would not take the keystroke.
  case refused
}

/// The general pasteboard, borrowed for the length of one edit.
nonisolated protocol Pasteboard {
  /// Every item and every type, opaque to the caller.
  func snapshot() -> Any
  func restore(_ saved: Any)
  /// Throws when the pasteboard did not take it, so nothing else on it is pasted.
  func write(_ content: PasteContent) throws
  /// `NSPasteboard.changeCount`: moves on every write, ours or anyone's.
  var changeCount: Int { get }
}

/// Which application has the front, and handing it back.
nonisolated protocol Front {
  func current() -> pid_t?
  func give(to pid: pid_t?)
}

/// Handles for compose windows, and the listing the Mail server reads.
///
/// ## Why handles live here and not in the driver's `HandleStore`
///
/// Two composers can carry the same subject, so neither the title nor the
/// subject names one. A handle is minted per window the first time it is seen
/// and kept for as long as the process lives; `mc-<n>` numbers are never reused,
/// so a handle held across a send can only go stale, never point at another draft.
nonisolated enum MailComposer {

  /// `@unchecked Sendable` for the reason `AccessibilityDriver.HandleStore` is:
  /// the lock is the invariant.
  private final class Registry: @unchecked Sendable {
    private var entries: [(number: Int, window: ComposerWindow)] = []
    private var next = 0
    private let lock = NSLock()

    func register(_ windows: [ComposerWindow]) -> [String] {
      lock.lock()
      defer { lock.unlock() }
      // Dead windows are dropped so a long session does not hold every composer
      // it ever saw. Their numbers are not recycled: `next` only goes up.
      entries.removeAll { !$0.window.isAlive }
      return windows.map { window in
        if let known = entries.first(where: { $0.window.isSame(as: window) }) {
          return "mc-\(known.number)"
        }
        next += 1
        entries.append((next, window))
        return "mc-\(next)"
      }
    }

    func resolve(_ handle: String) -> ComposerWindow? {
      lock.lock()
      defer { lock.unlock() }
      guard handle.hasPrefix("mc-"), let number = Int(handle.dropFirst(3)),
        let entry = entries.first(where: { $0.number == number }), entry.window.isAlive
      else { return nil }
      return entry.window
    }
  }

  private static let registry = Registry()

  static func register(_ windows: [ComposerWindow]) -> [String] {
    registry.register(windows)
  }

  static func resolve(_ handle: String) -> ComposerWindow? {
    registry.resolve(handle)
  }

  /// One entry per window: its handle, subject, recipients and own text.
  ///
  /// `quoted` is a Bool when every block's level was readable, and NSNull when
  /// one was not, in which case own text stops before that block: a body that
  /// cannot be split is not offered as if it had been.
  ///
  /// `quote` is the text of the blocks from the first quoted one down, joined
  /// with newlines and cut at `quoteChars` (`quoteTruncated` says whether it
  /// was). It is null unless `quoted` is true, and when `quoteChars` is 0.
  static func listing(_ windows: [ComposerWindow], quoteChars: Int = 2000) -> [[String: Any]] {
    let handles = register(windows)
    return zip(windows, handles).map { window, handle in
      var own: [String] = []
      var files: [String] = []
      var quoteBlocks: [String] = []
      var quoted: Any = NSNull()
      if let blocks = try? window.blocks() {
        var boundary = false
        var unreadable = false
        for block in blocks {
          guard let level = block.quoteLevel else {
            unreadable = true
            break
          }
          if level > 0 {
            boundary = true
          }
          if boundary {
            quoteBlocks.append(block.text)
            continue
          }
          own.append(block.text)
          files += block.fileNames
        }
        if !unreadable { quoted = boundary }
      }
      let whole = quoteBlocks.joined(separator: "\n")
      let cut = max(quoteChars, 0)
      let showQuote = (quoted as? Bool) == true && cut > 0
      return [
        "composer": handle,
        "subject": window.subject,
        "main": window.isMain,
        "from": window.from ?? NSNull(),
        "to": window.to,
        "cc": window.cc,
        "bcc": window.bcc ?? NSNull(),
        "recipients": window.recipientNames,
        "text": own.joined(separator: "\n"),
        "quoted": quoted,
        "quote": showQuote ? String(whole.prefix(cut)) : NSNull(),
        "quoteTruncated": showQuote && whole.count > cut,
        "files": files,
      ]
    }
  }

  // ─── the edit verb ─────────────────────────────────────────────────────────

  struct EditRequest {
    var body: String?
    /// Pasted as HTML with `body` as its plain-text fallback, and verified as `body`.
    var html: String?
    var edits: [MailComposerText.Edit]?
    var files: [URL] = []
    var save = true
    /// The opening the caller expects the own text to have (the old `sameDraft`).
    var expectHead: String?
  }

  /// The arguments the Mail server sends.
  ///
  /// A malformed call is an error, not a refusal: it is the server's bug, and
  /// nothing about the draft. One of `body`, `edits` or `attachments` is
  /// required, `body` and `edits` exclude each other, and `html` rides on a
  /// `body`, which is its plain-text fallback and what the window must read back.
  struct ArgumentError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
  }

  static func request(from args: [String: Any]) throws -> EditRequest {
    var request = EditRequest()
    if let body = args["body"] {
      guard let body = body as? String else { throw ArgumentError("'body' is a string.") }
      request.body = body
    }
    if let html = args["html"] {
      guard let html = html as? String else { throw ArgumentError("'html' is a string.") }
      guard request.body != nil else {
        throw ArgumentError("'html' needs 'body': its plain text, which is what is verified.")
      }
      request.html = html
    }
    if let edits = args["edits"] {
      guard let list = edits as? [[String: Any]], !list.isEmpty else {
        throw ArgumentError("'edits' is a non-empty list of {find, replace}.")
      }
      request.edits = try list.map {
        guard let find = $0["find"] as? String, let replace = $0["replace"] as? String else {
          throw ArgumentError("Each edit is {find, replace}, both strings.")
        }
        return MailComposerText.Edit(find: find, replace: replace)
      }
      guard request.body == nil else { throw ArgumentError("Pass 'body' or 'edits', not both.") }
    }
    if let paths = args["attachments"] {
      guard let paths = paths as? [String], paths.allSatisfy({ $0.hasPrefix("/") }) else {
        throw ArgumentError("'attachments' is a list of absolute paths.")
      }
      request.files = paths.map { URL(fileURLWithPath: $0) }
    }
    guard request.body != nil || request.edits != nil || !request.files.isEmpty else {
      throw ArgumentError("Pass 'body', 'edits' or 'attachments'.")
    }
    if let save = args["save"] {
      guard let save = save as? Bool else { throw ArgumentError("'save' is a boolean.") }
      request.save = save
    }
    if let head = args["expectHead"] {
      guard let head = head as? String else { throw ArgumentError("'expectHead' is a string.") }
      request.expectHead = head
    }
    return request
  }

  /// The refusal for a handle that resolves to nothing.
  static func gone(_ handle: String) -> [String: Any] {
    refusal(
      "composer",
      "The composer \(handle) is gone: it was sent or closed, or Mail quit. Nothing was changed.",
      "List the composers again and edit the one that holds this draft.")
  }

  /// Edit one compose window in one verified step.
  ///
  /// The order is the safety property. Steps 1 to 7 only read, apart from
  /// moving the selection in the background, and any of them refusing leaves
  /// the draft exactly as it was and Mail where it was. From step 8 on, the
  /// pasteboard and the front are borrowed, and handed back on every way out.
  /// Nothing is saved that was not read back from the window first.
  ///
  ///  1. the window is alive;
  ///  2. its blocks read, every quote level readable;
  ///  3. `expectHead` matches the own text (whitespace-folded);
  ///  4. a `body` over own text holding files is refused, naming them, and so
  ///     is an attachment that is not there;
  ///  5. the new text is computed, or each edit placed exactly once. A change
  ///     the read-back could not see, because it only moves whitespace, is
  ///     refused: its "match" could be read before the paste is handled;
  ///  6. the own marker range reads as the own text, and a `body` is refused
  ///     over an inline image too, named or not;
  ///  7. every selection the pastes need is set and read back, BEFORE anything
  ///     is pasted (each one again right before its own paste);
  ///  8. the front is noted, and the pasteboard snapshotted just before the
  ///     first write;
  ///  9. Mail is activated, once;
  /// 10. each paste is polled until the own text reads as expected and the
  ///     quote is still there, unchanged;
  /// 11. files are pasted at the end of the own text and their names polled for;
  /// 12. command-S;
  /// 13. the pasteboard is restored, unless someone copied over it meanwhile,
  ///     and the front given back. When the last command-V went unanswered,
  ///     the restore waits up to `grace` for Mail to answer a read: a hung Mail
  ///     handles the keystroke when it wakes, and with the person's clipboard
  ///     back on the board it would paste THAT into a window Mail autosaves.
  ///
  /// `edits` are pasted one at a time, highest offset first, so an edit never
  /// shifts one still to come. Sub-range selection was measured only for an
  /// ASCII span at the end of a block, so each is read back and must equal the
  /// text it replaces; a mismatch refuses, and never falls back to repasting
  /// the whole own text.
  static func edit(
    _ w: ComposerWindow, request: EditRequest, board: Pasteboard, front: Front,
    readbackTimeout: TimeInterval = 5, filesTimeout: TimeInterval = 12, grace: TimeInterval = 2
  ) -> [String: Any] {
    let untouched = "Nothing was changed."

    // 1.
    guard w.isAlive else {
      return refusal(
        "composer", "The composer is gone: it was sent or closed, or Mail quit. \(untouched)",
        "List the composers again and edit the one that holds this draft.")
    }

    // 2.
    let before: Read
    do {
      guard let read = Read(try w.blocks()) else {
        return refusal(
          "selection",
          "Mail would not say where one of the composer's blocks sits relative to the quoted "
            + "original, so where the draft's own text ends is unknown. \(untouched)",
          "Edit the draft in Mail directly.")
      }
      before = read
    } catch {
      return refusal(
        "composer", "The composer's body could not be read (\(describe(error))). \(untouched)",
        "Try again, or edit the draft in Mail directly.")
    }

    // 3.
    if let head = request.expectHead, !sameHead(head, before.text) {
      return refusal(
        "identity",
        "The composer's own text does not begin the way this draft's does, so it may be "
          + "another draft. \(untouched)",
        "List the composers again and pick the one whose text is this draft's.")
    }

    // 4.
    if request.body != nil, !before.files.isEmpty {
      return refusal(
        "files",
        "The draft's own text holds \(before.files.joined(separator: ", ")), which a new body "
          + "would remove. \(untouched)",
        "Use edits, which change only the text they find and leave files where they are.",
        ["files": before.files])
    }
    let missing = request.files.filter { !FileManager.default.isReadableFile(atPath: $0.path) }
    if !missing.isEmpty {
      let names = missing.map(\.lastPathComponent)
      return refusal(
        "files",
        "\(names.joined(separator: ", ")) could not be read, so nothing was attached. \(untouched)",
        "Check the paths and try again.", ["files": names])
    }

    // 5.
    var result: String?
    if let edits = request.edits {
      switch MailComposerText.apply(edits, to: before.text) {
      case .ok(let text, _): result = text
      case .notFound(let find):
        return refusal(
          "edits", "This edit's text is not in the draft's own text. \(untouched)",
          "Read the draft again and quote its text exactly; line breaks do not matter.",
          ["find": find])
      case .ambiguous(let find, let count):
        return refusal(
          "edits",
          "This edit's text is in the draft's own text \(count) times, so which one to change "
            + "is unknown. \(untouched)",
          "Quote more of the text around it, so it matches once.",
          ["find": find, "count": count])
      case .overlapping:
        return refusal(
          "edits", "Two edits change overlapping text. \(untouched)",
          "Merge them into one edit, or make them touch separate text.")
      }
    } else if let body = request.body {
      // Equal to the letter, there is nothing to paste. Equal only once
      // whitespace is folded, the read-back reads "done" before the paste and
      // after it alike, so it could not tell a paste that never landed.
      if same(body, before.text) && !(request.html == nil && body == before.text) {
        return refusal(
          "confirmation",
          "The new body differs from the draft's own text only in whitespace (line breaks or "
            + "spaces)\(request.html == nil ? "" : " or formatting"), which reading the window "
            + "back cannot tell apart, so there would be no way to know the paste landed. "
            + untouched,
          "Change the words, or adjust the spacing in Mail directly.")
      }
      result = body
    }

    // 6.
    let range: String
    do {
      guard let text = try w.ownRangeText(), same(text, before.text) else {
        return refusal(
          "selection",
          "The text range over the draft's own blocks does not read as their text, so a "
            + "selection built on it could reach the quote. \(untouched)",
          "Edit the draft in Mail directly.")
      }
      range = text
    } catch {
      return refusal(
        "composer", "The composer's text could not be read (\(describe(error))). \(untouched)",
        "Try again, or edit the draft in Mail directly.")
    }
    // A file reads as U+FFFC in the marker range whether it has a name or not,
    // and `squash` drops the character, so an image the blocks could not name
    // would vanish under a body with a read-back that still passes.
    let marks = range.unicodeScalars.filter { $0 == "\u{FFFC}" }.count
    if request.body != nil, marks > before.files.count {
      let unnamed = marks - before.files.count
      let named = Array(repeating: "an inline image", count: unnamed)
      return refusal(
        "files",
        "The draft's own text holds \(unnamed == 1 ? "an inline image" : "\(unnamed) inline images") "
          + "with no name, which a new body would remove. \(untouched)",
        "Use edits, which change only the text they find and leave images where they are.",
        ["files": named])
    }
    var steps: [Step] = []
    if let edits = request.edits {
      guard let placed = place(edits, in: range) else {
        return refusal(
          "selection",
          "The edits matched the draft's blocks but not the composer's text range, so they "
            + "cannot be selected there. \(untouched)",
          "Edit the draft in Mail directly.")
      }
      // Each paste must leave a text the one before it could not be mistaken
      // for, or its read-back can pass before Mail has handled the command-V.
      var previous = range
      for step in placed {
        if same(step.expected, previous) {
          return refusal(
            "edits",
            "This edit changes only whitespace (line breaks or spaces), which reading the window "
              + "back cannot tell apart, so there would be no way to know it landed. \(untouched)",
            "Change the words around it as well, or adjust the spacing in Mail directly.",
            ["find": step.find])
        }
        previous = step.expected
      }
      steps = placed
    }

    // 7. In the background, before anything is borrowed or pasted.
    do {
      if !steps.isEmpty {
        for step in steps {
          guard let back = try w.selectSubrange(step.range, in: range),
            sameSpan(back, step.original)
          else { return misselected(step.original, changed: false) }
        }
      } else if request.body != nil {
        guard let back = try w.selectOwn(), sameSpan(back, range) else {
          return misselected(nil, changed: false)
        }
      } else {
        guard let back = try w.selectOwnEnd(), back.isEmpty else {
          return misselected(nil, changed: false)
        }
      }
    } catch {
      return refusal(
        "composer", "The composer's text could not be selected (\(describe(error))). \(untouched)",
        "Try again once the Mac is free, or edit the draft in Mail directly.")
    }

    // 8. And 13, on every way out from here.
    let previous = front.current()
    let borrow = Borrow(board)
    let answer = paste(
      w, request, before: before, range: range, steps: steps, result: result, board: borrow,
      readbackTimeout: readbackTimeout, filesTimeout: filesTimeout)
    if borrow.unanswered {
      let deadline = Date().addingTimeInterval(grace)
      while Date() < deadline, (try? w.blocks()) == nil, w.isAlive { usleep(50_000) }
    }
    borrow.giveBack()
    front.give(to: previous)
    return answer
  }

  /// The pasteboard, borrowed lazily: snapshotted just before the first write,
  /// and given back only if nobody has written over it since the last one of
  /// ours. A person who copied something during the edit keeps their copy.
  private final class Borrow {
    let board: Pasteboard
    private var saved: Any?
    private var ours: Int?
    /// The last command-V got no answer from Mail at all, so Mail may still
    /// handle it: see `edit`'s step 13.
    var unanswered = false

    init(_ board: Pasteboard) { self.board = board }

    func write(_ content: PasteContent) throws {
      if saved == nil { saved = board.snapshot() }
      // Recorded whether or not the write throws: `LivePasteboard.write` clears
      // the board before it can refuse, so a failed write has already moved the
      // count and wiped the person's clipboard, and must still be given back.
      defer { ours = board.changeCount }
      try board.write(content)
    }

    func giveBack() {
      guard let saved, let ours, board.changeCount == ours else { return }
      board.restore(saved)
    }
  }

  /// Steps 9 to 12. Borrowing and handing back are the caller's.
  private static func paste(
    _ w: ComposerWindow, _ request: EditRequest, before: Read, range: String, steps: [Step],
    result: String?, board: Borrow, readbackTimeout: TimeInterval,
    filesTimeout: TimeInterval
  ) -> [String: Any] {
    // Whether the window may now hold something the saved draft does not.
    var changed = false
    func state() -> String {
      changed
        ? "This did not save it: the draft keeps whatever Mail last saved, and the window holds "
          + "changes this could not verify."
        : "Nothing was pasted and the draft is unchanged."
    }
    let look = "Look at the composer in Mail: fix it there, or close it without saving."

    do {
      // 9.
      guard try w.activate() else {
        return refusal(
          "composer",
          "Mail did not come to the front with this composer as its window, so nothing was "
            + "pasted. Someone is probably using the Mac. \(state())",
          "Try again once the Mac is free.")
      }

      // 10.
      var shown = before
      if !steps.isEmpty {
        for step in steps {
          guard let back = try w.selectSubrange(step.range, in: range),
            sameSpan(back, step.original)
          else { return misselected(step.original, changed: changed) }
          let content = PasteContent.text(step.replace)
          try board.write(content)
          guard try w.paste(content) else { return unfocused(state()) }
          changed = true
          let awaited = awaitRead(
            w, timeout: readbackTimeout, until: { same($0.text, step.expected) })
          guard case .read(let read) = awaited else {
            return unconfirmed(awaited, board, readbackTimeout, state(), look)
          }
          guard quoteIntact(before, read) else { return quoteLost() }
          shown = read
        }
      } else if let body = request.body {
        guard let back = try w.selectOwn(), sameSpan(back, range) else {
          return misselected(nil, changed: changed)
        }
        // A body equal to the own text to the letter has nothing to paste.
        if !(request.html == nil && body == before.text) {
          let content = request.html.map { PasteContent.html($0, fallback: body) } ?? .text(body)
          try board.write(content)
          guard try w.paste(content) else { return unfocused(state()) }
          changed = true
        }
      }
      if let result {
        let awaited = awaitRead(w, timeout: readbackTimeout, until: { same($0.text, result) })
        guard case .read(let read) = awaited else {
          return unconfirmed(awaited, board, readbackTimeout, state(), look)
        }
        guard quoteIntact(before, read) else { return quoteLost() }
        shown = read
      }

      // 11.
      var added: [String] = []
      if !request.files.isEmpty {
        guard let back = try w.selectOwnEnd(), back.isEmpty else {
          return misselected(nil, changed: changed)
        }
        let content = PasteContent.files(request.files)
        try board.write(content)
        guard try w.paste(content) else { return unfocused(state()) }
        changed = true
        let names = request.files.map(\.lastPathComponent)
        let text = shown.text
        let held = shown.files
        let awaited = awaitRead(
          w, timeout: filesTimeout,
          until: {
            same($0.text, text) && arrived(names, before: held, now: $0.files)
              && quoteIntact(before, $0)
          })
        guard case .read(let read) = awaited else {
          if case .timedOut(answered: false) = awaited { board.unanswered = true }
          let why =
            awaited == .gone
            ? "the composer window closed before they read back"
            : "they did not read back in the draft's own text within \(seconds(filesTimeout)), "
              + "with that text and the quote unchanged"
          return refusal(
            "confirmation", "\(names.joined(separator: ", ")) were pasted, but \(why). \(state())",
            look)
        }
        shown = read
        added = names
      }

      // 12.
      var saved = false
      let note: String
      if request.save {
        let outcome = (try? w.save()) ?? .refused
        switch outcome {
        case .pressed:
          saved = true
          note =
            "The change was read back from the composer and saved. The window is still open in "
            + "Mail."
        case .gone:
          note =
            "The change was read back from the composer, and then the window went before it "
            + "could be saved. Nothing here closes one, so someone closed or sent it. Look in "
            + "Mail before doing anything else."
        case .refused:
          note =
            "The change was read back from the composer, but Mail would not take command-S, so "
            + "this did not save it. The window is open with the change in it."
        }
      } else {
        note = "The change was read back from the composer and, as asked, not saved."
      }
      return [
        "replaced": true, "method": "inPlace", "text": shown.text, "quoteKept": shown.quoted,
        "filesAdded": added, "saved": saved, "note": note,
      ]
    } catch {
      return refusal("composer", "The edit stopped: \(describe(error)). \(state())", look)
    }
  }

  // ─── the edit's parts ──────────────────────────────────────────────────────

  /// A body split at the quote: own blocks are the level-0 ones before the
  /// first quoted block. Nil when any level is unreadable.
  struct Read {
    let own: [ComposerBlock]
    let quote: [ComposerBlock]

    init?(_ blocks: [ComposerBlock]) {
      guard blocks.allSatisfy({ $0.quoteLevel != nil }) else { return nil }
      let boundary = blocks.firstIndex { ($0.quoteLevel ?? 0) > 0 } ?? blocks.endIndex
      own = Array(blocks[..<boundary])
      quote = Array(blocks[boundary...])
    }

    var text: String { own.map(\.text).joined(separator: "\n") }
    var quoteText: String { quote.map(\.text).joined(separator: "\n") }
    var files: [String] { own.flatMap(\.fileNames) }
    var quoted: Bool { !quote.isEmpty }
  }

  /// One edit's paste. `range` indexes the own range's text; `expected` is the
  /// own text once this edit and every one pasted before it have landed.
  private struct Step {
    let find: String
    let range: Range<String.Index>
    let original: String
    let replace: String
    let expected: String
  }

  /// The edits as pastes, highest offset first.
  private static func place(_ edits: [MailComposerText.Edit], in text: String) -> [Step]? {
    guard case .ok(_, let matches) = MailComposerText.apply(edits, to: text) else { return nil }
    let order = edits.indices.sorted { matches[$0].lowerBound > matches[$1].lowerBound }
    var steps: [Step] = []
    for (k, index) in order.enumerated() {
      guard
        case .ok(let expected, _) = MailComposerText.apply(
          order[...k].map { edits[$0] }, to: text)
      else { return nil }
      steps.append(
        Step(
          find: edits[index].find, range: matches[index], original: String(text[matches[index]]),
          replace: edits[index].replace, expected: expected))
    }
    return steps
  }

  /// How a poll after a paste ended. `answered` is whether Mail answered any
  /// read at all: a Mail that answered while the text never moved dropped the
  /// keystroke, a Mail that answered nothing may still handle it.
  private enum Awaited: Equatable {
    case read(Read)
    case timedOut(answered: Bool)
    case gone

    static func == (a: Awaited, b: Awaited) -> Bool {
      switch (a, b) {
      case (.gone, .gone): return true
      case (.timedOut(let x), .timedOut(let y)): return x == y
      default: return false
      }
    }
  }

  private static func awaitRead(
    _ w: ComposerWindow, timeout: TimeInterval, until done: (Read) -> Bool
  ) -> Awaited {
    let deadline = Date().addingTimeInterval(timeout)
    var answered = false
    while true {
      if let blocks = try? w.blocks() {
        answered = true
        if let read = Read(blocks), done(read) { return .read(read) }
      }
      if !w.isAlive { return .gone }
      if Date() >= deadline { return .timedOut(answered: answered) }
      usleep(50_000)
    }
  }

  /// The quote that was there is still there, word for word. A draft that had
  /// none has nothing to lose.
  private static func quoteIntact(_ before: Read, _ now: Read) -> Bool {
    !before.quoted || (now.quoted && same(now.quoteText, before.quoteText))
  }

  /// Each name at least once more than it was there before, per time it is added.
  private static func arrived(_ names: [String], before: [String], now: [String]) -> Bool {
    names.allSatisfy { name in
      now.filter { $0 == name }.count
        >= before.filter { $0 == name }.count + names.filter { $0 == name }.count
    }
  }

  /// The own text and a read-back of it, compared as `revise.ts` does: every
  /// whitespace run is one space, ends trimmed, and the object replacement
  /// character a file reads as in a marker range dropped. Mail's paragraphs
  /// read back with breaks where the caller has spaces, and `&nbsp;` where a
  /// pasted HTML space was.
  static func squash(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{FFFC}", with: "")
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  static func same(_ a: String, _ b: String) -> Bool { squash(a) == squash(b) }

  /// Stricter, for a selection against the text it is meant to cover: both come
  /// from the same marker-range read, so only a whitespace run's shape may
  /// differ. A selection one newline wider than its text is not the same span:
  /// pasting over it would join two paragraphs.
  static func sameSpan(_ a: String, _ b: String) -> Bool {
    func fold(_ s: String) -> String {
      var out = ""
      for c in s {
        if c.isWhitespace {
          if out.last != " " { out.append(" ") }
        } else {
          out.append(c)
        }
      }
      return out
    }
    return fold(a) == fold(b)
  }

  static let headLength = 120

  /// The old `sameDraft`: the two openings agree for as long as both run, up to
  /// `headLength` characters. Both empty is a match.
  static func sameHead(_ expected: String, _ shown: String) -> Bool {
    let a = Array(squash(expected))
    let b = Array(squash(shown))
    if a.isEmpty || b.isEmpty { return a.isEmpty == b.isEmpty }
    let n = min(a.count, b.count, headLength)
    return a.prefix(n) == b.prefix(n)
  }

  private static func misselected(_ text: String?, changed: Bool) -> [String: Any] {
    let what = text.map { "the text \"\($0)\"" } ?? "the draft's own text"
    let state =
      changed
      ? "Earlier edits are in the window, verified, but this did not save it: the draft keeps "
        + "whatever Mail last saved."
      : "Nothing was pasted and the draft is unchanged."
    return refusal(
      "selection",
      "The selection over \(what) did not read back as that text, so a paste could reach "
        + "further than it should. \(state)",
      changed
        ? "Look at the composer in Mail: fix it there, or close it without saving."
        : "Edit the draft in Mail directly, or replace the whole body.")
  }

  private static func unfocused(_ state: String) -> [String: Any] {
    refusal(
      "composer",
      "The composer would not take the keyboard, so the paste was not posted. Someone is "
        + "probably using the Mac. \(state)",
      "Try again once the Mac is free.")
  }

  private static func unconfirmed(
    _ awaited: Awaited, _ board: Borrow, _ timeout: TimeInterval, _ state: String, _ hint: String
  ) -> [String: Any] {
    if awaited == .timedOut(answered: false) { board.unanswered = true }
    let why: String
    switch awaited {
    case .gone:
      why = "The composer window closed before the paste read back."
    case .timedOut(answered: false):
      why =
        "Mail did not answer a single read within \(seconds(timeout)) of the paste, so it may "
        + "still be handling it."
    default:
      why =
        "The paste did not read back as the expected text within \(seconds(timeout)). Someone "
        + "may have typed in the window."
    }
    return refusal("confirmation", "\(why) \(state)", hint)
  }

  private static func quoteLost() -> [String: Any] {
    refusal(
      "confirmation",
      "The paste went in, but the quoted original below it is gone or changed, so it reached "
        + "further than the draft's own text. This did not save it: the draft keeps whatever Mail "
        + "last saved.",
      "Close the composer in Mail WITHOUT saving, or undo inside it with command-Z.")
  }

  private static func seconds(_ t: TimeInterval) -> String {
    t >= 1 ? "\(Int(t.rounded())) s" : "\(Int((t * 1000).rounded())) ms"
  }

  private static func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? String(describing: error)
  }

  /// The shape `revise.ts` refuses with, so the Mail server passes it through.
  static func refusal(
    _ capability: String, _ reason: String, _ hint: String, _ extra: [String: Any] = [:]
  ) -> [String: Any] {
    var out: [String: Any] = [
      "replaced": false, "degraded": true, "method": "inPlace", "capability": capability,
      "reason": reason, "hint": hint,
    ]
    out.merge(extra) { _, new in new }
    return out
  }
}

/// A compose window read through Accessibility.
///
/// Recognised by its subject FIELD (`Mail.subjectField`, three levels down), not
/// its title: a viewer showing a message with the same subject has the same
/// title and no field.
///
/// Every write goes through `DrivingSession.admit` first, as every driving verb
/// does, so the person at the keyboard is warned or asked before the selection
/// moves; and every keystroke through `AccessibilityDriver.key`, which refuses
/// to post unless Mail is frontmost.
///
/// UNMEASURED LIVE beyond what `scripts/spike-mail-composer.swift` records.
nonisolated final class AXComposerWindow: ComposerWindow, @unchecked Sendable {
  static let bundleId = "com.apple.mail"
  static let scope = AccessibilityDriver.Scope.only([bundleId])
  private static let tokenChar: Character = "\u{FFFC}"
  /// Roles whose name marks a file in the body, as `FILE_ROLES` in ax.ts.
  private static let fileRoles: Set<String> = ["AXImage", "AXButton"]
  private static let selectedRange = "AXSelectedTextMarkerRange"

  let window: AXUIElement
  private let subjectField: AXUIElement
  private let pid: pid_t

  private init(window: AXUIElement, subjectField: AXUIElement, pid: pid_t) {
    self.window = window
    self.subjectField = subjectField
    self.pid = pid
  }

  /// Every compose window Mail has open now. Reads only.
  ///
  /// Through `AccessibilityDriver.windowElements`, so the window list is the
  /// driver's (`kAXWindows` merged with window children) and every read carries
  /// its messaging timeout: a hung Mail answers `busy` instead of holding the
  /// connection. Mail not running, or with no window, is no composer; any other
  /// failure is thrown, because "none open" is an answer the Mail server acts on.
  static func all(scope: AccessibilityDriver.Scope) throws -> [AXComposerWindow] {
    let windows: [AXUIElement]
    do {
      windows = try AccessibilityDriver.windowElements(bundleId: bundleId, scope: scope)
    } catch AccessibilityDriver.Failure.appNotRunning(_) {
      return []
    } catch AccessibilityDriver.Failure.noWindows(_) {
      return []
    }
    return windows.compactMap { window in
      var pid: pid_t = 0
      guard AXUIElementGetPid(window, &pid) == .success else { return nil }
      return field(in: window, "Mail.subjectField").map {
        AXComposerWindow(window: window, subjectField: $0, pid: pid)
      }
    }
  }

  var subject: String { Self.attr(subjectField, kAXValueAttribute as String) as? String ?? "" }

  /// Only an element AX calls invalid is dead. A busy Mail (`cannotComplete`)
  /// still has its window, and calling that gone would let a later listing
  /// mint it a second handle.
  var isAlive: Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
      return false
    }
    var out: CFTypeRef?
    return Self.alive(
      after: AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &out))
  }

  static func alive(after err: AXError) -> Bool { err != .invalidUIElement }

  func isSame(as other: ComposerWindow) -> Bool {
    guard let other = other as? AXComposerWindow else { return false }
    return CFEqual(window, other.window)
  }

  var to: [String] { Self.field(in: window, "Mail.toField").map(Self.names(in:)) ?? [] }
  var cc: [String] { Self.field(in: window, "Mail.ccField").map(Self.names(in:)) ?? [] }
  var bcc: [String]? { Self.field(in: window, "Mail.bccField").map(Self.names(in:)) }

  /// `popup_from`'s value reads `Name – address`.
  var from: String? {
    Self.field(in: window, "popup_from").flatMap {
      Self.attr($0, kAXValueAttribute as String) as? String
    }
  }

  var isMain: Bool {
    (Self.attr(window, kAXMainAttribute as String) as? NSNumber)?.boolValue == true
  }

  /// The names in one recipient field: its tokens, then whatever is still being
  /// typed, which sits between the tokens in the value.
  private static func names(in field: AXUIElement) -> [String] {
    let value = attr(field, kAXValueAttribute as String) as? String ?? ""
    var names: [String] = []
    if value.contains(tokenChar) {
      for token in descendants(of: field, depth: 2)
      where attr(token, kAXSubroleAttribute as String) as? String == "AXTextAttachment" {
        if let name = (attr(token, kAXValueAttribute as String) as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
        {
          names.append(name)
        }
      }
    }
    let typed =
      value.split(separator: tokenChar, omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return names + typed
  }

  struct NoBody: Error {}

  func blocks() throws -> [ComposerBlock] {
    try Self.children(webArea()).map { block in
      ComposerBlock(
        text: Self.text(of: block),
        quoteLevel: (Self.attr(block, "AXBlockQuoteLevel") as? NSNumber)?.intValue,
        fileNames: Self.files(in: block))
    }
  }

  // ─── editing ───────────────────────────────────────────────────────────────

  func ownRangeText() throws -> String? {
    let web = try webArea()
    guard let range = ownRange(web) else { return nil }
    return Self.string(web, for: range) ?? ""
  }

  func selectOwn() throws -> String? {
    let web = try webArea()
    guard let range = ownRange(web) else { return nil }
    return try select(range, in: web)
  }

  /// MEASURED only for an ASCII span at the end of a block (spike RUN 2). Offsets
  /// are UTF-16 from the own range's start, added to that start's index in the
  /// web area. Whether this holds mid-block, across blocks or past a non-BMP
  /// character is unmeasured, which is why the caller reads the selection back.
  func selectSubrange(_ range: Range<String.Index>, in own: String) throws -> String? {
    let web = try webArea()
    guard let ownRange = ownRange(web),
      let base =
        (Self.param(web, "AXIndexForTextMarker", Self.start(of: ownRange))
        as? NSNumber)?.intValue
    else { return nil }
    let span = NSRange(range, in: own)
    guard
      let from = Self.marker(
        Self.param(web, "AXTextMarkerForIndex", NSNumber(value: base + span.location))),
      let to = Self.marker(
        Self.param(web, "AXTextMarkerForIndex", NSNumber(value: base + NSMaxRange(span))))
    else { return nil }
    return try select(AXTextMarkerRangeCreate(kCFAllocatorDefault, from, to), in: web)
  }

  func selectOwnEnd() throws -> String? {
    let web = try webArea()
    guard let range = ownRange(web) else { return nil }
    let end = AXTextMarkerRangeCopyEndMarker(range)
    return try select(AXTextMarkerRangeCreate(kCFAllocatorDefault, end, end), in: web)
  }

  /// MEASURED (spike): a paste only lands with Mail active, and right after
  /// `activate()` the frontmost read can still say no while the paste would
  /// land — so this waits for the window server to agree (up to two seconds,
  /// `activateAndWait`), then raises this window and focuses its body, and
  /// requires it to be Mail's focused window: command-V goes to the key window,
  /// and the viewer's search field is not where a draft goes. Both that and
  /// Mail being frontmost must then hold for a moment (`settled`).
  func activate() throws -> Bool {
    let web = try webArea()
    guard try AccessibilityDriver.activateAndWait(bundleId: Self.bundleId, scope: Self.scope)
    else { return false }
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(web, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return Self.settled(focused: isFocusedWindow, frontmost: AccessibilityDriver.frontmostBundleId)
  }

  /// Mail frontmost as the window server says, AND this window Mail's focused
  /// one, both holding for `stable`.
  ///
  /// `isFocusedWindow` alone is Mail's own idea of its key window, which it
  /// keeps while another application is in front, so it could not tell Mail
  /// losing the front from Mail having it. And one yes is not enough: the
  /// focus change just made into the web area, or a hand-back from the edit
  /// before still landing, can move the front a moment later. A paste starts
  /// only on a front that has stayed put; if it never does, nothing is pasted.
  static func settled(
    stable: TimeInterval = 0.15, timeout: TimeInterval = 1.5, focused: () -> Bool,
    frontmost: () -> String?
  ) -> Bool {
    AccessibilityDriver.holdsSteadily(for: stable, within: timeout) {
      frontmost() == bundleId && focused()
    }
  }

  /// command-V, or Delete for an empty replacement: an empty pasteboard pastes
  /// nothing, and the selection has to go. Refused, not posted, unless this
  /// window still has the focus — `AccessibilityDriver.key` checks Mail is
  /// frontmost, this checks it is THIS window of Mail's.
  func paste(_ content: PasteContent) throws -> Bool {
    guard isFocusedWindow() else { return false }
    if content == .text("") {
      try AccessibilityDriver.key(
        "delete", modifiers: [], scope: Self.scope, announcing: Self.bundleId)
    } else {
      try AccessibilityDriver.key(
        "v", modifiers: ["command"], scope: Self.scope, announcing: Self.bundleId)
    }
    return true
  }

  func save() throws -> SaveOutcome {
    guard isAlive else { return .gone }
    guard isFocusedWindow() else { return .refused }
    do {
      try AccessibilityDriver.key(
        "s", modifiers: ["command"], scope: Self.scope, announcing: Self.bundleId)
    } catch {
      return isAlive ? .refused : .gone
    }
    return .pressed
  }

  private func webArea() throws -> AXUIElement {
    guard let web = Self.find(window, depth: 10, where: { Self.role($0) == "AXWebArea" })
    else { throw NoBody() }
    return web
  }

  /// The own blocks' range: the first's start to the last's end, joined with the
  /// public marker calls (Mail offers no `AXStartTextMarkerForTextMarkerRange`).
  /// With no own block, a collapsed range at the start of the first block, or
  /// of the web area when it has none.
  private func ownRange(_ web: AXUIElement) -> AXTextMarkerRange? {
    let blocks = Self.children(web)
    let own = blocks.prefix {
      (Self.attr($0, "AXBlockQuoteLevel") as? NSNumber)?.intValue == 0
    }
    if let first = own.first, let last = own.last {
      guard let head = Self.markerRange(Self.param(web, "AXTextMarkerRangeForUIElement", first)),
        let tail = Self.markerRange(Self.param(web, "AXTextMarkerRangeForUIElement", last))
      else { return nil }
      return AXTextMarkerRangeCreate(
        kCFAllocatorDefault, Self.start(of: head), AXTextMarkerRangeCopyEndMarker(tail))
    }
    guard
      let anchor = Self.markerRange(
        Self.param(web, "AXTextMarkerRangeForUIElement", blocks.first ?? web))
    else { return nil }
    let start = Self.start(of: anchor)
    return AXTextMarkerRangeCreate(kCFAllocatorDefault, start, start)
  }

  /// Set the selection and read it back, waiting up to half a second for it to
  /// read as the range set. Admission first: moving someone's selection is
  /// driving, as `select` and `set_value` are.
  private func select(_ range: AXTextMarkerRange, in web: AXUIElement) throws -> String? {
    try DrivingSession.admit(Self.bundleId)
    DriveActivity.record(Self.bundleId)
    let meant = Self.string(web, for: range) ?? ""
    guard
      AXUIElementSetAttributeValue(web, Self.selectedRange as CFString, range) == .success
    else { return nil }
    var read: String?
    let started = Date()
    repeat {
      if let selected = Self.markerRange(Self.attr(web, Self.selectedRange)) {
        read = Self.string(web, for: selected) ?? ""
        if read == meant { break }
      }
      usleep(25_000)
    } while Date().timeIntervalSince(started) < 0.5
    return read
  }

  private func isFocusedWindow() -> Bool {
    let app = AccessibilityDriver.element(for: pid)
    guard let focused = Self.attr(app, kAXFocusedWindowAttribute as String),
      CFGetTypeID(focused) == AXUIElementGetTypeID()
    else { return false }
    return CFEqual(focused, window)
  }

  // MARK: AX reads

  private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success ? out : nil
  }

  private static func param(_ el: AXUIElement, _ name: String, _ arg: CFTypeRef) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(el, name as CFString, arg, &out) == .success
      ? out : nil
  }

  private static func markerRange(_ value: CFTypeRef?) -> AXTextMarkerRange? {
    guard let value, CFGetTypeID(value) == AXTextMarkerRangeGetTypeID() else { return nil }
    return (value as! AXTextMarkerRange)
  }

  private static func marker(_ value: CFTypeRef?) -> AXTextMarker? {
    guard let value, CFGetTypeID(value) == AXTextMarkerGetTypeID() else { return nil }
    return (value as! AXTextMarker)
  }

  private static func start(of range: AXTextMarkerRange) -> AXTextMarker {
    AXTextMarkerRangeCopyStartMarker(range)
  }

  private static func string(_ web: AXUIElement, for range: AXTextMarkerRange) -> String? {
    param(web, "AXStringForTextMarkerRange", range) as? String
  }

  private static func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
  }

  private static func role(_ el: AXUIElement) -> String? {
    attr(el, kAXRoleAttribute as String) as? String
  }

  private static func find(_ el: AXUIElement, depth: Int, where test: (AXUIElement) -> Bool)
    -> AXUIElement?
  {
    if test(el) { return el }
    guard depth > 0 else { return nil }
    for child in children(el) {
      if let hit = find(child, depth: depth - 1, where: test) { return hit }
    }
    return nil
  }

  private static func field(in window: AXUIElement, _ id: String) -> AXUIElement? {
    find(window, depth: 3) { attr($0, kAXIdentifierAttribute as String) as? String == id }
  }

  private static func descendants(of el: AXUIElement, depth: Int) -> [AXUIElement] {
    guard depth > 0 else { return [] }
    return children(el).flatMap { [$0] + descendants(of: $0, depth: depth - 1) }
  }

  /// A block's own value plus its descendants', joined with nothing: inline runs
  /// share a line, as `ax.ts` reads them.
  private static func text(of el: AXUIElement, depth: Int = 8) -> String {
    var parts: [String] = []
    if let value = attr(el, kAXValueAttribute as String) as? String { parts.append(value) }
    if depth > 0 { for child in children(el) { parts.append(text(of: child, depth: depth - 1)) } }
    return parts.joined()
  }

  private static func files(in el: AXUIElement, depth: Int = 8) -> [String] {
    var names: [String] = []
    if let role = role(el), fileRoles.contains(role) {
      let name =
        (attr(el, kAXTitleAttribute as String) as? String).flatMap { $0.isEmpty ? nil : $0 }
        ?? (attr(el, kAXDescriptionAttribute as String) as? String)
      if let name, !name.isEmpty { names.append(name) }
    }
    if depth > 0 { for child in children(el) { names += files(in: child, depth: depth - 1) } }
    return names
  }
}

/// `NSPasteboard.general`, every item and every type kept, as the spike did.
nonisolated struct LivePasteboard: Pasteboard {
  private typealias Item = [(NSPasteboard.PasteboardType, Data)]

  struct Refused: LocalizedError {
    var errorDescription: String? { "The pasteboard would not take what was to be pasted." }
  }

  var changeCount: Int { NSPasteboard.general.changeCount }

  func snapshot() -> Any {
    (NSPasteboard.general.pasteboardItems ?? []).map { item -> Item in
      item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
  }

  func restore(_ saved: Any) {
    guard let items = saved as? [Item] else { return }
    let board = NSPasteboard.general
    board.clearContents()
    let restored = items.map { pairs -> NSPasteboardItem in
      let item = NSPasteboardItem()
      for (type, data) in pairs { item.setData(data, forType: type) }
      return item
    }
    if !restored.isEmpty { board.writeObjects(restored) }
  }

  func write(_ content: PasteContent) throws {
    let board = NSPasteboard.general
    board.clearContents()
    switch content {
    case .text(let text):
      guard board.setString(text, forType: .string) else { throw Refused() }
    case .html(let html, let fallback):
      let item = NSPasteboardItem()
      item.setString(html, forType: .html)
      item.setString(fallback, forType: .string)
      guard board.writeObjects([item]) else { throw Refused() }
    case .files(let urls):
      // Counted as well: compose.ts measured writeObjects answering true with
      // one item for two files.
      guard board.writeObjects(urls.map { $0 as NSURL }),
        board.pasteboardItems?.count == urls.count
      else { throw Refused() }
    }
  }
}

/// The frontmost application, by pid, as the window server sees it.
nonisolated struct LiveFront: Front {
  /// The application the edit drives. The front is handed back only while it
  /// still has it: someone who moved elsewhere meanwhile is left where they went,
  /// the rule `DrivingSession.finish` keeps.
  let driven: String

  func current() -> pid_t? {
    var raw: AnyObject?
    if AXUIElementCopyAttributeValue(
      AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &raw)
      == .success, let focused = raw, CFGetTypeID(focused) == AXUIElementGetTypeID()
    {
      var pid: pid_t = 0
      if AXUIElementGetPid(focused as! AXUIElement, &pid) == .success { return pid }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  /// The edit's one hand-back. It returns only once the previous application
  /// has the front and has kept it, or once it is clear it will not: see
  /// `handBack`.
  func give(to pid: pid_t?) {
    guard let pid, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated
    else { return }
    guard let previous = app.bundleIdentifier else {
      // Nothing to read back by: the old route, unwaited. Only an application
      // with no bundle id at all takes it.
      if pid != current(), AccessibilityDriver.frontmostBundleId() == driven { _ = app.activate() }
      return
    }
    _ = Self.handBack(
      to: previous, driven: driven, frontmost: AccessibilityDriver.frontmostBundleId,
      activate: AccessibilityDriver.handBack(to:))
  }

  enum HandBack: Equatable {
    /// The previous application was in front already; nothing was asked.
    case alreadyThere
    /// Someone else is in front: the person moved, and is left where they went.
    case leftAlone
    /// It came to the front and stayed there for the settle.
    case landed
    /// Asked for, and not in front by the deadline.
    case didNotLand
  }

  /// Give the front back to `previous`, and wait for it to land.
  ///
  /// Activation is asynchronous, so a hand-back that returns on the request
  /// can land after it, in the middle of the next edit, which is exactly when
  /// `announceSessionInput` would see Mail gone. `AccessibilityDriver.handBack`
  /// waits for the first read that says `previous`; this also waits for that
  /// answer to HOLD for `stable`, so nothing of this hand-back is left in flight
  /// when the call returns, and says when it did not land.
  ///
  /// Gated on `driven` being in front, read with `frontmostHolds` so a wrong
  /// answer for a moment does not skip it: LIVE RUN 1's gate read wrong, and
  /// the person's editor stayed behind Mail until the driving session ended
  /// eleven seconds after the run.
  static func handBack(
    to previous: String, driven: String, frontmost: () -> String?,
    activate: (String) -> Bool, stable: TimeInterval = 0.15, timeout: TimeInterval = 1,
    grace: TimeInterval = 0.5
  ) -> HandBack {
    guard previous != driven else { return .alreadyThere }
    let now = frontmost()
    if now == previous { return .alreadyThere }
    guard now == driven || AccessibilityDriver.frontmostHolds(driven, grace: grace, read: frontmost)
    else { return .leftAlone }
    _ = activate(previous)
    let landed = AccessibilityDriver.holdsSteadily(for: stable, within: timeout) {
      frontmost() == previous
    }
    return landed ? .landed : .didNotLand
  }
}
