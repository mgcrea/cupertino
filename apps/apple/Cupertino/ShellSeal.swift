import CryptoKit
import Foundation

/// "Shell is on" and "Don't ask", the two settings that lower the bar, counted only when they
/// carry a seal Cupertino made.
///
/// ## Why the plain preference is not enough
///
/// Cupertino is not sandboxed, so any process running as the user can write its preferences.
/// A session with a shell but no Full Disk Access could `defaults write` both keys and turn "has
/// a shell" into "has Full Disk Access" with no window in front of anybody. So each of the two
/// carries, beside it, a hex HMAC-SHA256 over `"<app identifier>|<preference key>|<value>"`,
/// keyed by 32 random bytes in the Keychain under an item Cupertino created. Another program
/// reading that key meets the system's own prompt.
///
/// A missing, unreadable or invalid seal reads as Shell **off** and as **Ask every time**, so
/// deleting the key or the preference fails safe. "Ask every time" and "Ask once per session"
/// need no seal: both still put a window in front of a person.
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
/// under the old key, copies included, stops validating. The setting that stayed up, if one did,
/// is sealed again under the new key, so lowering one never lowers the other.
///
/// ## The Debug build
///
/// The app identifier is both in the sealed text and in `KeyStore`'s service name, so the Debug
/// build has its own key and a seal from one build never validates in the other.
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

  /// The key in the Keychain, under `KeyStore` account `account`, base64.
  ///
  /// Cached in memory after the first read, so a request costs no Keychain call once Shell has
  /// been checked once. `KeyStore`'s service is per bundle identifier, so the Debug key is
  /// separate. The cache is shared by every instance, so a rotation is seen by all of them.
  struct Keychain: KeySource {
    static let account = "shell-seal"

    private final class Cache: @unchecked Sendable {
      let lock = NSLock()
      var key: Data?
      /// Set when a rotation could not store its key. The old key may still be in the
      /// Keychain, and with it every seal copied under it, so none is trusted until a later
      /// rotation succeeds.
      var poisoned = false
    }

    private static let cache = Cache()

    func key() -> Data? {
      Self.cache.lock.withLock {
        if Self.cache.poisoned { return nil }
        if let key = Self.cache.key { return key }
        // A denied prompt or a locked keychain reads the same as no key: off and ask.
        guard let stored = try? KeyStore.read(Self.account),
          let data = Data(base64Encoded: stored), data.count == keyBytes
        else { return nil }
        Self.cache.key = data
        return data
      }
    }

    func rotate() -> Data? {
      let fresh = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
      return Self.cache.lock.withLock {
        Self.cache.key = nil
        do {
          try KeyStore.write(Self.account, value: fresh.base64EncodedString())
        } catch {
          // Without the old key every seal fails, which is safe. If even the delete fails, the
          // poisoned flag keeps this process from trusting it.
          try? KeyStore.delete(Self.account)
          Self.cache.poisoned = true
          return nil
        }
        Self.cache.poisoned = false
        Self.cache.key = fresh
        return fresh
      }
    }
  }

  nonisolated(unsafe) static var source: any KeySource = Keychain()

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

  /// On writes the value and its seal. Off removes both and rotates the key.
  static func setEnabled(_ on: Bool, _ store: UserDefaults) {
    if on {
      store.set(true, forKey: enabledKey)
      seal(store, enabledKey, value: "true", sealKey: enabledSealKey)
    } else {
      store.removeObject(forKey: enabledKey)
      store.removeObject(forKey: enabledSealKey)
      rotateKeepingWhatHolds(store)
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

  /// Rotate the key after a setting went down, sealing again whichever protected setting still
  /// holds, so that only the one lowered is lost.
  private static func rotateKeepingWhatHolds(_ store: UserDefaults) {
    let keepEnabled = isEnabled(store)
    let keepNone = effectiveBefore(store) == ShellPolicy.Before.none
    guard source.rotate() != nil else { return }
    if keepEnabled { seal(store, enabledKey, value: "true", sealKey: enabledSealKey) }
    if keepNone {
      seal(store, ShellPolicy.key, value: ShellPolicy.Before.none.rawValue, sealKey: beforeSealKey)
    }
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
