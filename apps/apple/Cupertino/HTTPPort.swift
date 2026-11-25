import Foundation

/// The port the HTTP listener binds, and the one every HTTP entry names.
///
/// A file of its own so the two readers share one default without one
/// compiling the other: `ClientWiring` writes the port into client configs,
/// and `make wiring-check` compiles it without the listener behind it.
/// `HTTPListener.configuredPort` forwards here.
nonisolated enum HTTPPort {
  /// The defaults key the port is kept under, for the Settings pane.
  static let key = "httpPort"
  #if DEBUG
    static let defaultPort = 8831
  #else
    static let defaultPort = 8830
  #endif

  /// The user's setting, or the build's default.
  static var configured: Int {
    let stored = UserDefaults.standard.integer(forKey: key)
    return (1...65535).contains(stored) ? stored : defaultPort
  }
}
