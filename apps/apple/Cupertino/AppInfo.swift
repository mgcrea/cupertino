import Foundation
import Security
import ServiceManagement

/// Who this copy of Cupertino is: version, and the identity macOS holds it to.
///
/// Deliberately **not** asserting notarization here. Checking a stapled ticket
/// through `SecStaticCodeCheckValidity` can fall back to an online revocation
/// check, and docs/licensing.md sells "no network anywhere in app/" — a claim
/// scripts/audit-network.sh gates in CI. `make install-release` validates the
/// staple before installing, which is the right place for it.
enum AppInfo {
  static var version: String {
    let info = Bundle.main.infoDictionary
    let short = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(short) (\(build))"
  }

  /// The major version a licence key has to name to unlock this build.
  ///
  /// Nothing bumps `MARKETING_VERSION` in the pbxproj — CI overrides it from the
  /// `app-v*` tag and a local build keeps the default. So this reads 1 on every
  /// developer's Mac whatever tag is checked out, which is expected rather than
  /// a bug, and only ever wrong in a direction that is easy to notice.
  static var major: Int {
    let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    return Int(short.split(separator: ".").first ?? "") ?? 1
  }

  /// The team the signature names, or nil for a build signed to run locally.
  static var teamIdentifier: String? {
    var code: SecCode?
    guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return nil }

    var information: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
    guard SecCodeCopySigningInformation(unsafeBitCast(code, to: SecStaticCode.self), flags, &information) == errSecSuccess,
      let dictionary = information as? [String: Any]
    else { return nil }

    return dictionary[kSecCodeInfoTeamIdentifier as String] as? String
  }

  static var identity: String {
    guard let team = teamIdentifier else { return "Development build" }
    return "Developer ID · \(team)"
  }
}

/// The login item, which is a convenience rather than a requirement: the bridge
/// launches the app by path when it finds no socket, so the first tool call
/// starts Cupertino anyway. This only removes that first-call delay.
enum LoginItem {
  static var isEnabled: Bool {
    SMAppService.mainApp.status == .enabled
  }

  /// Registering from a translocated or temporary copy records a path that will
  /// not be there next login, so the caller gates on `InstallLocation.isStable`.
  static func set(_ enabled: Bool) -> String? {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      return nil
    } catch {
      hostLog("cupertino", .error, "login item: \(error.localizedDescription)")
      return error.localizedDescription
    }
  }
}
