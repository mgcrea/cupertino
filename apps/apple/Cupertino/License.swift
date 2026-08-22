import CryptoKit
import Foundation

/// What a licence key says about itself, once it has proved it.
struct License {
  let id: String
  let email: String
  let major: Int
  let issuedAt: String
}

/// The answer, with the reason attached.
///
/// A bare `Bool` would be cheaper and would throw away the only part anyone
/// needs: *why*. The bridge relays this sentence to the MCP host, the menu bar
/// renders it, and a support reply is mostly this sentence — so it is produced
/// once, here, rather than reconstructed at each of the three.
enum LicenseCheck {
  case valid(License)
  case refused(String)

  var license: License? {
    if case .valid(let license) = self { return license }
    return nil
  }
}

/// Offline verification of a licence key.
///
/// The twin of `scripts/lib/license.mjs`, and deliberately a twin rather than a
/// shared library: the app cannot import JavaScript and the Worker cannot import
/// Swift. The two make the same four checks in the same order — format,
/// signature, revocation, version — and `scripts/lib/license.test.mjs` reads the
/// public key out of this file and asserts it matches, because the failure mode
/// of that one constant drifting is every paid key refused at once.
///
/// Nothing here reaches the network, and nothing here may start to.
/// `scripts/audit-network.sh` fails the build on `URLSession`, `getaddrinfo` and
/// the TLS entry points, and docs/licensing.md sells that on the front page.
/// CryptoKit trips none of them; an activation call would trip all of them.
///
/// Nor is any of this a tamper defence. `apps/apple/LICENSE` §1(c) grants
/// compiling, the source is public, and the gate this feeds is a dozen readable
/// lines in `ServerHost.swift` — so removing it is minutes of work for exactly
/// the audience this sells to, and no amount of hardening changes that. §2(b)
/// makes deleting the check a breach rather than a puzzle worth setting; the
/// deterrent is legal and social, never technical. This buys a key that cannot
/// be forged. It does not buy — and must not pretend to buy — a binary that
/// cannot be modified.
enum LicenseKey {
  /// Namespaces the format. A v2 key would carry a different one and be refused
  /// by name here rather than failing somewhere less legible.
  static let prefix = "cup1"

  /// The public half of the signing key: raw 32 bytes, base64url.
  ///
  /// Must equal `PUBLIC_KEY` in `scripts/lib/license.mjs`, which
  /// `scripts/lib/license.test.mjs` asserts by reading this file. Changing it
  /// here alone would refuse every key ever issued; changing it in both places
  /// would refuse every key issued before the change.
  static let publicKey = "_sGLrSm_Sg3bv2p0T8yfzelAvkEjAa2se9l2X4sgNA4"

  static func check(
    _ key: String?,
    major: Int = AppInfo.major,
    revoked: Set<String> = Revocations.ids
  ) -> LicenseCheck {
    guard let key, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return .refused("no licence key")
    }

    let parts = key.trimmingCharacters(in: .whitespacesAndNewlines).split(
      separator: ".", omittingEmptySubsequences: false
    ).map(String.init)
    guard parts.count == 3 else { return .refused("expected three dot-separated parts") }
    guard parts[0] == prefix else { return .refused("unknown key format '\(parts[0])'") }
    guard !parts[1].isEmpty, !parts[2].isEmpty else {
      return .refused("empty payload or signature")
    }

    guard let payload = base64Url(parts[1]), let signature = base64Url(parts[2]) else {
      return .refused("payload or signature is not base64url")
    }
    guard let claims = try? JSONDecoder().decode(Claims.self, from: payload) else {
      return .refused("payload is not a licence")
    }

    guard let verifier = signer else {
      return .refused("this build has no signing key compiled in")
    }
    // Over the ENCODED payload, not the decoded claims: JSON key order and
    // whitespace then never have to agree across two languages.
    guard verifier.isValidSignature(signature, for: Data(parts[1].utf8)) else {
      return .refused("signature does not match")
    }

    // After the signature, never before. A forged id must not be waved through
    // by the simple expedient of not appearing on the list.
    guard !revoked.contains(claims.id) else {
      return .refused("licence \(claims.id) was revoked")
    }
    guard claims.major == major else {
      return .refused("key covers \(claims.major).x, this build is \(major).x")
    }

    return .valid(
      License(id: claims.id, email: claims.email, major: claims.major, issuedAt: claims.issuedAt))
  }

  // MARK: - Internals

  private struct Claims: Decodable {
    let id: String
    let email: String
    let major: Int
    let issuedAt: String
  }

  private static var signer: Curve25519.Signing.PublicKey? {
    guard let raw = base64Url(effectivePublicKey), !raw.isEmpty else { return nil }
    return try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
  }

  private static var effectivePublicKey: String {
    #if DEBUG
      if let dev = developmentPublicKey() { return dev }
    #endif
    return publicKey
  }

  #if DEBUG
    /// The same `dev.json` `ServerLocator` already reads, with one more key:
    ///
    ///     { "node": …, "repo": …, "licensePublicKey": "voEH53_e3s…" }
    ///
    /// A development build has to be able to verify keys signed by a throwaway
    /// keypair, and the alternative — a `#if DEBUG` branch that skips the check
    /// — would mean the gate is never exercised by the builds it is developed
    /// against. This way Debug and Release run identical logic and differ only
    /// in which public key they trust. Compiled out of Release entirely, so it
    /// cannot become a way in.
    private static func developmentPublicKey() -> String? {
      let url = URL(fileURLWithPath: BridgeProtocol.socketDirectory)
        .appendingPathComponent("dev.json")
      guard
        let data = try? Data(contentsOf: url),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
        let key = json["licensePublicKey"], !key.isEmpty
      else { return nil }
      return key
    }
  #endif

  private static func base64Url(_ text: String) -> Data? {
    var padded = text.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while padded.count % 4 != 0 { padded.append("=") }
    return Data(base64Encoded: padded)
  }
}
