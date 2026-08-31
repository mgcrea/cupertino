import CryptoKit
import Foundation

/// Signs an audit export, when asked.
///
/// ## The export, never the log
///
/// Nothing here runs while Bastion is serving requests. Signing each record, or
/// each segment as it rotates, would put a Keychain read on the path of every
/// tool call — and a per-item ACL prompt in the middle of a request nobody is
/// sitting there to answer. Signing happens when a person has just clicked
/// Export, which is the one moment a Keychain prompt is a reasonable thing to
/// see. The chain already covers the file's internal consistency; the signature
/// covers the artifact you hand somebody.
///
/// ## What a signature here does and does not prove
///
/// It proves the export came from a Mac holding this key and has not been
/// altered since it was signed.
///
/// It does **not** prove the log was not curated before it was signed. The
/// owner controls the app, the key and the machine, so if the owner is the
/// party being audited a signature adds nothing. And a public key that travels
/// only inside the manifest proves nothing either, because a forger includes
/// their own — it means something only if the recipient pinned the key out of
/// band, which is why the Audit pane shows a fingerprint to send them once.
///
/// Both sentences are on screen. A security claim nobody stated the limits of
/// is the kind this project does not ship.
///
/// Ed25519, and `License.swift`'s rule inverted: **sign the encoded bytes,
/// never the decoded object.** A verifier re-reads the manifest as text and
/// checks the signature against those exact bytes, so no JSON encoder's field
/// order or escaping can come between the two halves.
enum AuditSigning {
  private static let account = "export"

  /// The key, minted on first use.
  ///
  /// Stored base64 because `KeyStore` holds strings. Raw representation rather
  /// than a PEM: it is 32 bytes and never leaves this file.
  static func key() throws -> Curve25519.Signing.PrivateKey {
    if let stored = KeyStore.read(account),
      let raw = Data(base64Encoded: stored),
      let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
    {
      return key
    }
    let fresh = Curve25519.Signing.PrivateKey()
    try KeyStore.write(account, value: fresh.rawRepresentation.base64EncodedString())
    return fresh
  }

  /// Whether a key exists, without minting one.
  ///
  /// An attributes-only question, so it never meets the per-item ACL that
  /// guards a value — the same reason `KeyStore.exists` is separate from `read`.
  static var hasKey: Bool {
    KeyStore.exists(account)
  }

  /// Throw the key away. The next export mints a new one.
  static func forget() throws {
    try KeyStore.delete(account)
  }

  static func publicKey() throws -> String {
    try key().publicKey.rawRepresentation.base64EncodedString()
  }

  /// A short, readable form of the public key, for the one-time exchange.
  ///
  /// Grouped in fours because this gets read aloud and typed into a chat
  /// window. It is a truncated SHA256 of the public key, not the key itself:
  /// the full key travels in the manifest, and what a person needs to compare
  /// is something they can hold in their head for a second.
  static func fingerprint(_ publicKey: String) -> String {
    guard let raw = Data(base64Encoded: publicKey) else { return "—" }
    let digest = SHA256.hash(data: raw).map { String(format: "%02X", $0) }.joined()
    return stride(from: 0, to: 16, by: 4).map { index in
      String(digest[digest.index(digest.startIndex, offsetBy: index)...].prefix(4))
    }.joined(separator: " ")
  }

  static func currentFingerprint() -> String? {
    guard hasKey, let key = try? publicKey() else { return nil }
    return fingerprint(key)
  }

  static func sign(_ bytes: Data) throws -> String {
    try key().signature(for: bytes).base64EncodedString()
  }

  /// The other half, so the round trip can be asserted without an app.
  static func verify(_ bytes: Data, signature: String, publicKey: String) -> Bool {
    guard let signatureData = Data(base64Encoded: signature),
      let keyData = Data(base64Encoded: publicKey),
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData)
    else { return false }
    return key.isValidSignature(signatureData, for: bytes)
  }
}
