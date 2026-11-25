import Foundation
import os

/// Everything about a server, other than the request, that its answer can
/// depend on: which surface, which build of it, run by which node, with which
/// environment.
nonisolated struct HandshakeBase: Hashable {
  let surface: String
  let build: String
  let node: String
  let script: String
  let env: [String: String]
}

/// One request a server answered, keyed on everything the answer depends on:
/// the server, the session's handshake params (canonical, nil for the
/// handshake itself), the method and the canonical params.
nonisolated struct HandshakeKey: Hashable {
  let base: HandshakeBase
  let handshake: Data?
  let method: String
  let params: Data
}

/// A recorded response frame with its id cut out, so it can be replayed to a
/// session that asked under another id.
///
/// Only a frame that ends in `"id":` + id + `}` is accepted; it is held as the
/// head before the id and the tail `}`. Any other shape is not cached, rather
/// than rewritten.
nonisolated struct CachedReply: Equatable {
  /// Internal so a check can see where its bytes live.
  let head: Data
  private let tail: Data

  init?(frame: Data, id: Data) {
    var frame = frame
    if frame.last == UInt8(ascii: "\n") { frame.removeLast() }
    let suffix = Data(#""id":"#.utf8) + id + Data("}".utf8)
    guard frame.count > suffix.count, frame.suffix(suffix.count) == suffix else { return nil }
    // Its own bytes: a slice would keep the caller's whole buffer alive, and
    // the cache's byte cap would count only part of what it holds.
    head = LineBuffer.copy(frame.prefix(frame.count - id.count - 1))
    tail = Data("}".utf8)
  }

  /// The frame as the server would have sent it under `id`, without a newline.
  func frame(id: Data) -> Data { head + id + tail }

  var byteCount: Int { head.count + tail.count }
}

nonisolated enum RecordOutcome: Equatable {
  /// A new reply, now served to later sessions.
  case stored
  /// The same reply the cache already held.
  case matched
  /// A reply different from the one held: the surface is disabled.
  case mismatch
  /// A frame of a shape the cache does not hold, or larger than its cap.
  case uncacheable
  /// The surface was disabled by an earlier mismatch.
  case disabled
}

/// Replies recorded from real servers, served to later sessions so a server is
/// started only when a session makes a call the cache cannot answer.
///
/// In memory only, bounded by `byteCap`, keys and replies both counted, with
/// the least recently used entry evicted first. A surface whose server ever answers the same key two ways
/// is disabled for the life of the process: its replies are not stable enough
/// to serve.
nonisolated final class HandshakeCache: @unchecked Sendable {
  static let shared = HandshakeCache()

  private struct State {
    var entries: [HandshakeKey: CachedReply] = [:]
    /// Least recently used first.
    var order: [HandshakeKey] = []
    var disabled: Set<String> = []
    var byteCount = 0

    mutating func bump(_ key: HandshakeKey) {
      if let index = order.firstIndex(of: key) { order.remove(at: index) }
      order.append(key)
    }

    mutating func remove(_ key: HandshakeKey) {
      guard let reply = entries.removeValue(forKey: key) else { return }
      byteCount -= HandshakeCache.cost(key, reply)
      if let index = order.firstIndex(of: key) { order.remove(at: index) }
    }
  }

  private let byteCap: Int
  private let state = OSAllocatedUnfairLock(initialState: State())

  init(byteCap: Int = 8 << 20) {
    self.byteCap = byteCap
  }

  /// The recorded reply for `key`, if any; a hit makes it the most recent.
  func reply(for key: HandshakeKey) -> CachedReply? {
    state.withLock { state in
      guard !state.disabled.contains(key.base.surface), let reply = state.entries[key] else {
        return nil
      }
      state.bump(key)
      return reply
    }
  }

  /// Records what a server answered for `key`, under the request's `id`.
  func record(_ key: HandshakeKey, frame: Data, id: Data) -> RecordOutcome {
    let surface = key.base.surface
    let reply = CachedReply(frame: frame, id: id)
    return state.withLock { state in
      if state.disabled.contains(surface) { return .disabled }
      // A held key is checked first: an answer of another shape, or too big
      // to hold, is still a different answer.
      if let held = state.entries[key] {
        guard held == reply else {
          Self.disable(surface, in: &state)
          return .mismatch
        }
        state.bump(key)
        return .matched
      }
      guard let reply, Self.cost(key, reply) <= byteCap else { return .uncacheable }
      state.entries[key] = reply
      state.order.append(key)
      state.byteCount += Self.cost(key, reply)
      while state.byteCount > byteCap, let oldest = state.order.first {
        state.remove(oldest)
      }
      return .stored
    }
  }

  /// Stops serving and recording for `surface`, and drops what it held.
  func disable(surface: String) {
    state.withLock { Self.disable(surface, in: &$0) }
  }

  func isDisabled(surface: String) -> Bool {
    state.withLock { $0.disabled.contains(surface) }
  }

  /// For checks only: empties the entries and the disabled surfaces.
  func reset() {
    state.withLock { $0 = State() }
  }

  var byteCount: Int {
    state.withLock { $0.byteCount }
  }

  /// Whether sessions on these binaries are served from the cache.
  ///
  /// `deferServerSpawn` set to false turns it off everywhere. Otherwise it is
  /// on, except for development binaries, which change under it: those take
  /// `deferSpawnInDevelopment` set to true.
  ///
  /// Read once per session, at connect, so flipping either applies to new
  /// connections only. A session already deferred goes on being answered from
  /// the cache until it makes a call or hangs up; neither default closes it
  /// or starts its server.
  static func isOn(_ binaries: ServerBinaries, defaults: UserDefaults = .standard) -> Bool {
    if defaults.object(forKey: "deferServerSpawn") as? Bool == false { return false }
    if binaries.isDevelopment { return defaults.bool(forKey: "deferSpawnInDevelopment") }
    return true
  }

  /// What an entry counts against the cap: the reply, and the key's own
  /// params and handshake, which a client chooses and can make as large.
  fileprivate static func cost(_ key: HandshakeKey, _ reply: CachedReply) -> Int {
    reply.byteCount + key.params.count + (key.handshake?.count ?? 0)
  }

  private static func disable(_ surface: String, in state: inout State) {
    state.disabled.insert(surface)
    for key in state.entries.keys where key.base.surface == surface {
      state.remove(key)
    }
  }
}
