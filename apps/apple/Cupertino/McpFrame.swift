import Foundation

/// One newline-delimited JSON-RPC frame, read just far enough to route it.
///
/// What the host needs to decide whether a frame can wait for a server: its
/// kind, its method, its id as it went over the wire, and its params. Nothing
/// here interprets a result; `isError` is only whether a response carried an
/// `error` member.
nonisolated struct McpFrame {
  enum Kind { case request, notification, response, unparsed }

  let kind: Kind
  /// The id re-serialised as JSON, so `7` stays `7` and `"a"` keeps its
  /// quotes: a reply written by the host must carry it back byte for byte.
  let id: Data?
  let method: String?
  let params: Any?
  let isError: Bool

  static func parse(_ line: Data) -> McpFrame {
    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
      return McpFrame(kind: .unparsed, id: nil, method: nil, params: nil, isError: false)
    }
    let id = object["id"].flatMap {
      try? JSONSerialization.data(withJSONObject: $0, options: .fragmentsAllowed)
    }
    if let method = object["method"] as? String {
      return McpFrame(
        kind: id == nil ? .notification : .request, id: id, method: method,
        params: object["params"], isError: false)
    }
    if id != nil, object["result"] != nil || object["error"] != nil {
      return McpFrame(
        kind: .response, id: id, method: nil, params: nil, isError: object["error"] != nil)
    }
    return McpFrame(kind: .unparsed, id: id, method: nil, params: nil, isError: false)
  }

  /// A stable serialisation of `value`: sorted keys, slashes left alone, and
  /// the named keys removed from a top-level `_meta`, which goes too once
  /// nothing is left in it. Two requests that differ only in those keys give
  /// the same bytes.
  static func canonical(_ value: Any?, droppingMeta: Set<String>) -> Data {
    guard var value else { return Data("null".utf8) }
    if var object = value as? [String: Any], var meta = object["_meta"] as? [String: Any] {
      for key in droppingMeta { meta.removeValue(forKey: key) }
      object["_meta"] = meta.isEmpty ? nil : meta
      value = object
    }
    return
      (try? JSONSerialization.data(
        withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]))
      ?? Data("null".utf8)
  }
}

/// Complete lines out of a byte stream, the tail held until its newline.
///
/// Unbounded, unlike `FrameSplitter`: what it holds is what the host still owes
/// a server, so dropping any of it is not an option. A caller that must cap it
/// reads `pendingCount`.
nonisolated struct LineBuffer {
  private var pending = Data()

  var pendingCount: Int { pending.count }

  /// Every line completed by `chunk`, without its newline. Empty lines are skipped.
  mutating func append(_ chunk: Data) -> [Data] {
    pending.append(chunk)
    guard let last = pending.lastIndex(of: UInt8(ascii: "\n")) else { return [] }
    let complete = pending[pending.startIndex..<last]
    let lines = complete.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: true)
      .map { Data($0) }
    pending = Data(pending[pending.index(after: last)...])
    return lines
  }

  /// What arrived after the last newline, and the buffer emptied.
  mutating func takePending() -> Data {
    defer { pending = Data() }
    return pending
  }
}
