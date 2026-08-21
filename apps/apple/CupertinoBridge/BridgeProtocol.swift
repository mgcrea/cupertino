import Foundation

/// The contract between `cupertino-bridge` and the Cupertino app.
///
/// Duplicated verbatim in `app/Cupertino/BridgeProtocol.swift`. The two targets
/// are separate and Xcode's filesystem-synchronized groups make sharing one
/// file across both awkward, so this is copied rather than shared — it is small
/// and changes to it must be made in both places.
enum BridgeProtocol {
  /// Bumped only on a wire-incompatible change. The app refuses a version it
  /// does not know rather than guessing.
  static let version = "cupertino/1"

  /// `~/Library/Application Support/io.mgcrea.cupertino/cupertino.sock`
  ///
  /// A `sockaddr_un` path is capped at 104 bytes, and a long home directory can
  /// genuinely exhaust that, so callers must check `isAddressable` rather than
  /// assume.
  static var socketPath: String {
    let base = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/io.mgcrea.cupertino")
    return base.appendingPathComponent("cupertino.sock").path
  }

  static var socketDirectory: String {
    (socketPath as NSString).deletingLastPathComponent
  }

  static func isAddressable(_ path: String) -> Bool {
    path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path)
  }

  /// First line the bridge sends: `cupertino/1 mail\n`
  static func handshake(server: String) -> String { "\(version) \(server)\n" }

  /// First line the app sends back: `ok\n`, or `err <reason>\n`.
  static let ok = "ok"
  static let errorPrefix = "err "

  /// Passed to the app when the bridge cold-starts it, so it knows a tool call
  /// is waiting rather than a person. See `launchApp` in CupertinoBridge.
  static let backgroundFlag = "--background"
}

/// Fill a `sockaddr_un` for `path`, or nil if it will not fit.
func unixAddress(_ path: String) -> sockaddr_un? {
  guard BridgeProtocol.isAddressable(path) else { return nil }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  let capacity = MemoryLayout.size(ofValue: addr.sun_path)
  withUnsafeMutablePointer(to: &addr.sun_path) { tuple in
    tuple.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
      for (i, byte) in bytes.enumerated() { dst[i] = CChar(bitPattern: byte) }
      dst[bytes.count] = 0
    }
  }
  return addr
}

extension sockaddr_un {
  /// Call `body` with this address cast to `sockaddr`, as the socket API wants.
  func withSockaddr<R>(_ body: (UnsafePointer<sockaddr>, socklen_t) -> R) -> R {
    var copy = self
    return withUnsafePointer(to: &copy) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        body($0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
  }
}
