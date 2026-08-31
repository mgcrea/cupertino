import Foundation

/// Asserts what `CallCapture` records and — more to the point — what it does
/// not.
///
/// A standalone `swiftc` binary rather than an XCTest bundle, for the reason
/// `wiring-check.swift` gives: the Xcode project has synchronized-group targets
/// and no shared schemes, so a test target means hand-editing project.pbxproj.
/// `CallCapture` is written with no dependency on the rest of the app precisely
/// so it can be compiled here.
///
/// The two things worth holding still, both silent when they go wrong: a mail
/// body reaching the log because a surface was left on its default, and a
/// payload growing without bound in a store that keeps a thousand of them.
///
/// Run with `make unit`.
@main
struct UnitCheck {
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

  /// One capture, shaped as the appex writes it.
  static func write(_ dir: URL, _ name: String, at date: Date) {
    let entry: [String: Any] = [
      "url": "https://example.com/\(name)",
      "title": "t",
      "capturedAt": ISO8601DateFormatter().string(from: date),
      "text": "hello", "html": "<p>hello</p>",
      "textTruncated": false, "htmlTruncated": false,
    ]
    let file = dir.appendingPathComponent(name)
    try? JSONSerialization.data(withJSONObject: entry).write(to: file)
    // Set apart from `capturedAt` on purpose: these two must not be assumed
    // equal, and the tests that rely on the fallback need them to differ.
    try? FileManager.default.setAttributes(
      [.modificationDate: date], ofItemAtPath: file.path)
  }

  static func params(_ args: [String: Any]) -> [String: Any] {
    ["name": "t", "arguments": args]
  }

  static func main() {
    print("Call capture: content is blanked by default")

    // The headline. `send_message` takes "exactly what to send, sent verbatim",
    // and `compose.ts` takes the whole mail body. Recording arguments must not
    // mean recording those.
    let message = CallCapture.arguments(
      params: params(["to": "+15551234", "text": "meet me at eight"]),
      mode: .arguments, content: false)
    check("a message body is blanked", message?.contains("meet me at eight") == false)
    check("and the recipient survives", message?.contains("+15551234") == true)

    let mail = CallCapture.arguments(
      params: params(["mailbox": "INBOX", "subject": "Invoice", "body": "the private part"]),
      mode: .arguments, content: false)
    check("a mail body is blanked", mail?.contains("the private part") == false)
    check("a subject is blanked", mail?.contains("Invoice") == false)
    check("the mailbox survives", mail?.contains("INBOX") == true)

    let search = CallCapture.arguments(
      params: params(["query": "divorce lawyer", "limit": 10]),
      mode: .arguments, content: false)
    check("a search query is blanked", search?.contains("divorce lawyer") == false)
    check("the limit survives", search?.contains("10") == true)

    let nested = CallCapture.arguments(
      params: params(["draft": ["body": "the private part"]]), mode: .arguments, content: false)
    check("content nested in an object is blanked", nested?.contains("the private part") == false)

    let inArray = CallCapture.arguments(
      params: params(["rows": [["text": "the private part"]]]), mode: .arguments, content: false)
    check("content inside an array is blanked", inArray?.contains("the private part") == false)

    print("\nCall capture: content when it is asked for")

    let opted = CallCapture.arguments(
      params: params(["body": "the private part"]), mode: .arguments, content: true)
    check("content is recorded when the surface says so", opted?.contains("the private part") == true)

    // A credential is blanked whichever way the content switch is set: it is
    // not content, and no surface should be able to opt into it.
    for content in [true, false] {
      let secret = CallCapture.arguments(
        params: params(["api_key": "s3cr3t-canary"]), mode: .arguments, content: content)
      check(
        "a credential is blanked with content \(content)",
        secret?.contains("s3cr3t-canary") == false)
    }
    check("Api-Key matches api_key", CallCapture.shouldRedact("Api-Key", content: true))
    check("mailbox is not content", !CallCapture.shouldRedact("mailbox", content: false))

    print("\nCall capture: a second redaction on the way to disk")

    // The regression. The live row may carry content; the file is a separate
    // decision, and the first port of the audit log wired this in the wrong
    // order so a search query reached disk with the switch off.
    let live = #"{"limit":1,"query":"private-canary"}"#
    let onDisk = CallCapture.reredact(live, content: false)
    check("content is blanked again for the file", onDisk?.contains("private-canary") == false)
    check("and the structure survives it", onDisk?.contains("\"limit\":1") == true)
    check(
      "content passes through when the file is allowed it",
      CallCapture.reredact(live, content: true)?.contains("private-canary") == true)
    check("nil stays nil", CallCapture.reredact(nil, content: false) == nil)
    // Something that is not the JSON this wrote has fields that cannot be
    // identified, so none of them are kept.
    check(
      "an unparseable payload is blanked entirely",
      CallCapture.reredact("{not json", content: false) == CallCapture.redacted)
    check(
      "and is passed through only when content is allowed",
      CallCapture.reredact("{not json", content: true) == "{not json")

    print("\nCall capture: what each mode records")

    check(
      "off records no arguments",
      CallCapture.arguments(params: params(["a": 1]), mode: .off, content: true) == nil)
    check(
      "arguments records arguments",
      CallCapture.arguments(params: params(["a": 1]), mode: .arguments, content: true) != nil)
    check(
      "arguments records no result",
      CallCapture.result(["result": ["ok": true]], mode: .arguments, content: true) == nil)
    check(
      "argumentsAndResults records one",
      CallCapture.result(["result": ["ok": true]], mode: .argumentsAndResults, content: true) != nil)

    // A result is answered by the server, so all of it is content — a
    // get_message result IS the mail. With content off the row says a result
    // arrived and nothing about what was in it.
    let blanked = CallCapture.result(
      ["result": ["content": [["text": "the private part"]]]],
      mode: .argumentsAndResults, content: false)
    check("a result is withheld unless content is on", blanked == CallCapture.redacted)
    check(
      "and its text does not leak",
      blanked?.contains("the private part") == false)

    check(
      "an error frame is kept",
      CallCapture.result(["error": ["message": "no"]], mode: .argumentsAndResults, content: true)
        != nil)
    check("an error frame is a failure", CallCapture.isFailure(["error": ["message": "no"]]))
    check("an isError result is a failure", CallCapture.isFailure(["result": ["isError": true]]))
    check("a plain result is not", !CallCapture.isFailure(["result": ["ok": true]]))

    print("\nCall capture: correlating a reply with its call")

    check("a response is one", CallCapture.isResponse(["id": 1, "result": [:] as [String: Any]]))
    check("a request is not", !CallCapture.isResponse(["id": 1, "method": "tools/call"]))
    check("a notification is not", !CallCapture.isResponse(["method": "notifications/initialized"]))
    // Per the spec 1 and "1" are different ids, so the table must not collide
    // them — a reply to one would otherwise attach to the other's row.
    check("a numeric and a string id differ", CallCapture.idKey(1) != CallCapture.idKey("1"))
    check("a missing id has no key", CallCapture.idKey(nil) == nil)

    print("\nCall capture: malformed input")

    check(
      "no params yields nil",
      CallCapture.arguments(params: nil, mode: .arguments, content: true) == nil)
    check(
      "no arguments key yields nil",
      CallCapture.arguments(params: ["name": "t"], mode: .arguments, content: true) == nil)
    check(
      "empty arguments yield nil",
      CallCapture.arguments(params: params([:]), mode: .arguments, content: true) == nil)
    check(
      "no frame yields nil",
      CallCapture.result(nil, mode: .argumentsAndResults, content: true) == nil)
    check(
      "a frame with neither result nor error yields nil",
      CallCapture.result(["jsonrpc": "2.0"], mode: .argumentsAndResults, content: true) == nil)

    print("\nCall capture: the size cap")

    let long = String(repeating: "a", count: 10_000)
    let capped = CallCapture.truncate(long, to: 4096)
    check("truncation bounds the byte count", capped.utf8.count < 4200)
    check("and says how much went", capped.contains("+5904 bytes"))
    check("short text is untouched", CallCapture.truncate("hi", to: 4096) == "hi")

    // A cut landing mid-scalar would produce something that is not a String.
    // é is two UTF-8 bytes, so a cap of 3 must stop after the first one.
    let cut = CallCapture.truncate(String(repeating: "é", count: 100), to: 3)
    check("a cut lands on a character boundary", cut.hasPrefix("é") && !cut.hasPrefix("éé"))

    let big = CallCapture.arguments(
      params: params(["note": long]), mode: .arguments, content: true)
    check("a captured argument is capped", (big?.utf8.count ?? 0) < 4200)

    print("\nFrame splitting: the chunk boundary")

    // The bug this exists to hold still: reads arrive in 64 KiB chunks with no
    // regard for line boundaries, and splitting each chunk on its own dropped
    // every frame that straddled two — invisibly, because the pump still
    // forwarded the bytes. Results are the big frames, so the response
    // direction hits this far more often than the request one.
    var splitter = FrameSplitter()
    check("a chunk with no newline yields nothing", splitter.lines(Data("{\"a\":1".utf8)).isEmpty)
    let completed = splitter.lines(Data("}\n".utf8))
    check("and the line arrives once it is finished", completed.count == 1)
    check(
      "reassembled whole",
      completed.first.map { String(decoding: $0, as: UTF8.self) } == "{\"a\":1}")

    var many = FrameSplitter()
    check("several lines in one chunk all arrive", many.lines(Data("a\nb\nc\n".utf8)).count == 3)
    var partial = FrameSplitter()
    check("a trailing partial line is held back", partial.lines(Data("a\nb".utf8)).count == 1)
    check("and completed by the next chunk", partial.lines(Data("\n".utf8)).count == 1)
    var blanks = FrameSplitter()
    check("empty lines are dropped", blanks.lines(Data("a\n\n\nb\n".utf8)).count == 2)

    // A peer that never sends a newline must not grow the buffer forever.
    var runaway = FrameSplitter(limit: 16)
    _ = runaway.lines(Data(String(repeating: "x", count: 64).utf8))
    check(
      "a runaway line is dropped rather than buffered",
      runaway.lines(Data("y\n".utf8)).first.map { String(decoding: $0, as: UTF8.self) } == "y")

    print("\nSafari captures: what the extension has written")

    // The store this reads is written by the appex and read by the node server,
    // so its shape is a contract between three components. These assert the
    // cases that are silent when they go wrong: a lane that has stopped being
    // written reported as healthy, and one bad file taking down the row.
    let tmp = FileManager.default.temporaryDirectory
      .appendingPathComponent("cupertino-unit-\(UUID().uuidString)")

    // A directory that was never created is the same answer as an empty one:
    // nothing has been captured. The extension makes it on its first write.
    check("a missing directory reads as nothing captured", SafariCaptures.read(directory: tmp) == .none)

    try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    check("and so does an empty one", SafariCaptures.read(directory: tmp) == .none)

    let now = Date()
    write(tmp, "a.json", at: now.addingTimeInterval(-120))
    write(tmp, "b.json", at: now.addingTimeInterval(-600))
    let two = SafariCaptures.read(directory: tmp, now: now)
    check("both captures are counted", two.count == 2)
    // Newest, not first-found and not the most recently touched.
    check("the freshest one sets the age", two.newestAge.map { Int($0) } == 120)
    check("which is not quiet", !two.isQuiet)

    // Nothing recent. The pane says the captures are old and does not guess
    // why, because a directory listing cannot tell "switched off" from
    // "allowed on no site visited since".
    let cold = SafariCaptures.read(directory: tmp, now: now.addingTimeInterval(SafariCaptures.ttl))
    check("past the TTL the lane reads as quiet", cold.isQuiet)

    // Written by an older extension, or torn mid-write. It must not take the
    // row down, and it must not be silently dated to the epoch either — the
    // mtime is the fallback the file itself cannot supply.
    let junk = tmp.appendingPathComponent("c.json")
    try? Data("not json".utf8).write(to: junk)
    try? FileManager.default.setAttributes(
      [.modificationDate: now.addingTimeInterval(-30)], ofItemAtPath: junk.path)
    let withJunk = SafariCaptures.read(directory: tmp, now: now)
    check("an unreadable entry is still counted", withJunk.count == 3)
    check("and falls back to its mtime rather than the epoch", withJunk.newestAge.map { Int($0) } == 30)

    // Only ours. The container holds other things.
    try? Data("{}".utf8).write(to: tmp.appendingPathComponent("notes.txt"))
    check("non-JSON files are ignored", SafariCaptures.read(directory: tmp, now: now).count == 3)

    try? FileManager.default.removeItem(at: tmp)

    // MARK: - The audit chain
    //
    // Everything here is invisible when it goes wrong: a chain that verifies a
    // forged log, or one that cries tamper over a log nobody touched, both look
    // exactly like a chain that works until somebody depends on the answer.

    func record(_ seq: Int, _ text: String, prev: String, args: String? = nil)
      -> AuditChain.Record
    {
      AuditChain.seal(
        AuditChain.Record(
          seq: seq, at: Date(timeIntervalSince1970: 1_756_000_000 + Double(seq)),
          surface: "mail", kind: .call, text: text, args: args, prev: prev))
    }

    /// A sealed run of `count` records, each linked to the one before.
    func chain(_ count: Int, from: String = AuditChain.genesis) -> [AuditChain.Record] {
      var out: [AuditChain.Record] = []
      var prev = from
      for seq in 1...count {
        let sealed = record(seq, "apple_mail_tool_\(seq)", prev: prev)
        out.append(sealed)
        prev = sealed.hash
      }
      return out
    }

    print("\nAudit chain: a sequence nobody touched")

    let clean = chain(5)
    let cleanLines = clean.map { AuditChain.line($0) }
    let cleanReport = AuditChain.verify(lines: cleanLines)
    check("five records verify", cleanReport.isIntact)
    check("and are all counted", cleanReport.records == 5)
    check("the head is the last hash", cleanReport.head == clean[4].hash)
    check("a blank line is skipped, not failed", AuditChain.verify(lines: cleanLines + [""]).isIntact)
    check("an empty log verifies as genesis", AuditChain.verify(lines: []).head == AuditChain.genesis)

    print("\nAudit chain: tampering")

    // An edited field. The record still parses and still links; only its own
    // hash stops matching, which is the whole point of hashing the fields.
    var edited = cleanLines
    edited[2] = edited[2].replacingOccurrences(of: "apple_mail_tool_3", with: "apple_mail_tool_X")
    let editedReport = AuditChain.verify(lines: edited)
    check("an edited field is caught", !editedReport.isIntact)
    check("and is named by its seq", editedReport.failures.contains(.brokenHash(seq: 3)))

    // A deleted middle record. Nothing is edited, so every hash still matches
    // its own body — the break is the LINK, which is the reason `prev` exists.
    var deleted = cleanLines
    deleted.remove(at: 2)
    let deletedReport = AuditChain.verify(lines: deleted)
    check("a deleted middle record is caught", !deletedReport.isIntact)
    check("as a broken link on the record after it", deletedReport.failures.contains(.brokenLink(seq: 4)))
    check("and as a gap in the sequence", deletedReport.failures.contains(.outOfOrder(seq: 4)))

    // Reordering. Hashes still match their bodies; the links do not.
    var swapped = cleanLines
    swapped.swapAt(1, 2)
    check("a reordered pair is caught", !AuditChain.verify(lines: swapped).isIntact)

    // THE ONE A CHAIN CANNOT CATCH, and the reason the manifest carries a
    // count. Lopping off the tail leaves a shorter, perfectly valid chain.
    let truncated = Array(cleanLines.prefix(3))
    let truncatedReport = AuditChain.verify(lines: truncated)
    check("a truncated tail still verifies", truncatedReport.isIntact)
    check("but the count is lower", truncatedReport.records == 3)
    check("and the head has moved back", truncatedReport.head == clean[2].hash)

    check(
      "a corrupt line is reported by line number",
      AuditChain.verify(lines: ["{not json"]).failures == [.unreadable(line: 1)])
    check(
      "a record from a future format is refused rather than hashed",
      AuditChain.verify(lines: [cleanLines[0].replacingOccurrences(of: "\"v\":1", with: "\"v\":9")])
        .failures.contains(.unknownVersion(line: 1, version: 9)))

    print("\nAudit chain: segments")

    // Retention prunes whole segments, so a segment must link to the one
    // before it. Verified against the right head it is intact; against genesis
    // it is a broken link on its first record, which is what stops a dropped
    // segment from passing as a complete log.
    let second = chain(3, from: clean[4].hash).map { AuditChain.line($0) }
    check("a segment verifies from the previous head", AuditChain.verify(lines: second, from: clean[4].hash).isIntact)
    check(
      "and fails from genesis",
      AuditChain.verify(lines: second).failures.contains(.brokenLink(seq: 1)))

    print("\nAudit chain: the canonical form")

    // The hash is taken over bytes a verifier must be able to rebuild. These
    // are the inputs most likely to make two implementations disagree.
    let quoted = record(1, "tool", prev: AuditChain.genesis, args: #"{"q":"he said \"hi\""}"#)
    check("quotes survive a round trip", AuditChain.verify(lines: [AuditChain.line(quoted)]).isIntact)
    let newline = record(1, "tool", prev: AuditChain.genesis, args: "line1\nline2\ttab")
    check("newlines and tabs do", AuditChain.verify(lines: [AuditChain.line(newline)]).isIntact)
    let unicode = record(1, "tool", prev: AuditChain.genesis, args: #"{"note":"café 🔒 日本"}"#)
    check("multibyte text does", AuditChain.verify(lines: [AuditChain.line(unicode)]).isIntact)
    let control = record(1, "tool", prev: AuditChain.genesis, args: "bell\u{07}null-ish\u{01}")
    check("control characters do", AuditChain.verify(lines: [AuditChain.line(control)]).isIntact)

    // Sealing twice must not change anything, or a record re-read and re-sealed
    // would look edited.
    check("sealing is deterministic", AuditChain.seal(quoted).hash == quoted.hash)
    // And an omitted optional must not be written as null: a writer and a
    // verifier that disagree about that produce different bytes.
    check(
      "an absent argument is omitted, not nulled",
      !AuditChain.canonical(record(1, "t", prev: AuditChain.genesis)).contains("args"))

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}
