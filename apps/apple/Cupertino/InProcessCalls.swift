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
/// A canceller runs at most once, on the thread that read the frame, and must
/// return quickly: it is in the way of the next frame. It should make the call
/// end, not answer it. The call still returns its reply on its own thread, and
/// that reply is the only one written.
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

  private struct Entry {
    let serial: UInt64
    let cancel: @Sendable () -> Void
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var live: [UUID: [String: Entry]] = [:]
  nonisolated(unsafe) private static var serials: UInt64 = 0

  /// Register a canceller for one in-flight request. The returned token unregisters.
  static func register(
    connection: UUID, requestId: String, _ cancel: @escaping @Sendable () -> Void
  ) -> Token {
    lock.lock()
    defer { lock.unlock() }
    serials += 1
    live[connection, default: [:]][requestId] = Entry(serial: serials, cancel: cancel)
    return Token(connection: connection, requestId: requestId, serial: serials)
  }

  /// Call off one request. A no-op for an id nothing registered, which is
  /// every request on a surface that registers nothing, and any request that
  /// has already ended.
  static func cancel(connection: UUID, requestId: String) {
    // Taken out under the lock and run outside it, so a canceller that ends up
    // calling `done()` on its own token does not deadlock.
    lock.lock()
    let entry = live[connection]?.removeValue(forKey: requestId)
    if live[connection]?.isEmpty == true { live.removeValue(forKey: connection) }
    lock.unlock()
    entry?.cancel()
  }

  /// Call off everything still running on a connection: the client hung up.
  static func cancelAll(connection: UUID) {
    lock.lock()
    let entries = live.removeValue(forKey: connection) ?? [:]
    lock.unlock()
    for entry in entries.values { entry.cancel() }
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
  /// handles it, as before.
  static func cancelledRequestId(in line: String) -> String? {
    guard line.contains("notifications/cancelled"),
      let msg = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
      msg["method"] as? String == "notifications/cancelled",
      let params = msg["params"] as? [String: Any]
    else { return nil }
    return requestId(params["requestId"])
  }

  private static func remove(_ connection: UUID, _ requestId: String, serial: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    guard live[connection]?[requestId]?.serial == serial else { return }
    live[connection]?.removeValue(forKey: requestId)
    if live[connection]?.isEmpty == true { live.removeValue(forKey: connection) }
  }
}
