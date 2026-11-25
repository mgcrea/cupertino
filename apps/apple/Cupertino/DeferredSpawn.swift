import CryptoKit
import Foundation

/// The rules for starting a session's server only when it is needed.
///
/// See docs/superpowers/specs/2026-11-25-deferred-server-spawn-design.md.
nonisolated enum DeferredSpawn {
  /// Requests the host can answer from a recorded reply, without a process.
  /// `ping` is not one of them: it is answered with `{}` and never recorded.
  static let answerable: Set<String> = [
    "initialize", "server/discover", "tools/list", "prompts/list", "resources/list",
    "resources/templates/list",
  ]

  /// The requests whose params say who the client is and what it can do.
  static let handshakes: Set<String> = ["initialize", "server/discover"]

  /// `_meta` keys whose values change from one session to the next without
  /// changing the answer.
  static let volatileMeta: Set<String> = ["progressToken"]

  /// Bytes held without a newline past which the server is started and they
  /// are forwarded raw: no list call is this big, so whatever it is, it is not
  /// one the host can answer.
  static let oversized = 64 << 10
}

/// What a session sent before its first request a server has to answer.
///
/// Fed every client frame; says one line, once, when that request arrives, or
/// at close if it never did. The line is what the deferral is measured with:
/// which methods each client opens with, whether its handshake is the same
/// from one session to the next, and which `_meta` keys ride on the requests
/// the host would answer.
nonisolated struct ConnectTraffic {
  private var methods: [String] = []
  private var meta: Set<String> = []
  private var handshake: Data?
  private var said = false

  mutating func saw(_ frame: McpFrame) -> String? {
    guard !said else { return nil }
    switch frame.kind {
    case .notification:
      methods.append(frame.method ?? "?")
      return nil
    case .request:
      let method = frame.method ?? "?"
      if method == "ping" {
        methods.append(method)
        return nil
      }
      guard DeferredSpawn.answerable.contains(method) else { break }
      methods.append(method)
      let params = frame.params as? [String: Any]
      if let keys = (params?["_meta"] as? [String: Any])?.keys { meta.formUnion(keys) }
      if handshake == nil, DeferredSpawn.handshakes.contains(method) {
        handshake = McpFrame.canonical(frame.params, droppingMeta: DeferredSpawn.volatileMeta)
      }
      return nil
    case .response, .unparsed:
      break
    }
    said = true
    return line(first: Self.label(frame))
  }

  /// The line, if `saw` never said it.
  func atClose() -> String? {
    said ? nil : line(first: "none (closed)")
  }

  private func line(first: String) -> String {
    let fingerprint = handshake.map {
      SHA256.hash(data: $0).prefix(4).map { String(format: "%02x", $0) }.joined()
    }
    return "connect: \(methods.isEmpty ? "none" : methods.joined(separator: ", "))"
      + " | meta: \(meta.isEmpty ? "none" : meta.sorted().joined(separator: ", "))"
      + " | handshake: \(fingerprint ?? "none")"
      + " | first: \(first)"
  }

  private static func label(_ frame: McpFrame) -> String {
    switch frame.kind {
    case .request, .notification: frame.method ?? "?"
    case .response: "a response"
    case .unparsed: "an unparsed line"
    }
  }
}

/// The cache keys of one session's requests.
///
/// A key carries the session's handshake: the canonical params of its first
/// `initialize` or `server/discover`, so a list is only served to a client
/// that introduced itself the same way as the one it was recorded for.
nonisolated struct SessionKeys {
  private let base: HandshakeBase
  private var handshake: Data?

  init(base: HandshakeBase) {
    self.base = base
  }

  /// The key `frame` is cached under, nil unless it is a request the host
  /// could answer. The first handshake request is keyed without a handshake,
  /// and its params are the handshake of every later key.
  mutating func key(for frame: McpFrame) -> HandshakeKey? {
    guard frame.kind == .request, let method = frame.method,
      DeferredSpawn.answerable.contains(method)
    else { return nil }
    let params = McpFrame.canonical(frame.params, droppingMeta: DeferredSpawn.volatileMeta)
    let key = HandshakeKey(base: base, handshake: handshake, method: method, params: params)
    if handshake == nil, DeferredSpawn.handshakes.contains(method) { handshake = params }
    return key
  }
}

/// A request whose response the reply filter is waiting for.
private nonisolated struct Remembered {
  let key: HandshakeKey
  /// The host already answered it: the server's response is a check, then dropped.
  let servedByHost: Bool
}

/// One session before its server starts: what to answer, and what to hand the
/// server when it does.
///
/// Fed every client line until `client` says `.spawn`. The transcript is
/// every line but pings, in the order they came, the trigger included, so
/// the server that starts sees the session as if it had been there from the
/// first byte.
nonisolated struct DeferredSession {
  enum Step: Equatable {
    /// Write this to the client, newline included.
    case answer(Data)
    /// Nothing to write yet.
    case hold
    /// Start the server and write it `replay()`.
    case spawn
  }

  private let cache: HandshakeCache
  private var keys: SessionKeys
  private var transcript: [Data] = []
  private var remembered: [Data: Remembered] = [:]
  /// The request that started the server, once one has.
  private(set) var trigger: McpFrame?
  private var triggerIsAnswerable = false

  init(base: HandshakeBase, cache: HandshakeCache) {
    self.cache = cache
    keys = SessionKeys(base: base)
  }

  mutating func client(_ line: Data) -> Step {
    let frame = McpFrame.parse(line)
    if frame.kind == .request, frame.method == "ping", let id = frame.id {
      return .answer(
        Data(#"{"jsonrpc":"2.0","id":"#.utf8) + id + Data(#","result":{}}"#.utf8) + Self.newline)
    }
    transcript.append(line)
    if frame.kind == .notification { return .hold }
    let key = keys.key(for: frame)
    if let key, let id = frame.id, let reply = cache.reply(for: key) {
      remembered[id] = Remembered(key: key, servedByHost: true)
      return .answer(reply.frame(id: id) + Self.newline)
    }
    if let key, let id = frame.id {
      // A miss: its live answer is recorded for the next session.
      remembered[id] = Remembered(key: key, servedByHost: false)
      triggerIsAnswerable = true
    }
    trigger = frame
    return .spawn
  }

  /// What the server is written when it starts: the transcript, one line each.
  func replay() -> Data {
    transcript.reduce(into: Data()) { $0 += $1 + Self.newline }
  }

  /// The filter for the server's output, carrying what this session is owed.
  func filter() -> ReplyFilter {
    ReplyFilter(
      cache: cache, keys: keys, remembered: remembered, connectPhase: triggerIsAnswerable)
  }

  private static let newline = Data("\n".utf8)
}

/// What the server's output goes through after a deferred spawn.
///
/// The responses to requests the host answered are compared with what it
/// served and dropped: the client has them already. The responses to the
/// answerable requests it did not answer are recorded as they pass, for the
/// requests the trigger and the client's next frames make while the session
/// is still connecting. Once nothing is owed and the connect phase is over,
/// `isRetired` says the pump can stop calling it.
nonisolated struct ReplyFilter {
  enum Verdict: Equatable {
    case pass
    case drop
    /// The server answered `method` other than the cache holds: the surface is
    /// now off. `forward` says whether the frame still goes to the client,
    /// which it does unless the host answered the request itself.
    case mismatch(method: String, forward: Bool)
  }

  private let cache: HandshakeCache
  private var keys: SessionKeys
  private var remembered: [Data: Remembered]
  /// Still recording the answerable requests the client sends: from an
  /// answerable trigger to the first request that is not.
  private var connectPhase: Bool

  fileprivate init(
    cache: HandshakeCache, keys: SessionKeys, remembered: [Data: Remembered], connectPhase: Bool
  ) {
    self.cache = cache
    self.keys = keys
    self.remembered = remembered
    self.connectPhase = connectPhase
  }

  var isRetired: Bool { remembered.isEmpty && !connectPhase }

  /// Called with every client frame after the spawn, before it is forwarded.
  mutating func client(_ frame: McpFrame) {
    guard connectPhase, frame.kind == .request else { return }
    guard let key = keys.key(for: frame), let id = frame.id else {
      connectPhase = false
      return
    }
    remembered[id] = Remembered(key: key, servedByHost: false)
  }

  /// What to do with one line of the server's output.
  mutating func server(_ line: Data) -> Verdict {
    guard !remembered.isEmpty else { return .pass }
    let frame = McpFrame.parse(line)
    guard frame.kind == .response, let id = frame.id, let entry = remembered.removeValue(forKey: id)
    else { return .pass }
    let fallback: Verdict = entry.servedByHost ? .drop : .pass
    // An error is never recorded, nor compared: it says nothing about the answer.
    guard !frame.isError else { return fallback }
    if cache.record(entry.key, frame: line, id: id) == .mismatch {
      return .mismatch(method: entry.key.method, forward: !entry.servedByHost)
    }
    return fallback
  }
}
