import CryptoKit
import Foundation
import Security

/// "Shell is on" and "Don't ask", the two settings that lower the bar, counted only when they
/// carry a seal Cupertino made.
///
/// ## Why the plain preference is not enough
///
/// Cupertino is not sandboxed, so any process running as the user can write its preferences.
/// A session with a shell but no Full Disk Access could `defaults write` both keys and turn "has
/// a shell" into "has Full Disk Access" with no window in front of anybody. So each of the two
/// carries, beside it, a hex HMAC-SHA256 over `"<app identifier>|<preference key>|<value>"`,
/// keyed by 32 random bytes that only Cupertino's own signed code can create, read or replace.
///
/// A missing, unreadable or invalid seal reads as Shell **off** and as **Ask every time**, so
/// deleting the key or the preference fails safe. "Ask every time" and "Ask once per session"
/// need no seal: both still put a window in front of a person.
///
/// ## Why the key is in the data protection keychain
///
/// The first version kept it as a generic password in the login keychain, like `KeyStore`'s
/// audit key. That store lets ANY process create an item under any service and account, with an
/// ACL that trusts every app. So a program could plant `shell-seal` with a key it chose before
/// Shell was ever turned on, compute both seals itself, and `defaults write` all four keys: Shell
/// on, "Don't ask", no prompt anywhere. Rotation would not have helped, because an update
/// rewrites the planted item in place and keeps its ACL.
///
/// The data protection keychain (TN3137) scopes an item to a keychain access group, and a
/// process can only name a group its signature is entitled to, an entitlement a provisioning
/// profile must authorise. The group is the app's own application identifier, read from its
/// signature, so the Debug build (`io.mgcrea.cupertino.debug`) and the release build have
/// different groups and different keys. A build signed without that entitlement gets
/// `errSecMissingEntitlement` and so no key: Shell off, ask. `lastKeyError` keeps the reason.
///
/// ## Why a launch argument cannot set either
///
/// Values are read from `persistentDomain(forName: domain)`, never `object(forKey:)`. The
/// persistent domain leaves out `NSArgumentDomain`, so `-shell.before none` or
/// `-surfaceEnabled.shell YES` on a command line never reaches the value read here, sealed or
/// not. That is the difference from `driving.before`, which a launch argument may set.
///
/// ## Why the key rotates on the way down
///
/// The seal sits in a plist anyone running as the user can read. A process that copied it while
/// Shell was on could write it back after the person turned Shell off, and the copy would still
/// validate. So whenever a protected setting goes down, the key is replaced, and every seal made
/// under the old key, copies included, stops validating. Turning Shell off also puts "Before
/// running" back to "Ask every time", so turning it on again never brings "Don't ask" back with
/// it. Lowering "Don't ask" leaves Shell on: its seal is made again under the new key.
///
/// ## The Debug build
///
/// The app identifier is both in the sealed text and in the access group, so the Debug build has
/// its own key and a seal from one build never validates in the other.
nonisolated enum ShellSeal {

  /// Where the seal key lives. `Keychain` in the app; a check sets one held in memory so it
  /// never touches the real Keychain.
  protocol KeySource: Sendable {
    /// The current key, or nil when there is none or it cannot be read.
    func key() -> Data?
    /// Replace the key with 32 new random bytes, store them and return them. Nil when the new
    /// key could not be stored.
    func rotate() -> Data?
  }

  /// The key in the data protection keychain, in the access group named by this process's own
  /// application identifier.
  ///
  /// Cached in memory after the first read, so a request costs no Keychain call once Shell has
  /// been checked once. The cache is shared by every instance, so a rotation is seen by all of
  /// them. Every failure, a missing entitlement above all, reads as no key.
  struct Keychain: KeySource {
    static let account = "shell-seal"

    /// `com.apple.application-identifier` from this process's signature: `<prefix>.<bundle id>`,
    /// put there by the provisioning profile. Nil for a build signed without one, and for every
    /// check binary.
    static let signedApplicationIdentifier: String? = {
      guard let task = SecTaskCreateFromSelf(nil) else { return nil }
      let value = SecTaskCopyValueForEntitlement(
        task, "com.apple.application-identifier" as CFString, nil)
      return value as? String
    }()

    /// The access group for `applicationIdentifier`, which must be `<prefix>.<appIdentifier>`.
    /// Anything else, a wildcard or another build's identifier among them, is nil, so a key is
    /// never shared between the Debug and the release build however either was signed.
    static func accessGroup(applicationIdentifier: String?, appIdentifier: String) -> String? {
      guard let id = applicationIdentifier, let dot = id.firstIndex(of: "."),
        dot != id.startIndex, id[id.index(after: dot)...] == appIdentifier
      else { return nil }
      return id
    }

    /// The item's identity, pure so `shell-check` can pin it: the data protection keychain, the
    /// app's own access group. Nil when there is no group to use, so nothing is queried at all.
    static func query(applicationIdentifier: String?, appIdentifier: String) -> [String: Any]? {
      guard
        let group = accessGroup(
          applicationIdentifier: applicationIdentifier, appIdentifier: appIdentifier)
      else { return nil }
      return [
        kSecClass as String: kSecClassGenericPassword,
        kSecUseDataProtectionKeychain as String: true,
        kSecAttrAccessGroup as String: group,
        kSecAttrService as String: "\(appIdentifier).shell-seal",
        kSecAttrAccount as String: account,
      ]
    }

    private final class Cache: @unchecked Sendable {
      let lock = NSLock()
      var key: Data?
      /// Set when a rotation could not replace the key. The old key may still be there, and
      /// with it every seal copied under it, so none is trusted until a later rotation
      /// succeeds.
      var poisoned = false
      var error: String?
    }

    private static let cache = Cache()

    /// Why the last read or rotation found no key, when it failed rather than found none.
    static var lastError: String? { cache.lock.withLock { cache.error } }

    private let applicationIdentifier: String?

    init(applicationIdentifier: String? = Keychain.signedApplicationIdentifier) {
      self.applicationIdentifier = applicationIdentifier
    }

    private var base: [String: Any]? {
      Self.query(
        applicationIdentifier: applicationIdentifier, appIdentifier: BridgeProtocol.appIdentifier)
    }

    func key() -> Data? {
      Self.cache.lock.withLock {
        if Self.cache.poisoned { return nil }
        if let key = Self.cache.key { return key }
        guard var query = base else {
          Self.cache.error = Self.noGroup
          return nil
        }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
          Self.cache.error = nil
          return nil
        }
        guard status == errSecSuccess, let data = item as? Data, data.count == keyBytes else {
          Self.cache.error = Self.describe(status == errSecSuccess ? errSecDecode : status)
          return nil
        }
        Self.cache.error = nil
        Self.cache.key = data
        return data
      }
    }

    /// Delete, then add: never an update, so the item always carries the attributes set here.
    func rotate() -> Data? {
      let fresh = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
      return Self.cache.lock.withLock {
        Self.cache.key = nil
        guard let base else {
          Self.cache.error = Self.noGroup
          return nil
        }
        let deleted = SecItemDelete(base as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
          Self.cache.error = Self.describe(deleted)
          Self.cache.poisoned = true
          return nil
        }
        var add = base
        add[kSecValueData as String] = fresh
        // The screen can be locked while a request is in flight, and this device only, as for
        // `KeyStore`: a seal key that synced would let another Mac's seal validate here.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else {
          // Deleted and not replaced: no key, so every seal fails, which is safe.
          Self.cache.error = Self.describe(added)
          Self.cache.poisoned = true
          return nil
        }
        Self.cache.poisoned = false
        Self.cache.error = nil
        Self.cache.key = fresh
        return fresh
      }
    }

    private static let noGroup =
      "This build has no application identifier of its own, so it cannot keep the seal key."

    private static func describe(_ status: OSStatus) -> String {
      if status == errSecMissingEntitlement {
        return "This build is not entitled to the data protection keychain (\(status))."
      }
      let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
      return "Keychain error \(status): \(text)"
    }
  }

  nonisolated(unsafe) static var source: any KeySource = Keychain()

  /// Why the seal key could not be had, for the diagnostics and the pane. Nil when there was no
  /// failure, including when there is simply no key yet.
  static var lastKeyError: String? { Keychain.lastError }

  /// The defaults domain the values are read from. The app's own; a check sets its suite.
  nonisolated(unsafe) static var domain: String =
    Bundle.main.bundleIdentifier ?? BridgeProtocol.appIdentifier

  /// `SurfaceSettings.enabledKey` for the `shell` surface.
  static let enabledKey = "surfaceEnabled.shell"
  static let enabledSealKey = "shell.seal.enabled"
  static let beforeSealKey = "shell.seal.before"

  static let keyBytes = 32

  /// Whether Shell is on: the value says so and its seal holds.
  ///
  /// The key is fetched only once the value claims Shell is on, so Shell off costs no Keychain
  /// call.
  static func isEnabled(_ store: UserDefaults) -> Bool {
    let values = persistent(store)
    guard values[enabledKey] as? Bool == true else { return false }
    return isSealed(values, enabledKey, value: "true", sealKey: enabledSealKey)
  }

  /// The "Before running" setting in force. `.none` only with a valid seal, `.ask` for anything
  /// missing or unknown.
  static func effectiveBefore(_ store: UserDefaults) -> ShellPolicy.Before {
    let values = persistent(store)
    let raw = values[ShellPolicy.key] as? String
    let before = raw.flatMap(ShellPolicy.Before.init(rawValue:)) ?? ShellPolicy.Before.ask
    guard before == ShellPolicy.Before.none else { return before }
    let sealed = isSealed(
      values, ShellPolicy.key, value: ShellPolicy.Before.none.rawValue, sealKey: beforeSealKey)
    return sealed ? ShellPolicy.Before.none : ShellPolicy.Before.ask
  }

  /// On writes the value and its seal. Off removes both and puts "Before running" back to
  /// "Ask every time" through `setBefore(.ask)`, which rotates the key.
  static func setEnabled(_ on: Bool, _ store: UserDefaults) {
    if on {
      store.set(true, forKey: enabledKey)
      seal(store, enabledKey, value: "true", sealKey: enabledSealKey)
    } else {
      store.removeObject(forKey: enabledKey)
      store.removeObject(forKey: enabledSealKey)
      setBefore(.ask, store)
    }
  }

  /// `.none` writes the value and its seal. Anything else writes the value, removes the seal
  /// and rotates the key.
  static func setBefore(_ before: ShellPolicy.Before, _ store: UserDefaults) {
    store.set(before.rawValue, forKey: ShellPolicy.key)
    if before == ShellPolicy.Before.none {
      seal(store, ShellPolicy.key, value: before.rawValue, sealKey: beforeSealKey)
    } else {
      store.removeObject(forKey: beforeSealKey)
      rotateKeepingWhatHolds(store)
    }
  }

  // MARK: - Sealing

  /// The values as stored on disk for `domain`, without `NSArgumentDomain` or any other
  /// volatile domain.
  private static func persistent(_ store: UserDefaults) -> [String: Any] {
    store.persistentDomain(forName: domain) ?? [:]
  }

  private static func message(_ key: String, _ value: String) -> Data {
    Data("\(BridgeProtocol.appIdentifier)|\(key)|\(value)".utf8)
  }

  /// Compared in constant time by `HMAC.isValidAuthenticationCode`.
  private static func isSealed(
    _ values: [String: Any], _ key: String, value: String, sealKey: String
  ) -> Bool {
    guard let hex = values[sealKey] as? String, let mac = bytes(hex), let secret = source.key()
    else { return false }
    return HMAC<SHA256>.isValidAuthenticationCode(
      mac, authenticating: message(key, value), using: SymmetricKey(data: secret))
  }

  /// Seal `value` under the current key, minting one if there is none. With no key to be had
  /// the seal is removed, so the setting reads as down rather than as a stale seal.
  private static func seal(_ store: UserDefaults, _ key: String, value: String, sealKey: String) {
    guard let secret = source.key() ?? source.rotate() else {
      store.removeObject(forKey: sealKey)
      return
    }
    let mac = HMAC<SHA256>.authenticationCode(
      for: message(key, value), using: SymmetricKey(data: secret))
    store.set(mac.map { String(format: "%02x", $0) }.joined(), forKey: sealKey)
  }

  /// Rotate the key after a setting went down, sealing "Shell is on" again if it still holds.
  /// "Don't ask" is never up here: every rotation comes from lowering it, Shell off included.
  private static func rotateKeepingWhatHolds(_ store: UserDefaults) {
    let keepEnabled = isEnabled(store)
    guard source.rotate() != nil else { return }
    if keepEnabled { seal(store, enabledKey, value: "true", sealKey: enabledSealKey) }
  }

  /// The bytes a hex seal spells, one SHA-256 MAC long, or nil for anything else.
  private static func bytes(_ hex: String) -> Data? {
    let digits = Array(hex.utf8)
    guard digits.count == SHA256.byteCount * 2 else { return nil }
    var out = Data(capacity: SHA256.byteCount)
    for i in stride(from: 0, to: digits.count, by: 2) {
      guard let high = nibble(digits[i]), let low = nibble(digits[i + 1]) else { return nil }
      out.append(high << 4 | low)
    }
    return out
  }

  private static func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): c - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): c - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F"): c - UInt8(ascii: "A") + 10
    default: nil
    }
  }
}
