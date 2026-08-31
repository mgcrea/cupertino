import Foundation
import Observation

/// What the log window shows.
///
/// This is the GUI rendering of what `apple_mail_diagnostics` reports on the
/// tool side, and it deliberately reuses that vocabulary — lane names, error
/// text — rather than inventing a second one.
///
/// What it records, and the limit of the claim: Cupertino sees the JSON-RPC
/// frames crossing the socket — which surface, which method, which tool, and
/// the arguments it was called with. Prose is blanked unless a surface asks for
/// it, and results are recorded only for a surface that opts in; `CallCapture`
/// is where both are enforced rather than intended.
///
/// Payloads live here and only here. Nothing writes them to disk — this store
/// is a ring buffer in memory, cleared on quit, and `hostCall` keeps them off
/// the stderr mirror every other line goes through.
@MainActor
@Observable
final class LogStore {
  static let shared = LogStore()

  enum Level: String {
    case info, call, error
  }

  struct Entry: Identifiable {
    /// A `var` so `hostCall` can mint the id on the calling thread and hand it
    /// here, rather than waiting on this actor to learn what it became.
    var id = UUID()
    let at: Date
    let surface: String
    let level: Level
    let text: String
    /// What a `tools/call` was called with, already redacted and capped by
    /// `CallCapture`. Nil when the surface records names only, or when there
    /// were no arguments.
    var arguments: String?
    /// What came back, for a surface that opted into results. Attached later
    /// than the rest of the row: the reply arrives on the other pump thread,
    /// after the entry it belongs to already exists.
    var result: String?
    /// Whether the reply was an error frame or an `isError` result. Only
    /// meaningful once a result has been attached.
    var failed = false

    /// Roughly what this row costs, for the byte budget below.
    var weight: Int { text.utf8.count + (arguments?.utf8.count ?? 0) + (result?.utf8.count ?? 0) }

    /// Whether this row answers a search.
    ///
    /// Over the payloads as well as the name, because "which call touched order
    /// 992" is what a log this size gets opened for, and the answer is in the
    /// arguments rather than in `shopify_get_order`. The surface is searched too,
    /// so a surface name narrows the feed without reaching for the picker.
    ///
    /// Case- and diacritic-insensitive: a log is skimmed, not queried, and
    /// making someone match the case of a tool name they are trying to find is
    /// a filter that mostly returns nothing.
    func matches(_ needle: String) -> Bool {
      let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
      if text.range(of: needle, options: options) != nil { return true }
      if surface.range(of: needle, options: options) != nil { return true }
      if let arguments, arguments.range(of: needle, options: options) != nil { return true }
      if let result, result.range(of: needle, options: options) != nil { return true }
      return false
    }

    /// Whether the match is somewhere the row does not show until it is opened.
    ///
    /// A payload is previewed at a fixed length, so a search that hit character
    /// 900 of an argument would list a row with no visible reason for being
    /// there — the failure being that the feature looks broken rather than
    /// looks incomplete. `FeedRow` opens such a row itself.
    func matchIsHidden(_ needle: String, preview: Int) -> Bool {
      guard !needle.isEmpty, matches(needle) else { return false }
      let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
      if text.range(of: needle, options: options) != nil { return false }
      if surface.range(of: needle, options: options) != nil { return false }
      for payload in [arguments, result].compactMap({ $0 }) {
        if String(payload.prefix(preview)).range(of: needle, options: options) != nil {
          return false
        }
      }
      return true
    }

  }

  /// Bounded: this runs for as long as the machine is up, and an unbounded log
  /// is a memory leak with a nice name.
  private let limit = 1000

  /// And bounded again, in bytes.
  ///
  /// The entry count stopped being a bound once rows could carry payloads: a
  /// thousand rows of a tool name is a few tens of kilobytes, a thousand rows
  /// of two capped payloads is eight megabytes pinned for as long as the app is
  /// up. Whichever limit is reached first trims.
  private let byteLimit = 2 * 1024 * 1024
  private var weight = 0

  private(set) var entries: [Entry] = []

  func append(surface: String, level: Level, _ text: String) {
    add(Entry(at: Date(), surface: surface, level: level, text: text))
  }

  /// Record a call under an id its reply will be attached to later.
  ///
  /// Separate from `append` because the arguments must not reach stderr — see
  /// `hostCall`, which is the only thing that should call this.
  func appendCall(surface: String, text: String, arguments: String?, id: UUID) {
    add(Entry(id: id, at: Date(), surface: surface, level: .call, text: text, arguments: arguments))
  }

  /// Attach a reply to the call it answers.
  ///
  /// A miss is ordinary rather than an error: the row may have been trimmed out
  /// of the ring buffer while the server was still working on it.
  func attachResult(_ id: UUID, _ result: String?, failed: Bool) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    weight -= entries[index].weight
    entries[index].result = result
    entries[index].failed = failed
    weight += entries[index].weight
    Self.onResult?(entries[index])
  }

  private func add(_ entry: Entry) {
    entries.append(entry)
    weight += entry.weight
    // The durable copy, if anything is keeping one. Here rather than at the
    // call sites: this is the one place every row passes through, and it is on
    // the main actor, so whatever is listening inherits this store's ordering
    // rather than establishing its own — a hash chain built out of order fails
    // verification for no reason anyone can reproduce.
    //
    // A hook rather than a direct call to `AuditLog`, so this file keeps a
    // dependency closure small enough for the standalone check targets.
    Self.onCall?(entry)
    while entries.count > limit || (weight > byteLimit && entries.count > 1) {
      weight -= entries.removeFirst().weight
    }
  }

  func clear() {
    entries.removeAll()
    weight = 0
  }

  /// Installed by whatever wants a durable copy — `AuditLog`, at launch.
  ///
  /// Nil until something asks, which is also the default state of the feature:
  /// with the Activity pane untouched nothing is listening and no file opens.
  static var onCall: ((Entry) -> Void)?
  static var onResult: ((Entry) -> Void)?

  /// Seed one entry at a fixed instant, for `DemoSeed` only.
  ///
  /// Separate from `append` rather than an optional `at:` parameter on it: the
  /// live path must never be able to pass a date, because a caller that could
  /// choose the timestamp is a caller that could get it wrong, and every real
  /// line is stamped when it happens.
  func appendDemo(at: Date, surface: String, level: Level, _ text: String) {
    entries.append(Entry(at: at, surface: surface, level: level, text: text))
  }
}

/// Where Cupertino keeps everything that is not a socket.
///
/// `BridgeProtocol` already owns the identity and the directory — it has to,
/// because the bridge computes the socket path without linking any of this —
/// so this is a `URL` view of the same string rather than a second opinion
/// about where the app's state lives. Ported from Bastion, which needed it
/// first because it had files to write; Cupertino has had only a socket until
/// now.
///
/// The mode is 0700: the audit log below it holds what tools were called with.
enum AppSupport {
  static var directory: URL { URL(fileURLWithPath: BridgeProtocol.socketDirectory) }

  @discardableResult
  static func ensureDirectory() -> URL {
    let url = directory
    try? FileManager.default.createDirectory(
      at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return url
  }
}

/// Post a log line from any thread.
///
/// Also mirrored to stderr, which is where it shows up when the app is launched
/// from a terminal instead of by LaunchServices — the difference between being
/// able to debug the host and guessing at it.
/// The stderr mirror goes through `write(2)` for the same reason the bridge's
/// `warn` does: `-[NSFileHandle writeData:]` raises an Objective-C exception on
/// a failed write, Swift cannot catch it, and the process aborts. The bridge was
/// seen dying that way. A GUI app's stderr is usually a pipe LaunchServices
/// keeps open, so this end is far less exposed — but "usually" is the whole
/// problem, and a logging call is not something that should be able to take the
/// app down. A dropped line is the correct failure here.
func hostLog(_ surface: String, _ level: LogStore.Level, _ text: String) {
  let bytes = Array("[\(surface)] \(level.rawValue): \(text)\n".utf8)
  var offset = 0
  while offset < bytes.count {
    let written = bytes.withUnsafeBufferPointer {
      write(STDERR_FILENO, $0.baseAddress! + offset, bytes.count - offset)
    }
    if written <= 0 {
      if errno == EINTR { continue }
      break
    }
    offset += written
  }
  Task { @MainActor in LogStore.shared.append(surface: surface, level: level, text) }
}

/// Post a call line, with its arguments kept out of the stderr mirror.
///
/// The mirror is why this is not `hostLog(surface, .call, ...)` with a longer
/// string. `hostLog` writes every line it is given to stderr, and for an app
/// started by LaunchServices that lands outside Cupertino's own directory and
/// outlives the process — so routing a payload through it would quietly persist
/// the one thing this feature promises to keep in memory. Only the tool name
/// goes to stderr here; the arguments go to the store and nowhere else.
///
/// Returns the entry id so the reply can be attached to the right row. Minted
/// on the calling thread rather than inside the hop, so the pump can hold on to
/// it without waiting for the main actor.
@discardableResult
func hostCall(_ surface: String, _ text: String, arguments: String?) -> UUID {
  let id = UUID()
  let bytes = Array("[\(surface)] call: \(text)\n".utf8)
  var offset = 0
  while offset < bytes.count {
    let written = bytes.withUnsafeBufferPointer {
      write(STDERR_FILENO, $0.baseAddress! + offset, bytes.count - offset)
    }
    if written <= 0 {
      if errno == EINTR { continue }
      break
    }
    offset += written
  }
  // Pinned to one priority, and the same one `Sessions` uses. The main actor's
  // executor only guarantees FIFO *within* a priority, so a hop left to inherit
  // could overtake the one before it — and a result attaching to a row that has
  // not been appended yet is silently dropped.
  Task(priority: .userInitiated) { @MainActor in
    LogStore.shared.appendCall(surface: surface, text: text, arguments: arguments, id: id)
  }
  return id
}

/// Attach a reply from any thread.
func hostCallResult(_ id: UUID, _ result: String?, failed: Bool) {
  guard result != nil || failed else { return }
  Task(priority: .userInitiated) { @MainActor in
    LogStore.shared.attachResult(id, result, failed: failed)
  }
}
