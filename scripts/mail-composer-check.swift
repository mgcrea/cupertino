import Foundation

/// A composer that is not Mail's: lets the registry and the listing be asserted
/// with no Accessibility and no Mail running.
final class FakeComposer: ComposerWindow {
  var subject: String
  var recipientNames: [String]
  var body: [ComposerBlock]
  var isAlive = true
  init(subject: String, recipients: [String] = [], body: [ComposerBlock] = []) {
    self.subject = subject
    self.recipientNames = recipients
    self.body = body
  }
  func blocks() throws -> [ComposerBlock] { body }
}

/// Asserts the pure text core of the native Mail composer: how a find/replace
/// edit is located in a draft's own text, and when it is refused.
///
/// Nothing here touches Mail or Accessibility; it is text in, text out, plus the
/// registry and dispatch over fake composers. Every `tools/call` to the server
/// is a refusal path, so nothing reaches Accessibility.
///
/// Run with `make mail-composer-check`.
@main
struct MailComposerCheck {
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

  typealias Edit = MailComposerText.Edit

  /// The result of an `.ok` outcome, nil for any refusal.
  static func result(_ edits: [Edit], _ own: String) -> String? {
    if case .ok(let result, _) = MailComposerText.apply(edits, to: own) { return result }
    return nil
  }

  static func registryChecks() {
    print("\nregistry and listing")
    let a = FakeComposer(
      subject: "Hello", recipients: ["Ann", "Bob"],
      body: [
        ComposerBlock(text: "one", quoteLevel: 0, fileNames: ["a.pdf"]),
        ComposerBlock(text: "two", quoteLevel: 0, fileNames: []),
        ComposerBlock(text: "On Monday, X wrote:", quoteLevel: 1, fileNames: ["quoted.png"]),
      ])
    let b = FakeComposer(subject: "Hello")
    let listed = MailComposer.listing([a, b])
    let handles = listed.compactMap { $0["composer"] as? String }
    check("two same-titled windows list as two entries", listed.count == 2)
    check(
      "with distinct handles", Set(handles).count == 2 && handles.allSatisfy { $0.hasPrefix("mc-") }
    )
    check(
      "own text joins blocks with newlines, stopping at the quote",
      listed[0]["text"] as? String == "one\ntwo")
    check("quoted is true when a quote follows", listed[0]["quoted"] as? Bool == true)
    check("files come from own blocks only", listed[0]["files"] as? [String] == ["a.pdf"])
    check("recipients are listed", listed[0]["recipients"] as? [String] == ["Ann", "Bob"])
    check("an empty composer is not quoted", listed[1]["quoted"] as? Bool == false)
    check(
      "registering the same window again keeps its handle",
      MailComposer.register([b, a]) == [handles[1], handles[0]])
    check("resolve returns the window", MailComposer.resolve(handles[0]) === a)

    let odd = FakeComposer(
      subject: "Odd",
      body: [
        ComposerBlock(text: "kept", quoteLevel: 0, fileNames: []),
        ComposerBlock(text: "unknown", quoteLevel: nil, fileNames: []),
        ComposerBlock(text: "later", quoteLevel: 0, fileNames: []),
      ])
    let oddEntry = MailComposer.listing([odd])[0]
    check("an unreadable level makes quoted null", oddEntry["quoted"] is NSNull)
    check("and own text stops before that block", oddEntry["text"] as? String == "kept")

    a.isAlive = false
    check("a dead window no longer resolves", MailComposer.resolve(handles[0]) == nil)
    check("the other still does", MailComposer.resolve(handles[1]) === b)
    check("an unknown handle does not resolve", MailComposer.resolve("mc-9999") == nil)
    let c = FakeComposer(subject: "New")
    let fresh = MailComposer.register([c])[0]
    check("handle numbers are never reused", !handles.contains(fresh) && fresh != "mc-1")
  }

  static let surface = Surface.named("desktop")!

  static func ask(
    _ method: String, params: [String: Any]? = nil, writes: Bool, scope: AccessibilityDriver.Scope
  ) -> [String: Any]? {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": 1, "method": method]
    if let params { message["params"] = params }
    let line = String(data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard
      let reply = DesktopServer.handle(line, surface: surface, writesAllowed: writes, scope: scope),
      let data = reply.data(using: .utf8)
    else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  static func call(_ name: String, writes: Bool, scope: AccessibilityDriver.Scope) -> (String, Bool)
  {
    let reply = ask(
      "tools/call", params: ["name": name, "arguments": [String: Any]()], writes: writes,
      scope: scope)
    let result = reply?["result"] as? [String: Any]
    let text = ((result?["content"] as? [[String: Any]])?.first?["text"] as? String) ?? ""
    return (text, result?["isError"] as? Bool ?? false)
  }

  static func dispatchChecks() {
    print("\ndispatch")
    let mail = AccessibilityDriver.Scope.only(["com.apple.mail"])
    let scopes: [(String, AccessibilityDriver.Scope)] = [
      ("brokered", .brokered), ("any", .any), ("mail", mail),
      ("other app", .only(["com.apple.notes"])),
    ]
    for (label, scope) in scopes {
      for writes in [false, true] {
        let reply = ask("tools/list", writes: writes, scope: scope)
        let tools = ((reply?["result"] as? [String: Any])?["tools"] as? [[String: Any]]) ?? []
        let names = tools.compactMap { $0["name"] as? String }
        check(
          "tools/list names no mail verb (\(label), writes \(writes))",
          !tools.isEmpty && !names.contains { $0.hasPrefix("apple_desktop_mail_") })
      }
    }
    for scope in [AccessibilityDriver.Scope.brokered, .any, .only(["com.apple.notes"])] {
      let (text, isError) = call("apple_desktop_mail_composers", writes: true, scope: scope)
      check(
        "composers is refused as unknown outside the Mail scope (\(scope))",
        isError && text.contains("unknown tool"))
      let (editText, editError) = call(
        "apple_desktop_mail_composer_edit", writes: true, scope: scope)
      check(
        "edit is refused as unknown outside the Mail scope (\(scope))",
        editError && editText.contains("unknown tool"))
    }
    let (off, offError) = call("apple_desktop_mail_composer_edit", writes: false, scope: mail)
    check("edit with writes off is refused before AX", offError && off.contains("switched off"))
    let (later, laterError) = call("apple_desktop_mail_composer_edit", writes: true, scope: mail)
    check(
      "edit with writes on answers an error until it exists",
      laterError && later.contains("not available yet"))
  }

  static func main() {
    print("mail-composer-check")

    check(
      "a single edit replaces its match in place",
      result([Edit(find: "two", replace: "2")], "one\ntwo") == "one\n2")
    check(
      "a find spanning a line break matches across paragraphs",
      result([Edit(find: "one two", replace: "x")], "one\ntwo") == "x")
    check(
      "a find matches through a run of blank lines",
      result([Edit(find: "one two", replace: "x")], "one\n\n  \ntwo") == "x")
    check(
      "a repeated find is ambiguous, with its count",
      MailComposerText.apply([Edit(find: "a", replace: "b")], to: "a a")
        == .ambiguous(find: "a", count: 2))
    check(
      "a missing find is not found",
      MailComposerText.apply([Edit(find: "z", replace: "b")], to: "a") == .notFound(find: "z"))
    check(
      "an empty find is not found",
      MailComposerText.apply([Edit(find: "", replace: "b")], to: "a b") == .notFound(find: ""))
    check(
      "edits whose matches intersect are overlapping",
      MailComposerText.apply(
        [Edit(find: "a b", replace: "x"), Edit(find: "b c", replace: "y")], to: "a b c")
        == .overlapping)
    check(
      "edits that only touch are not overlapping",
      result([Edit(find: "a ", replace: "x"), Edit(find: "b", replace: "y")], "a b") == "xy")
    check(
      "several edits apply right to left against the original text",
      result(
        [Edit(find: "one", replace: "1111"), Edit(find: "three", replace: "3")],
        "one two\nthree") == "1111 two\n3")
    check(
      "matches index the original text, in edit order",
      {
        let own = "x\ny z"
        guard
          case .ok(_, let matches) = MailComposerText.apply(
            [Edit(find: "z", replace: "Z"), Edit(find: "x y", replace: "Q")], to: own)
        else { return false }
        return matches.map { String(own[$0]) } == ["z", "x\ny"]
      }())
    check(
      "non-ASCII text matches and keeps its surroundings",
      result([Edit(find: "ça", replace: "ok")], "Désolé — ça marche") == "Désolé — ok marche")
    check(
      "a quote header is the same quote across a line break",
      MailComposerText.sameQuote("On 22 Oct, X wrote:\nHi", "On 22 Oct, X wrote: Hi"))
    check(
      "different quotes are not the same",
      !MailComposerText.sameQuote("On 22 Oct, X wrote:\nHi", "On 23 Oct, X wrote: Hi"))

    registryChecks()
    dispatchChecks()

    print("\(checks) checks, \(failures) failures")
    if failures > 0 { exit(1) }
  }
}

/// `AppInfo` reaches for screenshot-mode state, which pulls half the app in; the
/// server only asks it for a version string. Same stub as `desktop-check.swift`.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
