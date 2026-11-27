import Foundation

// What `ClientWiring.swift` reaches in the rest of the app, as `make
// wiring-check` builds it: stand-ins that keep the check away from everything
// real. No preference is read or written, no login item is registered, no log
// line reaches Cupertino's store, and no Keychain service the app uses is named.
// `wiring-check.swift` points `ClientWiring.home` at a scratch directory and
// swaps `ClientWiring.tokens` for a vault in memory before any of it runs.

/// The switches, held here rather than in `UserDefaults`.
enum SurfaceSettings {
  /// Every surface on unless a check says otherwise.
  nonisolated(unsafe) static var off: Set<String> = []

  static func isEnabled(_ surface: Surface) -> Bool { !off.contains(surface.id) }
  static var enabledSurfaces: [Surface] { Surface.all.filter(isEnabled) }
}

/// Never a capture.
enum DemoSeed {
  static let isEnabled = false
  static let clientIDs: Set<String> = []
  static let bridgePath = "/Applications/Cupertino.app" + ClientWiringMerge.bridgeSuffix
  static let httpPort = 8830
  static func anonymised(_ url: URL) -> URL { url }
  static func clientConfig(for client: ClientWiring.Client) -> ClientWiring.Config? { nil }
}

/// Where this copy is installed, as a check decides.
enum InstallLocation {
  case applications(URL)
  case translocated(URL)
  case elsewhere(URL)

  nonisolated(unsafe) static var current = InstallLocation.applications(
    URL(fileURLWithPath: "/Applications/Cupertino.app"))

  var isStable: Bool {
    if case .applications = self { return true }
    return false
  }
}

/// Counts what it is asked, and registers nothing.
enum LoginItem {
  nonisolated(unsafe) static var isEnabled = false
  nonisolated(unsafe) static var requests: [Bool] = []
  /// What `set` answers: nil for success, or the error it reports.
  nonisolated(unsafe) static var failure: String?

  static func set(_ enabled: Bool) -> String? {
    requests.append(enabled)
    if failure == nil { isEnabled = enabled }
    return failure
  }
}

/// A service name no copy of the app uses, should anything reach the Keychain.
enum BridgeProtocol {
  static let appIdentifier = "io.mgcrea.cupertino.wiring-check"
}

enum LogStore {
  enum Level: String { case info, call, error }
}

/// Every line, kept for the checks to read.
nonisolated(unsafe) var loggedLines: [String] = []

func hostLog(_ surface: String, _ level: LogStore.Level, _ text: String, mirror: Bool = true) {
  loggedLines.append("\(level.rawValue): \(text)")
}
