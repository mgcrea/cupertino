import Foundation

/// Asserts that a write the audit log cannot make leaves the chain INTACT.
///
/// The failure this exists for is quiet and reads as its opposite. `AuditLog`
/// seals every record on the main actor and hands the bytes to a queue; the
/// queue used to swallow every error with `try?`. So on a full disk, an
/// immutable file or a permissions change, `seq` and `head` marched on while the
/// file did not, the next record that DID land pointed at a hash the file never
/// received, and `verifyAll` — correctly — reported a broken chain. A full disk
/// read exactly like a forger.
///
/// Now the writer appends only a record that links to what is on disk, the main
/// actor is rewound to match, and the file carries a notice saying how much it
/// is missing. This drives that: three records, then a file made immutable, two
/// more that cannot land, the file released, one more that can — and the chain
/// has to verify from genesis with the loss on the record.
///
/// Run with `make audit-log-check`. The scratch directory comes from the
/// `BridgeProtocol` stub below rather than from the environment, for the reason
/// recorded there.
///
/// A standalone `swiftc` binary rather than an XCTest bundle, for the reason
/// `unit-check.swift` gives: the Xcode project has no test target.

/// Stands in for `BridgeProtocol`, and it is the reason this check can run at
/// all without touching the real log.
///
/// `AuditLog.directory` is built from `AppSupport.directory`, which is built
/// from `BridgeProtocol.socketDirectory`, which is built from
/// `FileManager.homeDirectoryForCurrentUser` — and that ignores `$HOME`
/// entirely. MEASURED: with HOME pointed at a temp directory it still returns
/// the real one. So an earlier version of this file, which set `HOME` and then
/// checked that `HOME` looked like a temp path, was asserting something true
/// about a variable nothing downstream reads, while writing to — and calling
/// `clear()` on — the audit log of whoever ran it. A check that verifies the
/// wrong thing is worse than no check.
///
/// Stubbing the one type that decides the path is the whole fix, and it follows
/// the pattern this file already uses for `KeyStore` and `DemoSeed`. `main`
/// then asserts the REAL directory, not a proxy for it.
enum BridgeProtocol {
  nonisolated(unsafe) static var socketDirectory = NSTemporaryDirectory()
}

/// Stands in for `KeyStore`, as `audit-check.swift` does — `AuditSigning`
/// reaches for it and nothing here signs anything.
enum KeyStore {
  nonisolated(unsafe) static var items: [String: String] = [:]
  static func read(_ account: String) throws -> String? { items[account] }
  static func write(_ account: String, value: String) throws { items[account] = value }
  static func delete(_ account: String) throws { items[account] = nil }
  static func exists(_ account: String) -> Bool { items[account] != nil }
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in
/// behind it. The log only ever asks it for a version string, in the export.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}

@main
struct AuditLogCheck {
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

  @MainActor static func record(_ text: String) {
    AuditLog.shared.record(
      LogStore.Entry(at: Date(), surface: "mail", level: .call, text: text, arguments: nil))
  }

  /// Let the hops the writer queued for the main actor run.
  @MainActor static func settle() async {
    AuditLog.shared.flush()
    for _ in 0..<20 { await Task.yield() }
    try? await Task.sleep(for: .milliseconds(50))
    AuditLog.shared.flush()
  }

  @MainActor static func main() async {
    print("\naudit log: a write that fails leaves the chain intact\n")

    // A scratch directory of our own, and the assertion is against the path the
    // log will actually use rather than against an environment variable it does
    // not read.
    let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("cupertino-audit-log-check-\(getpid())", isDirectory: true)
    BridgeProtocol.socketDirectory = scratch.path
    defer { try? FileManager.default.removeItem(at: scratch) }

    let directory = AuditLog.directory.path
    guard directory.hasPrefix(scratch.path) else {
      print("  FAIL the log would write to \(directory), which is not the scratch directory")
      exit(1)
    }
    check(
      "the log writes inside a scratch directory, not the real one",
      directory.hasPrefix(scratch.path))

    // The registration domain is volatile, so switching the log on here writes
    // no preference anywhere.
    UserDefaults.standard.register(defaults: [AuditLog.enabledKey: true])
    AuditLog.shared.clear()

    for n in 1...3 { record("apple_mail_get_message \(n)") }
    await settle()
    var summary = AuditLog.verifyAll()
    check("three records land and verify", summary.records == 3 && summary.report.isIntact)

    // Make the segment immutable. `chflags uchg` is what a person would do to
    // reproduce this; a full disk and a permissions change fail the same call.
    let segment = AuditLog.segments().last
    check("the segment file exists", segment != nil)
    guard let segment else { exit(1) }
    check(
      "the segment is 0600",
      (try? FileManager.default.attributesOfItem(atPath: segment.path)[.posixPermissions] as? Int)
        == 0o600)
    check("the segment can be locked", chflags(segment.path, UInt32(UF_IMMUTABLE)) == 0)
    AuditLog.shared.releaseSegment()
    let sealedBytes = AuditLog.size(of: segment)

    record("apple_mail_get_message 4")
    record("apple_mail_get_message 5")
    await settle()

    check(
      "nothing reaches a file that cannot be written", AuditLog.size(of: segment) == sealedBytes)
    summary = AuditLog.verifyAll()
    check("the three records on disk still verify", summary.records == 3 && summary.report.isIntact)

    check("the segment can be released", chflags(segment.path, 0) == 0)
    record("apple_mail_get_message 6")
    await settle()

    summary = AuditLog.verifyAll()
    // Three that landed, one that landed after, and the notice the writer files
    // when the disk comes back. The two lost calls, and the notice the FIRST
    // failure tried to file, are exactly what the resumed notice counts.
    check("the chain verifies from genesis after the outage", summary.report.isIntact)
    check("the file holds the survivors and the notice, nothing else", summary.records == 5)

    let text = (try? String(contentsOf: segment, encoding: .utf8)) ?? ""
    let lines = text.split(separator: "\n").map(String.init)
    check(
      "the notice names how many records were lost",
      lines.last?.contains("3 record(s) were not written") == true)
    check(
      "the notice comes from the log itself", lines.last?.contains("\"surface\":\"audit\"") == true)
    check(
      "the lost calls are not in the file",
      !text.contains("get_message 4") && !text.contains("get_message 5"))
    check("the call after the outage is", text.contains("get_message 6"))

    // Sequence numbers are contiguous — the rewind reused the numbers of the
    // records that never landed, rather than leaving a hole that reads as a
    // truncation.
    let seqs = lines.compactMap { line -> Int? in
      guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
      else { return nil }
      return object["seq"] as? Int
    }
    check("sequence numbers are contiguous", seqs == Array(1...5))

    // And the log keeps working: a second streak gets its own notice.
    check("the segment can be locked again", chflags(segment.path, UInt32(UF_IMMUTABLE)) == 0)
    AuditLog.shared.releaseSegment()
    record("apple_mail_get_message 7")
    await settle()
    check("the segment can be released again", chflags(segment.path, 0) == 0)
    record("apple_mail_get_message 8")
    await settle()
    summary = AuditLog.verifyAll()
    check(
      "a second outage is accounted for the same way",
      summary.report.isIntact && summary.records == 7)

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}
