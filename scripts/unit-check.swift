import CryptoKit
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
    check(
      "content is recorded when the surface says so", opted?.contains("the private part") == true)

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
      CallCapture.result(["result": ["ok": true]], mode: .argumentsAndResults, content: true) != nil
    )

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

    print("\nCall capture: subscriptions and pushed updates")

    check(
      "subscriptions/listen is a subscription", CallCapture.isSubscription("subscriptions/listen"))
    check(
      "resources/subscribe is a subscription", CallCapture.isSubscription("resources/subscribe"))
    check("resources/read is not", !CallCapture.isSubscription("resources/read"))
    check(
      "a 2026 listen names its uris",
      CallCapture.subscribedUris([
        "notifications": ["resourceSubscriptions": ["mail://a", "mail://b"]]
      ]) == ["mail://a", "mail://b"])
    check(
      "a 2025 subscribe names its uri",
      CallCapture.subscribedUris(["uri": "messages://x"]) == ["messages://x"])
    check(
      "a listen for tool changes only names no uri",
      CallCapture.subscribedUris(["notifications": ["toolsListChanged": true]]).isEmpty)
    check("no params names no uri", CallCapture.subscribedUris(nil).isEmpty)
    check(
      "an updated notification yields its uri",
      CallCapture.pushedUri([
        "method": "notifications/resources/updated", "params": ["uri": "mail://a"],
      ]) == "mail://a")
    check(
      "a response is not a push",
      CallCapture.pushedUri(["id": 1, "result": ["uri": "mail://a"]]) == nil)
    check(
      "a progress notification is not a push",
      CallCapture.pushedUri([
        "method": "notifications/progress", "params": ["uri": "mail://a"],
      ]) == nil)
    check(
      "an updated notification without a uri is not a push",
      CallCapture.pushedUri([
        "method": "notifications/resources/updated", "params": [:] as [String: Any],
      ]) == nil)

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

    print("\nLazy tools: the log still names the real tool")

    // The claim on screen is that Activity records which capability was
    // reached. Under APPLE_<SURFACE>_LAZY_TOOLS the wire says
    // `apple_mail_call_write_tool` and the real name sits one level down, so
    // without unwrapping every write on a lazy surface logs as the same row.
    let dispatch: [String: Any] = [
      "name": "apple_mail_call_write_tool",
      "arguments": [
        "name": "apple_mail_send_message",
        "arguments": ["to": "+15551234", "text": "meet me at eight"],
      ],
    ]
    let unwrapped = CallCapture.unwrapFacade(
      name: "apple_mail_call_write_tool", params: dispatch)
    check("a dispatch resolves to the real tool", unwrapped?.name == "apple_mail_send_message")

    let dispatched = CallCapture.arguments(
      params: unwrapped?.params, mode: .arguments, content: false)
    check("the real arguments are what get recorded", dispatched?.contains("+15551234") == true)
    check("and content is blanked as usual", dispatched?.contains("meet me at eight") == false)
    check(
      "the dispatcher's own wrapper is not recorded",
      dispatched?.contains("apple_mail_send_message") == false)

    check(
      "the read dispatcher unwraps too",
      CallCapture.unwrapFacade(
        name: "apple_mail_call_tool",
        params: ["name": "apple_mail_call_tool", "arguments": ["name": "apple_mail_list_messages"]]
      )?.name == "apple_mail_list_messages")

    // The trap. `create_mailbox` takes an argument called `name`, so a rule
    // that recognised a dispatch by "the arguments carry a name" would read
    // this as a dispatch to a tool called Archive and log that instead.
    check(
      "an ordinary call with a name argument is left alone",
      CallCapture.unwrapFacade(
        name: "apple_mail_create_mailbox",
        params: params(["name": "Archive"])) == nil)
    check(
      "a dispatcher with nothing nested is left alone",
      CallCapture.unwrapFacade(
        name: "apple_mail_call_tool", params: ["name": "apple_mail_call_tool"]) == nil)

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
      runaway.lines(Data("y\n".utf8)).isEmpty)
    // The newline ends the runaway frame, so it is the tail of one, not a frame.
    check(
      "and the frame after it is read whole",
      runaway.lines(Data("z\n".utf8)).first.map { String(decoding: $0, as: UTF8.self) } == "z")

    // `RequestObserver` collects responses only while a notice is held, and
    // skips the chunks in between. Skipping by not calling at all left a partial
    // frame behind, so the first collected chunk was glued onto a stale head and
    // the reply that should have released the notice never parsed.
    func text(_ lines: [Data]) -> [String] { lines.map { String(decoding: $0, as: UTF8.self) } }
    var straddled = FrameSplitter()
    _ = straddled.lines(Data("{\"id\":1,".utf8))
    straddled.skip(Data("\"result\":{}}\n{\"id\":2,".utf8))
    check(
      "a frame begun in a skipped chunk is collected whole",
      text(straddled.lines(Data("\"result\":{}}\n".utf8))) == ["{\"id\":2,\"result\":{}}"])
    var midFrame = FrameSplitter()
    _ = midFrame.lines(Data("{\"id\":1,".utf8))
    midFrame.skip(Data("\"result\":\"still going".utf8))
    check(
      "the tail of a skipped frame is not taken for a frame",
      text(midFrame.lines(Data("\"}\n{\"id\":3}\n".utf8))) == ["{\"id\":3}"])
    var aligned = FrameSplitter()
    aligned.skip(Data("{\"id\":1}\n".utf8))
    check(
      "a skip that ends on a boundary leaves nothing behind",
      text(aligned.lines(Data("{\"id\":4}\n".utf8))) == ["{\"id\":4}"])

    print("\nPushes: found across read boundaries, and skipping resumes")

    // Drives the scanner and the splitter exactly as `RequestObserver.answered`
    // does, and reports which uris were pushed and how many chunks were skipped.
    func drive(_ chunks: [String], parsing: Bool = false) -> (pushed: [String], skipped: Int) {
      var scanner = PushScanner()
      var splitter = FrameSplitter()
      var pushed: [String] = []
      var skipped = 0
      for piece in chunks {
        let chunk = Data(piece.utf8)
        guard scanner.needsSplit(chunk, parsing: parsing) else {
          splitter.skip(chunk)
          skipped += 1
          continue
        }
        for line in splitter.lines(chunk) {
          guard line.range(of: CallCapture.pushMarker) != nil,
            let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let uri = CallCapture.pushedUri(object)
          else { continue }
          pushed.append(uri)
        }
      }
      return (pushed, skipped)
    }
    func push(_ uri: String) -> String {
      "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/resources/updated\",\"params\":{\"uri\":\"\(uri)\"}}\n"
    }
    let pushFrame = push("mail://a")
    let markerCut = pushFrame.index(pushFrame.startIndex, offsetBy: 40)  // inside the method name

    check(
      "a marker split by a read is found in skip mode",
      drive(["{\"id\":1}\n" + String(pushFrame[..<markerCut]), String(pushFrame[markerCut...])])
        .pushed == ["mail://a"])
    check(
      "a marker split by a read is found in parsing mode",
      drive([String(pushFrame[..<markerCut]), String(pushFrame[markerCut...])], parsing: true)
        .pushed == ["mail://a"])
    check(
      "a marker split with no earlier newline is found",
      drive([String(pushFrame[..<markerCut]), String(pushFrame[markerCut...])]).pushed == [
        "mail://a"
      ])
    check(
      "a push frame split after its marker is found",
      drive([String(pushFrame.dropLast(12)), String(pushFrame.suffix(12))]).pushed == ["mail://a"])
    check(
      "a head of one byte at a time is found",
      drive(pushFrame.map { String($0) }).pushed == ["mail://a"])
    check(
      "two pushes in one chunk are both found",
      drive([push("mail://a") + push("mail://b")]).pushed == ["mail://a", "mail://b"])

    let bulk = "{\"id\":9,\"result\":\"" + String(repeating: "x", count: 5000)
    let after = drive([
      push("mail://a") + bulk, String(repeating: "y", count: 3000),
      String(repeating: "z", count: 3000), "\"}\n", "{\"id\":10}\n",
    ])
    check("a push then a large frame start is found", after.pushed == ["mail://a"])
    check("and the chunks after it are skipped again", after.skipped == 4)

    let plain = drive((0..<20).map { "{\"id\":\($0),\"result\":{}}\n" } + ["{\"id\":99,\"res"])
    check("a marker-free stream never leaves skip", plain.skipped == 21 && plain.pushed.isEmpty)

    var open = PushScanner()
    _ = open.needsSplit(
      Data("{\"method\":\"notifications/resources/updated\",".utf8), parsing: false)
    check("a frame open after a marker is collecting", open.collecting)
    _ = open.needsSplit(Data("\"params\":{}}\n{\"id\":1".utf8), parsing: false)
    check("and stops collecting once it closes", !open.collecting)

    var quiet = PushScanner()
    let longChunk = Data((String(repeating: "x", count: 70_000) + "{\"id\":1}").utf8)
    check("a long marker-free chunk does not split", !quiet.needsSplit(longChunk, parsing: false))
    check(
      "and leaves the carry as its last marker.count - 1 bytes",
      quiet.carry == Data(longChunk.suffix(CallCapture.pushMarker.count - 1)))
    _ = quiet.needsSplit(Data("ab".utf8), parsing: false)
    check(
      "a short chunk extends the carry rather than replacing it",
      quiet.carry == Data((longChunk + Data("ab".utf8)).suffix(CallCapture.pushMarker.count - 1)))

    var head = FrameSplitter()
    head.skip(Data("{\"method\":\"notifications/res".utf8))
    check(
      "a small read holding only a frame head is kept, not discarded",
      text(head.lines(Data("ources/updated\"}\n".utf8))) == [
        "{\"method\":\"notifications/resources/updated\"}"
      ])

    print("\nSafari captures: what the extension has written")

    // The store this reads is written by the appex and read by the node server,
    // so its shape is a contract between three components. These assert the
    // cases that are silent when they go wrong: a lane that has stopped being
    // written reported as healthy, and one bad file taking down the row.
    let tmp = FileManager.default.temporaryDirectory
      .appendingPathComponent("cupertino-unit-\(UUID().uuidString)")

    // A directory that was never created is the same answer as an empty one:
    // nothing has been captured. The extension makes it on its first write.
    check(
      "a missing directory reads as nothing captured", SafariCaptures.read(directory: tmp) == .none)

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
    check(
      "and falls back to its mtime rather than the epoch", withJunk.newestAge.map { Int($0) } == 30)

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
    check(
      "a blank line is skipped, not failed", AuditChain.verify(lines: cleanLines + [""]).isIntact)
    check(
      "an empty log verifies as genesis", AuditChain.verify(lines: []).head == AuditChain.genesis)

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
    check(
      "as a broken link on the record after it",
      deletedReport.failures.contains(.brokenLink(seq: 4)))
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
    let secondRecords = chain(3, from: clean[4].hash)
    let second = secondRecords.map { AuditChain.line($0) }
    check(
      "a segment verifies from the previous head",
      AuditChain.verify(lines: second, from: clean[4].hash).isIntact)
    check(
      "verified against the wrong head, it is a broken link on its first record",
      AuditChain.verify(lines: second).failures.contains(.brokenLink(seq: 1)))

    // The contract the header promises: dropping the oldest segment is a
    // DECLARED truncation — "intact from segment 4" — not corruption. Held to
    // genesis, the first surviving record is always a broken link, so for years
    // a pruned log read as tampered with.
    let whole = AuditChain.verify(segments: [
      AuditChain.Segment(number: 1, lines: cleanLines),
      AuditChain.Segment(number: 2, lines: second),
    ])
    check("a whole log verifies from genesis", whole.isIntact)
    check("and says so", whole.startsAtSegment == 1)
    check("counting every record across the segments", whole.records == 8)
    check("and ending on the last record's hash", whole.head == secondRecords[2].hash)

    let pruned = AuditChain.verify(segments: [AuditChain.Segment(number: 2, lines: second)])
    check("after retention drops segment 1, the survivor is intact", pruned.isIntact)
    check("and declares where the guarantee begins", pruned.startsAtSegment == 2)
    check("counting only what survives", pruned.records == 3)
    check(
      "the seed is the survivor's own opening link",
      AuditChain.openingLink(of: second) == clean[4].hash)

    // Two things the seeding must NOT swallow.
    check(
      "a file numbered 1 is still held to genesis",
      AuditChain.verify(segments: [AuditChain.Segment(number: 1, lines: second)])
        .failures.contains(.brokenLink(seq: 1)))
    let third = chain(2, from: secondRecords[2].hash).map { AuditChain.line($0) }
    let gapped = AuditChain.verify(segments: [
      AuditChain.Segment(number: 1, lines: cleanLines),
      AuditChain.Segment(number: 3, lines: third),
    ])
    check("a segment missing from the MIDDLE is still a break", !gapped.isIntact)
    check("and is not excused as a truncation", gapped.startsAtSegment == 1)

    print("\nAudit chain: the export manifest")

    // These bytes are what a signature is taken over, so a change to them is a
    // change to what "signed" means. The export path is otherwise reachable
    // only through a save panel, which no check can click.
    let described = [
      AuditChain.SegmentEntry(name: "audit-0001.jsonl", records: 5, sha256: "aa"),
      AuditChain.SegmentEntry(name: "audit-0002.jsonl", records: 3, sha256: "bb"),
    ]
    let card = AuditChain.manifest(
      app: "Cupertino 1.0.0", exportedAt: Date(timeIntervalSince1970: 1_756_000_000),
      records: 8, segments: described, head: "c17b", intact: true)

    check(
      "the manifest parses as JSON",
      (try? JSONSerialization.jsonObject(with: Data(card.utf8))) != nil)
    let decoded =
      (try? JSONSerialization.jsonObject(with: Data(card.utf8))) as? [String: Any] ?? [:]
    check("it names the format", decoded["format"] as? String == "cupertino-audit")
    check("and the version", decoded["version"] as? Int == AuditChain.version)
    // The count is the only thing that makes a truncated export visible, since
    // a shortened chain still verifies.
    check("it carries the record count", decoded["records"] as? Int == 8)
    check("and the chain head", decoded["head"] as? String == "c17b")
    check("and every segment", (decoded["segments"] as? [Any])?.count == 2)
    // Without this a reader cannot tell a whole log from a pruned one: both
    // say "intact":true.
    check("it declares where the chain starts", decoded["startsAtSegment"] as? Int == 1)
    check(
      "and says so when retention has cut into it",
      AuditChain.manifest(
        app: "Cupertino 1.0.0", exportedAt: Date(timeIntervalSince1970: 1_756_000_000),
        records: 8, segments: described, head: "c17b", intact: true, startsAtSegment: 4
      ).contains("\"startsAtSegment\":4"))
    check("with each segment's digest", card.contains("\"sha256\":\"aa\""))
    // Pinned to the exact instant, not just the shape: a formatter that
    // followed the machine's calendar or zone would write a manifest that
    // verifies where it was made and nowhere else, and a loose check would
    // never notice.
    check("the timestamp is that instant in UTC", card.contains("2025-08-24T01:46:40.000Z"))

    // Deterministic for fixed inputs, or a signature could not be checked twice.
    let again = AuditChain.manifest(
      app: "Cupertino 1.0.0", exportedAt: Date(timeIntervalSince1970: 1_756_000_000),
      records: 8, segments: described, head: "c17b", intact: true)
    check("building it twice gives the same bytes", again == card)
    check(
      "and a different head gives different bytes",
      AuditChain.manifest(
        app: "Cupertino 1.0.0", exportedAt: Date(timeIntervalSince1970: 1_756_000_000),
        records: 8, segments: described, head: "dead", intact: true) != card)
    check(
      "a failed verification is recorded rather than hidden",
      AuditChain.manifest(
        app: "Cupertino 1.0.0", exportedAt: Date(timeIntervalSince1970: 1_756_000_000),
        records: 8, segments: described, head: "c17b", intact: false
      ).contains("\"intact\":false"))

    print("\nAudit chain: the canonical form")

    // The hash is taken over bytes a verifier must be able to rebuild. These
    // are the inputs most likely to make two implementations disagree.
    let quoted = record(1, "tool", prev: AuditChain.genesis, args: #"{"q":"he said \"hi\""}"#)
    check(
      "quotes survive a round trip", AuditChain.verify(lines: [AuditChain.line(quoted)]).isIntact)
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

    // MARK: - Searching the log

    print("\nLog search: what a query matches")

    func row(
      _ text: String, surface: String = "mail", args: String? = nil,
      result: String? = nil
    ) -> LogStore.Entry {
      LogStore.Entry(
        at: Date(), surface: surface, level: .call, text: text, arguments: args, result: result)
    }

    let order = row(
      "apple_mail_get_message", args: #"{"id":"msg-992","mailbox":"INBOX"}"#,
      result: #"{"subject":"«redacted»","from":"a@b.com"}"#)

    check("the tool name matches", order.matches("get_message"))
    check("the surface matches", order.matches("mail"))
    // The reason to search a log at all: the identifier is in the arguments,
    // not in the tool name.
    check("an argument matches", order.matches("992"))
    check("a result matches", order.matches("a@b.com"))
    check("something absent does not", !order.matches("calendar"))

    check("case is ignored", order.matches("APPLE_MAIL_GET_MESSAGE"))
    check("in payloads too", order.matches("MSG-992"))
    check("accents are ignored", row("café_tool").matches("cafe"))
    check("a row with no payload still matches its name", row("ping").matches("ping"))
    check("and does not match a payload it does not have", !row("ping").matches("992"))

    print("\nLog search: a match the row would not show")

    // A payload is previewed at a fixed length, so a match past that point
    // lists a row with no visible reason for being there — which reads as a
    // bug rather than as a truncation. `FeedRow` opens such a row itself.
    let buried = row("tool", args: String(repeating: "x", count: 300) + "needle")
    check("a match past the preview is flagged", buried.matchIsHidden("needle", preview: 160))
    check(
      "a match inside the preview is not",
      !row("tool", args: "needle" + String(repeating: "x", count: 300))
        .matchIsHidden("needle", preview: 160))
    check("a match in the tool name is not", !order.matchIsHidden("get_message", preview: 160))
    check("a match in the surface is not", !order.matchIsHidden("mail", preview: 160))
    check("a row that does not match at all is not", !order.matchIsHidden("absent", preview: 160))
    check("an empty query flags nothing", !buried.matchIsHidden("", preview: 160))

    print("\nLog store: what Follow can key on at the cap")

    // The Log's Follow scrolled on `entries.count`, and `add` trims on every
    // append once the store is full — so at the cap the count never moves
    // again, and Follow stopped following. With payloads the byte budget is
    // reached first, at a few hundred rows. The last entry's id is what still
    // changes with every append, in both cases; this pins that contract, which
    // is the one `MainWindow` now keys on.
    let log = LogStore()
    for n in 0..<1100 { log.append(surface: "mail", level: .info, "line \(n)") }
    let fullCount = log.entries.count
    let lastBefore = log.entries.last?.id
    log.append(surface: "mail", level: .info, "one more")
    check("the entry cap holds the count still", log.entries.count == fullCount)
    check("while the last entry's id changes", log.entries.last?.id != lastBefore)

    log.clear()
    let payload = String(repeating: "x", count: 8 * 1024)
    for _ in 0..<400 {
      log.appendCall(
        surface: "mail", text: "apple_mail_get_message", arguments: payload, id: UUID())
    }
    let budgetCount = log.entries.count
    let budgetLast = log.entries.last?.id
    log.appendCall(surface: "mail", text: "apple_mail_get_message", arguments: payload, id: UUID())
    check(
      "the byte budget is reached well before the entry cap (\(budgetCount) rows)",
      budgetCount < 1000)
    check("and holds the count still too", log.entries.count == budgetCount)
    check("while the last entry's id changes", log.entries.last?.id != budgetLast)

    print("\nVisible tools: which Node calls light a notice")

    // The warn tier is the orange card that asks for hands off the keyboard, so
    // it belongs only to calls that take the foreground and post input. Mail's
    // compose paths do: `stripCitation` raises Mail and sends Cmd-A plus menu
    // clicks through System Events, and the fallback reply pastes with Cmd-V.
    for tool in [
      "apple_mail_send_message", "apple_mail_update_draft",
      "apple_mail_reply_to_message", "apple_mail_forward_message",
    ] {
      check("\(tool) warns", VisibleTools.notice(forTool: tool) == .driving)
    }

    // The screen changes, but the keyboard and mouse stay the user's.
    check(
      "open_url is a page opening",
      VisibleTools.notice(forTool: "apple_safari_open_url") == .showing(.openingPage))
    check(
      "a page click is a click",
      VisibleTools.notice(forTool: "apple_safari_click") == .showing(.clickingPage))
    check(
      "a fill is a fill",
      VisibleTools.notice(forTool: "apple_safari_fill") == .showing(.fillingPage))
    check(
      "a scroll is a scroll",
      VisibleTools.notice(forTool: "apple_safari_scroll") == .showing(.scrollingPage))
    check(
      "a form submit is a submit",
      VisibleTools.notice(forTool: "apple_safari_submit") == .showing(.submittingPage))
    check(
      "closing tabs is shown",
      VisibleTools.notice(forTool: "apple_safari_close_tabs") == .showing(.closingTabs))
    // Waiting reads the page and changes nothing, like page_elements.
    check(
      "wait_for shows no notice",
      VisibleTools.notice(forTool: "apple_safari_wait_for") == nil)
    check(
      "a Maps favourite opens a place",
      VisibleTools.notice(forTool: "apple_maps_add_favorite") == .showing(.openingPlace))

    // Writes that reach an app by Apple Event, which starts it when it is quit.
    // The observer only shows these when the app was not running, so a run of
    // Notes writes does not flash a card each time.
    for tool in [
      "apple_notes_create_note", "apple_notes_update_note", "apple_notes_add_attachment",
      "apple_notes_move_note", "apple_notes_delete_notes",
      "apple_reminders_create_reminder", "apple_reminders_update_reminder",
      "apple_reminders_complete_reminders", "apple_reminders_move_reminders",
      "apple_reminders_delete_reminders",
      "apple_calendar_create_event", "apple_calendar_update_event", "apple_calendar_delete_events",
      "apple_contacts_create_contact", "apple_contacts_update_contact",
      "apple_messages_send_message", "apple_mail_check_for_new_mail",
      "apple_safari_add_reading_list_item",
    ] {
      check("\(tool) may launch", VisibleTools.notice(forTool: tool) == .launching)
    }

    // Reads change nothing on screen.
    for tool in ["apple_safari_list_tabs", "apple_mail_list_messages", "apple_notes_get_note"] {
      check("\(tool) is silent", VisibleTools.notice(forTool: tool) == nil)
    }
    // Maps' three store-lane tools that can seed open `maps://` with `open -g`,
    // which puts Maps on screen behind the front app: each says so. The two
    // removes never seed and change nothing on screen. The in-process surfaces
    // never pass through this table at all.
    for tool in [
      "apple_maps_add_favorite", "apple_maps_save_place", "apple_maps_add_place_to_guide",
    ] {
      check(
        "\(tool) says it opens a place",
        VisibleTools.notice(forTool: tool) == .showing(.openingPlace))
    }
    for tool in ["apple_maps_remove_favorite", "apple_maps_remove_saved_place"] {
      check("\(tool) is silent", VisibleTools.notice(forTool: tool) == nil)
    }
    check(
      "a desktop verb is not listed here",
      VisibleTools.notice(forTool: "apple_desktop_press") == nil)
    // The observer unwraps a lazy dispatcher before asking, so the wrapper's own
    // name must not match anything.
    check(
      "a lazy dispatcher is not a tool",
      VisibleTools.notice(forTool: "apple_mail_call_write_tool") == nil)
    check("an unknown name is silent", VisibleTools.notice(forTool: "apple_mail_nope") == nil)
    check("and so is an empty one", VisibleTools.notice(forTool: "") == nil)

    print("\nVisible tools: a launch notice only for an app that was not running")

    // A run of Notes writes against a Notes that is already open changes nothing
    // anybody can see, and a card flashing on each one would teach people to
    // ignore the card.
    check(
      "a launching write to a running app is silent",
      VisibleTools.notice(forTool: "apple_notes_create_note", appRunning: true) == nil)
    check(
      "and lights when the app was quit",
      VisibleTools.notice(forTool: "apple_notes_create_note", appRunning: false) == .launching)
    // The other tiers change the screen whether or not the app was running.
    check(
      "a running app does not silence driving",
      VisibleTools.notice(forTool: "apple_mail_send_message", appRunning: true) == .driving)
    check(
      "nor a page change",
      VisibleTools.notice(forTool: "apple_safari_open_url", appRunning: true)
        == .showing(.openingPage))

    print("\nVisible tools: holding the notice while a call is in flight")

    // Mail's send spends seconds inside stripCitation, longer than the linger,
    // so the observer keeps the card lit until the reply arrives.
    let t0 = Date(timeIntervalSince1970: 1_756_000_000)
    var flight = VisibleTools.InFlight()
    check("nothing is in flight to begin with", flight.isEmpty)
    flight.started("i1", bundleId: "com.apple.mail", notice: .driving, at: t0)
    check("a started call is in flight", !flight.isEmpty)
    let held = flight.live(at: t0.addingTimeInterval(10))
    check(
      "and is held while it runs",
      held.count == 1 && held.first?.bundleId == "com.apple.mail" && held.first?.notice == .driving)
    flight.answered("i1")
    check("the reply releases it", flight.isEmpty)

    // A server that never answers must not hold the orange card up forever.
    var stuck = VisibleTools.InFlight()
    stuck.started("i2", bundleId: "com.apple.Safari", notice: .showing(.openingPage), at: t0)
    check(
      "a call past the cap is no longer held",
      stuck.live(at: t0.addingTimeInterval(VisibleTools.InFlight.cap + 1)).isEmpty)
    stuck.prune(at: t0.addingTimeInterval(VisibleTools.InFlight.cap + 1))
    check("and pruning forgets it", stuck.isEmpty)
    // An answer for a call this never saw, a read, say, is not an error.
    stuck.answered("i-unknown")
    check("an unknown reply changes nothing", stuck.isEmpty)

    print("\nDriving policy: what happens before Cupertino takes the screen")

    // The decision a countdown depends on, and the one that is silent when
    // wrong: a card that never shows looks exactly like a Mac nobody was using.
    let noon = Date(timeIntervalSince1970: 1_756_000_000)
    let counting = DrivingPolicy.Settings(before: .countdown, countdown: 3, idleRelease: 45)
    let asking = DrivingPolicy.Settings(before: .ask, countdown: 3, idleRelease: 45)
    let nothing = DrivingPolicy.Settings(before: .none, countdown: 3, idleRelease: 45)
    func decide(
      _ settings: DrivingPolicy.Settings, idle: Double, declinedUntil: Date? = nil,
      background: Bool = false
    ) -> DrivingPolicy.Decision {
      DrivingPolicy.decide(
        settings, secondsSinceInput: idle, declinedUntil: declinedUntil, now: noon,
        background: background)
    }
    // A verb that cannot take the focus (keys posted to a pid, an in-app channel)
    // cannot land in the person's sentence, so it does not make them wait.
    check(
      "a background verb opens at once while somebody types",
      decide(counting, idle: 0.5, background: true) == .open)
    check(
      "and is not asked about either", decide(asking, idle: 0, background: true) == .open)
    // Background means behind the person's app. Typing into the app they are
    // typing in moves their caret and mixes keystrokes, whatever the lane.
    check(
      "an application behind the one in front is driven in the background",
      DrivingPolicy.isBackground(target: "com.apple.TextEdit", frontmost: "com.microsoft.VSCode"))
    check(
      "the application in front is not",
      !DrivingPolicy.isBackground(target: "com.apple.mail", frontmost: "com.apple.mail"))
    check(
      "and an unreadable front counts as in front, which errs toward the countdown",
      !DrivingPolicy.isBackground(target: "com.apple.mail", frontmost: nil))
    // Two copies of one app share a bundle id, so the copy behind the person's
    // is told apart by its process: the worktree's Debug build behind the one
    // they are using.
    check(
      "the other copy of the application in front is behind it",
      DrivingPolicy.isBackground(target: pid_t(4512), frontmost: pid_t(3011)))
    check(
      "and the copy in front is not",
      !DrivingPolicy.isBackground(target: pid_t(3011), frontmost: pid_t(3011)))
    check(
      "but a recent no still outranks it",
      decide(counting, idle: 0, declinedUntil: noon.addingTimeInterval(10), background: true)
        == .declined(retryIn: 10))

    // Which card a session shows comes from the lane each call took. On
    // 2026-11-17 a session of channel clicks and AX presses into a copy behind
    // the person's own showed "Please don't use the keyboard or mouse" for 86 s,
    // while nothing it did could reach either.
    let channelBehind = DrivingPolicy.leavesInputAlone(.channel, behind: true)
    let sessionLane = DrivingPolicy.leavesInputAlone(.session, behind: true)
    check("a channel call behind the person's app leaves their input alone", channelBehind)
    check(
      "and so does an Accessibility press behind it",
      DrivingPolicy.leavesInputAlone(.accessibility, behind: true))
    check(
      "but not either one into the app in front, where they are typing",
      !DrivingPolicy.leavesInputAlone(.channel, behind: false)
        && !DrivingPolicy.leavesInputAlone(.accessibility, behind: false))
    check(
      "nor keys posted to a pid, or anything posted to the session, wherever it lands",
      !DrivingPolicy.leavesInputAlone(.processKeys, behind: true) && !sessionLane)
    let opened = DrivingPolicy.tier(nil, admitting: channelBehind)
    check("a session opened by a channel call says they can keep working", opened == .keepWorking)
    let channelAgain = DrivingPolicy.tier(opened, admitting: channelBehind)
    check("and still does after another", channelAgain == .keepWorking)
    let thenSession = DrivingPolicy.tier(channelAgain, admitting: sessionLane)
    check("a session-lane call after them turns it hands off", thenSession == .handsOff)
    check(
      "and it stays hands off, whatever lane comes next",
      DrivingPolicy.tier(thenSession, admitting: channelBehind) == .handsOff)
    check(
      "a session opened on the session lane is hands off from the start",
      DrivingPolicy.tier(nil, admitting: sessionLane) == .handsOff)
    // What is in front, between calls: a driven copy coming forward, by itself
    // after a press or because the person switched to it, puts their keys into it.
    let reached: Set<pid_t> = [4512]
    check(
      "another app in front, the person's own copy included, keeps it blue",
      DrivingPolicy.tier(.keepWorking, frontmost: pid_t(3011), driven: reached) == .keepWorking)
    check(
      "the driven copy in front turns it hands off",
      DrivingPolicy.tier(.keepWorking, frontmost: pid_t(4512), driven: reached) == .handsOff)
    check(
      "an unreadable front does too, erring toward warning",
      DrivingPolicy.tier(.keepWorking, frontmost: pid_t?.none, driven: reached) == .handsOff)
    check(
      "and the driven copy going behind again does not turn it back",
      DrivingPolicy.tier(.handsOff, frontmost: pid_t(3011), driven: reached) == .handsOff)
    check("somebody typing gets a countdown", decide(counting, idle: 0.5) == .countdown(3))
    check(
      "just inside the window still counts as somebody there",
      decide(counting, idle: DrivingPolicy.activeWindow - 0.1) == .countdown(3))
    check(
      "a Mac left alone for the window is driven straight away",
      decide(counting, idle: DrivingPolicy.activeWindow) == .open)
    check(
      "asking waits no longer than its timeout",
      decide(asking, idle: 1) == .ask(timeout: DrivingPolicy.askTimeout))
    check("nothing means nothing, even while somebody types", decide(nothing, idle: 0) == .open)
    let declined = noon.addingTimeInterval(10)
    check(
      "a recent no outranks the preference, including nothing",
      decide(nothing, idle: 0, declinedUntil: declined) == .declined(retryIn: 10))
    check(
      "and outranks an idle Mac",
      decide(counting, idle: 600, declinedUntil: declined) == .declined(retryIn: 10))
    check(
      "a no that has expired decides nothing",
      decide(counting, idle: 0.5, declinedUntil: noon.addingTimeInterval(-1)) == .countdown(3))
    check(
      "a question gives up before a lent channel's 30 s call timeout",
      DrivingPolicy.askTimeout < 30)
    check(
      "the longest countdown ends inside the active window",
      TimeInterval(DrivingPolicy.countdownRange.upperBound) < DrivingPolicy.activeWindow)

    // A field whose window another process draws, a sandboxed app's open or
    // save panel, which the panel service owns (MEASURED 2026-11-16 on
    // TextEdit's Open panel: the field answers TextEdit's pid, and its window
    // is the service's). A driving channel and keys posted to the app's pid
    // reach only the app's own windows.
    check(
      "a field in a window another process owns is in a foreign window",
      DrivingPolicy.inForeignWindow(windowOwner: pid_t(49812), process: pid_t(49752)))
    check(
      "one in its own process's window is not",
      !DrivingPolicy.inForeignWindow(windowOwner: pid_t(49752), process: pid_t(49752)))
    check(
      "and one whose window cannot be read is left as it was",
      !DrivingPolicy.inForeignWindow(windowOwner: nil, process: pid_t(49752))
        && !DrivingPolicy.inForeignWindow(windowOwner: pid_t(49812), process: nil))

    print("\nBackground typing: whether text posted to a field in the background landed")

    // The read-back decides between answering and typing again in front, so a
    // wrong "nothing landed" types the text twice.
    check(
      "an empty field that now holds the text landed",
      BackgroundTyping.verdict(before: "", after: "abc", typed: "abc") == .landed(verified: true))
    check(
      "text appended after what was there landed",
      BackgroundTyping.verdict(before: "x", after: "xabc", typed: "abc")
        == .landed(verified: true))
    check(
      "appended to identical text still counts the new copy",
      BackgroundTyping.verdict(before: "abc", after: "abcabc", typed: "abc")
        == .landed(verified: true))
    check(
      "an unchanged field is nothing landed, even when it already holds the text",
      BackgroundTyping.verdict(before: "abc", after: "abc", typed: "abc") == .nothingLanded)
    check(
      "a field that took part of it landed, unverified, so it is not typed again",
      BackgroundTyping.verdict(before: "", after: "ab", typed: "abcdef")
        == .landed(verified: false))
    // Focusing an NSTextField through AX selects all of it, so typing the text
    // it already holds replaces it with itself: the value reads the same, and
    // only the selection says anything happened.
    check(
      "identical text replacing a selection landed, because the selection moved",
      BackgroundTyping.verdict(before: "abc", after: "abc", typed: "abc", selectionMoved: true)
        == .landed(verified: true))
    check(
      "a value that could not be read is not taken for nothing landed",
      BackgroundTyping.verdict(before: "x", after: nil, typed: "abc") == .landed(verified: false))
    check(
      "a secure field is never typed in the background: its value cannot be read back",
      !BackgroundTyping.eligible(role: "AXTextField", subrole: "AXSecureTextField", value: ""))
    check(
      "a text area with a string value is",
      BackgroundTyping.eligible(role: "AXTextArea", subrole: nil, value: "hi"))

    // Typing by value, into a field no key can reach: the text goes where
    // typing would put it, over the selection or at the caret. Ranges are
    // UTF-16, as Accessibility's are.
    check(
      "typed at the caret, the text goes in there",
      BackgroundTyping.inserting("X", into: "abcd", at: (location: 2, length: 0)) == "abXcd")
    check(
      "over a selection, it replaces it",
      BackgroundTyping.inserting("X", into: "abcd", at: (location: 1, length: 2)) == "aXd")
    check(
      "over the whole field, as a focus that selects all leaves it, it replaces it all",
      BackgroundTyping.inserting("new", into: "old", at: (location: 0, length: 3)) == "new")
    check(
      "with no selection to read, it is appended",
      BackgroundTyping.inserting("X", into: "abc", at: nil) == "abcX")
    check(
      "a range past the end is appended, never a trap",
      BackgroundTyping.inserting("X", into: "abc", at: (location: 9, length: 4)) == "abcX"
        && BackgroundTyping.inserting("X", into: "abc", at: (location: 2, length: 9)) == "abX")
    check(
      "a range counted in UTF-16 lands after an emoji, not inside it",
      BackgroundTyping.inserting("X", into: "a😀b", at: (location: 3, length: 0)) == "a😀Xb")
    check(
      "and one that would split it goes after it",
      BackgroundTyping.inserting("X", into: "a😀b", at: (location: 2, length: 0)) == "a😀Xb")
    // The caret goes after what was typed, counted from where it really went
    // in, not from the range asked: a stale range past the end, or a start
    // moved off the middle of an emoji, would put it elsewhere.
    check(
      "the caret follows the text, in UTF-16",
      BackgroundTyping.insertion("XY", into: "abcd", at: (location: 1, length: 2)).caret == 3
        && BackgroundTyping.insertion("X", into: "abc", at: (location: 9, length: 0)).caret == 4
        && BackgroundTyping.insertion("X", into: "a😀b", at: (location: 2, length: 0)).caret == 4
        && BackgroundTyping.insertion("😀", into: "ab", at: nil).caret == 4)
    check(
      "an element with no string value is not",
      !BackgroundTyping.eligible(role: "AXWebArea", subrole: nil, value: nil))

    // Stored the way the Settings row writes them, and the way a launch argument
    // arrives: `NSArgumentDomain` hands back strings.
    let suite = "cupertino-unit-driving-\(UUID().uuidString)"
    let store = UserDefaults(suiteName: suite)!
    check(
      "nothing stored reads as the defaults", DrivingPolicy.read(store) == DrivingPolicy.defaults)
    store.set("ask", forKey: DrivingPolicy.Keys.before)
    store.set("7", forKey: DrivingPolicy.Keys.countdownSeconds)
    store.set(60, forKey: DrivingPolicy.Keys.idleReleaseSeconds)
    check(
      "a string and a number both read back",
      DrivingPolicy.read(store)
        == DrivingPolicy.Settings(before: .ask, countdown: 7, idleRelease: 60))
    store.set("maybe", forKey: DrivingPolicy.Keys.before)
    store.set(99, forKey: DrivingPolicy.Keys.countdownSeconds)
    store.set(1, forKey: DrivingPolicy.Keys.idleReleaseSeconds)
    check(
      "a value nobody could have chosen falls back or is clamped",
      DrivingPolicy.read(store)
        == DrivingPolicy.Settings(
          before: .countdown, countdown: TimeInterval(DrivingPolicy.countdownRange.upperBound),
          idleRelease: TimeInterval(DrivingPolicy.idleReleaseRange.lowerBound)))
    UserDefaults.standard.removePersistentDomain(forName: suite)

    // Its own scope: `t0` already names the in-flight checks' clock above.
    do {
      print("\nShell policy: a cooldown outranks everything, a session never crosses into ask")
      let t0 = Date(timeIntervalSince1970: 1_000_000)
      func shell(
        _ b: ShellPolicy.Before, until: Date? = nil, declined: Date? = nil, inFlight: Int = 0
      ) -> ShellPolicy.Decision {
        ShellPolicy.decide(
          b, sessionApprovedUntil: until, declinedUntil: declined, inFlight: inFlight, now: t0)
      }
      check("ask: window, no session button", shell(.ask) == .ask(timeout: 60, offerSession: false))
      check(
        "session: window offers the session button",
        shell(.session) == .ask(timeout: 60, offerSession: true))
      check(
        "session approved: runs, card shown", shell(.session, until: t0 + 10) == .run(notice: true))
      check(
        "session approval expired at 30 min asks again",
        shell(.session, until: t0) == .ask(timeout: 60, offerSession: true))
      check(
        "approval ignored once the setting is ask",
        shell(.ask, until: t0 + 10) == .ask(timeout: 60, offerSession: false))
      check("none: runs, card shown", shell(.none) == .run(notice: true))
      check("cooldown beats none", shell(.none, declined: t0 + 12) == .declined(retryIn: 12))
      check(
        "cooldown beats a session approval",
        shell(.session, until: t0 + 10, declined: t0 + 5) == .declined(retryIn: 5))
      check(
        "cooldown in the past is ignored",
        shell(.ask, declined: t0 - 1) == .ask(timeout: 60, offerSession: false))
      check("fifth run is busy", shell(.none, inFlight: 4) == .busy)
      check("fourth run is allowed", shell(.none, inFlight: 3) == .run(notice: true))
      check(
        "cooldown beats busy", shell(.none, declined: t0 + 3, inFlight: 4) == .declined(retryIn: 3))
    }

    print("\nNotice style: where the card lands and how big it is")

    // Silent when wrong, which is the whole reason this is arithmetic in its
    // own type: a card placed off the bottom of a display looks exactly like a
    // card that never appeared.
    //
    // A 1440x900 display with the menu bar gone: y runs UPWARD from 0, so the
    // visible frame starts at 0 and the top edge is 875.
    let display = CGRect(x: 0, y: 0, width: 1440, height: 875)
    let noticeCard = CGSize(width: 320, height: 60)
    let m = NoticeStyle.margin
    func at(
      _ placement: NoticeStyle.Placement, _ frame: CGRect = display, _ size: CGSize = noticeCard
    )
      -> CGRect
    {
      NoticeStyle.frame(for: size, in: frame, placement: placement)
    }
    check(
      "top right is where the card shipped, and is still the default",
      NoticeStyle.defaults.placement == .topRight
        && at(.topRight) == CGRect(x: 1440 - 320 - m, y: 875 - 60 - m, width: 320, height: 60))
    check("top left hugs the other side", at(.topLeft).minX == m)
    check("the two top corners sit at the same height", at(.topLeft).minY == at(.topRight).minY)
    check("top centres the card", at(.top).midX == display.midX)
    check(
      "bottom is measured UP from the visible frame, not down from the top",
      at(.bottom).minY == m && at(.bottomLeft).minY == m && at(.bottomRight).minY == m)
    check("and bottom centres it too", at(.bottom).midX == display.midX)
    check(
      "every placement stays inside the display",
      NoticeStyle.Placement.allCases.allSatisfy { display.contains(at($0)) })

    // A display offset from the origin is the two-screen case, and the one an
    // `NSRect` built from width and height alone gets wrong.
    let leftDisplay = CGRect(x: -1512, y: 300, width: 1512, height: 900)
    check(
      "a display left of the primary is placed in ITS coordinates",
      at(.topRight, leftDisplay).maxX == leftDisplay.maxX - m
        && at(.topRight, leftDisplay).maxY == leftDisplay.maxY - m)
    check(
      "and its bottom row is its own bottom",
      at(.bottomLeft, leftDisplay).minY == leftDisplay.minY + m)

    // The clamp. Not reachable today — the widest card is 546pt — but a card
    // hanging off the side of the screen is the failure this type exists for.
    let tiny = CGRect(x: 0, y: 0, width: 200, height: 100)
    check(
      "a card wider than the display is pinned to its leading edge rather than off it",
      at(.topRight, tiny).minX == tiny.minX && at(.top, tiny).minX == tiny.minX)
    check(
      "and the axis that still fits is placed normally",
      at(.topRight, tiny).maxY == tiny.maxY - m)

    check("medium is exactly the card that shipped", NoticeStyle.Size.medium.scale == 1)
    check(
      "the sizes are ordered and distinct",
      NoticeStyle.Size.small.scale < 1 && NoticeStyle.Size.large.scale > 1)
    check(
      "type grows with the panel rather than staying put",
      NoticeStyle.Size.large.titlePoints > NoticeStyle.Size.medium.titlePoints
        && NoticeStyle.Size.small.titlePoints < NoticeStyle.Size.medium.titlePoints)
    check(
      "the title is always larger than the detail under it",
      NoticeStyle.Size.allCases.allSatisfy { $0.titlePoints > $0.detailPoints })
    check(
      "and the smallest detail line is still legible",
      NoticeStyle.Size.small.detailPoints >= 8)

    check("the card is silent until somebody picks a sound", NoticeStyle.defaults.isSilent)
    check(
      "and the volume it would play at is a cue rather than an alert",
      NoticeStyle.defaults.volume > 0 && NoticeStyle.defaults.volume <= 0.5)

    let styleSuite = "cupertino-unit-notice-\(UUID().uuidString)"
    let styles = UserDefaults(suiteName: styleSuite)!
    check(
      "nothing stored reads as the card that shipped",
      NoticeStyle.read(styles) == NoticeStyle.defaults)
    styles.set("bottom", forKey: NoticeStyle.Keys.placement)
    styles.set("large", forKey: NoticeStyle.Keys.size)
    styles.set("Submarine", forKey: NoticeStyle.Keys.arriving)
    styles.set("Pop", forKey: NoticeStyle.Keys.leaving)
    styles.set(0.6, forKey: NoticeStyle.Keys.volume)
    check(
      "a stored choice reads back",
      NoticeStyle.read(styles)
        == NoticeStyle.Settings(
          placement: .bottom, size: .large, arriving: "Submarine", leaving: "Pop", volume: 0.6))
    check("and a card with either sound set is not silent", !NoticeStyle.read(styles).isSilent)
    styles.set("", forKey: NoticeStyle.Keys.arriving)
    check(
      "one sound alone is still not silence",
      !NoticeStyle.read(styles).isSilent && NoticeStyle.read(styles).arriving.isEmpty)
    styles.set("", forKey: NoticeStyle.Keys.leaving)
    check("both set to None is", NoticeStyle.read(styles).isSilent)

    // The volume is the one number a launch argument or a `defaults write` can
    // get wrong in a way that is not obvious: silently loud, or silently gone.
    // `NSArgumentDomain` hands back strings, so `-notice.soundVolume 0` must
    // read as 0 and not fall through to a default that is a third of full.
    styles.set("0", forKey: NoticeStyle.Keys.volume)
    check("a volume stored as a launch argument reads as one", NoticeStyle.read(styles).volume == 0)
    styles.set(1.4, forKey: NoticeStyle.Keys.volume)
    check("a volume above full is clamped", NoticeStyle.read(styles).volume == 1)
    styles.set(-0.2, forKey: NoticeStyle.Keys.volume)
    check("and one below silence is too", NoticeStyle.read(styles).volume == 0)
    styles.set("loud", forKey: NoticeStyle.Keys.volume)
    check(
      "a volume nobody could have chosen falls back",
      NoticeStyle.read(styles).volume == NoticeStyle.defaults.volume)
    check(
      "and so does a NaN, rather than reaching NSSound",
      NoticeStyle.fraction(Double.nan, fallback: 0.35) == 0.35)

    styles.set("middle", forKey: NoticeStyle.Keys.placement)
    styles.set("enormous", forKey: NoticeStyle.Keys.size)
    check(
      "a placement or size nobody could have chosen falls back",
      NoticeStyle.read(styles).placement == NoticeStyle.defaults.placement
        && NoticeStyle.read(styles).size == NoticeStyle.defaults.size)
    UserDefaults.standard.removePersistentDomain(forName: styleSuite)

    print("\nServer resolution: which cli.js a surface runs")

    // Built on disk rather than described, because every rule here is about
    // what exists. `node` is only ever checked for existence, so an empty file
    // stands in for the runtime.
    let fs = FileManager.default
    let lab = fs.temporaryDirectory.appendingPathComponent("cupertino-locate-\(UUID().uuidString)")
    func touch(_ url: URL, _ text: String = "") {
      try? fs.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? Data(text.utf8).write(to: url)
    }
    let resources = lab.appendingPathComponent("Resources")
    touch(resources.appendingPathComponent("node"))
    touch(resources.appendingPathComponent("servers/mail/dist/cli.js"))
    let repo = lab.appendingPathComponent("repo")
    let devNode = lab.appendingPathComponent("bin/node")
    touch(devNode)
    touch(repo.appendingPathComponent("packages/mail/dist/cli.js"))
    let devConfig = lab.appendingPathComponent("support/dev.json")
    let noConfig = lab.appendingPathComponent("support-absent/dev.json")
    func writeDevConfig(node: URL = devNode, repo: URL = repo) {
      touch(devConfig, #"{"node":"\#(node.path)","repo":"\#(repo.path)"}"#)
    }

    // A Release build passes no dev config at all: the bundle is the only answer.
    let shipped = try? ServerResolution.resolve(id: "mail", resources: resources, devConfig: nil)
    check("a release build runs the bundled server", shipped?.isDevelopment == false)
    check(
      "from the bundle's own path",
      shipped?.script.path == resources.appendingPathComponent("servers/mail/dist/cli.js").path)
    check(
      "a debug build with no dev.json runs the bundled server too",
      (try? ServerResolution.resolve(id: "mail", resources: resources, devConfig: noConfig))?
        .isDevelopment == false)

    // The bug. `make dev-config` exists to point a Debug build at the workspace,
    // and a bundled copy left inside the app beat it silently: a probe read
    // month-old code while dev.json said otherwise, and nothing said so.
    writeDevConfig()
    let dev = try? ServerResolution.resolve(id: "mail", resources: resources, devConfig: devConfig)
    check("dev.json wins over a bundled copy", dev?.isDevelopment == true)
    check(
      "and runs the workspace build",
      dev?.script.path == repo.appendingPathComponent("packages/mail/dist/cli.js").path)

    // An explicit opt-in that cannot be honoured is an error, never a quiet
    // fall back to the bundle, because the quiet fall back IS the trap.
    var unbuilt = false
    do {
      _ = try ServerResolution.resolve(id: "maps", resources: resources, devConfig: devConfig)
    } catch LocateError.devConfigInvalid(let detail) {
      unbuilt = detail.contains("pnpm")
    } catch {}
    check("a dev.json whose build is missing refuses, and says how to build it", unbuilt)

    touch(devConfig, "{not json")
    var malformed = false
    do {
      _ = try ServerResolution.resolve(id: "mail", resources: resources, devConfig: devConfig)
    } catch LocateError.devConfigInvalid {
      malformed = true
    } catch {}
    check("a malformed dev.json refuses rather than falling back", malformed)

    writeDevConfig(node: lab.appendingPathComponent("bin/absent-node"))
    var nodeless = false
    do {
      _ = try ServerResolution.resolve(id: "mail", resources: resources, devConfig: devConfig)
    } catch LocateError.devConfigInvalid(let detail) {
      nodeless = detail.contains("no node")
    } catch {}
    check("a dev.json naming a missing node refuses", nodeless)

    var nowhere = false
    do {
      _ = try ServerResolution.resolve(id: "notes", resources: resources, devConfig: noConfig)
    } catch LocateError.notBundled {
      nowhere = true
    } catch {}
    check("a surface with neither a bundle nor a dev.json is not bundled", nowhere)

    try? fs.removeItem(at: lab)

    print("\nWhich clients are fronted")

    // The table. Two entries, and both were measured rather than assumed.
    check("claude-code defers", ClientFacade.defersSchemas("claude-code", override: nil))
    check("claude-desktop defers", ClientFacade.defersSchemas("claude-desktop", override: nil))
    check("cursor does not", !ClientFacade.defersSchemas("cursor", override: nil))
    check("nor does lm-studio", !ClientFacade.defersSchemas("lm-studio", override: nil))

    // The default that matters. A config written before `--client=` existed
    // carries no id, and absence must not be read as "defers" — that would
    // silently switch the facade off for everybody who has not re-configured.
    check(
      "an unknown client does not defer", !ClientFacade.defersSchemas("who-is-this", override: nil))
    check("and neither does no client at all", !ClientFacade.defersSchemas(nil))

    // Both directions, which is why the override is a tri-state and not a Bool.
    check("an override can add one", ClientFacade.defersSchemas("cursor", override: "on"))
    check("an override can remove one", !ClientFacade.defersSchemas("claude-code", override: "off"))
    check(
      "an empty override is not a decision",
      ClientFacade.defersSchemas("claude-code", override: ""))
    check(
      "and neither is a value nobody wrote",
      ClientFacade.defersSchemas("claude-code", override: "maybe") == false)

    print("\nThe client id on the wire")

    check("an ordinary id is well formed", BridgeProtocol.isWellFormedClient("claude-desktop"))
    // The handshake is one space-separated line, so these are not bad ids —
    // they are different messages.
    check("a space is not", !BridgeProtocol.isWellFormedClient("claude desktop"))
    check("a newline is not", !BridgeProtocol.isWellFormedClient("a\nb"))
    check("an empty id is not", !BridgeProtocol.isWellFormedClient(""))
    check("upper case is not", !BridgeProtocol.isWellFormedClient("Claude-Code"))
    check(
      "and neither is something absurdly long",
      !BridgeProtocol.isWellFormedClient(String(repeating: "a", count: 65)))
    check(
      "the handshake it builds carries the id",
      BridgeProtocol.handshake(server: "mail", client: "claude-desktop")
        == "cupertino/1 mail client=claude-desktop\n")

    print("\nChildTermination: a server that will not stop")
    // SIGTERM was the whole of it, at quit and at an update relaunch. A server
    // that ignores it, or is wedged, outlived the app holding its permissions
    // with nothing supervising it, or went on serving the outgoing bundle's
    // code after Sparkle replaced it.
    func stubborn() -> Process {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/sh")
      // `exec`, so the ignored SIGTERM is the sleep's own: one process, no
      // grandchild for the check to miss.
      process.arguments = ["-c", "trap '' TERM; exec /bin/sleep 30"]
      try? process.run()
      Thread.sleep(forTimeInterval: 0.2)
      return process
    }
    func obliging() -> Process {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/sleep")
      process.arguments = ["30"]
      try? process.run()
      return process
    }
    do {
      let children = [stubborn(), stubborn(), obliging()]
      let started = Date()
      ChildTermination.terminateAll(children, grace: 0.5)
      // `isRunning` turns false once the child is reaped, which Foundation does
      // on its own queue, so a moment is allowed for it to notice.
      let deadline = Date().addingTimeInterval(0.5)
      while children.contains(where: \.isRunning), Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      check(
        "every child is gone, the ones that ignored SIGTERM included",
        children.allSatisfy { !$0.isRunning })
      check(
        "and the call waited no longer than the grace and the kill",
        Date().timeIntervalSince(started) < 2.5)
      for process in children where process.isRunning {
        kill(process.processIdentifier, SIGKILL)
      }
      let quick = [obliging(), obliging()]
      let quickStart = Date()
      ChildTermination.terminateAll(quick, grace: 3)
      check(
        "children that exit on SIGTERM cost nothing like the grace",
        Date().timeIntervalSince(quickStart) < 1)
      let emptyStart = Date()
      ChildTermination.terminateAll([], grace: 3)
      check("an empty list returns at once", Date().timeIntervalSince(emptyStart) < 0.1)
    }

    // A gate's text reaches the server only with its gate. Safari's cookie hosts
    // are the second gate on a tool that reads signed-in sessions, so a value
    // that leaked past a switched-off gate, or an empty one passed as "", would
    // be a gate in name only.
    print("\ngate values")
    do {
      let safari = Surface.all.first { $0.id == "safari" }!
      let cookies = safari.gates.first { $0.id == "allowCookies" }
      check("safari declares the cookies gate", cookies?.envSuffix == "ALLOW_COOKIES")
      check("and its value is the host list", cookies?.value?.envSuffix == "COOKIE_HOSTS")

      let hosts = { (_: Surface.Gate) -> String? in "  yahoo.com, example.org \n" }
      let on = ServerLocator.gateValues(for: safari, isOn: { $0.id == "allowCookies" }, text: hosts)
      check(
        "the hosts pass while the gate is on, trimmed",
        on == ["COOKIE_HOSTS": "yahoo.com, example.org"])
      let off = ServerLocator.gateValues(for: safari, isOn: { _ in false }, text: hosts)
      check("nothing passes while the gate is off, whatever is typed", off.isEmpty)
      let blank = ServerLocator.gateValues(for: safari, isOn: { _ in true }, text: { _ in "  " })
      check("an empty field passes nothing, so the server keeps its default", blank.isEmpty)
      let other = ServerLocator.gateValues(
        for: safari, isOn: { $0.id == "allowNetwork" }, text: hosts)
      check("another gate being on does not carry this one's value", other.isEmpty)

      let env = ServerLocator.environment(
        for: safari, allowWrites: false, gates: ["ALLOW_COOKIES"], values: on)
      check("the env names the gate", env["APPLE_SAFARI_ALLOW_COOKIES"] == "1")
      check("and carries the hosts", env["APPLE_SAFARI_COOKIE_HOSTS"] == "yahoo.com, example.org")
      let none = ServerLocator.environment(for: safari, allowWrites: false)
      check("with no values, no host variable at all", none["APPLE_SAFARI_COOKIE_HOSTS"] == nil)
    }

    // ─── McpFrame ───
    print("\nMcpFrame: what a session sends before its first call")
    do {
      let req = McpFrame.parse(
        Data(#"{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}"#.utf8))
      check("request kind", req.kind == .request && req.method == "tools/list")
      check("numeric id", req.id == Data("7".utf8))
      check(
        "string id keeps quotes",
        McpFrame.parse(Data(#"{"id":"a","method":"ping"}"#.utf8)).id == Data(#""a""#.utf8))
      check(
        "notification",
        McpFrame.parse(Data(#"{"method":"notifications/initialized"}"#.utf8)).kind == .notification)
      check("error response", McpFrame.parse(Data(#"{"id":1,"error":{"code":-1}}"#.utf8)).isError)
      check("garbage", McpFrame.parse(Data("not json".utf8)).kind == .unparsed)
      check(
        "canonical sorts and drops volatile meta",
        McpFrame.canonical(
          ["b": 1, "a": 2, "_meta": ["progressToken": 3]], droppingMeta: ["progressToken"])
          == Data(#"{"a":2,"b":1}"#.utf8))
      check(
        "canonical keeps other meta",
        McpFrame.canonical(
          ["_meta": ["progressToken": 3, "x": 1]], droppingMeta: ["progressToken"])
          == Data(#"{"_meta":{"x":1}}"#.utf8))
      var lb = LineBuffer()
      check(
        "line buffer splits", lb.append(Data("a\nb\nc".utf8)) == [Data("a".utf8), Data("b".utf8)])
      check(
        "line buffer keeps tail", lb.pendingCount == 1 && lb.takePending() == Data("c".utf8))
      check(
        "string id keeps its slashes",
        McpFrame.parse(Data(#"{"id":"a/b","method":"ping"}"#.utf8)).id == Data(#""a/b""#.utf8))
      var crlf = LineBuffer()
      check(
        "line buffer strips one carriage return and skips a bare one",
        crlf.append(Data("a\r\n\r\nb".utf8)) == [Data("a".utf8)]
          && crlf.append(Data("\r".utf8)).isEmpty
          && crlf.append(Data("\n".utf8)) == [Data("b".utf8)] && crlf.pendingCount == 0)
      var split = LineBuffer()
      _ = split.append(Data("ab".utf8))
      check(
        "line buffer joins a line across chunks",
        split.append(Data("c\nd".utf8)) == [Data("abc".utf8)] && split.pendingCount == 1)
      var big = LineBuffer()
      let piece = Data(repeating: UInt8(ascii: "x"), count: 1024)
      let started = Date()
      for _ in 0..<4096 { _ = big.append(piece) }
      let tail = big.append(Data("\n".utf8))
      let elapsed = Date().timeIntervalSince(started)
      check(
        "line buffer reads a 4 MB frame in 1 KB chunks without rescanning (\(Int(elapsed * 1000)) ms)",
        tail.count == 1 && tail[0].count == 4 << 20 && elapsed < 1)
      var ct = ConnectTraffic()
      _ = ct.saw(
        .parse(Data(#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"x"}}}"#.utf8)))
      _ = ct.saw(.parse(Data(#"{"method":"notifications/initialized"}"#.utf8)))
      _ = ct.saw(
        .parse(Data(#"{"id":2,"method":"tools/list","params":{"_meta":{"progressToken":5}}}"#.utf8))
      )
      let line = ct.saw(.parse(Data(#"{"id":3,"method":"tools/call","params":{}}"#.utf8)))
      /// The first 8 hex of the SHA-256 of `text`, worked out here rather than by the code checked.
      func fp(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
      }
      let hello = fp(#"{"clientInfo":{"name":"x"}}"#)
      check(
        "connect line lists methods, meta keys, the handshake, the first call and each params",
        line
          == "connect: initialize, notifications/initialized, tools/list | meta: progressToken"
          + " | handshake: \(hello) | first: tools/call"
          + " | params: initialize=\(hello), tools/list=\(fp("{}"))")
      check(
        "said once",
        ct.saw(.parse(Data(#"{"id":4,"method":"tools/call"}"#.utf8))) == nil && ct.atClose() == nil)

      var closing = ConnectTraffic()
      _ = closing.saw(
        .parse(Data(#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"x"}}}"#.utf8)))
      check(
        "a session that never called says so at close",
        closing.atClose()
          == "connect: initialize | meta: none | handshake: \(hello) | first: none (closed)"
          + " | params: initialize=\(hello)")
      check(
        "a session that sent nothing says so too",
        ConnectTraffic().atClose()
          == "connect: none | meta: none | handshake: none | first: none (closed) | params: none")

      var pinging = ConnectTraffic()
      let pingSaid = pinging.saw(.parse(Data(#"{"id":1,"method":"ping"}"#.utf8)))
      let listSaid = pinging.saw(.parse(Data(#"{"id":2,"method":"tools/list"}"#.utf8)))
      let callSaid = pinging.saw(.parse(Data(#"{"id":3,"method":"tools/call"}"#.utf8)))
      check(
        "a ping keeps the connect phase open",
        pingSaid == nil && listSaid == nil
          && callSaid?.hasPrefix("connect: ping, tools/list | ") == true
          && callSaid?.hasSuffix(" | params: ping=\(fp("null")), tools/list=\(fp("null"))") == true)

      /// The connect line of a session listing tools with these `_meta` values, then calling.
      func listed(_ meta: String) -> String? {
        var traffic = ConnectTraffic()
        _ = traffic.saw(
          .parse(Data(#"{"id":2,"method":"tools/list","params":{"_meta":\#(meta)}}"#.utf8)))
        return traffic.saw(.parse(Data(#"{"id":3,"method":"tools/call"}"#.utf8)))
      }
      check(
        "a fingerprint does not move with the progress token",
        listed(#"{"progressToken":5}"#) == listed(#"{"progressToken":"other"}"#)
          && listed(#"{"progressToken":5}"#)?.hasSuffix(" | params: tools/list=\(fp("{}"))") == true
      )
      check(
        "but does with any other _meta value, which is what it is there to show",
        listed(#"{"x":1}"#) != listed(#"{"x":2}"#))
    }

    // ─── HandshakeCache ───
    print("\nHandshakeCache: replies recorded from an identical server")
    do {
      let base = HandshakeBase(
        surface: "mail", build: "1", node: "/n", script: "/s", env: ["PATH": "/usr/bin:/bin"])
      let k = HandshakeKey(
        base: base, handshake: nil, method: "tools/list", params: Data("{}".utf8))
      let frame = Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":7}"#.utf8)
      check(
        "reply swaps id",
        CachedReply(frame: frame, id: Data("7".utf8))?.frame(id: Data(#""x""#.utf8))
          == Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":"x"}"#.utf8))
      check(
        "id not last is uncacheable",
        CachedReply(frame: Data(#"{"jsonrpc":"2.0","id":7,"result":{}}"#.utf8), id: Data("7".utf8))
          == nil)
      let buffer = Data(repeating: UInt8(ascii: " "), count: 1 << 20) + frame
      let sliced = CachedReply(frame: buffer.suffix(frame.count), id: Data("7".utf8))
      let ownStorage = buffer.withUnsafeBytes { whole in
        sliced?.head.withUnsafeBytes { head in
          guard let h = head.baseAddress, let w = whole.baseAddress else { return false }
          return h < w || h >= w + whole.count
        } ?? false
      }
      check("a reply cut from a larger buffer holds its own bytes", ownStorage)
      let held = HandshakeCache(byteCap: 1 << 20)
      _ = held.record(k, frame: frame, id: Data("7".utf8))
      check(
        "an answer of another shape for a held key is a mismatch",
        held.record(
          k, frame: Data(#"{"jsonrpc":"2.0","id":7,"result":{}}"#.utf8), id: Data("7".utf8))
          == .mismatch && held.isDisabled(surface: "mail"))
      let c = HandshakeCache(byteCap: 1 << 20)
      check("stored", c.record(k, frame: frame, id: Data("7".utf8)) == .stored)
      check("hit", c.reply(for: k) != nil)
      check("same again matches", c.record(k, frame: frame, id: Data("7".utf8)) == .matched)
      let envKey = HandshakeKey(
        base: HandshakeBase(
          surface: "mail", build: "1", node: "/n", script: "/s", env: ["PATH": "/x"]),
        handshake: nil, method: "tools/list", params: Data("{}".utf8))
      check("env is in the key", c.reply(for: envKey) == nil)
      let other = Data(#"{"result":{"tools":[1]},"jsonrpc":"2.0","id":7}"#.utf8)
      check(
        "different answer is a mismatch", c.record(k, frame: other, id: Data("7".utf8)) == .mismatch
      )
      check(
        "mismatch disables the surface", c.isDisabled(surface: "mail") && c.reply(for: k) == nil)
      check("disabled refuses records", c.record(k, frame: frame, id: Data("7".utf8)) == .disabled)
      let small = HandshakeCache(byteCap: 100)
      let big = Data(
        (#"{"result":""# + String(repeating: "a", count: 40) + #"","jsonrpc":"2.0","id":1}"#).utf8)
      let k1 = HandshakeKey(
        base: base, handshake: nil, method: "tools/list", params: Data("1".utf8))
      let k2 = HandshakeKey(
        base: base, handshake: nil, method: "tools/list", params: Data("2".utf8))
      _ = small.record(k1, frame: big, id: Data("1".utf8))
      _ = small.record(k2, frame: big, id: Data("1".utf8))
      check("byte cap evicts oldest", small.reply(for: k1) == nil && small.reply(for: k2) != nil)
      let tiny = Data(#"{"result":{},"jsonrpc":"2.0","id":1}"#.utf8)
      let tinyBytes = CachedReply(frame: tiny, id: Data("1".utf8))!.byteCount
      let keyed = HandshakeCache(byteCap: 100)
      let heavy = HandshakeKey(
        base: base, handshake: Data(repeating: UInt8(ascii: "h"), count: 40), method: "tools/list",
        params: Data(repeating: UInt8(ascii: "p"), count: 40))
      check(
        "a key's own bytes count toward the cap",
        tinyBytes < 100 && keyed.record(heavy, frame: tiny, id: Data("1".utf8)) == .uncacheable
          && keyed.byteCount == 0)
      _ = keyed.record(k1, frame: tiny, id: Data("1".utf8))
      check("and toward the bytes held", keyed.byteCount == tinyBytes + k1.params.count)
      keyed.disable(surface: "mail")
      check("and leave with the entry", keyed.byteCount == 0)
      let d = UserDefaults(suiteName: "unit-check-\(UUID())")!
      check(
        "off for dev builds",
        !HandshakeCache.isOn(
          ServerBinaries(
            node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"),
            isDevelopment: true), defaults: d))
      d.set(true, forKey: "deferSpawnInDevelopment")
      check(
        "dev opt-in",
        HandshakeCache.isOn(
          ServerBinaries(
            node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"),
            isDevelopment: true), defaults: d))
      check(
        "a mismatch traps a Debug build on release binaries only",
        DeferredSpawn.assertsOnMismatch(
          ServerBinaries(
            node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"),
            isDevelopment: false))
          && !DeferredSpawn.assertsOnMismatch(
            ServerBinaries(
              node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"),
              isDevelopment: true))
      )
      d.set(false, forKey: "deferServerSpawn")
      check(
        "kill switch",
        !HandshakeCache.isOn(
          ServerBinaries(
            node: URL(fileURLWithPath: "/n"), script: URL(fileURLWithPath: "/s"),
            isDevelopment: false), defaults: d))
    }

    // ─── DeferredSession ───
    print("\nDeferredSession: a session answered before its server exists")
    do {
      let base = HandshakeBase(
        surface: "mail", build: "1", node: "/n", script: "/s", env: ["PATH": "/usr/bin:/bin"])
      let initLine = Data(
        #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"cc"}}}"#
          .utf8)
      let notified = Data(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.utf8)
      func listLine(token: Int, id: Int = 2) -> Data {
        Data(
          #"{"jsonrpc":"2.0","id":\#(id),"method":"tools/list","params":{"_meta":{"progressToken":\#(token)}}}"#
            .utf8)
      }
      let callLine = Data(
        #"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"x"}}"#.utf8)
      let nl = Data("\n".utf8)
      // Node-style answers: the id last.
      let iAnswer = Data(
        #"{"result":{"protocolVersion":"2025-06-18"},"jsonrpc":"2.0","id":1}"#.utf8)
      let lAnswer = Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":2}"#.utf8)
      let lOther = Data(#"{"result":{"tools":[{"name":"y"}]},"jsonrpc":"2.0","id":2}"#.utf8)

      /// The keys a session that sends initLine then L would ask under.
      func keys() -> (i: HandshakeKey, l: HandshakeKey) {
        var k = SessionKeys(base: base)
        let i = k.key(for: .parse(initLine))!
        let l = k.key(for: .parse(listLine(token: 1)))!
        return (i, l)
      }
      /// A fresh cache holding the initLine and L answers.
      func warmCache() -> HandshakeCache {
        let cache = HandshakeCache()
        let k = keys()
        _ = cache.record(k.i, frame: iAnswer, id: Data("1".utf8))
        _ = cache.record(k.l, frame: lAnswer, id: Data("2".utf8))
        return cache
      }
      /// A session on a warm cache that sent initLine, notified, L and then callLine.
      func warmSpawn(_ cache: HandshakeCache) -> DeferredSession {
        var s = DeferredSession(base: base, cache: cache)
        _ = s.client(initLine)
        _ = s.client(notified)
        _ = s.client(listLine(token: 9))
        _ = s.client(callLine)
        return s
      }

      var k = SessionKeys(base: base)
      check("a notification has no key", k.key(for: .parse(notified)) == nil)
      check("a call has no key", k.key(for: .parse(callLine)) == nil)
      let before = k.key(for: .parse(listLine(token: 1)))
      let ki = k.key(for: .parse(initLine))
      let after = k.key(for: .parse(listLine(token: 4)))
      check("the handshake key carries no handshake", ki != nil && ki?.handshake == nil)
      check(
        "a list after the handshake carries it, whatever its progress token",
        after?.handshake != nil && after != before && after == keys().l)

      var cold = DeferredSession(base: base, cache: HandshakeCache())
      check("cold session spawns on initialize", cold.client(initLine) == .spawn)
      check("cold replay is the initialize", cold.replay() == initLine + nl)
      check("the trigger is the initialize", cold.trigger?.method == "initialize")

      var warm = DeferredSession(base: base, cache: warmCache())
      check("warm initialize is answered with id 1", warm.client(initLine) == .answer(iAnswer + nl))
      check("the initialized notification is held", warm.client(notified) == .hold)
      check(
        "a list with another progress token is answered with id 2",
        warm.client(listLine(token: 9)) == .answer(lAnswer + nl))
      check("a call spawns", warm.client(callLine) == .spawn)
      check(
        "warm replay is the whole session in order",
        warm.replay()
          == [initLine, notified, listLine(token: 9), callLine].map { $0 + nl }.reduce(Data(), +))
      check("the trigger is the call", warm.trigger?.method == "tools/call")

      // A ping is learned like a list, never composed: node answers it with
      // its own bytes in the legacy era and refuses it in the 2026-07-28 one,
      // and the host must do whichever a fresh server would.
      let pingLine = Data(#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#.utf8)
      let pingAnswer = Data(#"{"result":{},"jsonrpc":"2.0","id":9}"#.utf8)
      let pings = warmCache()
      var pinging = DeferredSession(base: base, cache: pings)
      _ = pinging.client(initLine)
      check("a ping the cache has not heard starts the server", pinging.client(pingLine) == .spawn)
      check("and is replayed", pinging.replay() == initLine + nl + pingLine + nl)
      var pingFilter = pinging.filter()
      _ = pingFilter.server(iAnswer)
      check("the server's answer to it reaches the client", pingFilter.server(pingAnswer) == .pass)
      var pingedLater = DeferredSession(base: base, cache: pings)
      _ = pingedLater.client(initLine)
      check(
        "a later session's ping is answered with node's own bytes",
        pingedLater.client(Data(#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#.utf8))
          == .answer(Data(#"{"result":{},"jsonrpc":"2.0","id":"p"}"#.utf8) + nl))
      let refusing = warmCache()
      var modernPing = DeferredSession(base: base, cache: refusing)
      _ = modernPing.client(initLine)
      _ = modernPing.client(pingLine)
      var modernFilter = modernPing.filter()
      _ = modernFilter.server(iAnswer)
      check(
        "a ping refused as unknown reaches the client",
        modernFilter.server(
          Data(
            #"{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"Method not found"}}"#.utf8))
          == .pass)
      var pingAgain = DeferredSession(base: base, cache: refusing)
      _ = pingAgain.client(initLine)
      check(
        "and is not recorded, so the next session's ping starts a server too",
        pingAgain.client(pingLine) == .spawn)

      var codex = DeferredSession(base: base, cache: warmCache())
      check(
        "different clientInfo misses",
        codex.client(
          Data(
            #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"codex"}}}"#
              .utf8)) == .spawn)

      var piped = DeferredSession(base: base, cache: warmCache())
      var buffer = LineBuffer()
      let steps = buffer.append(initLine + nl + notified + nl + listLine(token: 9) + nl).map {
        piped.client($0)
      }
      check(
        "a pipelined chunk is answered in order",
        steps == [.answer(iAnswer + nl), .hold, .answer(lAnswer + nl)])

      var served = warmSpawn(warmCache()).filter()
      check("filter drops what the host served", served.server(iAnswer) == .drop)

      let skewCache = warmCache()
      var skew = warmSpawn(skewCache).filter()
      check(
        "filter catches a skewed replay, and still drops it",
        skew.server(lOther) == .mismatch(method: "tools/list", forward: false))
      check("a skewed replay disables the surface", skewCache.isDisabled(surface: "mail"))

      let liveSkewCache = HandshakeCache()
      _ = liveSkewCache.record(keys().l, frame: lAnswer, id: Data("2".utf8))
      var liveSkewSession = DeferredSession(base: base, cache: liveSkewCache)
      _ = liveSkewSession.client(initLine)
      var liveSkew = liveSkewSession.filter()
      liveSkew.client(.parse(listLine(token: 3)))
      check(
        "a live answer that differs from the held one is forwarded",
        liveSkew.server(lOther) == .mismatch(method: "tools/list", forward: true)
          && liveSkewCache.isDisabled(surface: "mail"))

      let liveCache = HandshakeCache()
      var live = DeferredSession(base: base, cache: liveCache)
      _ = live.client(initLine)
      var recorder = live.filter()
      recorder.client(.parse(notified))
      recorder.client(.parse(listLine(token: 3)))
      check("filter passes a live initialize", recorder.server(iAnswer + nl) == .pass)
      check("filter records a live miss", recorder.server(lAnswer) == .pass)
      var next = DeferredSession(base: base, cache: liveCache)
      check(
        "a new session is answered from what was recorded",
        next.client(initLine) == .answer(iAnswer + nl) && next.client(notified) == .hold
          && next.client(listLine(token: 5)) == .answer(lAnswer + nl))

      let errorCache = HandshakeCache()
      var erring = DeferredSession(base: base, cache: errorCache)
      _ = erring.client(initLine)
      var errors = erring.filter()
      errors.client(.parse(callLine))
      check(
        "a live error is passed",
        errors.server(Data(#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603}}"#.utf8)) == .pass)
      check(
        "and not recorded, and forgotten",
        errorCache.reply(for: keys().i) == nil && errors.isRetired
          && errors.server(iAnswer) == .pass && errorCache.reply(for: keys().i) == nil)
      let servedErrorCache = warmCache()
      var servedErrors = warmSpawn(servedErrorCache).filter()
      check(
        "an error to a host-served id is dropped, and the surface stays on",
        servedErrors.server(Data(#"{"jsonrpc":"2.0","id":1,"error":{"code":-1}}"#.utf8)) == .drop
          && !servedErrorCache.isDisabled(surface: "mail")
          && servedErrorCache.reply(for: keys().i) != nil)

      var passing = warmSpawn(warmCache()).filter()
      check(
        "filter passes notifications and garbage",
        passing.server(Data(#"{"jsonrpc":"2.0","method":"notifications/message"}"#.utf8)) == .pass
          && passing.server(Data("not json".utf8)) == .pass)
      check(
        "filter passes the call's answer",
        passing.server(Data(#"{"jsonrpc":"2.0","id":3,"result":{}}"#.utf8)) == .pass)

      var opening = DeferredSession(base: base, cache: HandshakeCache())
      _ = opening.client(initLine)
      var phase = opening.filter()
      check("not retired while the connect phase is open", !phase.isRetired)
      phase.client(.parse(listLine(token: 1)))
      _ = phase.server(iAnswer)
      _ = phase.server(lAnswer)
      check("not retired with every id seen and the phase open", !phase.isRetired)
      phase.client(.parse(callLine))
      check("retired once a call closes the phase", phase.isRetired)
      var pending = warmSpawn(warmCache()).filter()
      check("a call trigger opens no phase, but served ids are pending", !pending.isRetired)
      _ = pending.server(iAnswer)
      check("not retired with an id pending", !pending.isRetired)
      _ = pending.server(lAnswer)
      check("retired once every served id is seen", pending.isRetired)

      // The handshake's method is part of it: the SDK picks its era from which
      // of the two the client sent, so the same params under each are two
      // different sessions.
      var viaInitialize = SessionKeys(base: base)
      var viaDiscover = SessionKeys(base: base)
      _ = viaInitialize.key(for: .parse(initLine))
      _ = viaDiscover.key(
        for: .parse(
          Data(
            #"{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"clientInfo":{"name":"cc"}}}"#
              .utf8)))
      check(
        "an initialize and a server/discover with the same params are different handshakes",
        viaInitialize.key(for: .parse(listLine(token: 1)))
          != viaDiscover.key(for: .parse(listLine(token: 1))))

      let pingCache = HandshakeCache()
      var pinged = DeferredSession(base: base, cache: pingCache)
      _ = pinged.client(initLine)
      var afterPing = pinged.filter()
      afterPing.client(.parse(Data(#"{"jsonrpc":"2.0","id":8,"method":"ping"}"#.utf8)))
      afterPing.client(.parse(listLine(token: 1)))
      _ = afterPing.server(iAnswer)
      check("a ping after the spawn leaves the connect phase open", !afterPing.isRetired)
      _ = afterPing.server(lAnswer)
      check(
        "and the list after it is still recorded", pingCache.reply(for: keys().l) != nil)

      // A client reusing an id while the host still waits on the first: the
      // first entry stands, tainted, so the first response under that id is
      // dropped because it is what the host served, and the second reaches
      // the client.
      let reuseCache = HandshakeCache()
      _ = reuseCache.record(keys().i, frame: iAnswer, id: Data("1".utf8))
      var reusing = DeferredSession(base: base, cache: reuseCache)
      _ = reusing.client(initLine)
      _ = reusing.client(listLine(token: 1))
      var reused = reusing.filter()
      reused.client(
        .parse(Data(#"{"jsonrpc":"2.0","id":1,"method":"prompts/list","params":{}}"#.utf8)))
      check("a reused id keeps the host-served entry", reused.server(iAnswer) == .drop)
      check(
        "and the second response under it reaches the client",
        reused.server(Data(#"{"result":{"prompts":[]},"jsonrpc":"2.0","id":1}"#.utf8)) == .pass)

      var twice = DeferredSession(base: base, cache: warmCache())
      _ = twice.client(initLine)
      check(
        "a hit under an id the host already answered starts the server instead",
        twice.client(listLine(token: 1, id: 1)) == .spawn)
      var twiceFilter = twice.filter()
      check(
        "and the replayed first answer under it is dropped, the second passed",
        twiceFilter.server(iAnswer) == .drop
          && twiceFilter.server(Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":1}"#.utf8))
            == .pass
      )

      // A request cancelled, then its id reused. The SDK answers a cancelled
      // request with nothing, so the one response under that id is the new
      // request's: it must reach the client, and be neither recorded under
      // the old request's key nor compared with what the host served for it.
      let cancelSeven = Data(
        #"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}"#.utf8)
      let callSeven = Data(
        #"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x"}}"#.utf8)
      let callSevenAnswer = Data(#"{"result":{"content":[]},"jsonrpc":"2.0","id":7}"#.utf8)

      let liveTaintCache = HandshakeCache()
      _ = liveTaintCache.record(keys().i, frame: iAnswer, id: Data("1".utf8))
      let liveTaintBytes = liveTaintCache.byteCount
      var liveTaint = DeferredSession(base: base, cache: liveTaintCache)
      _ = liveTaint.client(initLine)
      _ = liveTaint.client(notified)
      check(
        "a live list under id 7 starts the server",
        liveTaint.client(listLine(token: 1, id: 7)) == .spawn)
      var liveTaintFilter = liveTaint.filter()
      liveTaintFilter.client(.parse(cancelSeven))
      liveTaintFilter.client(.parse(callSeven))
      _ = liveTaintFilter.server(iAnswer)
      check(
        "a call reusing the cancelled live list's id gets its answer",
        liveTaintFilter.server(callSevenAnswer) == .pass)
      check(
        "and the answer is not recorded as the list's, and nothing is disabled",
        liveTaintCache.reply(for: keys().l) == nil && liveTaintCache.byteCount == liveTaintBytes
          && !liveTaintCache.isDisabled(surface: "mail"))

      let servedTaintCache = warmCache()
      let servedTaintBytes = servedTaintCache.byteCount
      var servedTaint = DeferredSession(base: base, cache: servedTaintCache)
      _ = servedTaint.client(initLine)
      _ = servedTaint.client(notified)
      check(
        "a list under id 7 is served by the host",
        servedTaint.client(listLine(token: 1, id: 7))
          == .answer(Data(#"{"result":{"tools":[]},"jsonrpc":"2.0","id":7}"#.utf8) + nl))
      _ = servedTaint.client(cancelSeven)
      check("a call reusing id 7 starts the server", servedTaint.client(callSeven) == .spawn)
      var servedTaintFilter = servedTaint.filter()
      _ = servedTaintFilter.server(iAnswer)
      check(
        "the call gets its answer, though the host served a list under its id",
        servedTaintFilter.server(callSevenAnswer) == .pass)
      check(
        "and the cache is untouched, and nothing is disabled",
        !servedTaintCache.isDisabled(surface: "mail")
          && servedTaintCache.byteCount == servedTaintBytes
          && servedTaintCache.reply(for: keys().l)
            == CachedReply(frame: lAnswer, id: Data("2".utf8))
      )
      check("and the filter retires", servedTaintFilter.isRetired)

      // The transcript is bounded: past `transcriptLimit` the line that
      // crosses it starts the server, even one the cache could answer.
      let limit = DeferredSpawn.transcriptLimit
      let filler = Data(
        (#"{"jsonrpc":"2.0","method":"notifications/x","params":{"pad":""#
          + String(repeating: "a", count: 1000) + #""}}"#).utf8)
      var chatty = DeferredSession(base: base, cache: warmCache())
      _ = chatty.client(initLine)
      var held = 0
      var lastStep = DeferredSession.Step.hold
      while lastStep == .hold, held < 2 * limit / filler.count {
        lastStep = chatty.client(filler)
        held += 1
      }
      check(
        "notifications past the transcript limit start the server",
        lastStep == .spawn && chatty.overflowed && chatty.replay().count > limit
          && chatty.replay().count - filler.count - 1 <= limit)
      /// A notification whose line, newline included, is exactly `bytes` long.
      func notification(bytes: Int) -> Data {
        let head = #"{"method":"p","params":""#
        let tail = #""}"#
        return Data(
          (head + String(repeating: "a", count: bytes - 1 - head.count - tail.count) + tail).utf8)
      }
      let list = listLine(token: 1)
      let room = limit - (initLine.count + 1) - (list.count + 1)
      var brim = DeferredSession(base: base, cache: warmCache())
      _ = brim.client(initLine)
      _ = brim.client(notification(bytes: room))
      check(
        "a list that brings the transcript to the limit exactly is answered",
        brim.client(list) == .answer(lAnswer + nl) && brim.replay().count == limit)
      check(
        "and the next line, past it, starts the server",
        brim.client(notified) == .spawn && brim.overflowed)
      var over = DeferredSession(base: base, cache: warmCache())
      _ = over.client(initLine)
      _ = over.client(notification(bytes: room + 1))
      check(
        "a list the cache holds is not answered once it would take the transcript past the limit",
        over.client(list) == .spawn && over.overflowed && over.replay().count == limit + 1)

      var spent = DeferredSession(base: base, cache: warmCache())
      _ = spent.client(callLine)
      let spentReplay = spent.replay()
      check(
        "a session that said spawn says it again and keeps its transcript",
        spent.client(initLine) == .spawn && spent.replay() == spentReplay
          && spent.trigger?.method == "tools/call")
    }

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}
