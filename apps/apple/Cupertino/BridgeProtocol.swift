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

  /// `~/Library/Application Support/<appIdentifier>/cupertino.sock`
  ///
  /// A `sockaddr_un` path is capped at 104 bytes, and a long home directory can
  /// genuinely exhaust that, so callers must check `isAddressable` rather than
  /// assume.
  /// The app's bundle identifier, which also names its support directory.
  ///
  /// A DEBUG build carries a DIFFERENT one so it can hold its own Full Disk
  /// Access grant. TCC keys a grant on the identifier PLUS the code
  /// requirement, and these two builds are signed differently — the shipped app
  /// with "Developer ID Application", a local build with "Apple Development".
  /// Sharing one identifier made them collide in a single Full Disk Access
  /// entry: the list showed one "Cupertino" row holding whichever requirement
  /// was stored first, and the other build was denied no matter how it was
  /// launched, with nothing in the UI to say why.
  ///
  /// It also separates the socket, so a Debug build and the installed app do
  /// not fight over one path — which matters because the installed app is a
  /// login item and comes back on its own.
  #if DEBUG
    static let appIdentifier = "io.mgcrea.cupertino.debug"
  #else
    static let appIdentifier = "io.mgcrea.cupertino"
  #endif

  static var socketPath: String {
    let base = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/\(appIdentifier)")
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

  /// The internal channel: `cupertino/1 desktop for=mail\n`.
  ///
  /// A node server asking to borrow an in-process surface for its OWN
  /// application — Mail reaching its composer through the native Accessibility
  /// driver rather than through System Events. `cupertino-bridge` never sends
  /// this; the only callers are servers the app itself spawned, and `ServerHost`
  /// proves that with the peer pid rather than believing the line.
  ///
  /// A third field rather than a second verb, so a host that does not know about
  /// it fails the arity check above and is told the protocol is unsupported
  /// instead of being served something it did not ask for.
  static func lentHandshake(server: String, onBehalfOf: String) -> String {
    "\(version) \(server) \(onBehalfOfPrefix)\(onBehalfOf)\n"
  }

  static let onBehalfOfPrefix = "for="

  /// The internal channel the app uses on itself: `cupertino/1 mail self\n`.
  ///
  /// The Chat pane reaching a surface the same way any editor reaches it. A
  /// third field again, and for a second reason on top of the arity one above:
  /// it makes the exemptions this earns a property of THIS FEATURE rather than
  /// of the process. "Any connection from our own pid is unlicensed-exempt"
  /// would be true of the next in-app button to open this socket too, and
  /// nobody reviewing that button would see it inherit anything.
  ///
  /// `ServerHost.serve` honours it only when the peer pid is its own, so the
  /// word is a claim and the kernel is the check — exactly the arrangement
  /// `for=` already relies on.
  static func selfHandshake(server: String) -> String {
    "\(version) \(server) \(selfSuffix)\n"
  }

  static let selfSuffix = "self"

  /// `cupertino/1 mail client=claude-desktop\n` — an ordinary client, saying
  /// which one it is.
  ///
  /// The app writes this into the config alongside `--server=`, so the id is
  /// the one Cupertino chose when it wired that file rather than anything the
  /// client says about itself. `clientInfo.name` from the MCP handshake would
  /// be the obvious alternative and is useless here: it arrives after
  /// `initialize`, and the server's environment is fixed when it is spawned.
  ///
  /// Absent from an older config, and that has to stay harmless: an unknown
  /// client is treated as one that does not defer, which is what every client
  /// was treated as before this existed. `ClientWiringMerge.state` compares the
  /// `command` and never the `args`, so adding this does not make anybody's
  /// existing wiring report as stale.
  static func handshake(server: String, client: String) -> String {
    "\(version) \(server) \(clientPrefix)\(client)\n"
  }

  static let clientPrefix = "client="

  /// What may appear after `client=`.
  ///
  /// The handshake is one space-separated line, so a value carrying a space or
  /// a newline would not be a bad id, it would be a different message. Ids are
  /// this app's own (`ClientWiring.clients`), but they arrive here off a config
  /// file a person can edit.
  static func isWellFormedClient(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 64
      && id.allSatisfy { $0.isLowercase && $0.isLetter || $0.isNumber || $0 == "-" }
  }

  /// First line the app sends back: `ok\n`, or `err <reason>\n`.
  static let ok = "ok"
  static let errorPrefix = "err "

  /// The one phase with a deadline, and BOTH ends set it on the same read.
  /// The bridge protects itself from an app that accepted and then wedged; the
  /// app protects itself from any process running as this user that connects
  /// and sends nothing. Cleared once the handshake is through, where blocking
  /// forever is the correct behaviour for both.
  static let handshakeTimeoutSeconds = 15

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
