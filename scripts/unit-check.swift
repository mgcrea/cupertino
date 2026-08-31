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

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}
