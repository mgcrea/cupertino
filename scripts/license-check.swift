import CryptoKit
import Foundation

/// Runs the app's licence check against keys shaped the way people paste them.
///
/// `scripts/lib/license.test.mjs` covers the Node twin end to end, with a
/// keypair it makes up. This side cannot do that: the public key is compiled
/// in, and the private half lives on the Worker and nowhere near CI. So the
/// keys here are signed by a throwaway keypair and every one is refused — what
/// is asserted is WHICH sentence refuses it. A key that reaches "signature does
/// not match" got through the format and the base64url decode, which is the
/// whole of what a mail client's line breaks used to break.
///
/// A standalone `swiftc` binary rather than an XCTest bundle, for the reason
/// `wiring-check.swift` gives: the Xcode project has no test target.
///
/// Run with `make license-check`.

/// Stands in for `AppInfo`, which `LicenseKey.check` reads for its default
/// major and which would drag in `DemoSeed`, ServiceManagement and the host log
/// behind it. Every call below passes `major:` anyway.
enum AppInfo {
  static let major = 1
}

@main
struct LicenseCheckRun {
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

  static func reason(_ result: LicenseCheck) -> String {
    switch result {
    case .valid: return "(valid)"
    case .refused(let why): return why
    }
  }

  static func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// A key in the real format, signed by a key the app does not trust.
  static func foreignKey() -> String {
    let claims =
      #"{"id":"01M0K3QSKCDHPXF14CMNJS0ZZZ","email":"buyer@example.com","major":1,"#
      + #""issuedAt":"2026-10-03T00:00:00.000Z"}"#
    let payload = base64Url(Data(claims.utf8))
    let signature = try! Curve25519.Signing.PrivateKey().signature(for: Data(payload.utf8))
    return "\(LicenseKey.prefix).\(payload).\(base64Url(signature))"
  }

  /// Hard-wrapped the way a mail client does it: CRLF and a leading space.
  static func wrapped(_ key: String, every width: Int = 76) -> String {
    var lines: [String] = []
    var rest = Substring(key)
    while !rest.isEmpty {
      lines.append(String(rest.prefix(width)))
      rest = rest.dropFirst(width)
    }
    return lines.joined(separator: "\r\n ")
  }

  static func main() {
    let key = foreignKey()
    let refused = "signature does not match"

    print("A pasted key: whitespace is never part of it")
    check(
      "a clean key reaches the signature check",
      reason(LicenseKey.check(key, major: 1, revoked: [])) == refused)
    check(
      "so does one with whitespace around it",
      reason(LicenseKey.check("\n  \(key)  \n", major: 1, revoked: [])) == refused)
    // The case that used to stop at "payload or signature is not base64url":
    // `Data(base64Encoded:)` refuses a line break in the middle.
    check(
      "so does one a mail client wrapped across lines",
      reason(LicenseKey.check(wrapped(key), major: 1, revoked: [])) == refused)
    check(
      "and one wrapped with bare newlines and tabs",
      reason(
        LicenseKey.check(
          wrapped(key, every: 40).replacingOccurrences(of: "\r\n ", with: "\n\t"),
          major: 1, revoked: [])) == refused)
    check(
      "whitespace alone is no key at all",
      reason(LicenseKey.check(" \r\n\t ", major: 1, revoked: [])) == "no licence key")

    print("\(checks - failures)/\(checks) checks passed")
    if failures > 0 { exit(1) }
  }
}
