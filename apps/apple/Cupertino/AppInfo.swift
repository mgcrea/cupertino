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

  /// The marketing version alone, for the places that show it in passing rather
  /// than as an About line: the menu bar popover and the sidebar footer.
  ///
  /// No build number, because neither surface is where someone goes to file a
  /// bug — Settings carries the full string, the commit and the copy button.
  static var shortVersion: String {
    if DemoSeed.isEnabled { return DemoSeed.version }
    return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
  }

  /// The commit this bundle was built from, or nil for a build that had no git
  /// to ask — an Xcode-only build, or a source tarball.
  ///
  /// `CFBundleVersion` is the commit *count*, which orders builds but does not
  /// identify one: two branches at the same depth carry the same number, and so
  /// does a rebuild after an amend. This is the part that turns "1.0.0 (119)"
  /// in a bug report into a diff.
  static var commit: String? {
    let value = Bundle.main.infoDictionary?["CupertinoGitCommit"] as? String ?? ""
    return value.isEmpty ? nil : value
  }

  /// One line naming this exact build, for pasting into a bug report.
  ///
  /// Everything a maintainer needs to reproduce what the reporter is running,
  /// and nothing that identifies them — no licence key, no machine id, no path.
  static var buildLine: String {
    var parts = ["Cupertino \(version)"]
    if let commit { parts.append(commit) }
    parts.append(identity)
    parts.append("macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
    return parts.joined(separator: " · ")
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

  /// The identity line as shown, with the commit appended when there is one.
  static var identityLine: String {
    guard let commit else { return identity }
    return "\(identity) · \(commit)"
  }
}

/// The login item, which is a convenience rather than a requirement: the bridge
/// launches the app by path when it finds no socket, so the first tool call
/// starts Cupertino anyway. This only removes that first-call delay.
enum LoginItem {
  static var isEnabled: Bool {
    SMAppService.mainApp.status == .enabled
  }

  /// What the user asked for, as opposed to what the service currently reports.
  ///
  /// These come apart. `SMAppService.mainApp` registers a bundle at a path, and
  /// a registration can drop to `.requiresApproval` or `.notFound` when the
  /// bundle under it is replaced — which is now something that happens on its
  /// own, every time Sparkle installs an update. Without a record of the intent
  /// there is nothing to compare against, so the box would simply be unticked
  /// the next time somebody opened Settings, and the app would have silently
  /// stopped starting at login without anyone being told.
  static let desiredKey = "launchAtLoginDesired"

  /// Registering from a translocated or temporary copy records a path that will
  /// not be there next login, so the caller gates on `InstallLocation.isStable`.
  static func set(_ enabled: Bool) -> String? {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      UserDefaults.standard.set(enabled, forKey: desiredKey)
      return nil
    } catch {
      hostLog("cupertino", .error, "login item: \(error.localizedDescription)")
      return error.localizedDescription
    }
  }

  /// Re-register once if the user asked for launch at login and the service no
  /// longer agrees.
  ///
  /// Called at launch, which is the first moment after an update where both
  /// facts are readable. Deliberately one attempt and no retry loop: if it
  /// fails, `GeneralPane` shows the real status and the error, and quietly
  /// trying forever would only make a broken registration harder to notice.
  static func healIfNeeded() {
    guard UserDefaults.standard.bool(forKey: desiredKey),
      SMAppService.mainApp.status != .enabled,
      InstallLocation.current.isStable
    else { return }
    hostLog(
      "cupertino", .info,
      "login item was requested but is \(SMAppService.mainApp.status) — re-registering")
    _ = set(true)
  }
}
