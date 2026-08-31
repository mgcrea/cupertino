import CryptoKit
import Foundation

/// The tamper-evident half of the audit log.
///
/// The same file as Bastion's, adapted: `surface` where that one says `origin`,
/// and its own genesis constant so a Cupertino segment cannot be verified as a
/// Bastion one. Copied rather than shared because the two apps have no package
/// in common and Xcode's synchronized groups make one awkward to add — the same
/// reason `BridgeProtocol.swift` is duplicated between this app and its bridge,
/// with a comment saying so.
///
/// Pure: no store, no file, no main actor, no settings. `AuditLog` owns the
/// file and calls in here for every byte it writes, which is what lets
/// `make unit` compile this against `scripts/unit-check.swift` and assert the
/// chain properties without an app — the same shape `license-check.swift`
/// already uses for the licence verifier.
///
/// ## Events, not calls
///
/// A record is an EVENT. One tool call produces a `call` event and, if it is
/// answered and the profile records results, a later `result` event carrying
/// the first one's `seq` in `ref`.
///
/// That split is forced and it is also correct. `LogStore.attachResult` fills a
/// result in after the row exists — the reply arrives on another thread, later
/// — so a record hashed at append time cannot contain it, and a record hashed
/// after the reply would have to be rewritten. Rewriting is the one thing an
/// append-only chain must never do. Two events cost a few bytes and buy back
/// something worth having: a call that was never answered stays visible as a
/// call with no result, which is a fact an audit log should keep rather than
/// lose.
///
/// ## What the chain is worth, and what it is not
///
/// Each record carries `prev`, the hash of the record before it. Recomputing
/// the sequence detects an edited field, a deleted record in the middle, and a
/// truncated tail. That is real, and it is the whole claim.
///
/// It is **not** proof against whoever controls this Mac. Nothing is signed —
/// there is no per-device key, deliberately — so anyone who can write the file
/// can recompute the whole chain and produce a consistent forgery. The chain
/// detects tampering by something that does not know it is a chain, and
/// corruption by something that was not trying at all. Claiming more than that
/// would be the kind of unfalsifiable security sentence this project has gone
/// out of its way not to ship.
enum AuditChain {
  /// The format, in the file, on every record.
  ///
  /// A version field rather than the additive-optional convention `profiles.json`
  /// uses. That convention is right for configuration the app rewrites, and
  /// wrong here: these bytes must still verify years after the code that wrote
  /// them changed, and a verifier has to be able to say "I do not know this
  /// format" instead of silently hashing a record it half-understood.
  static let version = 1

  /// What a record before the first one hashes to.
  ///
  /// A constant rather than an empty string so a file that begins with a
  /// truncated record cannot be mistaken for a file that begins at genesis.
  static let genesis = "cupertino-audit-v1-genesis"

  enum Kind: String, Codable {
    case call, result, info, error
  }

  /// One line of the file.
  ///
  /// Field names are short because every record carries them. Optional fields
  /// are omitted rather than written null, and `canonical` depends on that —
  /// a verifier and a writer that disagree about whether to emit a null produce
  /// different bytes and therefore different hashes.
  struct Record {
    var seq: Int
    var at: Date
    var surface: String
    var kind: Kind
    var text: String
    var args: String?
    var result: String?
    var failed: Bool?
    /// For a `result` event, the `seq` of the call it answers.
    var ref: Int?
    var prev: String
    var hash: String = ""
  }

  /// Dates as RFC 3339 with milliseconds, in UTC, always.
  ///
  /// Fixed locale and fixed zone: a formatter that follows the user's calendar
  /// would write records that verify on the Mac that made them and nowhere
  /// else.
  static let clock: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter
  }()

  /// The bytes a record's hash is taken over.
  ///
  /// Hand-built rather than `JSONEncoder`, and that is deliberate. The hash has
  /// to be reproducible by a verifier that may be a different Swift version, a
  /// script, or another language entirely — so the field order is written down
  /// here once, in one place, instead of inherited from whatever
  /// `.sortedKeys` happened to do. `hash` is excluded, because it is the
  /// output.
  static func canonical(_ record: Record) -> String {
    var parts: [String] = [
      "\"v\":\(version)",
      "\"seq\":\(record.seq)",
      "\"at\":\(quote(clock.string(from: record.at)))",
      "\"surface\":\(quote(record.surface))",
      "\"kind\":\(quote(record.kind.rawValue))",
      "\"text\":\(quote(record.text))",
    ]
    if let args = record.args { parts.append("\"args\":\(quote(args))") }
    if let result = record.result { parts.append("\"result\":\(quote(result))") }
    if let failed = record.failed { parts.append("\"failed\":\(failed)") }
    if let ref = record.ref { parts.append("\"ref\":\(ref)") }
    parts.append("\"prev\":\(quote(record.prev))")
    return "{" + parts.joined(separator: ",") + "}"
  }

  /// A JSON string literal.
  ///
  /// Written here rather than borrowed from `JSONSerialization`, which escapes
  /// forward slashes and non-ASCII inconsistently across platforms — a
  /// difference that shows up as a hash mismatch on somebody else's machine and
  /// nowhere on yours.
  static func quote(_ s: String) -> String {
    var out = "\""
    for scalar in s.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    return out + "\""
  }

  static func digest(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Seal a record: compute its hash from its own fields and `prev`.
  static func seal(_ record: Record) -> Record {
    var sealed = record
    sealed.hash = digest(canonical(record))
    return sealed
  }

  /// The line written to the file — the canonical bytes with the hash added.
  ///
  /// The hash goes last and outside `canonical`, so a reader can strip it,
  /// re-derive the canonical form, and compare without reordering anything.
  static func line(_ record: Record) -> String {
    let sealed = record.hash.isEmpty ? seal(record) : record
    let body = canonical(sealed)
    return String(body.dropLast()) + ",\"hash\":\(quote(sealed.hash))}"
  }

  // MARK: - Verifying

  enum Failure: Equatable {
    case unreadable(line: Int)
    case unknownVersion(line: Int, version: Int)
    case brokenHash(seq: Int)
    case brokenLink(seq: Int)
    case outOfOrder(seq: Int)
  }

  struct Report: Equatable {
    var records = 0
    var failures: [Failure] = []
    /// The hash of the last record, which is what the next segment links to.
    var head = genesis
    var isIntact: Bool { failures.isEmpty }
  }

  /// Recompute a sequence and report where, if anywhere, it stops adding up.
  ///
  /// `from` is what the first record's `prev` must be: `genesis` for the first
  /// segment, the previous segment's head otherwise. Passing the wrong one is
  /// reported as a broken link on the first record rather than silently
  /// accepted, which is the point of carrying the head across segments at all.
  static func verify(lines: [String], from: String = genesis) -> Report {
    var report = Report(head: from)
    var previous = from
    var lastSeq: Int?

    for (index, raw) in lines.enumerated() {
      let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { continue }
      guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
        let row = object as? [String: Any],
        let seq = row["seq"] as? Int,
        let hash = row["hash"] as? String,
        let prev = row["prev"] as? String
      else {
        report.failures.append(.unreadable(line: index + 1))
        continue
      }
      let found = row["v"] as? Int ?? 0
      guard found == version else {
        report.failures.append(.unknownVersion(line: index + 1, version: found))
        continue
      }

      report.records += 1
      // Strip the hash and re-derive the bytes it was taken over. Split on the
      // marker rather than re-encoding the parsed object: a record whose
      // canonical form this build cannot reproduce is exactly the record a
      // verifier must not silently rewrite.
      guard let cut = text.range(of: ",\"hash\":", options: .backwards) else {
        report.failures.append(.unreadable(line: index + 1))
        continue
      }
      let body = String(text[text.startIndex..<cut.lowerBound]) + "}"
      if digest(body) != hash { report.failures.append(.brokenHash(seq: seq)) }
      if prev != previous { report.failures.append(.brokenLink(seq: seq)) }
      if let last = lastSeq, seq != last + 1 { report.failures.append(.outOfOrder(seq: seq)) }

      previous = hash
      lastSeq = seq
      report.head = hash
    }
    return report
  }
}
