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
  /// start of the document (not of the first block, which in a forward is the
  /// quote), and `selectionReachesQuote` proves it lands outside the quote.
  func selectOwn() throws -> String?
  /// Select `range` of `own`, the string `ownRangeText` answered.
  func selectSubrange(_ range: Range<String.Index>, in own: String) throws -> String?
  /// A collapsed selection at the end of the own text, where files go.
  func selectOwnEnd() throws -> String?
  /// A collapsed selection at the START of the own text, where an inserted
  /// body goes: the first own block's start, or with no own block the start
  /// of the document, as `selectOwn` collapses for empty own text.
  func selectOwnStart() throws -> String?
  /// Whether either end of the selection just set sits inside the quoted
  /// original: the element its marker resolves to, or any ancestor of it up to
  /// the body, has a quote level above 0. Nil when that could not be told,
  /// which the edit treats as yes.
  func selectionReachesQuote() throws -> Bool?
  /// Bring Mail and this window to the front, ready to take a paste. Once per
  /// edit: a second activation would pull Mail back over an app the person
  /// moved to in between.
  func activate() throws -> Bool
  /// Paste what the pasteboard holds over the selection. `content` is what was
  /// written there; the live type does not need it, a fake does.
  func paste(_ content: PasteContent) throws -> Bool
  func save() throws -> SaveOutcome

  // ─── tabs ────────────────────────────────────────────────────────────────
  //
  // MEASURED, LIVE RUN 3 (2026-10-26): with "Prefer tabs when opening
  // documents: Always", Mail opens every composer as a TAB of one window.
  // Accessibility lists that window once, its title and content are the
  // selected tab's only, and it has an `AXTabGroup` child whose titled
  // children are the tabs. So a tab, not the window, is what names a composer,
  // and a background tab's text cannot be read without switching to it.

  /// Nil for a window holding one composer. For a tab, `.selected` only while
  /// its window shows it, and `.background` otherwise, or when that cannot be
  /// told: everything read or pasted through the window reaches the tab shown.
  var tab: ComposerTab? { get }
  /// Whether another tab of the same window carries this tab's title, so its
  /// subject field could not tell the two apart after a switch. True when it
  /// cannot be read.
  var sharesTabTitle: Bool { get }
  /// Press this composer's tab, admission first. False when it is not a tab a
  /// press is allowed on, or Mail refused the press. Whether it then shows is
  /// the caller's to wait for.
  func pressTab() throws -> Bool
  /// The tab this composer's window shows now, for handing it back. Nil for
  /// an untabbed window, and when no single tab reads as selected.
  func shownTab() -> ComposerWindow?
  /// Admission, then Mail to the front, touching no window: step 0's, before
  /// a tab is pressed. MEASURED, LIVE RUN 4: a press flips the tab's `AXValue`
  /// at once, but the window's content swaps to it only while Mail is
  /// frontmost.
  func bringForward() throws -> Bool
  /// Step 9 once `bringForward` has run: raise this window and focus its
  /// body WITHOUT activating Mail again, true only once Mail is frontmost and
  /// this window focused, settled. A second activation would pull Mail back
  /// over an app the person moved to in between.
  func focus() throws -> Bool
  /// The element the window's body is now, whichever tab it shows; nil when
  /// it cannot be read. Opaque: compared only with `sameBody`.
  func windowBody() -> AnyObject?
  func sameBody(_ a: AnyObject, _ b: AnyObject) -> Bool
  /// A live composer standing for this one once its tab's element has died:
  /// nil unless that holds (see `AXComposerWindow.rebind`). The registry
  /// keeps the handle on it, number and all, and marks it `rebound`: the tab
  /// may hold another draft, so an edit by the handle alone refuses until a
  /// listing reads it as the text the handle was last seen with.
  func rebound() -> ComposerWindow?
}

/// Where a tab stands in its window. Its raw value is the listing's `tab`.
nonisolated enum ComposerTab: String {
  case selected, background
}

extension ComposerWindow {
  /// A window of its own, for a conformer that knows nothing of tabs.
  nonisolated var tab: ComposerTab? { nil }
  nonisolated var sharesTabTitle: Bool { false }
  nonisolated func pressTab() throws -> Bool { false }
  nonisolated func shownTab() -> ComposerWindow? { nil }
  nonisolated func bringForward() throws -> Bool { false }
  nonisolated func focus() throws -> Bool { try activate() }
  nonisolated func windowBody() -> AnyObject? { nil }
  nonisolated func sameBody(_ a: AnyObject, _ b: AnyObject) -> Bool { a === b }
  nonisolated func rebound() -> ComposerWindow? { nil }
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
/// so a handle held across a send goes stale rather than naming a later draft.
///
/// One exception, and it is marked: a tab's handle is keyed by its tab button,
/// which Mail re-mints whenever a tab opens or closes (LIVE RUN 5). A dead tab
/// is re-bound to the live tab of its window carrying its title, when that
/// title was unique then and is unique now (`AXComposerWindow.rebind`). That
/// tab CAN be another draft: the person closed the first and opened or
/// retitled a second under the same title. So a re-bound handle carries a
/// `rebound` mark, listed on its row, under which an edit refuses unless
/// `expectHead` proves the text. The mark clears in two ways only: a listing
/// reads the tab's own text, not empty, equal to the text recorded for the
/// handle at its last sighting before the turnover; or an edit by the handle
/// carried an `expectHead` the tab's text matched and read its result back,
/// which proves the content. A sighting is a listing that read the text, or a
/// verified edit's read-back; a body that could not be read lists `text`
/// null and is no sighting. With no text recorded (the tab was only ever
/// seen in the background), a listing never clears the mark.
nonisolated enum MailComposer {

  /// `@unchecked Sendable` for the reason `AccessibilityDriver.HandleStore` is:
  /// the lock is the invariant.
  private final class Registry: @unchecked Sendable {
    private struct Entry {
      let number: Int
      var window: ComposerWindow
      /// The handle was re-bound to a tab that may be another draft.
      var rebound = false
      /// The own text read at the last listing that could read it; what a
      /// re-bound tab must read as for the mark to clear. Frozen while marked.
      var ownText: String?
    }

    private var entries: [Entry] = []
    private var next = 0
    private let lock = NSLock()

    /// Re-bind the entry at `i` when its tab's element has died, and mark it.
    private func rebind(_ i: Int) {
      guard !entries[i].window.isAlive, let live = entries[i].window.rebound() else { return }
      entries[i].window = live
      entries[i].rebound = true
    }

    func register(_ windows: [ComposerWindow]) -> [String] {
      lock.lock()
      defer { lock.unlock() }
      // A tab whose element Mail re-minted keeps its handle when it can be
      // told for sure which live tab is titled as it was (`rebound`).
      for i in entries.indices { rebind(i) }
      // Dead windows are dropped so a long session does not hold every composer
      // it ever saw. Their numbers are not recycled: `next` only goes up.
      entries.removeAll { !$0.window.isAlive }
      return windows.map { window in
        if let known = entries.firstIndex(where: { $0.window.isSame(as: window) }) {
          // This sighting is the last one: what a re-binding goes by.
          entries[known].window = window
          return "mc-\(entries[known].number)"
        }
        next += 1
        entries.append(Entry(number: next, window: window))
        return "mc-\(next)"
      }
    }

    func resolve(_ handle: String) -> ComposerWindow? {
      lock.lock()
      defer { lock.unlock() }
      guard let at = index(of: handle) else { return nil }
      rebind(at)
      return entries[at].window.isAlive ? entries[at].window : nil
    }

    func isRebound(_ handle: String) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return index(of: handle).map { entries[$0].rebound } ?? false
    }

    /// A listing read the own text of the composer `handle` names. Unmarked,
    /// it is the text a later re-binding will be held to; marked, the mark
    /// clears only when it is that text, and never when either is empty: two
    /// empty drafts under one title prove nothing about each other, and an
    /// unreadable body once listed as "" (review of round 4).
    func sighted(_ handle: String, text: String) {
      lock.lock()
      defer { lock.unlock() }
      guard let at = index(of: handle) else { return }
      if entries[at].rebound {
        if !text.isEmpty, entries[at].ownText == text { entries[at].rebound = false }
      } else {
        entries[at].ownText = text
      }
    }

    /// A verified edit by `handle` read the composer's own text back as
    /// `text`: a sighting, recorded as a listing's would be. `proved` says the
    /// edit carried an `expectHead` the tab's text matched, which on a marked
    /// handle proves the content and clears the mark. A marked handle's edit
    /// never gets here unproved (`edit` refuses it), so nothing is recorded
    /// for one.
    func edited(_ handle: String, text: String, proved: Bool) {
      lock.lock()
      defer { lock.unlock() }
      guard let at = index(of: handle) else { return }
      if entries[at].rebound {
        guard proved else { return }
        entries[at].rebound = false
      }
      entries[at].ownText = text
    }

    private func index(of handle: String) -> Int? {
      guard handle.hasPrefix("mc-"), let number = Int(handle.dropFirst(3)) else { return nil }
      return entries.firstIndex { $0.number == number }
    }
  }

  private static let registry = Registry()

  static func register(_ windows: [ComposerWindow]) -> [String] {
    registry.register(windows)
  }

  static func resolve(_ handle: String) -> ComposerWindow? {
    registry.resolve(handle)
  }

  /// Whether `handle` was re-bound to a tab that may be another draft, and
  /// nothing has since proved its text: no listing read it as the text the
  /// handle was last seen with, and no edit by it checked an `expectHead`.
  /// `edit` asks it for the handle it is given.
  static func isRebound(_ handle: String) -> Bool {
    registry.isRebound(handle)
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
  ///
  /// `tab` is null for a window of its own, `"selected"` for the tab its
  /// window shows, which reads as a window does, and `"background"` for any
  /// other tab: its title and nothing else, every field it cannot read null,
  /// because reading one means switching tabs and a listing never does.
  ///
  /// `text` is null when the body could not be read at all (Mail still
  /// loading it, or not answering), as it is for a background tab: a row
  /// whose text is a string is the handle's sighting, what a later re-binding
  /// is held to, or what clears the mark; a null one is not.
  ///
  /// `rebound` is true while the handle was re-bound to a tab that may be
  /// another draft (see the registry): an edit by that handle alone refuses.
  static func listing(_ windows: [ComposerWindow], quoteChars: Int = 2000) -> [[String: Any]] {
    let handles = register(windows)
    return zip(windows, handles).map { window, handle in
      let tab = window.tab
      if tab == .background { return background(window, handle) }
      var entry = shown(window, handle, quoteChars: quoteChars)
      entry["tab"] = tab?.rawValue ?? NSNull()
      // Switched away from while it was read, what it answered may be the
      // next tab's: listed as what it now is, and not taken as a sighting.
      if tab == .selected, window.tab != .selected { return background(window, handle) }
      if let text = entry["text"] as? String { registry.sighted(handle, text: text) }
      entry["rebound"] = registry.isRebound(handle)
      return entry
    }
  }

  private static func background(_ window: ComposerWindow, _ handle: String) -> [String: Any] {
    [
      "composer": handle, "subject": window.subject, "tab": ComposerTab.background.rawValue,
      "main": false, "from": NSNull(), "to": NSNull(), "cc": NSNull(), "bcc": NSNull(),
      "recipients": NSNull(), "text": NSNull(), "quoted": NSNull(), "quote": NSNull(),
      "quoteTruncated": false, "files": [String](), "rebound": registry.isRebound(handle),
    ]
  }

  private static func shown(_ window: ComposerWindow, _ handle: String, quoteChars: Int)
    -> [String: Any]
  {
    var own: [String] = []
    var files: [String] = []
    var quoteBlocks: [String] = []
    var quoted: Any = NSNull()
    // A body that could not be read lists its text as null, never as "": an
    // empty string would read as an empty draft, and be taken as a sighting.
    var readable = false
    if let blocks = try? window.blocks() {
      readable = true
      var boundary = false
      var unreadable = false
      for block in blocks {
        guard let level = block.quoteLevel else {
          unreadable = true
          // Nothing of the own text read before the level failed, or only a
          // blank caret line: that is no more an empty draft than an
          // unreadable body is.
          if squash(own.joined(separator: "\n")).isEmpty { readable = false }
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
      "text": readable ? own.joined(separator: "\n") : NSNull(),
      "quoted": quoted,
      "quote": showQuote ? String(whole.prefix(cut)) : NSNull(),
      "quoteTruncated": showQuote && whole.count > cut,
      "files": files,
    ]
  }

  // ─── the edit verb ─────────────────────────────────────────────────────────

  struct EditRequest {
    var body: String?
    /// `body` goes in ABOVE the own text instead of over it: a new composer,
    /// whose own text is the account's signature (see `edit`).
    var insert = false
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
  /// `insert` rides on a plain `body`, with no `html`.
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
    if let insert = args["insert"] {
      guard let insert = insert as? Bool else { throw ArgumentError("'insert' is a boolean.") }
      guard !insert || (request.body != nil && request.html == nil) else {
        throw ArgumentError("'insert' needs a plain 'body', with no 'html'.")
      }
      request.insert = insert
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
  /// ## A body inserted above the own text (`insert`)
  ///
  /// For a NEW composer, whose own text is the account's signature, if it has
  /// one, which the body must not replace (the base pasted at Mail's caret,
  /// above the signature, and the signature survived). Steps 4 and 6 refuse
  /// nothing on files or images, since nothing is removed. Step 5's new own
  /// text is `body`, a newline, then the own text as it was, compared folded
  /// like every read-back. Step 7 and the paste collapse the selection at the
  /// START of the own text (`selectOwnStart`), proved outside the quote, read
  /// back empty. What is pasted is `body`, and a newline after it when the own
  /// text's first line holds text, so the body does not run into it; a blank
  /// first line, Mail's caret line above a signature, takes the body as it is.
  /// The answer carries `kept`, the own text the body went in above. Every
  /// other gate is the same: the quote re-read, the pasteboard borrowed and
  /// given back, the front checks, the save.
  ///
  /// `edits` are pasted one at a time, highest offset first, so an edit never
  /// shifts one still to come. Sub-range selection was measured only for an
  /// ASCII span at the end of a block, so each is read back and must equal the
  /// text it replaces; a mismatch refuses, and never falls back to repasting
  /// the whole own text.
  ///
  /// ## A composer that is a background tab
  ///
  /// Its window shows another tab, and everything above reads and pastes
  /// through the window, so the tab is selected first, as step 0, right after
  /// step 1 and before anything is read. In this order:
  ///
  ///  - refused with nothing done, no tab switched and Mail left where it is:
  ///    a tab whose title another tab of the window shares, unless
  ///    `expectHead` was given (after the switch nothing else could prove the
  ///    content shown is this draft's), and an attachment that is not there;
  ///
  /// Before either path, a handle the registry re-bound (`rebound`, see the
  /// registry) is refused the same way unless `expectHead` was given: the tab
  /// it names now may be another draft, and only the text can prove it. And
  /// after either path, a verified edit's read-back is recorded as the
  /// handle's sighting; one that carried an `expectHead` clears the mark.
  ///  - the tab shown, the front and the window's body element are noted;
  ///  - Mail is brought to the front (admission first). MEASURED, LIVE RUN 4:
  ///    a pressed tab's `AXValue` flips at once, but the window's content
  ///    swaps to it only while Mail is frontmost;
  ///  - the tab is pressed, then polled for up to `tabTimeout` until it reads
  ///    as the tab shown (the one tab selected, the subject field reading as
  ///    its title) AND the body is another element than before the press,
  ///    holding for 150 ms. The flag alone flips without the content, and two
  ///    tabs can share a title. Anything short of that refuses, nothing read
  ///    or pasted, and the front handed back;
  ///  - steps 2 to 13, with step 9 only focusing the window: Mail is already
  ///    in front, and is not activated a second time.
  ///
  /// From step 10 on, before every selection and paste and before step 12, the
  /// tab must still be the one shown: a person who picks another tab mid-edit
  /// stops it, and command-S, which saves the tab shown, is not pressed.
  ///
  /// Once command-S was tried, this draft's tab is LEFT SHOWN, and the note
  /// says so. command-S goes by HID and a tab's press by Mach message, so a
  /// press right after it could be handled first and the save land in the
  /// draft shown before; and Mail's compose window has no `AXEdited` (MEASURED,
  /// LIVE RUN 6), so nothing can tell when the save has landed. On every other
  /// way out (refused before command-S, or saving not asked) the tab that was
  /// shown before is selected again, while Mail is still in front (pressed with
  /// Mail behind, the content would not follow), and only while this tab is
  /// still the one shown (a person who picked another is left there), and
  /// never after a command-V Mail did not answer, which may still land in
  /// whatever tab is shown when it does. Then the front goes back to the
  /// application noted before Mail came forward.
  static func edit(
    _ w: ComposerWindow, request: EditRequest, board: Pasteboard, front: Front,
    handle: String? = nil, readbackTimeout: TimeInterval = 5, filesTimeout: TimeInterval = 12,
    grace: TimeInterval = 2, tabTimeout: TimeInterval = 2
  ) -> [String: Any] {
    let untouched = "Nothing was changed."

    // 1.
    guard w.isAlive else {
      return refusal(
        "composer", "The composer is gone: it was sent or closed, or Mail quit. \(untouched)",
        "List the composers again and edit the one that holds this draft.")
    }
    if let handle, isRebound(handle), request.expectHead == nil {
      return refusal(
        "identity",
        "This composer's tab changed underneath it: Mail rebuilt its window's tabs since the "
          + "composer was listed, and the handle now names the tab carrying its title, which may "
          + "be another draft. \(untouched) No tab was switched.",
        "Edit the draft by its saved draft's ref, which checks its text: a moved handle stays "
          + "reference-only until its text is proved. List the composers again after a verified "
          + "edit.")
    }
    guard w.tab == .background else {
      return sighted(
        handle, request,
        editShown(
          w, request: request, board: board, front: front, broughtForward: false,
          readbackTimeout: readbackTimeout, filesTimeout: filesTimeout, grace: grace,
          outcome: Outcome()))
    }

    // 0. A background tab.
    if request.expectHead == nil, w.sharesTabTitle {
      return refusal(
        "identity",
        "This composer is a tab its window is not showing, and another tab of that window has "
          + "the same title (or its tabs' titles could not be read), so once it is selected "
          + "nothing could prove that what the window shows is this draft. \(untouched) No tab "
          + "was switched.",
        "Edit it by the saved draft's ref, which checks its text, or select its tab in Mail and "
          + "try again.")
    }
    if let refused = missingFiles(request, untouched) { return refused }
    let previous = w.shownTab()
    let unswitched = "Nothing was read or pasted, and the draft is unchanged."
    // Checked before Mail comes forward, so a body that cannot be read costs
    // no flash of Mail; read again after, for the proof.
    guard w.windowBody() != nil else {
      return refusal(
        "composer",
        "The composer's window would not say which body it shows, so a switch to its tab "
          + "could not be confirmed. \(untouched) No tab was switched.",
        "Try again, or select the draft's tab in Mail and try again.")
    }
    // Before Mail comes forward, or the front handed back would be Mail's.
    let frontBefore = front.current()
    let forward: Bool
    do {
      forward = try w.bringForward()
    } catch {
      front.give(to: frontBefore)
      return refusal(
        "composer",
        "Mail could not be brought to the front to select the composer's tab "
          + "(\(describe(error))). \(unswitched)",
        "Try again once the Mac is free, or edit the draft in Mail directly.")
    }
    // Read after the activation, which could rebuild the body element: the
    // proof below is a body other than THIS one.
    guard forward, let bodyBefore = w.windowBody() else {
      front.give(to: frontBefore)
      return refusal(
        "composer",
        (forward
          ? "The composer's window stopped saying which body it shows once Mail came forward, "
            + "so a switch to its tab could not be confirmed. "
          : "Mail did not come to the front, and a tab selected while it is behind does not "
            + "show its draft. Someone is probably using the Mac. ")
          + unswitched,
        "Try again once the Mac is free.")
    }
    var handedBack = false
    // Not after a command-V Mail did not answer, nor after a command-S: either
    // could still land in the tab shown then, and nothing says when it has.
    func reselect(_ report: Outcome) {
      guard !handedBack else { return }
      handedBack = true
      guard !report.unanswered, !report.savePosted else { return }
      handBackTab(previous, after: w)
    }
    let pressed: Bool
    do {
      pressed = try w.pressTab()
    } catch {
      front.give(to: frontBefore)
      return refusal(
        "composer", "The composer's tab could not be selected (\(describe(error))). \(unswitched)",
        "Try again once the Mac is free, or edit the draft in Mail directly.")
    }
    guard pressed, awaitShown(w, from: bodyBefore, timeout: tabTimeout) else {
      reselect(Outcome())
      front.give(to: frontBefore)
      return refusal(
        "composer",
        (pressed
          ? "The composer's tab was pressed but did not come up as the tab its window shows "
            + "within \(seconds(tabTimeout)), so its text could not be read. "
          : "The composer is a tab its window is not showing, and Mail would not let it be "
            + "selected, so its text could not be read. ")
          + unswitched,
        "Select the draft's tab in Mail, then try again.")
    }
    let outcome = Outcome()
    let answer = editShown(
      w, request: request, board: board, front: nil, broughtForward: true,
      readbackTimeout: readbackTimeout, filesTimeout: filesTimeout, grace: grace,
      outcome: outcome)
    // After the pasteboard is given back, before the front: as `editShown`
    // orders its own hand-back.
    reselect(outcome)
    front.give(to: frontBefore)
    return sighted(handle, request, answer)
  }

  /// A verified edit's read-back is the handle's sighting (see the registry).
  /// The answer is returned as it is.
  private static func sighted(_ handle: String?, _ request: EditRequest, _ answer: [String: Any])
    -> [String: Any]
  {
    if let handle, answer["replaced"] as? Bool == true, let text = answer["text"] as? String {
      // An empty `expectHead` matches an empty draft, which proves nothing:
      // the mark never clears on empty text.
      let proved = request.expectHead.map { !squash($0).isEmpty } ?? false
      registry.edited(handle, text: text, proved: proved)
    }
    return answer
  }

  /// What `editShown` leaves for the caller to act on.
  private final class Outcome {
    /// The last command-V went unanswered (`Borrow.unanswered`).
    var unanswered = false
    /// command-S was tried, whatever it answered.
    var savePosted = false
  }

  /// Poll until `w` reads as the tab its window shows, with a body that is
  /// not `before`, both holding for `stable`.
  private static func awaitShown(
    _ w: ComposerWindow, from before: AnyObject, timeout: TimeInterval,
    stable: TimeInterval = 0.15
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var since: Date?
    while true {
      let now = Date()
      let swapped = w.windowBody().map { !w.sameBody($0, before) } ?? false
      if w.tab == .selected && swapped {
        let first = since ?? now
        since = first
        if now.timeIntervalSince(first) >= stable { return true }
      } else {
        since = nil
      }
      if !w.isAlive || now >= deadline { return false }
      usleep(25_000)
    }
  }

  /// Select `previous` again, if this edit's tab is still the one shown.
  private static func handBackTab(_ previous: ComposerWindow?, after w: ComposerWindow) {
    guard let previous, !previous.isSame(as: w), let shown = w.shownTab(), shown.isSame(as: w)
    else { return }
    _ = try? previous.pressTab()
  }

  private static func missingFiles(_ request: EditRequest, _ untouched: String) -> [String: Any]? {
    let missing = request.files.filter { !FileManager.default.isReadableFile(atPath: $0.path) }
    guard !missing.isEmpty else { return nil }
    let names = missing.map(\.lastPathComponent)
    return refusal(
      "files",
      "\(names.joined(separator: ", ")) could not be read, so nothing was attached. \(untouched)",
      "Check the paths and try again.", ["files": names])
  }

  /// Steps 1 to 13, on a window showing this composer. With no `front`, the
  /// caller noted it before bringing Mail forward, and hands it back itself.
  private static func editShown(
    _ w: ComposerWindow, request: EditRequest, board: Pasteboard, front: Front?,
    broughtForward: Bool, readbackTimeout: TimeInterval, filesTimeout: TimeInterval,
    grace: TimeInterval, outcome: Outcome
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

    // 4. An inserted body removes nothing.
    if request.body != nil, !request.insert, !before.files.isEmpty {
      return refusal(
        "files",
        "The draft's own text holds \(before.files.joined(separator: ", ")), which a new body "
          + "would remove. \(untouched)",
        "Use edits, which change only the text they find and leave files where they are.",
        ["files": before.files])
    }
    if let refused = missingFiles(request, untouched) { return refused }

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
    } else if let body = request.body, request.insert {
      // Nothing but whitespace would read back as the own text it went above.
      guard !squash(body).isEmpty else {
        return refusal(
          "confirmation",
          "The body to insert is only whitespace (line breaks or spaces), which reading the "
            + "window back cannot tell from the draft as it is, so there would be no way to know "
            + "the paste landed. \(untouched)",
          "Give the body some words.")
      }
      result = body + "\n" + before.text
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
    if request.body != nil, !request.insert, marks > before.files.count {
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
          else { return misselected(step.original, state: untouched) }
          if let refused = try outsideQuote(w, state: untouched) { return refused }
        }
      } else if request.body != nil, request.insert {
        guard let back = try w.selectOwnStart(), back.isEmpty else {
          return misselected(nil, state: untouched)
        }
        if let refused = try outsideQuote(w, state: untouched) { return refused }
      } else if request.body != nil {
        guard let back = try w.selectOwn(), sameSpan(back, range) else {
          return misselected(nil, state: untouched)
        }
        if let refused = try outsideQuote(w, state: untouched) { return refused }
      } else {
        guard let back = try w.selectOwnEnd(), back.isEmpty else {
          return misselected(nil, state: untouched)
        }
        if let refused = try outsideQuote(w, state: untouched) { return refused }
      }
    } catch {
      return refusal(
        "composer", "The composer's text could not be selected (\(describe(error))). \(untouched)",
        "Try again once the Mac is free, or edit the draft in Mail directly.")
    }

    // 8. And 13, on every way out from here.
    let previous = front?.current()
    let borrow = Borrow(board)
    let answer = paste(
      w, request, before: before, range: range, steps: steps, result: result, board: borrow,
      broughtForward: broughtForward, readbackTimeout: readbackTimeout,
      filesTimeout: filesTimeout, report: outcome)
    if borrow.unanswered {
      let deadline = Date().addingTimeInterval(grace)
      while Date() < deadline, (try? w.blocks()) == nil, w.isAlive { usleep(50_000) }
    }
    borrow.giveBack()
    outcome.unanswered = borrow.unanswered
    front?.give(to: previous)
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
    result: String?, board: Borrow, broughtForward: Bool, readbackTimeout: TimeInterval,
    filesTimeout: TimeInterval, report: Outcome
  ) -> [String: Any] {
    // Whether the window may now hold something the saved draft does not.
    var changed = false
    // The pastes that read back as meant, and whether the last one posted has not.
    var verified: [String] = []
    var unverified = false
    func state() -> String {
      guard changed else { return "Nothing was pasted and the draft is unchanged." }
      let done =
        verified.isEmpty
        ? ""
        : "\(sentence(verified)) \(verified.count == 1 ? "was" : "were") pasted and read back. "
      return unverified
        ? done + "The last paste could not be verified. \(autosaved)"
        : done + "Nothing after that was pasted. \(autosavedPart)"
    }
    func look() -> String {
      changed ? afterPaste : "Look at the composer in Mail: fix it there, or close it."
    }
    // For a refusal whose own hint fits only while nothing is pasted.
    func hint() -> String? { changed ? afterPaste : nil }
    // Before every selection and paste once Mail is in front: the window
    // still shows this composer's tab, so nothing reaches another draft.
    func elsewhere() -> [String: Any]? {
      guard w.tab == .background else { return nil }
      return refusal(
        "composer",
        "Mail's window moved to another of its tabs during the edit, so nothing more was "
          + "selected or pasted. Someone is probably using the Mac. \(state())",
        hint() ?? "Try again once the Mac is free.")
    }

    do {
      // 9. Once only: Mail already came forward for a tab at step 0.
      guard try broughtForward ? w.focus() : w.activate() else {
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
          if let refused = elsewhere() { return refused }
          guard let back = try w.selectSubrange(step.range, in: range),
            sameSpan(back, step.original)
          else { return misselected(step.original, state: state(), hint: hint()) }
          if let refused = try outsideQuote(w, state: state(), hint: hint()) { return refused }
          if let refused = elsewhere() { return refused }
          let content = PasteContent.text(step.replace)
          try board.write(content)
          guard try w.paste(content) else { return unfocused(state(), hint: hint()) }
          changed = true
          unverified = true
          let awaited = awaitRead(
            w, timeout: readbackTimeout, quote: before, until: { same($0.text, step.expected) })
          if case .quoteChanged = awaited { return quoteLost() }
          guard case .read(let read) = awaited else {
            return unconfirmed(awaited, board, readbackTimeout, state(), look())
          }
          guard quoteIntact(before, read) else { return quoteLost() }
          shown = read
          unverified = false
          verified.append("the edit of \"\(step.find)\"")
        }
      } else if let body = request.body, request.insert {
        if let refused = elsewhere() { return refused }
        guard let back = try w.selectOwnStart(), back.isEmpty else {
          return misselected(nil, state: state(), hint: hint())
        }
        if let refused = try outsideQuote(w, state: state(), hint: hint()) { return refused }
        if let refused = elsewhere() { return refused }
        let content = PasteContent.text(insertion(body, above: before))
        try board.write(content)
        guard try w.paste(content) else { return unfocused(state(), hint: hint()) }
        changed = true
        unverified = true
      } else if let body = request.body {
        if let refused = elsewhere() { return refused }
        guard let back = try w.selectOwn(), sameSpan(back, range) else {
          return misselected(nil, state: state(), hint: hint())
        }
        if let refused = try outsideQuote(w, state: state(), hint: hint()) { return refused }
        if let refused = elsewhere() { return refused }
        // A body equal to the own text to the letter has nothing to paste.
        if !(request.html == nil && body == before.text) {
          let content = request.html.map { PasteContent.html($0, fallback: body) } ?? .text(body)
          try board.write(content)
          guard try w.paste(content) else { return unfocused(state(), hint: hint()) }
          changed = true
          unverified = true
        }
      }
      if let result {
        let awaited = awaitRead(
          w, timeout: readbackTimeout, quote: before, until: { same($0.text, result) })
        if case .quoteChanged = awaited { return quoteLost() }
        guard case .read(let read) = awaited else {
          return unconfirmed(awaited, board, readbackTimeout, state(), look())
        }
        guard quoteIntact(before, read) else { return quoteLost() }
        shown = read
        if request.body != nil && unverified {
          unverified = false
          verified.append("the new body")
        }
      }

      // 11.
      var added: [String] = []
      if !request.files.isEmpty {
        if let refused = elsewhere() { return refused }
        guard let back = try w.selectOwnEnd(), back.isEmpty else {
          return misselected(nil, state: state(), hint: hint())
        }
        if let refused = try outsideQuote(w, state: state(), hint: hint()) { return refused }
        if let refused = elsewhere() { return refused }
        let content = PasteContent.files(request.files)
        try board.write(content)
        guard try w.paste(content) else { return unfocused(state(), hint: hint()) }
        changed = true
        unverified = true
        let names = request.files.map(\.lastPathComponent)
        let text = shown.text
        let held = shown.files
        let awaited = awaitRead(
          w, timeout: filesTimeout, quote: before,
          until: {
            same($0.text, text) && arrived(names, before: held, now: $0.files)
              && quoteIntact(before, $0)
          })
        if case .quoteChanged = awaited { return quoteLost() }
        guard case .read(let read) = awaited else {
          if case .timedOut(answered: false) = awaited { board.unanswered = true }
          let why =
            awaited == .gone
            ? "the composer window closed before they read back"
            : "they did not read back in the draft's own text within \(seconds(filesTimeout)), "
              + "with that text and the quote unchanged"
          return refusal(
            "confirmation", "\(names.joined(separator: ", ")) were pasted, but \(why). \(state())",
            look())
        }
        shown = read
        added = names
      }

      // 12.
      var saved = false
      let note: String
      if request.save, w.tab == .background {
        note =
          "The change was read back from the composer, but Mail's window then moved to another "
          + "of its tabs, and command-S saves the tab shown, so it was not pressed and this did "
          + "not save it. The draft's tab is open in Mail with the change in it."
      } else if request.save {
        // A tab Mail came forward for is left shown from here (`edit`).
        let outcome = (try? w.save()) ?? .refused
        if broughtForward { report.savePosted = true }
        let leftShown =
          broughtForward
          ? " This draft's tab is left shown in Mail's window, in place of the tab shown before: "
            + "say so to the person." : ""
        switch outcome {
        case .pressed where broughtForward:
          saved = true
          note =
            "The change was read back from the composer and command-S was pressed. Mail's window "
            + "does not say when a save has landed, so this left this draft's tab shown rather "
            + "than selecting the tab shown before, which a late command-S could have saved "
            + "instead. The window is still open in Mail. Say so to the person."
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
            + "this did not save it. The window is open with the change in it." + leftShown
        }
      } else {
        note = "The change was read back from the composer and, as asked, not saved."
      }
      var answer: [String: Any] = [
        "replaced": true, "method": "inPlace", "text": shown.text, "quoteKept": shown.quoted,
        "filesAdded": added, "saved": saved, "note": note,
      ]
      if request.insert { answer["kept"] = before.text }
      return answer
    } catch {
      return refusal("composer", "The edit stopped: \(describe(error)). \(state())", look())
    }
  }

  // ─── the edit's parts ──────────────────────────────────────────────────────

  /// What an inserted body is pasted as: the body, and a newline after it when
  /// the own text's first line holds text, which the body would otherwise run
  /// into. A blank first line, or no own text, takes the body as it is.
  static func insertion(_ body: String, above before: Read) -> String {
    guard let first = before.own.first, !squash(first.text).isEmpty else { return body }
    return body + "\n"
  }

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
    /// The quote read differently from before the paste: the paste went into it.
    case quoteChanged

    static func == (a: Awaited, b: Awaited) -> Bool {
      switch (a, b) {
      case (.gone, .gone), (.quoteChanged, .quoteChanged): return true
      case (.timedOut(let x), .timedOut(let y)): return x == y
      default: return false
      }
    }
  }

  /// Poll until `done`. A read whose quote TEXT differs from `quote`'s, whitespace
  /// folded, ends the poll at once: text that went into the quoted original is
  /// never waited on or saved. LIVE RUN 2's forward only ever read "own text
  /// still empty" until the deadline, while the note sat in the quote.
  private static func awaitRead(
    _ w: ComposerWindow, timeout: TimeInterval, quote: Read, until done: (Read) -> Bool
  ) -> Awaited {
    let deadline = Date().addingTimeInterval(timeout)
    var answered = false
    while true {
      if let blocks = try? w.blocks() {
        answered = true
        if let read = Read(blocks) {
          if !quoteIntact(quote, read) { return .quoteChanged }
          if done(read) { return .read(read) }
        }
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
      now.filter { fileMatches($0, name) }.count
        >= before.filter { fileMatches($0, name) }.count + names.filter { $0 == name }.count
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
  /// Whether a file element's label is the file `name`: equal to it, or the
  /// name then ", " and what follows, a size. MEASURED, LIVE RUN 5: an
  /// attachment reads `AXDescription` "probe-note.txt, 6 bytes", with an empty
  /// title. A longer name that only begins with it ("….bak") is not it.
  static func fileMatches(_ label: String, _ name: String) -> Bool {
    label == name || label.hasPrefix(name + ", ")
  }

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

  /// Said by every refusal issued once a paste has reached Mail. Mail autosaves
  /// an open composer on its own: LIVE RUN 2's unverified forward reached
  /// Drafts with `X-Apple-Auto-Saved: 1` although this never pressed command-S.
  static let autosaved =
    "This did not save it, but Mail autosaves an open composer on its own, so the unverified "
    + "text may already be in Drafts."
  /// The same, once every paste so far read back and the rest were not made:
  /// what Mail may have autosaved is a draft half edited.
  static let autosavedPart =
    "This did not save it, but Mail autosaves an open composer on its own, so Drafts may already "
    + "hold the draft with only those changes."
  static let afterPaste =
    "Close the composer in Mail WITHOUT saving, then check Drafts and delete any copy holding "
    + "text you did not mean."

  /// "The edit of "a" and the new body", capitalised, for `state()`.
  static func sentence(_ items: [String]) -> String {
    let joined =
      items.count <= 1
      ? items.joined()
      : items.dropLast().joined(separator: ", ") + " and " + (items.last ?? "")
    return joined.prefix(1).uppercased() + joined.dropFirst()
  }

  private static func misselected(_ text: String?, state: String, hint: String? = nil)
    -> [String: Any]
  {
    let what = text.map { "the text \"\($0)\"" } ?? "the draft's own text"
    return refusal(
      "selection",
      "The selection over \(what) did not read back as that text, so a paste could reach "
        + "further than it should. \(state)",
      hint ?? "Edit the draft in Mail directly, or replace the whole body.")
  }

  /// The gate after every selection: neither end of it inside the quote.
  /// A selection Mail would not place cannot be shown to be outside it, and is
  /// refused the same way.
  private static func outsideQuote(_ w: ComposerWindow, state: String, hint: String? = nil) throws
    -> [String: Any]?
  {
    let reaches = try w.selectionReachesQuote()
    if reaches == false { return nil }
    let why =
      reaches == true
      ? "The caret would land inside the quoted original, which a draft's own text never does."
      : "Mail would not say where the selection sits relative to the quoted original, so a "
        + "paste there could land inside it."
    return refusal(
      "selection", "\(why) \(state)",
      hint ?? "Write the draft's own text in Mail directly, above the quoted original.")
  }

  /// `hint` is the caller's: "try again" only while nothing has been pasted.
  private static func unfocused(_ state: String, hint: String?) -> [String: Any] {
    refusal(
      "composer",
      "The composer would not take the keyboard, so the paste was not posted. Someone is "
        + "probably using the Mac. \(state)",
      hint ?? "Try again once the Mac is free.")
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
      "The paste went in, but the quoted original is gone or reads differently, so it reached "
        + "further than the draft's own text. \(autosaved)",
      "Undo inside the composer with command-Z, or close it in Mail WITHOUT saving, then check "
        + "Drafts and delete any copy holding text you did not mean.")
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

  /// The window it was listed in. For a tab, where to look for it first: see
  /// `host`.
  let window: AXUIElement
  /// A tab's button in its window's `AXTabGroup`: what names the composer
  /// when the window holds several. Nil for a window of its own.
  let tabButton: AXUIElement?
  /// The tab's title when it was listed. A tab reading otherwise later is
  /// not trusted to be the same one (see `isAlive`).
  private let listedTitle: String?
  /// A window of its own reads its subject here; a tab reads its title.
  private let subjectField: AXUIElement
  private let pid: pid_t

  /// Whether no other tab of its window carried its title when it was
  /// listed: half of what lets a re-minted tab keep its handle.
  private let titleUnique: Bool

  private init(window: AXUIElement, tab: AXUIElement?, subjectField: AXUIElement, pid: pid_t) {
    self.window = window
    self.tabButton = tab
    let title = tab.flatMap(Self.title(of:))
    self.listedTitle = title
    self.titleUnique =
      title.map { name in Self.tabButtons(in: window).filter { Self.title(of: $0) == name }.count }
      == 1
    self.subjectField = subjectField
    self.pid = pid
  }

  /// A composer's text was asked for while its tab is not the one shown.
  struct NotShown: LocalizedError {
    var errorDescription: String? {
      "the composer's tab is not the one its window shows, so what the window holds is another draft"
    }
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
    // A window holding tabs is one element for all of them, its content the
    // selected tab's: each titled tab is a composer of its own, named by its
    // button, never by the window.
    return windows.flatMap { window -> [AXComposerWindow] in
      var pid: pid_t = 0
      guard AXUIElementGetPid(window, &pid) == .success,
        let field = field(in: window, "Mail.subjectField")
      else { return [] }
      let tabs = tabButtons(in: window)
      if tabs.isEmpty {
        return [AXComposerWindow(window: window, tab: nil, subjectField: field, pid: pid)]
      }
      return tabs.map { AXComposerWindow(window: window, tab: $0, subjectField: field, pid: pid) }
    }
  }

  /// A window's subject; a tab's title, which is its subject (LIVE RUN 3).
  var subject: String {
    if let tabButton { return Self.title(of: tabButton) ?? "" }
    return Self.attr(subjectField, kAXValueAttribute as String) as? String ?? ""
  }

  /// Only an element AX calls invalid is dead. A busy Mail (`cannotComplete`)
  /// still has its window, and calling that gone would let a later listing
  /// mint it a second handle.
  ///
  /// A window of its own that has since taken tabs is retired: its element now
  /// stands for every tab in it, and its content follows whichever is
  /// selected, so the handle that named it names no composer. A listing gives
  /// each tab its own. A tab is retired once its title no longer reads as the
  /// one it was listed with, should Mail ever hand a closed tab's button to
  /// another (unmeasured): a subject edited since only costs a new handle.
  var isAlive: Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
      return false
    }
    var out: CFTypeRef?
    guard let tabButton else {
      guard
        Self.alive(after: AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &out))
      else { return false }
      return Self.tabButtons(in: window).isEmpty
    }
    guard
      Self.alive(
        after: AXUIElementCopyAttributeValue(tabButton, kAXTitleAttribute as CFString, &out))
    else { return false }
    guard let now = out as? String else { return true }
    return now == listedTitle
  }

  static func alive(after err: AXError) -> Bool { err != .invalidUIElement }

  /// MEASURED, LIVE RUN 5: opening a tab RE-MINTS every tab button of the
  /// window, so no earlier button is `CFEqual` to its tab any more. A dead
  /// tab is re-bound to the live tab of the SAME window element carrying its
  /// title, only when that title was unique among the window's tabs when it
  /// was last listed, and is unique now. Otherwise it stays dead. The live tab
  /// can still be another draft (the person closed this one and opened or
  /// retitled another under the title), which is why the registry marks the
  /// handle `rebound` and `edit` then wants `expectHead`.
  func rebound() -> ComposerWindow? {
    guard tabButton != nil, let listedTitle else { return nil }
    var out: CFTypeRef?
    guard
      Self.alive(after: AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &out)),
      let live = Self.rebind(
        title: listedTitle, uniqueThen: titleUnique, among: Self.tabButtons(in: window),
        title: Self.title(of:))
    else { return nil }
    let next = AXComposerWindow(window: window, tab: live, subjectField: subjectField, pid: pid)
    return next.isAlive ? next : nil
  }

  /// The one tab titled `title` among `tabs`, when it was unique then too.
  static func rebind<E>(
    title: String, uniqueThen: Bool, among tabs: [E], title name: (E) -> String?
  ) -> E? {
    guard uniqueThen, !title.isEmpty else { return nil }
    let same = tabs.filter { name($0) == title }
    return same.count == 1 ? same.first : nil
  }

  func isSame(as other: ComposerWindow) -> Bool {
    guard let other = other as? AXComposerWindow else { return false }
    return Self.sameComposer(
      (window, tabButton), (other.window, other.tabButton), equal: { CFEqual($0, $1) })
  }

  // ─── tabs ──────────────────────────────────────────────────────────────────

  /// Same composer: a tab by its button, wherever its window; a window of its
  /// own by its window. Never a tab for the window holding it, which is one
  /// element whatever tab it shows.
  static func sameComposer<E>(
    _ a: (window: E, tab: E?), _ b: (window: E, tab: E?), equal: (E, E) -> Bool
  ) -> Bool {
    switch (a.tab, b.tab) {
    case (nil, nil): return equal(a.window, b.window)
    case (let x?, let y?): return equal(x, y)
    default: return false
    }
  }

  /// A tab group's composers: its titled children. MEASURED, LIVE RUN 3: one
  /// child has an empty title, probably the new-tab button.
  static func titledTabs<E>(_ children: [E], title: (E) -> String?) -> [E] {
    children.filter { !(title($0) ?? "").isEmpty }
  }

  /// The only role a tab is pressed or read as selected by. EXPECTED, not
  /// measured: a tab of any other role is never pressed and never shown, so
  /// it lists as a background tab and refuses to be edited.
  static func pressable(role: String?) -> Bool { role == "AXRadioButton" }

  /// The one tab reading as selected (`AXValue` 1, EXPECTED), or nil when none
  /// or several do.
  static func selectedTab<E>(among tabs: [E], role: (E) -> String?, value: (E) -> Int?) -> E? {
    let selected = tabs.filter { pressable(role: role($0)) && value($0) == 1 }
    return selected.count == 1 ? selected.first : nil
  }

  /// Whether the window shows `tab`: it is the one tab reading as selected,
  /// and the window's subject field reads as its title. Either alone could be
  /// wrong, and two tabs can share a title, which is why a background tab that
  /// shares one needs `expectHead` before it is edited.
  static func shows<E>(
    _ tab: E, among tabs: [E], subject: String?, equal: (E, E) -> Bool,
    role: (E) -> String?, value: (E) -> Int?, title: (E) -> String?
  ) -> Bool {
    guard let selected = selectedTab(among: tabs, role: role, value: value), equal(selected, tab),
      let name = title(tab), !name.isEmpty, let subject
    else { return false }
    return subject == name
  }

  /// The tabs of a window: the titled children of its `AXTabGroup` child
  /// (MEASURED, LIVE RUN 3). Empty for a window with no tab group.
  private static func tabButtons(in window: AXUIElement) -> [AXUIElement] {
    guard let group = children(window).first(where: { role($0) == "AXTabGroup" }) else {
      return []
    }
    return titledTabs(children(group), title: title(of:))
  }

  private static func title(of el: AXUIElement) -> String? {
    attr(el, kAXTitleAttribute as String) as? String
  }

  private static func intValue(_ el: AXUIElement) -> Int? {
    (attr(el, kAXValueAttribute as String) as? NSNumber)?.intValue
  }

  /// The window holding this tab now: the one it was listed in while it is
  /// still there, otherwise whichever of Mail's windows holds it, in case
  /// AppKit gives each tab a window of its own (unmeasured). Nil when none.
  private func host() -> AXUIElement? {
    guard let tabButton else { return window }
    if Self.tabButtons(in: window).contains(where: { CFEqual($0, tabButton) }) { return window }
    guard
      let windows = try? AccessibilityDriver.windowElements(
        bundleId: Self.bundleId, scope: Self.scope)
    else { return nil }
    return windows.first { Self.tabButtons(in: $0).contains { CFEqual($0, tabButton) } }
  }

  /// The window, when what it shows is this composer: always, for a window of
  /// its own that has not taken tabs; for a tab, only while `shows` says so.
  /// Every read and write of the body goes through here, so none reaches
  /// another tab's draft.
  private func shownWindow() -> AXUIElement? {
    guard let tabButton else { return Self.tabButtons(in: window).isEmpty ? window : nil }
    guard let host = host() else { return nil }
    let subject = Self.field(in: host, "Mail.subjectField").flatMap {
      Self.attr($0, kAXValueAttribute as String) as? String
    }
    let shown = Self.shows(
      tabButton, among: Self.tabButtons(in: host), subject: subject, equal: { CFEqual($0, $1) },
      role: Self.role, value: Self.intValue, title: Self.title(of:))
    return shown ? host : nil
  }

  var tab: ComposerTab? {
    guard tabButton != nil else { return nil }
    return shownWindow() == nil ? .background : .selected
  }

  var sharesTabTitle: Bool {
    guard let tabButton else { return false }
    guard let host = host(), let name = Self.title(of: tabButton) else { return true }
    return Self.tabButtons(in: host).filter { Self.title(of: $0) == name }.count > 1
  }

  /// UNMEASURED: whether `AXPress` selects a tab. The caller polls `tab`
  /// afterwards and refuses when it does not come up.
  func pressTab() throws -> Bool {
    guard let tabButton, Self.pressable(role: Self.role(tabButton)) else { return false }
    try DrivingSession.admit(Self.bundleId)
    DriveActivity.record(Self.bundleId)
    return AXUIElementPerformAction(tabButton, kAXPressAction as CFString) == .success
  }

  func shownTab() -> ComposerWindow? {
    guard tabButton != nil, let host = host(),
      let selected = Self.selectedTab(
        among: Self.tabButtons(in: host), role: Self.role, value: Self.intValue)
    else { return nil }
    return AXComposerWindow(window: host, tab: selected, subjectField: subjectField, pid: pid)
  }

  // ─── the fields ────────────────────────────────────────────────────────────

  var to: [String] {
    shownWindow().flatMap { Self.field(in: $0, "Mail.toField") }.map(Self.names(in:)) ?? []
  }
  var cc: [String] {
    shownWindow().flatMap { Self.field(in: $0, "Mail.ccField") }.map(Self.names(in:)) ?? []
  }
  var bcc: [String]? {
    shownWindow().flatMap { Self.field(in: $0, "Mail.bccField") }.map(Self.names(in:))
  }

  /// `popup_from`'s value reads `Name – address`.
  var from: String? {
    shownWindow().flatMap { Self.field(in: $0, "popup_from") }.flatMap {
      Self.attr($0, kAXValueAttribute as String) as? String
    }
  }

  var isMain: Bool {
    guard let shown = shownWindow() else { return false }
    return (Self.attr(shown, kAXMainAttribute as String) as? NSNumber)?.boolValue == true
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

  /// UNMEASURED LIVE: a collapsed selection at the start of the own range is
  /// where Mail's caret sits in a fresh composer, above the signature. Read
  /// back, and proved outside the quote, by the caller.
  func selectOwnStart() throws -> String? {
    let web = try webArea()
    guard let range = ownRange(web) else { return nil }
    let start = Self.start(of: range)
    return try select(AXTextMarkerRangeCreate(kCFAllocatorDefault, start, start), in: web)
  }

  /// MEASURED (spike): a paste only lands with Mail active, and right after
  /// `activate()` the frontmost read can still say no while the paste would
  /// land — so this waits for the window server to agree (up to two seconds,
  /// `activateAndWait`), then raises this window and focuses its body, and
  /// requires it to be Mail's focused window: command-V goes to the key window,
  /// and the viewer's search field is not where a draft goes. Both that and
  /// Mail being frontmost must then hold for a moment (`settled`).
  func activate() throws -> Bool {
    _ = try webArea()
    guard try AccessibilityDriver.activateAndWait(bundleId: Self.bundleId, scope: Self.scope)
    else { return false }
    return try focus()
  }

  /// `activate` without the activation: Mail already came forward for a tab
  /// at step 0. `settled` still requires Mail frontmost, so a person who moved
  /// to another application since is not pulled back; the paste is refused.
  func focus() throws -> Bool {
    let web = try webArea()
    guard let window = shownWindow() else { throw NotShown() }
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(web, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return Self.settled(focused: isFocusedWindow, frontmost: AccessibilityDriver.frontmostBundleId)
  }

  /// Admission (inside `activateAndWait`), then Mail frontmost, as the window
  /// server says. No window is raised: the one to raise is not shown yet.
  func bringForward() throws -> Bool {
    try AccessibilityDriver.activateAndWait(bundleId: Self.bundleId, scope: Self.scope)
  }

  /// The web area the host window shows now, whichever tab's it is. A tab's
  /// content is its own view, so a switch that took shows another element;
  /// UNMEASURED, and if Mail reused one element for every tab, no switch would
  /// ever be confirmed and every background-tab edit would refuse.
  func windowBody() -> AnyObject? {
    guard let host = host() else { return nil }
    return Self.find(host, depth: 10, where: { Self.role($0) == "AXWebArea" })
  }

  func sameBody(_ a: AnyObject, _ b: AnyObject) -> Bool { CFEqual(a, b) }

  /// A file element's name: its title, or else its description. MEASURED,
  /// LIVE RUN 5: an attachment is an AXButton with an empty title and the
  /// description "probe-note.txt, 6 bytes", the name, ", ", a localised size.
  /// For that shape the last ", " part is dropped when it starts with a digit;
  /// anything else is kept as it reads, and the read-back's `fileMatches`
  /// still takes "name, size" for the name. An image's title is its name.
  static func fileName(role: String?, title: String?, description: String?) -> String? {
    if let title, !title.isEmpty { return title }
    guard let description, !description.isEmpty else { return nil }
    guard role == "AXButton", let cut = description.range(of: ", ", options: .backwards),
      description[cut.upperBound...].first?.isNumber == true
    else { return description }
    return String(description[..<cut.lowerBound])
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
  /// frontmost, this checks it is THIS window of Mail's. Asked again inside
  /// `key` if its front check had to wait (`still`): a Delete into the viewer
  /// instead of the composer would move the selected message to the Trash.
  func paste(_ content: PasteContent) throws -> Bool {
    guard isFocusedWindow() else { return false }
    if content == .text("") {
      try AccessibilityDriver.key(
        "delete", modifiers: [], scope: Self.scope, announcing: Self.bundleId,
        still: { self.isFocusedWindow() })
    } else {
      try AccessibilityDriver.key(
        "v", modifiers: ["command"], scope: Self.scope, announcing: Self.bundleId,
        still: { self.isFocusedWindow() })
    }
    return true
  }

  func save() throws -> SaveOutcome {
    guard isAlive else { return .gone }
    guard isFocusedWindow() else { return .refused }
    do {
      try AccessibilityDriver.key(
        "s", modifiers: ["command"], scope: Self.scope, announcing: Self.bundleId,
        still: { self.isFocusedWindow() })
    } catch {
      return isAlive ? .refused : .gone
    }
    return .pressed
  }

  private func webArea() throws -> AXUIElement {
    guard let window = shownWindow() else { throw NotShown() }
    guard let web = Self.find(window, depth: 10, where: { Self.role($0) == "AXWebArea" })
    else { throw NoBody() }
    return web
  }

  /// The own blocks' range: the first's start to the last's end, joined with the
  /// public marker calls (Mail offers no `AXStartTextMarkerForTextMarkerRange`).
  ///
  /// With no own block, a collapsed range at the start of the DOCUMENT: the web
  /// area's index 0, or the start of its own marker range. Not the first
  /// block's start. MEASURED, LIVE RUN 2 (2026-10-26): a forward's own area is
  /// a bare `<br id="lineBreakAtBeginningOfMessage">` ahead of
  /// `<div class="AppleOriginalContents">`, which AX does not expose as a block,
  /// so the first block IS the quote (level 1, "Begin forwarded message:"), and
  /// a caret at its start pasted the note inside the quoted original. Where the
  /// document start resolves is then proved by `selectionReachesQuote` before
  /// anything is pasted.
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
    let start =
      Self.marker(Self.param(web, "AXTextMarkerForIndex", NSNumber(value: 0)))
      ?? Self.markerRange(Self.param(web, "AXTextMarkerRangeForUIElement", web)).map {
        Self.start(of: $0)
      }
    guard let start else { return nil }
    return AXTextMarkerRangeCreate(kCFAllocatorDefault, start, start)
  }

  /// Both ends of the web area's selection, each resolved to its element with
  /// `AXUIElementForTextMarker` and walked up to the web area: any element on
  /// the way with `AXBlockQuoteLevel` above 0 is inside the quote. Nil when an
  /// end does not resolve, or the walk never reaches the web area.
  ///
  /// For a selection that covers text, its end is taken one character back
  /// (`AXPreviousTextMarkerForTextMarker`, when Mail answers it): the end
  /// marker sits on the boundary after the last selected character, which can
  /// resolve to the element that follows, a reply's first quoted block. A
  /// collapsed caret is resolved where it is, which is where a paste inserts.
  func selectionReachesQuote() throws -> Bool? {
    let web = try webArea()
    guard let selected = Self.markerRange(Self.attr(web, Self.selectedRange)) else { return nil }
    let start = AXTextMarkerRangeCopyStartMarker(selected)
    var last = AXTextMarkerRangeCopyEndMarker(selected)
    if (Self.string(web, for: selected) ?? "").isEmpty == false,
      let previous = Self.marker(Self.param(web, "AXPreviousTextMarkerForTextMarker", last))
    {
      last = previous
    }
    for end in [start, last] {
      guard let raw = Self.param(web, "AXUIElementForTextMarker", end),
        CFGetTypeID(raw) == AXUIElementGetTypeID()
      else { return nil }
      let found = Self.walkReachesQuote(
        from: raw as! AXUIElement, isBody: { CFEqual($0, web) },
        level: { (Self.attr($0, "AXBlockQuoteLevel") as? NSNumber)?.intValue },
        parent: {
          guard let up = Self.attr($0, kAXParentAttribute as String),
            CFGetTypeID(up) == AXUIElementGetTypeID()
          else { return nil }
          return (up as! AXUIElement)
        })
      guard let found else { return nil }
      if found { return true }
    }
    return false
  }

  /// From an element up to the body: true at the first quote level above 0,
  /// false on reaching the body, nil when it cannot be told.
  ///
  /// Nil, and so a refusal, when the walk never reaches the body, and when the
  /// body's DIRECT child on the way does not answer its level: `Read` refuses
  /// an unreadable level the same way, and the body's children are the blocks
  /// whose levels were measured to always answer. A deeper element that does
  /// not answer is passed over, as inline runs need not carry one.
  static func walkReachesQuote<E>(
    from start: E, isBody: (E) -> Bool, level: (E) -> Int?, parent: (E) -> E?
  ) -> Bool? {
    var element = start
    for _ in 0..<64 {
      if isBody(element) { return false }
      let answered = level(element)
      if let answered, answered > 0 { return true }
      guard let up = parent(element) else { return nil }
      if answered == nil && isBody(up) { return nil }
      element = up
    }
    return nil
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

  /// Mail's focused window is the one showing this composer: for a tab, the
  /// window AND this tab shown in it, so a keystroke never reaches another
  /// tab's draft.
  private func isFocusedWindow() -> Bool {
    guard let window = shownWindow() else { return false }
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
    if let role = role(el), fileRoles.contains(role),
      let name = fileName(
        role: role, title: attr(el, kAXTitleAttribute as String) as? String,
        description: attr(el, kAXDescriptionAttribute as String) as? String)
    {
      names.append(name)
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
    activate: (String) -> Bool, isRegularApp: (String) -> Bool = AccessibilityDriver.isRegularApp,
    stable: TimeInterval = 0.15, timeout: TimeInterval = 1, grace: TimeInterval = 0.5
  ) -> HandBack {
    guard previous != driven else { return .alreadyThere }
    let now = frontmost()
    if now == previous { return .alreadyThere }
    // Another regular application in front is the person having moved: left
    // alone at once. Only an unanswered or helper read is waited out.
    guard
      now == driven
        || AccessibilityDriver.frontmostHolds(
          driven, grace: grace, read: frontmost, isRegularApp: isRegularApp)
    else { return .leftAlone }
    _ = activate(previous)
    let landed = AccessibilityDriver.holdsSteadily(for: stable, within: timeout) {
      frontmost() == previous
    }
    return landed ? .landed : .didNotLand
  }
}
