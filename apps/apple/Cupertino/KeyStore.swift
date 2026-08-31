import Foundation
import Security

/// The Keychain, for the one thing that belongs in it.
///
/// **This is the app's first `SecItem` code, and that is a reversal worth
/// stating.** `LicenseStore` says the licence key lives in `UserDefaults`
/// because "a licence key is not a secret" and the Keychain would have been
/// ceremony — which was right, and is still right for that.
///
/// A private signing key is a different kind of thing. It cannot be re-derived,
/// re-issued or retyped: lose it and every export signed with it is orphaned
/// from the key its recipients pinned. So the same reasoning that kept the
/// licence out now puts this in, and `LicenseStore`'s comment has been updated
/// to say which of the two it is talking about rather than being left to read
/// as a rule about the whole app.
///
/// Deliberately narrow: one scope, one accessibility class, four operations.
/// Bastion's `CredentialStore` is the shape this is trimmed from — it carries
/// four scopes because it holds four kinds of secret, and Cupertino holds one.
///
/// `make audit` greps undefined Mach-O symbols and does not inspect linked
/// frameworks, so it will not notice Security.framework arriving. That is why
/// this file says so instead.
enum KeyStore {
  /// Keyed by bundle identifier, so a Debug build never reads or writes the
  /// real app's key — the same separation `BridgeProtocol.appIdentifier`
  /// already makes for the socket and the Full Disk Access grant.
  private static var service: String { "\(BridgeProtocol.appIdentifier).audit" }

  enum StoreError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
      switch self {
      case .keychain(let status):
        let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
        return "Keychain error \(status): \(text)"
      }
    }
  }

  static func read(_ account: String) -> String? {
    var query = base(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func write(_ account: String, value: String) throws {
    let data = Data(value.utf8)
    // Update first, add second. `SecItemAdd` on an existing account fails with
    // errSecDuplicateItem rather than replacing, so an add-only path can never
    // rotate a key.
    let updated = SecItemUpdate(
      base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw StoreError.keychain(updated) }

    var query = base(account)
    query[kSecValueData as String] = data
    // The screen can be locked while a tool call is in flight, and this device
    // only: a signing key that synced to iCloud would make "this Mac's key"
    // untrue, which is the only thing a signature here claims.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(query as CFDictionary, nil)
    guard added == errSecSuccess else { throw StoreError.keychain(added) }
  }

  static func delete(_ account: String) throws {
    let status = SecItemDelete(base(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw StoreError.keychain(status)
    }
  }

  /// Whether an account exists, without asking for its value.
  ///
  /// An attributes-only query, so it never meets the ACL that guards the data —
  /// the difference between "is a key set" and a prompt.
  static func exists(_ account: String) -> Bool {
    var query = base(account)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess
  }

  private static func base(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}
