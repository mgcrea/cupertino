import Foundation

/// Where this Mac's licence key lives, and whether it is any good.
///
/// `UserDefaults`, not the Keychain. The key is not a secret: it is issued to
/// the user, rendered in the menu bar, emailed to them in plain text and
/// re-sendable on demand. Encrypting at rest something displayed in the UI would
/// be ceremony, and it would make this the app's first `SecItem` code for no
/// security gained. `SurfaceSettings.allowWrites` already reads `UserDefaults`
/// synchronously from the connection thread; this needs exactly that and no more.
///
/// Nothing is cached. Ed25519 verification is microseconds, and re-checking on
/// every read means entering a key takes effect immediately with no
/// invalidation to get wrong — the bug `WritesToggle` records at the top of
/// `CupertinoApp.swift`, avoided by not having state to invalidate.
enum LicenseStore {
  private static let defaultsKey = "license"

  /// The stored key as typed, or nil. Kept separate from `check()` so the entry
  /// field can show what is there even when it is being refused.
  static var raw: String? {
    UserDefaults.standard.string(forKey: defaultsKey)
  }

  /// Set by `DemoSeed` and by nothing else.
  ///
  /// A screenshot has to show the licensed state, and it cannot get there the
  /// honest way: every valid key is Ed25519-signed, so the only alternative to
  /// this flag is committing a real working licence key to the repository.
  ///
  /// This is not a hole in the licence check. The source is public and the gate
  /// is a dozen readable lines in `ServerHost.swift`, so anyone minded to bypass
  /// it would edit those rather than find their way here — and the flag is
  /// unreachable in a shipped build regardless, since `DemoSeed.isEnabled` is
  /// false without a launch argument.
  nonisolated(unsafe) static var demoLicensed = false

  static var check: LicenseCheck {
    if demoLicensed {
      return .valid(
        License(id: "demo", email: "you@example.com", major: AppInfo.major, issuedAt: "2026-01-15"))
    }
    return LicenseKey.check(raw)
  }

  static var current: License? {
    check.license
  }

  static var isLicensed: Bool {
    current != nil
  }

  /// Store a key only if it verifies, and say why if it does not.
  ///
  /// Refusing to persist a bad key is what keeps `raw` and `check` from
  /// disagreeing in a way the user cannot see — a key that is saved but refused
  /// looks like the app losing it.
  @discardableResult
  static func store(_ key: String) -> LicenseCheck {
    let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
    let result = LicenseKey.check(trimmed)
    if case .valid = result {
      UserDefaults.standard.set(trimmed, forKey: defaultsKey)
    }
    return result
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: defaultsKey)
  }
}
