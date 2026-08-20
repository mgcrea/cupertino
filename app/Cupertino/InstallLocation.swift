import AppKit
import Foundation

/// Where Cupertino is running from, and whether a Full Disk Access grant made
/// here would survive.
///
/// Measured in `scripts/spike-app-tcc`: a TCC entry for Full Disk Access binds
/// to the **path**, and validates the signature there. The granted bundle
/// copied elsewhere — byte-identical, signature still valid — is denied. So the
/// obvious install order is the broken one:
///
///     grant Full Disk Access in ~/Downloads, then drag to /Applications
///     -> same app, same signature, dead permission, no error anywhere
///
/// The app knows its own location, so it can refuse to ask rather than hand
/// someone a grant that stops working the moment they tidy up.
enum InstallLocation {
  case applications(URL)
  /// Gatekeeper ran the app from a read-only disk image copy. Nothing granted
  /// here survives, because the path does not even outlive the session.
  case translocated(URL)
  case elsewhere(URL)

  static var current: InstallLocation {
    let url = Bundle.main.bundleURL.resolvingSymlinksInPath()
    let path = url.path

    if path.contains("/AppTranslocation/") { return .translocated(url) }

    let roots = [
      "/Applications",
      FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path,
    ]
    for root in roots where path.hasPrefix(root + "/") { return .applications(url) }
    return .elsewhere(url)
  }

  /// Whether a Full Disk Access grant made now is worth anything long-term.
  var grantWillPersist: Bool {
    if case .applications = self { return true }
    return false
  }

  var url: URL {
    switch self {
    case .applications(let u), .translocated(let u), .elsewhere(let u): return u
    }
  }

  var warning: String? {
    switch self {
    case .applications:
      return nil
    case .translocated:
      return """
        Cupertino is running from a temporary copy made by Gatekeeper. Move it to \
        your Applications folder and open it from there — a permission granted now \
        would be discarded.
        """
    case .elsewhere(let url):
      return """
        Cupertino is running from \(url.deletingLastPathComponent().path). Full Disk \
        Access is tied to the app's location, so granting it here stops working as \
        soon as the app moves. Move it to Applications first.
        """
    }
  }

  func revealInFinder() {
    NSWorkspace.shared.activateFileViewerSelecting([url])
  }
}
