import Foundation
import Security
import os

/// Where the HTTP tokens are kept, one per client id.
///
/// A protocol so the checks can hold tokens in memory: a check that wrote to
/// the login Keychain would leave items behind in the real one.
nonisolated protocol TokenVault: Sendable {
  func read(_ client: String) -> String?
  func write(_ client: String, _ token: String) throws
  func delete(_ client: String) throws
  /// Every stored token, keyed by client id.
  func all() -> [String: String]
}

/// The tokens in the Keychain: generic-password items, the service fixed, the
/// account the client id.
///
/// This device only and after first unlock: a request can arrive while the
/// screen is locked, and a token that synced to iCloud Keychain would sign a
/// client in on another Mac, where nothing listens for it.
nonisolated struct KeychainTokenVault: TokenVault {
  static let service = "io.mgcrea.cupertino.http-token"

  enum VaultError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
      switch self {
      case .keychain(let status):
        let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
        return "Keychain error \(status): \(text)"
      }
    }
  }

  func read(_ client: String) -> String? {
    var query = Self.base(client)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func write(_ client: String, _ token: String) throws {
    let data = Data(token.utf8)
    // Update first, add second: `SecItemAdd` on an existing account fails with
    // errSecDuplicateItem rather than replacing it.
    let updated = SecItemUpdate(
      Self.base(client) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw VaultError.keychain(updated) }

    var add = Self.base(client)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(add as CFDictionary, nil)
    guard added == errSecSuccess else { throw VaultError.keychain(added) }
  }

  func delete(_ client: String) throws {
    let status = SecItemDelete(Self.base(client) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw VaultError.keychain(status)
    }
  }

  func all() -> [String: String] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrSynchronizable as String: false,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
      kSecReturnData as String: true,
    ]
    var items: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
      let rows = items as? [[String: Any]]
    else { return [:] }
    var tokens: [String: String] = [:]
    for row in rows {
      guard let client = row[kSecAttrAccount as String] as? String,
        let data = row[kSecValueData as String] as? Data,
        let token = String(data: data, encoding: .utf8)
      else { continue }
      tokens[client] = token
    }
    return tokens
  }

  /// `kSecAttrSynchronizable` false is the default, and is stated anyway: the
  /// item must never be the iCloud Keychain's.
  private static func base(_ client: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: client,
      kSecAttrSynchronizable as String: false,
    ]
  }
}

/// One bearer token per wired client (claude-code, vscode, cursor, codex).
///
/// The token is written into that client's config and names the client on
/// every HTTP request: `client(for:)` is what `HTTPGate.verify` calls. It runs
/// on every request, from many threads, so it never reaches the vault: the map
/// is read from the vault once, on first use, and kept in step on every mint
/// and revoke, under one lock.
nonisolated final class HTTPTokens: @unchecked Sendable {
  static let shared = HTTPTokens(vault: KeychainTokenVault())

  enum TokenError: LocalizedError {
    case random(OSStatus)

    var errorDescription: String? {
      switch self {
      case .random(let status): "SecRandomCopyBytes failed (\(status)); no token minted"
      }
    }
  }

  private struct State {
    var loaded = false
    /// Keyed by client id.
    var tokens: [String: String] = [:]
  }

  private let vault: TokenVault
  private let state = OSAllocatedUnfairLock(initialState: State())

  init(vault: TokenVault) { self.vault = vault }

  /// The client's token, minted and stored on its first call.
  ///
  /// A client missing from the map is looked up in the vault by its own id
  /// before one is minted, so a token the vault holds is never replaced by a
  /// load that came back short.
  func token(for client: String) throws -> String {
    try state.withLock { state in
      load(&state)
      if let token = state.tokens[client] { return token }
      if let stored = vault.read(client) {
        state.tokens[client] = stored
        return stored
      }
      let token = try Self.mint()
      try vault.write(client, token)
      state.tokens[client] = token
      return token
    }
  }

  /// The client a token belongs to, or nil for one nobody holds.
  ///
  /// Constant time in the token's content: the candidate is compared with
  /// every stored token, and the loop does not stop at a match.
  func client(for token: String) -> String? {
    guard !token.isEmpty else { return nil }
    let candidate = Array(token.utf8)
    return state.withLock { state in
      load(&state)
      var found: String?
      for (client, stored) in state.tokens {
        if Self.equal(candidate, Array(stored.utf8)) { found = client }
      }
      return found
    }
  }

  /// Signs out one client: its token stops working at once.
  func revoke(_ client: String) throws {
    try state.withLock { state in
      load(&state)
      try vault.delete(client)
      state.tokens[client] = nil
    }
  }

  private func load(_ state: inout State) {
    guard !state.loaded else { return }
    state.tokens = vault.all()
    state.loaded = true
  }

  /// 32 bytes from the system's CSPRNG, as 64 lowercase hex characters. A
  /// failure throws: there is no weaker generator to fall back to.
  private static func mint() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else { throw TokenError.random(status) }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// Equal bytes, in a time that depends on `stored`'s length only. A
  /// candidate of another length still walks the whole of `stored`.
  private static func equal(_ candidate: [UInt8], _ stored: [UInt8]) -> Bool {
    var diff: UInt8 = candidate.count == stored.count ? 0 : 1
    for i in 0..<stored.count {
      diff |= stored[i] ^ (i < candidate.count ? candidate[i] : 0)
    }
    return diff == 0
  }
}
