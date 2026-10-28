import Foundation

/// The in-process calls a client can still call off, by connection and request id.
///
/// `ServerHost.serveInProcess` reads a connection's frames on one thread and
/// handles its requests on another, so a frame that arrives while a call runs
/// is seen at once. Two of those mean "stop": a `notifications/cancelled`
/// naming the request (Esc in Claude Code), and the client hanging up. This is
/// how the loop reaches the call. A surface with something worth stopping — a
/// window waiting for an answer, a process still running — registers a
/// canceller when the call starts and calls `done()` on the token when it
/// ends. A surface that registers nothing ignores both, which is what every
/// surface did before this existed.
///
/// A stop can arrive before the call it is for has registered: the request is
/// still queued behind another, or the worker has not reached `register` yet
/// when the reader sees the client hang up. Neither is lost. A cancel for an id
/// nothing has registered leaves a tombstone, and a hang-up marks the
/// connection closed; a later `register` that meets either runs its canceller
/// at once, inside `register`, before the token is returned. So a canceller
/// must be ready to run from the moment it is passed in.
///
/// A canceller runs at most once, on the thread that read the frame or on the
/// thread that registered it, and must return quickly: it is in the way of the
/// next frame. It should make the call end, not answer it. The call still
/// returns its reply on its own thread, and that reply is the only one written.
nonisolated enum InProcessCalls {

  /// Proof of one registration. `done()` takes it back.
  ///
  /// Holds a serial rather than only the id, so a call that ends after its id
  /// was registered again (a client reusing an id it considers finished) takes
  /// back its own canceller and never the newer one.
  final class Token: Sendable {
    private let connection: UUID
    private let requestId: String
    private let serial: UInt64

    fileprivate init(connection: UUID, requestId: String, serial: UInt64) {
      self.connection = connection
      self.requestId = requestId
      self.serial = serial
    }

    /// The call ended. Safe to call more than once, and after a cancel.
    func done() { InProcessCalls.remove(connection, requestId, serial: serial) }
  }

  /// How many cancels for ids that have not registered one connection keeps.
  ///
  /// A client reaches this only by cancelling requests it never sent, or ones
  /// that have already been answered, so the oldest is dropped past it rather
  /// than letting a client grow the table without limit. Real clients cancel
  /// one call at a time.
  static let tombstoneLimit = 16

  private struct Entry {
    let serial: UInt64
    let cancel: @Sendable () -> Void
  }

  /// Everything held for one connection, until `forget`.
  private struct Calls {
    var running: [String: Entry] = [:]
    /// Cancelled before they registered, oldest first.
    var tombstones: [String] = []
    /// The client hung up: every call, registered or not yet, is off.
    var closed = false
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var live: [UUID: Calls] = [:]
  nonisolated(unsafe) private static var serials: UInt64 = 0

  /// Register a canceller for one in-flight request. The returned token unregisters.
  ///
  /// Runs `cancel` before returning when the request was already called off:
  /// its connection has hung up, or a cancel naming it arrived first.
  static func register(
    connection: UUID, requestId: String, _ cancel: @escaping @Sendable () -> Void
  ) -> Token {
    lock.lock()
    serials += 1
    let token = Token(connection: connection, requestId: requestId, serial: serials)
    var calls = live[connection] ?? Calls()
    let tombstone = calls.tombstones.firstIndex(of: requestId)
    if let tombstone { calls.tombstones.remove(at: tombstone) }
    let already = calls.closed || tombstone != nil
    if !already { calls.running[requestId] = Entry(serial: serials, cancel: cancel) }
    live[connection] = calls
    lock.unlock()
    if already { cancel() }
    return token
  }

  /// Call off one request. Reaches a call that has registered at once, and
  /// one that registers later through a tombstone.
  static func cancel(connection: UUID, requestId: String) {
    // Taken out under the lock and run outside it, so a canceller that ends up
    // calling `done()` on its own token does not deadlock.
    lock.lock()
    var calls = live[connection] ?? Calls()
    let entry = calls.running.removeValue(forKey: requestId)
    if entry == nil, !calls.closed, !calls.tombstones.contains(requestId) {
      calls.tombstones.append(requestId)
      if calls.tombstones.count > tombstoneLimit { calls.tombstones.removeFirst() }
    }
    live[connection] = calls
    lock.unlock()
    entry?.cancel()
  }

  /// Call off everything on a connection, including calls that have not
  /// registered yet: the client hung up.
  static func cancelAll(connection: UUID) {
    lock.lock()
    var calls = live[connection] ?? Calls()
    let entries = calls.running
    calls.running = [:]
    calls.tombstones = []
    calls.closed = true
    live[connection] = calls
    lock.unlock()
    for entry in entries.values { entry.cancel() }
  }

  /// Drop everything held for a connection. Its loop calls this once nothing
  /// on it can register again, after its worker has finished.
  static func forget(connection: UUID) {
    lock.lock()
    defer { lock.unlock() }
    live.removeValue(forKey: connection)
  }

  /// What is held for a connection, nil when nothing is: for the checks.
  static func held(connection: UUID) -> (running: Int, tombstones: Int, closed: Bool)? {
    lock.lock()
    defer { lock.unlock() }
    return live[connection].map { ($0.running.count, $0.tombstones.count, $0.closed) }
  }

  /// A JSON-RPC id (Int or String) as a stable key.
  ///
  /// Prefixed by kind, because `7` and `"7"` are two different ids. nil for
  /// anything JSON-RPC does not allow as an id, a boolean included even though
  /// Foundation hands it over as a number.
  static func requestId(_ id: Any?) -> String? {
    if let number = id as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
    switch id {
    case let int as Int: return "i\(int)"
    case let string as String: return "s\(string)"
    default: return nil
    }
  }

  /// The request a `notifications/cancelled` line names, or nil for any other line.
  ///
  /// A substring test first, so the reader parses only the rare line that can
  /// be a cancel: every other frame is parsed once, by the surface that
  /// handles it, as before. The test has to survive JSON's escapes. `/` may be
  /// written `\/`, so it looks for `cancelled`, which has no slash; and any
  /// character may be written `\uXXXX`, so a line holding a `\u` is parsed
  /// too. A cancel spelled any way JSON allows therefore contains one or the
  /// other.
  static func cancelledRequestId(in line: String) -> String? {
    guard line.contains("cancelled") || line.contains("\\u"),
      let msg = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
      msg["method"] as? String == "notifications/cancelled",
      let params = msg["params"] as? [String: Any]
    else { return nil }
    return requestId(params["requestId"])
  }

  private static func remove(_ connection: UUID, _ requestId: String, serial: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    guard live[connection]?.running[requestId]?.serial == serial else { return }
    live[connection]?.running.removeValue(forKey: requestId)
  }
}
