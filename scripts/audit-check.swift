import CryptoKit
import Foundation

/// Runs the real export signer through a round trip.
///
/// `AuditChain` is covered by `make unit`, which needs no key and no Keychain.
/// This is the other half: the bytes that get signed, and whether a signature
/// over them survives being written to a file and read back by something that
/// did not produce it. The failure this exists to catch is quiet — a change to
/// what goes into the manifest, or to how it is encoded, leaves every export
/// verifying on the Mac that made it and nowhere else.
///
/// A standalone `swiftc` binary rather than an XCTest bundle, for the reason
/// `wiring-check.swift` gives: the Xcode project has no test target.
///
/// Run with `make audit-check`.

/// Stands in for `KeyStore`, which `AuditSigning` reaches for key storage and
/// which would drag Security.framework and `BridgeProtocol` in behind it. Storage is not what is under test here — the
/// crypto is — and an in-memory stub makes the round trip reproducible on a
/// machine with no Keychain entry, which is every CI machine.
enum KeyStore {
  
  nonisolated(unsafe) static var items: [String: String] = [:]
  static func read(_ account: String) -> String? { items[account] }
  static func write(_ account: String, value: String) throws { items[account] = value }
  static func delete(_ account: String) throws { items[account] = nil }
  static func exists(_ account: String) -> Bool { items[account] != nil }
}

@main
struct AuditCheck {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  static func main() throws {
    print("Audit signing: the round trip")

    let manifest = Data(
      #"{"format":"cupertino-audit","version":1,"records":412,"head":"c17b"}"#.utf8)

    let signature = try AuditSigning.sign(manifest)
    let publicKey = try AuditSigning.publicKey()
    check("a signed manifest verifies", AuditSigning.verify(manifest, signature: signature, publicKey: publicKey))

    // The whole point. One byte different is a different document.
    var tampered = manifest
    tampered.replaceSubrange(tampered.range(of: Data("412".utf8))!, with: Data("413".utf8))
    check(
      "a manifest edited by one field does not",
      !AuditSigning.verify(tampered, signature: signature, publicKey: publicKey))

    // A signature is only worth what the key pinning is worth: another key
    // produces a signature that is perfectly valid and means nothing.
    let other = Curve25519.Signing.PrivateKey()
    let otherSignature = try other.signature(for: manifest).base64EncodedString()
    check(
      "a signature from another key is refused against this one",
      !AuditSigning.verify(manifest, signature: otherSignature, publicKey: publicKey))
    check(
      "and verifies against its own — which is why the key must be pinned",
      AuditSigning.verify(
        manifest, signature: otherSignature,
        publicKey: other.publicKey.rawRepresentation.base64EncodedString()))

    print("\nAudit signing: malformed input is refused, not crashed on")

    check("a non-base64 signature", !AuditSigning.verify(manifest, signature: "not base64!", publicKey: publicKey))
    check("a non-base64 key", !AuditSigning.verify(manifest, signature: signature, publicKey: "not base64!"))
    check(
      "a well-formed but wrong-length key",
      !AuditSigning.verify(manifest, signature: signature, publicKey: Data("short".utf8).base64EncodedString()))
    check("an empty signature", !AuditSigning.verify(manifest, signature: "", publicKey: publicKey))

    print("\nAudit signing: the key")

    check("a key exists once it has been used", AuditSigning.hasKey)
    let again = try AuditSigning.publicKey()
    check("and is stable across calls", again == publicKey)

    // Key loss is a designed-for event, not an error: old exports keep
    // verifying against the public half a recipient already pinned.
    try AuditSigning.forget()
    check("forgetting a key removes it", !AuditSigning.hasKey)
    let minted = try AuditSigning.publicKey()
    check("the next export mints a new one", minted != publicKey)
    check(
      "and the old export still verifies against the old key",
      AuditSigning.verify(manifest, signature: signature, publicKey: publicKey))
    check(
      "while the old signature fails against the new key",
      !AuditSigning.verify(manifest, signature: signature, publicKey: minted))

    print("\nAudit signing: the fingerprint")

    let fingerprint = AuditSigning.fingerprint(publicKey)
    check("is four groups of four", fingerprint.split(separator: " ").count == 4)
    check("is stable for one key", AuditSigning.fingerprint(publicKey) == fingerprint)
    check("differs for another", AuditSigning.fingerprint(minted) != fingerprint)
    check("survives a key it cannot decode", AuditSigning.fingerprint("not base64!") == "—")

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}
