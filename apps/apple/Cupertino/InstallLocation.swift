import AppKit
import Foundation

/// Where Cupertino is running from.
///
/// **This is not about the TCC grant.** Measured in `scripts/spike-app-tcc`: a
/// grant is bound to the code signature, not the path — it followed the bundle
/// from a build directory to /Applications untouched, and the user TCC database
/// keys its rows on the bundle identifier. Moving the app after granting is
/// safe. An earlier version of this type claimed otherwise and was wrong.
///
/// What the location does affect is the **bridge path**, which `ClientWiring`
/// writes as an absolute path into other applications' config files. A config
/// pointing into a build directory breaks the moment that directory is cleaned,
/// and the failure surfaces inside someone else's app as a server that will not
/// start.
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

  /// Whether a path written into another app's config from here will keep working.
  var isStable: Bool {
    if case .applications = self { return true }
    return false
  }

  /// Whether the bundle is somewhere Safari will look for its extension.
  ///
  /// Deliberately separate from `isStable`, which today tests the same case and
  /// answers a different question: one is about a path staying valid in someone
  /// else's config file, the other about whether Safari will enumerate an appex
  /// at all — it ignores a container that is translocated or outside an
  /// Applications folder. Collapsing them would assert the two must always
  /// agree, which is not something either measurement establishes.
  var isInApplications: Bool {
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
        Cupertino is running from a temporary copy made by Gatekeeper, at a path that \
        will not exist next time. Move it to your Applications folder and open it from \
        there before configuring any MCP clients.
        """
    case .elsewhere(let url):
      return """
        Cupertino is running from \(url.deletingLastPathComponent().path). Clients are \
        configured with the full path to this copy, so they will stop working if it \
        moves or is deleted. Move it to Applications for a stable location.
        """
    }
  }

  func revealInFinder() {
    NSWorkspace.shared.activateFileViewerSelecting([url])
  }
}
