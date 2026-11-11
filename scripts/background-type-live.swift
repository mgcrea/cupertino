import AppKit
import ApplicationServices

/// Live: `apple_desktop_type` with a handle types into a field in the BACKGROUND.
///
/// The in-process desktop server, compiled from this checkout, driven the way
/// `desktop-check` drives it, against a real TextEdit started behind whatever is
/// in front. Unlike `desktop-check` it posts input, so it is not part of any gate:
/// run it by hand with `make background-type-live`. Every event goes to
/// TextEdit's pid, so it is safe while someone works; nothing takes the front.
///
/// Refuses to start while TextEdit is running, so it never touches a document
/// somebody has open. The document it makes is closed unsaved, and TextEdit quit.
@main
struct BackgroundTypeLive {
  static var failures = 0

  static func check(_ label: String, _ condition: Bool) {
    print("  \(condition ? "ok  " : "FAIL") \(label)")
    if !condition { failures += 1 }
  }

  static let surface = Surface.named("desktop")!
  static let textEdit = "com.apple.TextEdit"

  static func call(_ name: String, _ args: [String: Any]) -> [String: Any] {
    let message: [String: Any] = [
      "jsonrpc": "2.0", "id": 1, "method": "tools/call",
      "params": ["name": name, "arguments": args],
    ]
    let line = String(data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard
      let reply = DesktopServer.handle(line, surface: surface, writesAllowed: true, scope: .any),
      let object = try? JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any],
      let result = object["result"] as? [String: Any],
      let text = (result["content"] as? [[String: Any]])?.first?["text"] as? String
    else { return ["error": "no reply"] }
    var body =
      (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [
        "text": text
      ]
    if result["isError"] as? Bool == true { body["isError"] = true }
    return body
  }

  static func osascript(_ source: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", source]
    try? p.run()
    p.waitUntilExit()
  }

  /// Every handle in a find_elements answer, wherever the tree nests it.
  static func handles(in value: Any) -> [String] {
    if let object = value as? [String: Any] {
      return (object["handle"] as? String).map { [$0] } ?? []
        + object.values.flatMap { handles(in: $0) }
    }
    if let list = value as? [Any] { return list.flatMap { handles(in: $0) } }
    return []
  }

  static func main() {
    guard AXIsProcessTrusted() else {
      print("This process has no Accessibility grant.")
      exit(1)
    }
    guard NSRunningApplication.runningApplications(withBundleIdentifier: textEdit).isEmpty else {
      print("TextEdit is running. Quit it first: this check makes and discards its own document.")
      exit(1)
    }
    print("\nbackground type, live against TextEdit")
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier

    let launched = call("apple_desktop_launch", ["bundleId": textEdit])
    check("TextEdit started behind", launched["launched"] as? Bool == true)
    osascript("tell application \"TextEdit\" to make new document")
    Thread.sleep(forTimeInterval: 1)

    let found = call("apple_desktop_find_elements", ["bundleId": textEdit, "role": "AXTextArea"])
    guard let area = handles(in: found).first else {
      print("  FAIL no text area found: \(found)")
      exit(1)
    }
    let text = "typed behind, é ✓"
    let typed = call("apple_desktop_type", ["handle": area, "text": text])
    print("       answer: \(typed)")
    check("it went the background lane", typed["lane"] as? String == "background")
    check("and read back verified", typed["verified"] as? Bool == true)
    let value = call("apple_desktop_get_attribute", ["handle": area, "attribute": "AXValue"])
    check(
      "the document holds the text, accents included",
      (value["value"] as? String ?? "\(value)").contains(text))
    let textEditApp = NSRunningApplication.runningApplications(withBundleIdentifier: textEdit).first
    check("TextEdit never became active", textEditApp?.isActive == false)
    check(
      "the application in front is the one that was",
      NSWorkspace.shared.frontmostApplication?.bundleIdentifier == front)

    let released = call("apple_desktop_release", [:])
    check("the session it opened is released", released["released"] as? String == textEdit)

    osascript("tell application \"TextEdit\" to close every document saving no")
    // AppleScript's quit left a TextEdit started behind running (2026-11-11), so
    // it is asked to terminate directly once it holds no document.
    textEditApp?.terminate()
    print(failures == 0 ? "\nall passed" : "\n\(failures) failed")
    exit(failures == 0 ? 0 : 1)
  }
}

/// The stub desktop-check carries, for the same reason: `AppInfo` and the overlay
/// ask screenshot mode, and the real one pulls half the app in behind it.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
