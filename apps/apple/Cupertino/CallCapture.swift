import Foundation

/// What a recorded call is allowed to carry.
///
/// Inherited from Bastion's file of the same name, and deliberately not shared
/// with it: the two apps have no package in common, and the halves that differ
/// are the halves that matter. Bastion redacts credentials because it holds
/// every credential on the machine. Cupertino holds none — and has a sharper
/// problem instead.
///
///   THE INVERSION  In Bastion an argument is an identifier and the bulk data
///                  comes back in the result, so recording arguments by default
///                  is close to free. Here it is the other way round: the body
///                  of a mail, the text of a message and the content of a note
///                  arrive as ARGUMENTS, on the way out. `send_message` takes
///                  "exactly what to send, sent verbatim". Recording arguments
///                  naively would write every mail, note and iMessage the user
///                  sends into the log, which is not what "record the call"
///                  should mean on a machine this app is trusted with.
///
///                  So content and structure are separated. By default a call
///                  records which tool, which mailbox, which recipient, which
///                  limit — and blanks the prose. `SurfaceSettings` turns the
///                  prose back on per surface, for whoever is debugging the
///                  thing that needs it.
///
///   THE SIZE       An argument is not reliably small, and here that is the
///                  normal case rather than the edge one. Capture is capped in
///                  bytes before it reaches a store that keeps a thousand of
///                  them.
///
/// Free of dependencies on the rest of the app: no store, no surface table, no
/// main actor. That is what lets `make unit` compile it against
/// `scripts/unit-check.swift` alone, which is the only kind of test this
/// project has.
enum CallCapture {
  /// How much of a call a surface records.
  ///
  /// Ordered by how much it keeps, so `>=` is a meaningful question.
  enum Mode: String, Codable, CaseIterable, Comparable {
    /// Names only — what Cupertino recorded before any of this existed.
    case off
    /// What a tool was called with.
    case arguments
    /// And what it answered.
    case argumentsAndResults

    private var rank: Int {
      switch self {
      case .off: 0
      case .arguments: 1
      case .argumentsAndResults: 2
      }
    }

    static func < (a: Mode, b: Mode) -> Bool { a.rank < b.rank }

    var label: String {
      switch self {
      case .off: "Names only"
      case .arguments: "Arguments"
      case .argumentsAndResults: "Arguments and results"
      }
    }
  }

  /// What a surface records when it has been asked for nothing in particular.
  static let defaultMode: Mode = .arguments

  /// Per payload, before it reaches the ring buffer.
  static let byteCap = 4096

  /// What replaces a value that is not being recorded.
  static let redacted = "«redacted»"

  // MARK: - What counts as content

  /// The argument names that carry prose rather than structure.
  ///
  /// Blanked unless a surface is set to include content. Drawn from the actual
  /// schemas rather than guessed at — `packages/mail/src/tools/compose.ts`
  /// (`body`), `packages/notes/src/tools/actions.ts` (`body`),
  /// `packages/messages/src/tools/actions.ts` (`text`, `query`).
  ///
  /// `subject` and `query` are in here on purpose, and they are the arguable
  /// ones. Both are short, and leaving them visible would make the default log
  /// noticeably more useful — but "what did I search my mail for" and "what did
  /// I title that message" are the user's business in the same way the body is.
  /// The toggle is what makes that judgement cheap to disagree with: this list
  /// is one constant, and a surface that needs its prose can have it.
  ///
  /// What survives redaction is the structure, which is what a log is usually
  /// wanted for: which tool, which mailbox, which recipient, which id, which
  /// limit, which date range.
  static let contentKeys: Set<String> = [
    "body", "text", "content", "html", "markdown", "note", "snippet", "message",
    "subject", "query",
  ]

  /// Names conventional enough to be worth blanking whatever a schema calls
  /// them. Cupertino has no tool that takes a credential — unlike Bastion,
  /// whose `set_credential` is the reason that app needs a never-capture list —
  /// but a surface added later might, and this costs nothing until then.
  static let alwaysRedacted: Set<String> = [
    "secret", "token", "password", "passwd", "credential", "credentials",
    "api_key", "apikey", "access_token", "refresh_token", "client_secret",
    "authorization", "auth", "private_key", "cookie",
  ]

  // MARK: - Capture

  /// What a `tools/call` was called with, or nil if nothing should be kept.
  static func arguments(params: [String: Any]?, mode: Mode, content: Bool) -> String? {
    guard mode >= .arguments, let params else { return nil }
    guard let inner = params["arguments"] as? [String: Any], !inner.isEmpty else { return nil }
    return encode(redact(inner, content: content))
  }

  /// What came back, or nil if nothing should be kept.
  ///
  /// An `error` frame and an `isError` result are both kept: a failure is what
  /// someone is most likely reading the log to understand, and neither is
  /// visible today even as a failure.
  ///
  /// A result is answered by the server, so every word of it is content by
  /// construction — a `get_message` result IS the mail. There is nothing
  /// structural to keep separate here, so `content` gates the whole thing
  /// rather than picking fields out of it.
  static func result(_ frame: [String: Any]?, mode: Mode, content: Bool) -> String? {
    guard mode >= .argumentsAndResults, let frame else { return nil }
    if let error = frame["error"] { return encode(redact(error, content: content)) }
    guard let value = frame["result"] else { return nil }
    if let object = value as? [String: Any], object.isEmpty { return nil }
    guard content else { return redacted }
    return encode(redact(value, content: true))
  }

  /// Whether a frame reported a failure, for the row's tint.
  static func isFailure(_ frame: [String: Any]?) -> Bool {
    guard let frame else { return false }
    if frame["error"] != nil { return true }
    return (frame["result"] as? [String: Any])?["isError"] as? Bool == true
  }

  /// Whether a decoded line is a response rather than a request.
  ///
  /// A response has an id and no method. A notification has a method and no id,
  /// and must not be mistaken for either.
  static func isResponse(_ frame: [String: Any]) -> Bool {
    frame["method"] == nil && frame["id"] != nil
  }

  /// A JSON-RPC id as a dictionary key.
  ///
  /// Ids may be a string or a number and the two are distinct — `1` and `"1"`
  /// are different ids per the spec — so the tag keeps them apart rather than
  /// stringifying both into a collision.
  static func idKey(_ value: Any?) -> String? {
    switch value {
    case let int as Int: "i\(int)"
    case let string as String: "s\(string)"
    case let number as NSNumber: "i\(number.intValue)"
    default: nil
    }
  }

  // MARK: - Redaction

  /// Walk a decoded JSON value, blanking what is not being recorded.
  ///
  /// Recurses through objects and arrays: a body nested two levels down is
  /// still a body. Matching is case-insensitive and ignores `-`/`_`, so
  /// `Api-Key`, `api_key` and `apiKey` are one name.
  static func redact(_ value: Any, content: Bool) -> Any {
    switch value {
    case let object as [String: Any]:
      var out: [String: Any] = [:]
      for (key, inner) in object {
        out[key] =
          shouldRedact(key, content: content)
          ? redacted : redact(inner, content: content)
      }
      return out
    case let array as [Any]:
      return array.map { redact($0, content: content) }
    default:
      return value
    }
  }

  static func shouldRedact(_ key: String, content: Bool) -> Bool {
    let normalised = normalise(key)
    if alwaysRedacted.contains(where: { normalise($0) == normalised }) { return true }
    if content { return false }
    return contentKeys.contains { normalise($0) == normalised }
  }

  private static func normalise(_ s: String) -> String {
    s.lowercased().replacingOccurrences(of: "-", with: "")
      .replacingOccurrences(of: "_", with: "")
  }

  // MARK: - Encoding

  /// Compact JSON, capped, or nil if it cannot be represented.
  ///
  /// `JSONSerialization` refuses a fragment, so a bare string or number is
  /// wrapped rather than dropped — a tool that answers `"ok"` should still
  /// leave a record.
  static func encode(_ value: Any) -> String? {
    let isObject = JSONSerialization.isValidJSONObject(value)
    let wrapped: Any = isObject ? value : [value]
    guard let data = try? JSONSerialization.data(withJSONObject: wrapped, options: [.sortedKeys]),
      var text = String(data: data, encoding: .utf8)
    else { return nil }
    if !isObject { text = String(text.dropFirst().dropLast()) }
    return truncate(text, to: byteCap)
  }

  /// Cut to `limit` bytes on a character boundary, saying how much went.
  ///
  /// Bytes because the cap exists to bound memory, and on a boundary because a
  /// `String` cut mid-scalar is not a `String`. The marker is part of the
  /// record: a truncated argument that does not say so is a misleading line.
  static func truncate(_ text: String, to limit: Int) -> String {
    let bytes = text.utf8.count
    guard bytes > limit else { return text }
    var end = text.startIndex
    var used = 0
    for index in text.indices {
      let width = text[index].utf8.count
      if used + width > limit { break }
      used += width
      end = text.index(after: index)
    }
    return String(text[text.startIndex..<end]) + "… +\(bytes - used) bytes"
  }
}

/// Splits a byte stream into newline-delimited frames.
///
/// Not `LineReader`, which already exists in `SurfaceCatalog.swift` and is a
/// different shape: that one PULLS lines from a `FileHandle` it owns, this one
/// is PUSHED chunks by a pump that owns the descriptor.
///
/// Lifted out of `RequestObserver`, where it was written once and is now needed
/// twice — the response direction straddles 64 KiB boundaries far more often
/// than the request one, because results are the big frames. Splitting each
/// chunk on its own dropped every frame unlucky enough to span two, invisibly,
/// because the pump still forwarded the bytes.
///
/// Here rather than beside its callers so `make unit` can compile it: that bug
/// is exactly the kind a test holds still, and it needs no app to reproduce.
struct FrameSplitter {
  /// The tail of a chunk that ended mid-line.
  private var pending = Data()

  /// A line this long is not MCP framing, so stop buffering rather than grow
  /// without bound on a peer that never sends a newline.
  private let limit: Int

  init(limit: Int = 1 << 20) { self.limit = limit }

  /// Every complete line in what has arrived so far.
  mutating func lines(_ chunk: Data) -> [Data] {
    pending.append(chunk)
    guard let lastNewline = pending.lastIndex(of: UInt8(ascii: "\n")) else {
      if pending.count > limit { pending.removeAll(keepingCapacity: false) }
      return []
    }
    let complete = pending[..<lastNewline]
    pending = Data(pending[pending.index(after: lastNewline)...])
    return complete.split(separator: UInt8(ascii: "\n")).filter { !$0.isEmpty }.map { Data($0) }
  }
}
