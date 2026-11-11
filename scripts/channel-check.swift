import AppKit
import ApplicationServices

/// `make channel-check`: Cupertino drives a Debug build through its
/// `SupportKitDriving` channel, and the app never comes forward.
///
/// Builds on `CupertinoChannelFixture.app` (scripts/channel-fixture.swift), which
/// the Makefile compiles with swift-support-kit's driving sources and registers
/// with Launch Services. It is started through `apple_desktop_launch` with
/// `channel: true`, driven through `AppChannel` directly and through the desktop
/// server's own verbs, and read back through Accessibility.
///
/// Nothing is posted to the session: every command goes through the fixture's
/// channel file. So it is safe while someone works, and it needs the shell's
/// Accessibility grant only to read the fixture back.
@main
struct ChannelCheck {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ condition: Bool) {
    checks += 1
    print("  \(condition ? "ok  " : "FAIL") \(label)")
    if !condition { failures += 1 }
  }

  static let surface = Surface.named("desktop")!
  static let fixture = "io.mgcrea.channel-fixture"

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

  // ─── reading the fixture back ────────────────────────────────────────────

  static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var raw: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &raw) == .success ? raw : nil
  }

  static func find(_ root: AXUIElement, _ id: String, depth: Int = 0) -> AXUIElement? {
    if (attr(root, "AXIdentifier") as? String) == id { return root }
    guard depth < 14, let kids = attr(root, kAXChildrenAttribute) as? [AXUIElement] else {
      return nil
    }
    for kid in kids { if let hit = find(kid, id, depth: depth + 1) { return hit } }
    return nil
  }

  static func centre(_ e: AXUIElement) -> CGPoint {
    var origin = CGPoint.zero
    var size = CGSize.zero
    if let p = attr(e, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &origin) }
    if let s = attr(e, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
  }

  /// SwiftUI's Text reads its string as AXDescription or AXValue depending on
  /// the release; either will do.
  static func text(_ e: AXUIElement?) -> String {
    guard let e else { return "?" }
    return (attr(e, kAXValueAttribute) as? String) ?? (attr(e, kAXDescriptionAttribute) as? String)
      ?? "?"
  }

  static func refusal(_ body: () throws -> Void) -> String {
    do {
      try body()
      return ""
    } catch {
      return error.localizedDescription
    }
  }

  static func main() {
    guard AXIsProcessTrusted() else {
      print("This process has no Accessibility grant.")
      exit(1)
    }

    print("\nfinding a channel")
    let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("channel-check-\(UUID().uuidString)")
    func plant(pid: Int32, readyPid: Int32) -> URL {
      let dir = scratch.appendingPathComponent("SupportKitDriving/\(pid)")
      try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try! "{\"kind\":\"ready\",\"pid\":\(readyPid),\"version\":1}\n".write(
        to: dir.appendingPathComponent("events.jsonl"), atomically: true, encoding: .utf8)
      FileManager.default.createFile(
        atPath: dir.appendingPathComponent("commands.jsonl").path, contents: nil)
      return dir
    }
    // A pid that is not running: the highest a Mac hands out, unused.
    let dead: Int32 = 99_998
    check(
      "a channel left by a process that is gone is not found",
      AppChannel.find(pid: dead, in: [plant(pid: dead, readyPid: dead)]) == nil)
    check(
      "nor one whose ready names another process",
      AppChannel.find(pid: getpid(), in: [plant(pid: getpid(), readyPid: 1)]) == nil)
    check(
      "a channel whose ready names a live process is",
      AppChannel.find(pid: getpid(), in: [plant(pid: getpid() + 0, readyPid: getpid())]) != nil)
    try? FileManager.default.removeItem(at: scratch)

    // Any process of this user can write this user's temporary directory. A
    // channel planted there for an app Cupertino did not launch with one must
    // not be believed, or the agent's keystrokes, a password included, would
    // be written to a file the planter reads.
    if let finder = NSRunningApplication.runningApplications(
      withBundleIdentifier: "com.apple.finder"
    ).first {
      let planted = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("SupportKitDriving/\(finder.processIdentifier)")
      try? FileManager.default.createDirectory(at: planted, withIntermediateDirectories: true)
      try? "{\"kind\":\"ready\",\"pid\":\(finder.processIdentifier),\"version\":1}\n".write(
        to: planted.appendingPathComponent("events.jsonl"), atomically: true, encoding: .utf8)
      FileManager.default.createFile(
        atPath: planted.appendingPathComponent("commands.jsonl").path, contents: nil)
      check(
        "a channel planted for an app Cupertino did not launch with one is not believed",
        AppChannel.find(bundleId: "com.apple.finder") == nil)
      let clicked = call("apple_desktop_click", ["x": -9000, "y": -9000, "bundleId": "com.apple.finder"])
      check("and a verb to that app does not go through it", clicked["lane"] as? String != "channel")
      try? FileManager.default.removeItem(at: planted)
    } else {
      check("Finder is running, to plant a channel for", false)
    }

    print("\nlaunching the fixture with a channel")
    if let stale = NSRunningApplication.runningApplications(withBundleIdentifier: fixture).first {
      stale.forceTerminate()
      Thread.sleep(forTimeInterval: 0.5)
    }
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    // By path, the way a Debug build that shares its bundle id with an installed
    // copy is started.
    let fixturePath = FileManager.default.currentDirectoryPath
      + "/apps/apple/.build/channel-fixture/CupertinoChannelFixture.app"
    let launched = call("apple_desktop_launch", ["path": fixturePath, "channel": true])
    check("it starts behind, by path", launched["launched"] as? Bool == true)
    check("and says it opened a channel", launched["channel"] as? Bool == true)
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: fixture).first
    else {
      print("  FAIL the fixture is not running: \(launched)")
      exit(1)
    }
    var channel: AppChannel?
    for _ in 0..<100 where channel == nil {
      channel = AppChannel.find(pid: app.processIdentifier, bundleId: fixture)
      if channel == nil { Thread.sleep(forTimeInterval: 0.05) }
    }
    guard let channel else {
      print("  FAIL no channel appeared for pid \(app.processIdentifier)")
      app.forceTerminate()
      exit(1)
    }
    check("its channel is found by pid", true)
    let again = call("apple_desktop_launch", ["path": fixturePath, "channel": true])
    check(
      "a second launch by path starts no second copy, and says where the first is",
      again["launched"] as? Bool == false
        && (again["note"] as? String ?? "").contains("CupertinoChannelFixture.app"))
    check(
      "and the first copy keeps its channel",
      AppChannel.find(bundleId: fixture) != nil
        && NSRunningApplication.runningApplications(withBundleIdentifier: fixture).count == 1)

    let root = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.first else {
      print("  FAIL the fixture's window is not readable")
      app.forceTerminate()
      exit(1)
    }
    let nsButton = find(window, "nsButton")
    let nsField = find(window, "nsField")
    let swiftButton = find(window, "swiftButton")
    let stallButton = find(window, "stallButton")
    check(
      "the fixture's controls are readable",
      nsButton != nil && nsField != nil && swiftButton != nil && stallButton != nil)
    guard let nsButton, let nsField, let swiftButton, let stallButton else {
      app.forceTerminate()
      exit(1)
    }

    print("\nthrough AppChannel")
    let b = centre(nsButton)
    let ack = try? channel.send(["verb": "click", "x": b.x, "y": b.y])
    check("a click on an AppKit button is acknowledged", ack?["kind"] as? String == "ack")
    check("and pressed it", text(find(window, "nsTaps")) == "1")
    let outside = refusal { _ = try channel.send(["verb": "click", "x": -9000, "y": -9000]) }
    check(
      "a point on none of its windows is refused by the app",
      outside.contains("no window of this app"))
    let s = centre(stallButton)
    let stalled = refusal { _ = try channel.send(["verb": "click", "x": s.x, "y": s.y]) }
    print("       stalled: \(stalled.isEmpty ? "acknowledged" : stalled)")
    check(
      "an app that does not answer is a refusal naming the wait, not a hang",
      stalled.contains("2 s"))
    Thread.sleep(forTimeInterval: 3.2)

    print("\nthrough the desktop server's verbs")
    let w = centre(swiftButton)
    let clicked = call("apple_desktop_click", ["x": w.x, "y": w.y, "bundleId": fixture])
    check("click goes through the channel", clicked["lane"] as? String == "channel")
    check("and pressed the SwiftUI button", text(find(window, "swiftTaps")) == "1")
    let f = centre(nsField)
    _ = call("apple_desktop_click", ["x": f.x, "y": f.y, "bundleId": fixture])
    let typed = call("apple_desktop_type", ["bundleId": fixture, "text": "abc"])
    check("type goes through the channel", typed["lane"] as? String == "channel")
    check("and the field holds it", (attr(nsField, kAXValueAttribute) as? String) == "abc")
    let keyed = call("apple_desktop_key", ["bundleId": fixture, "key": "a", "modifiers": ["command"]])
    print("       key answer: \(keyed)")
    check("a shortcut goes through the channel", keyed["lane"] as? String == "channel")
    // The selection lives in the field editor, which AX reaches as the field's
    // focused child or as the application's focused element.
    let focused = attr(root, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    let selected = focused.flatMap { attr($0, kAXSelectedTextAttribute) as? String }
    check("and selected all of it", selected == "abc")

    print("\nand the person's Mac")
    check("the fixture never became active", !app.isActive)
    check(
      "the application in front is the one that was",
      NSWorkspace.shared.frontmostApplication?.bundleIdentifier == front)
    let released = call("apple_desktop_release", [:])
    check("the session it opened is released", released["released"] as? String == fixture)

    app.terminate()
    print("\n\(checks - failures)/\(checks) passed")
    exit(failures == 0 ? 0 : 1)
  }
}

/// The stub desktop-check carries: `AppInfo` and the overlay ask screenshot
/// mode, and the real one pulls half the app in behind it.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
