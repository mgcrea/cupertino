import Foundation
import Security
import os

/// Where the HTTP tokens are kept, one per client id.
///
/// A protocol so the checks can hold tokens in memory: a check that wrote to
/// the login Keychain would leave items behind in the real one.
nonisolated protocol TokenVault: Sendable {
  /// The client's token, nil only when it has none. Every other failure
  /// throws, so a token that could not be read is never taken for one that
  /// is not there.
  func read(_ client: String) throws -> String?
  func write(_ client: String, _ token: String) throws
  func delete(_ client: String) throws
  /// Every stored token, keyed by client id. Throws when they could not be
  /// listed, which is not the same as there being none.
  func all() throws -> [String: String]
}

/// The tokens in the Keychain: generic-password items, the service fixed, the
/// account the client id.
///
/// The service is keyed by the build's identifier, as `KeyStore`'s is: release
/// keeps `io.mgcrea.cupertino.http-token` and Debug gets its own. Both builds
/// wire the same client configs, and each caches its own map, so one shared
/// item would be re-minted and revoked under the other; on the file-based
/// Keychain the item also trusts only the build that made it, so the other's
/// read would prompt.
///
/// This device only and after first unlock: a request can arrive while the
/// screen is locked, and a token that synced to iCloud Keychain would sign a
/// client in on another Mac, where nothing listens for it.
nonisolated struct KeychainTokenVault: TokenVault {
  static let service = "\(BridgeProtocol.appIdentifier).http-token"

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

  func read(_ client: String) throws -> String? {
    var query = Self.base(client)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw VaultError.keychain(status) }
    guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
      throw VaultError.keychain(errSecDecode)
    }
    return token
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

  /// The accounts first, then each one's token. The file-based Keychain
  /// refuses `kSecReturnData` with `kSecMatchLimitAll` (errSecParam), so a
  /// single listing query cannot return the tokens themselves.
  func all() throws -> [String: String] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrSynchronizable as String: false,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
    ]
    var items: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &items)
    if status == errSecItemNotFound { return [:] }
    guard status == errSecSuccess else { throw VaultError.keychain(status) }
    guard let rows = items as? [[String: Any]] else { throw VaultError.keychain(errSecDecode) }
    var tokens: [String: String] = [:]
    for row in rows {
      guard let client = row[kSecAttrAccount as String] as? String else { continue }
      if let token = try read(client) { tokens[client] = token }
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
/// is read from the vault once, at the listener's start (`preload`) or on
/// first use, and kept in step on every mint and revoke, under one lock.
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
    /// When the last listing failed, on `now`'s clock. See `load`.
    var failedAt: TimeInterval?
    /// Keyed by client id.
    var tokens: [String: String] = [:]
  }

  private let vault: TokenVault
  private let now: @Sendable () -> TimeInterval
  private let state = OSAllocatedUnfairLock(initialState: State())

  /// How long a failed listing is left before the vault is asked again.
  static let retryAfter: TimeInterval = 5

  /// `now` is a monotonic clock in seconds, for the retry back-off; the checks
  /// pass one they move by hand.
  init(
    vault: TokenVault,
    now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.vault = vault
    self.now = now
  }

  /// Lists the vault now, so the first request does not pay for it. The
  /// listener calls it as it starts, off the main thread.
  func preload() { state.withLock { load(&$0) } }

  /// The client's token, minted and stored on its first call.
  ///
  /// A client missing from the map is looked up in the vault by its own id
  /// before one is minted, and a token is minted only when that read says
  /// there is none: a read that failed throws, rather than minting over a
  /// token the vault may still hold.
  func token(for client: String) throws -> String {
    try state.withLock { state in
      load(&state)
      if let token = state.tokens[client] { return token }
      if let stored = try vault.read(client) {
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

  /// Reads the vault until a listing succeeds. A failed one leaves the map
  /// unloaded, so a later call tries again rather than refusing every token
  /// until the app is relaunched, but not within `retryAfter` of the failure:
  /// every request runs this under the lock, and a Keychain that keeps
  /// refusing must not be asked once per request. Requests in that window see
  /// the map as it is. Tokens minted or read meanwhile stay in the map, and
  /// the listing is merged under them.
  ///
  /// A failure is logged once per attempt, by its status alone: the error's
  /// text is the Keychain's, and nothing here may put a token in the log.
  private func load(_ state: inout State) {
    guard !state.loaded else { return }
    let at = now()
    if let failed = state.failedAt, at - failed < Self.retryAfter { return }
    do {
      let listed = try vault.all()
      state.tokens.merge(listed) { cached, _ in cached }
      state.loaded = true
      state.failedAt = nil
    } catch {
      state.failedAt = at
      hostLog(
        "cupertino", .error,
        "HTTP tokens: the Keychain listing failed (\(Self.status(of: error))); "
          + "trying again in \(Int(Self.retryAfter)) s at the earliest")
    }
  }

  /// A failure as its status: the OSStatus of a Keychain error, the type's
  /// name for anything else.
  private static func status(of error: Error) -> String {
    if case KeychainTokenVault.VaultError.keychain(let status) = error { return "status \(status)" }
    return String(describing: type(of: error))
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
