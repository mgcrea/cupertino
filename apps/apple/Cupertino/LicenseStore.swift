import Foundation

/// Where this Mac's licence key lives, and whether it is any good.
///
/// `UserDefaults`, not the Keychain. The key is not a secret: it is issued to
/// the user, rendered in the menu bar, emailed to them in plain text and
/// re-sendable on demand. Encrypting at rest something displayed in the UI would
/// be ceremony. `SurfaceSettings.allowWrites` already reads `UserDefaults`
/// synchronously from the connection thread; this needs exactly that and no more.
///
/// This used to add "and it would make this the app's first `SecItem` code for
/// no security gained". `KeyStore` is that code now — the audit log's export
/// signing key genuinely cannot be re-issued or retyped, which is the property
/// a licence key has and a private key does not. The argument above is still
/// the right one for THIS value; it was never a rule about the whole app, and
/// the sentence is corrected here rather than left to read like one.
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
    // `LicensePane.onAppear` puts this into a 92pt `TextEditor`, in every
    // entitlement state — so without the branch the developer's own key is
    // photographed at full size on the licence plate.
    #if DEBUG
      if DemoSeed.isEnabled { return demoLicensed ? demoKey : nil }
    #else
      if DemoSeed.isEnabled { return nil }
    #endif
    return UserDefaults.standard.string(forKey: defaultsKey)
  }

  /// Set by `DemoSeed` and by nothing else.
  ///
  /// A screenshot has to show the licensed state, and it cannot get there the
  /// honest way: every valid key is Ed25519-signed, so the only alternative to
  /// this flag is committing a real working licence key to the repository.
  ///
  /// Debug-only in its effect. `raw` and `check` consult it under `#if DEBUG`,
  /// so a Release build cannot report a licence from this flag however
  /// `ScreenshotMode` was set. The flag itself is deliberately NOT fenced: it is
  /// assigned from `DemoSeed.seedStores`, which has to compile into any
  /// configuration. Fencing the two readers costs the licensed plate nothing,
  /// because `make screenshots` captures the `app` target and that is `Debug`
  /// (`CONFIG` in the Makefile) — check that before moving the capture to
  /// Release, because the plate would then render UNLICENSED rather than fail.
  ///
  /// This comment used to say the flag was "unreachable in a shipped build
  /// regardless, since `DemoSeed.isEnabled` is false without a launch argument".
  /// That was false: `isEnabled` read `UserDefaults.standard`, which also reads
  /// the persisted domain, so one `defaults write ScreenshotMode -bool YES` set
  /// it and licensed a shipped build. `DemoSeed.argument` fixed the read; the
  /// fences below are why a second such slip would not reach the licence answer.
  nonisolated(unsafe) static var demoLicensed = false

  /// A key of the right SHAPE and deliberately not of the right signature.
  ///
  /// It is rendered, never verified — `check` below branches before
  /// `LicenseKey.check` ever sees it. That is the point: a demo key that
  /// actually verified would be a valid licence sitting in a public repository.
  static let demoKey =
    "cup1.eyJpZCI6ImRlbW8iLCJlbWFpbCI6InlvdUBleGFtcGxlLmNvbSIsIm1ham9yIjoxLCJpc3N1ZWRBdCI6IjIwMjYtMDEtMTUifQ"
    + ".DEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMODEMOKEYNOTSIGNED"

  static var check: LicenseCheck {
    if demoLicensed {
      // `.valid` is reachable only from a Debug build, and the guard is the
      // point rather than a formality. `demoLicensed` is set from
      // `DemoSeed.seedStores`, and `DemoSeed` carries no DEBUG guard of its own
      // — deliberately, since the plates are captured from a Release build — so
      // without this the shipped binary would answer the licence question from a
      // flag rather than from a signature. It did, until this fence went in.
      #if DEBUG
        return .valid(
          License(
            id: "demo", email: "you@example.com", major: AppInfo.major, issuedAt: "2026-01-15"))
      #else
        return .refused("no licence key on this Mac")
      #endif
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
