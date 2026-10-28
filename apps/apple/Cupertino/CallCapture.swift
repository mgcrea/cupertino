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
nonisolated enum CallCapture {
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

  /// The dispatcher names a surface exposes when it loads its tools on demand.
  ///
  /// Kept as suffixes rather than full names because the prefix is the surface
  /// id, and this file is surface-agnostic.
  static let facadeDispatchers = ["_call_tool", "_call_write_tool"]

  /// The real tool behind a facade dispatch, or nil for an ordinary call.
  ///
  /// With `APPLE_<SURFACE>_LAZY_TOOLS=1` a surface lists a search tool and a
  /// dispatcher instead of its tools, so the wire carries
  /// `apple_mail_call_write_tool` with the real name nested one level down. The
  /// Activity window has to keep saying `apple_mail_send_message`, because a
  /// log that names the dispatcher records that *something* was written and
  /// nothing about what — which is the whole value of the row.
  ///
  /// Bastion solves this by rewriting the frame before it is logged. Cupertino
  /// cannot: this observer is deliberately non-blocking and never edits the
  /// pump. It does not have to. Unwrapping is a property of READING the frame,
  /// and reading is all this does.
  ///
  /// **The suffix check is not decoration.** `apple_mail_create_mailbox` takes
  /// an argument called `name`, so recognising a dispatch by "the arguments
  /// contain a name" alone would read that call as a dispatch to a mailbox
  /// called Archive. The outer tool name has to look like a dispatcher first.
  static func unwrapFacade(name: String, params: [String: Any]?) -> (
    name: String, params: [String: Any]
  )? {
    guard facadeDispatchers.contains(where: { name.hasSuffix($0) }) else { return nil }
    guard let inner = params?["arguments"] as? [String: Any],
      let real = inner["name"] as? String, !real.isEmpty
    else { return nil }
    return (real, inner)
  }

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
  ///
  /// `tool` is the one exception, and only for the tools `structuralResults` names: their
  /// result keeps its structure without content. Every other tool, and nil, is as above.
  static func result(
    _ frame: [String: Any]?, mode: Mode, content: Bool, tool: String? = nil
  ) -> String? {
    guard mode >= .argumentsAndResults, let frame else { return nil }
    if let error = frame["error"] { return encode(redact(error, content: content)) }
    guard let value = frame["result"] else { return nil }
    if let object = value as? [String: Any], object.isEmpty { return nil }
    guard content else { return structure(of: value, tool: tool).flatMap(encode) ?? redacted }
    return encode(redact(value, content: true))
  }

  /// The tools whose result is partly structure, and the `structuredContent` fields that are.
  ///
  /// A result is content by construction, which is why `result` keeps none of it without the
  /// content switch. A Shell run is the exception the spec names: what was decided and how the
  /// run ended is the record of what an agent did, the same kind of fact as a tool name, while
  /// stdout can be the text of somebody's mail. So for a tool listed here, a result with no
  /// content switch keeps `isError` and those `structuredContent` fields, and every other field
  /// and the text become `redacted`.
  ///
  /// An allowlist, keyed by tool, so a field added to a result later is redacted until someone
  /// lists it, and a surface that is not listed records exactly what it always did.
  static let structuralResults: [String: Set<String>] = [
    "apple_shell_run": [
      "decision", "exitCode", "signal", "timedOut", "durationMs", "stdoutTruncated",
      "stderrTruncated",
    ]
  ]

  /// The structural part of a listed tool's result, or nil for any other tool and for a result
  /// with no `structuredContent` object.
  static func structure(of value: Any, tool: String?) -> [String: Any]? {
    guard let tool, let fields = structuralResults[tool],
      let object = value as? [String: Any],
      let structured = object["structuredContent"] as? [String: Any]
    else { return nil }
    var kept: [String: Any] = [:]
    for (key, inner) in structured { kept[key] = fields.contains(key) ? inner : redacted }
    var out: [String: Any] = ["content": redacted, "structuredContent": kept]
    if let isError = object["isError"] { out["isError"] = isError }
    return out
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

  // MARK: - Subscriptions

  /// The bytes of an update notification's method, which is what the server→client
  /// pump looks for BEFORE it splits or parses anything.
  ///
  /// A chunk is mostly results, and results are the big frames; paying a JSON
  /// parse per line to find the rare push would be the most expensive thing on
  /// the hot path. A byte search over the chunk costs next to nothing and lets
  /// every chunk without one keep taking `FrameSplitter.skip`.
  static let pushMarker = Data("notifications/resources/updated".utf8)

  /// Whether a method asks the server to push updates, in either protocol era.
  ///
  /// 2025 clients send `resources/subscribe`; 2026-07-28 clients open a
  /// `subscriptions/listen` stream. Neither is a call that returns a result a
  /// reader is waiting on, so neither belongs in the table of calls in flight.
  static func isSubscription(_ method: String) -> Bool {
    method == "subscriptions/listen" || method == "resources/subscribe"
  }

  /// The resources a subscription request asks about, in either era's shape.
  ///
  /// A listen that asks only for list-changed notifications names no resource,
  /// which is an empty list rather than a malformed request.
  static func subscribedUris(_ params: [String: Any]?) -> [String] {
    if let uri = params?["uri"] as? String { return [uri] }
    let notifications = params?["notifications"] as? [String: Any]
    return (notifications?["resourceSubscriptions"] as? [Any])?.compactMap { $0 as? String } ?? []
  }

  /// The resource a `notifications/resources/updated` frame is about, else nil.
  static func pushedUri(_ object: [String: Any]) -> String? {
    guard object["method"] as? String == "notifications/resources/updated" else { return nil }
    return (object["params"] as? [String: Any])?["uri"] as? String
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

  /// Redact an ALREADY-ENCODED payload a second time, on its way to disk.
  ///
  /// The live row may carry content — a surface set to include it shows it in
  /// the window — and writing that same string to a file is a separate
  /// decision. So this re-parses what the window is holding and redacts it
  /// again rather than trusting it.
  ///
  /// Belt and braces on purpose, and not hypothetically: the first port of the
  /// audit log wired the caller in the wrong order and the redaction was simply
  /// never applied, so a search query went to disk with content switched off.
  /// It is a pure function here, and not on the writer, so `make unit` can hold
  /// it still.
  ///
  /// A payload that cannot be re-parsed is blanked entirely rather than passed
  /// through: something that is not the JSON this wrote is something whose
  /// fields cannot be identified, and the safe answer is to keep none of them.
  static func reredact(_ payload: String?, content: Bool) -> String? {
    guard let payload else { return nil }
    guard !content else { return payload }
    guard let data = payload.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data)
    else { return redacted }
    return encode(redact(object, content: false)) ?? redacted
  }

  /// `reredact` for a result, which knows its tool: a listed tool's result keeps its structure
  /// on the way to disk as it does in the window. Without that, a row kept whole in the window
  /// would reach the file with stdout in `structuredContent`, a key `redact` does not know.
  /// Every other tool is exactly `reredact`.
  static func reredactResult(_ payload: String?, tool: String?, content: Bool) -> String? {
    guard let tool, structuralResults[tool] != nil else {
      return reredact(payload, content: content)
    }
    guard let payload else { return nil }
    guard !content else { return payload }
    guard let data = payload.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data)
    else { return redacted }
    if let kept = structure(of: object, tool: tool) { return encode(kept) ?? redacted }
    return encode(redact(object, content: false)) ?? redacted
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
nonisolated struct FrameSplitter {
  /// The tail of a chunk that ended mid-line.
  private var pending = Data()

  /// A line this long is not MCP framing, so stop buffering rather than grow
  /// without bound on a peer that never sends a newline.
  private let limit: Int

  /// Set by `skip` when a chunk it was handed ended mid-frame: the bytes up to
  /// the next newline are the tail of a frame nobody collected, not the start
  /// of one.
  private var discarding = false

  /// Whether `pending` was put there by `skip` (a small head kept on purpose)
  /// rather than by `lines`. Only a kept head may be grown by a later skip.
  private var kept = false

  /// How much of an open frame `skip` keeps rather than discards. A push
  /// notification is a few hundred bytes; a result is not, and is not worth
  /// holding on to for a reader that is not collecting.
  private let retain = 4096

  init(limit: Int = 1 << 20) { self.limit = limit }

  /// Every complete line in what has arrived so far.
  mutating func lines(_ chunk: Data) -> [Data] {
    var chunk = chunk
    if discarding {
      guard let newline = chunk.firstIndex(of: UInt8(ascii: "\n")) else { return [] }
      chunk = Data(chunk[chunk.index(after: newline)...])
      discarding = false
    }
    kept = false
    pending.append(chunk)
    guard let lastNewline = pending.lastIndex(of: UInt8(ascii: "\n")) else {
      if pending.count > limit {
        pending.removeAll(keepingCapacity: false)
        // The rest of that frame is not a frame either, and must not be held by
        // `skip` as if it were the head of one.
        discarding = true
      }
      return []
    }
    let complete = pending[..<lastNewline]
    pending = Data(pending[pending.index(after: lastNewline)...])
    return complete.split(separator: UInt8(ascii: "\n")).filter { !$0.isEmpty }.map { Data($0) }
  }

  /// Account for a chunk without collecting what is in it.
  ///
  /// For a caller that only sometimes wants the lines — `RequestObserver`
  /// parses responses only while a notice is held. Simply not calling `lines`
  /// for the chunks in between left the last partial frame sitting in
  /// `pending`, so the next chunk that WAS fed was glued onto a stale head,
  /// parsed as garbage, and the reply that should have released the notice was
  /// never seen. Skipping still has to know where frames end; it just does not
  /// keep them.
  mutating func skip(_ chunk: Data) {
    guard let lastNewline = chunk.lastIndex(of: UInt8(ascii: "\n")) else {
      // A small chunk that starts a frame at a boundary, or carries on a head this
      // method kept, is held: a tiny read holding only the head of a push frame
      // must not cost the push. Bounded, so a long frame still falls through.
      if !discarding, pending.isEmpty || kept, pending.count + chunk.count <= retain {
        pending.append(chunk)
        kept = true
        return
      }
      // Still inside whatever frame was in progress. Its head is of no use now,
      // and keeping it would grow without bound on a long uncollected frame.
      if !chunk.isEmpty {
        kept = false
        pending.removeAll(keepingCapacity: false)
        discarding = true
      }
      return
    }
    // What follows the last newline is the start of a frame, and the next call
    // to `lines` may want it.
    pending = Data(chunk[chunk.index(after: lastNewline)...])
    discarding = false
    kept = !pending.isEmpty && pending.count <= retain
    if pending.count > limit {
      pending.removeAll(keepingCapacity: false)
      discarding = true
    }
  }
}

/// Decides, per chunk of the server→client stream, whether it has to be split
/// into frames, so that a pushed update is never missed and nothing else pays.
///
/// Pure, and here beside `FrameSplitter`, so `make unit` can hold it still: the
/// two bugs it replaced (a marker split by a read boundary, and a flag that
/// stayed set after the frame it was for had closed) are both about chunk
/// boundaries, and neither needs an app to reproduce.
///
/// Answering "does this chunk hold the marker" with one byte search keeps the
/// hot path cheap. Two things make that sound across reads:
///
///   `carry`       the last `marker.count - 1` bytes of the stream so far, so a
///                 marker cut by a read boundary is found when its second half
///                 arrives. A whole marker cannot hide in fewer bytes than that.
///   `collecting`  set while the frame still OPEN at the end of a chunk contains
///                 a marker, and cleared the moment that frame closes. Without
///                 it a push whose newline arrives in the next read would be
///                 skipped half way; kept set longer, every later chunk would
///                 be split until a read happened to end on a newline.
nonisolated struct PushScanner {
  private let marker: Data
  private(set) var carry = Data()
  private(set) var collecting = false

  init(marker: Data = CallCapture.pushMarker) { self.marker = marker }

  /// Whether `chunk` must go through `FrameSplitter.lines` rather than `skip`.
  /// `parsing` is the caller's own reason to split, which does not stop this
  /// from tracking the stream.
  mutating func needsSplit(_ chunk: Data, parsing: Bool) -> Bool {
    let width = marker.count - 1
    var hit = chunk.range(of: marker) != nil
    if !hit, !carry.isEmpty {
      hit = (carry + chunk.prefix(width)).range(of: marker) != nil
    }
    let split = parsing || hit || collecting

    // A chunk with no marker costs no more than the search above: the frame open
    // at its end cannot hold one, so the only question is whether a newline
    // closed the frame that was open before it, and that is asked only while one
    // is.
    if !hit {
      if collecting, chunk.contains(UInt8(ascii: "\n")) { collecting = false }
    } else if let newline = chunk.lastIndex(of: UInt8(ascii: "\n")) {
      // The frame open at the end is only what follows the last newline.
      collecting = chunk[chunk.index(after: newline)...].range(of: marker) != nil
    } else {
      collecting = true
    }
    // Copying the whole chunk to take its tail would be an allocation and a
    // memcpy of a full pipe read on every call, which is the cost this type
    // exists to avoid. Only a chunk shorter than the carry needs the old bytes.
    carry = chunk.count >= width ? Data(chunk.suffix(width)) : Data((carry + chunk).suffix(width))
    return split
  }
}
