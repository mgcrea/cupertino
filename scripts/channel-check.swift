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
        (try? AppChannel.find(bundleId: "com.apple.finder")) == nil)
      let clicked = call(
        "apple_desktop_click", ["x": -9000, "y": -9000, "bundleId": "com.apple.finder"])
      check(
        "and a verb to that app does not go through it", clicked["lane"] as? String != "channel")
      try? FileManager.default.removeItem(at: planted)
    } else {
      check("Finder is running, to plant a channel for", false)
    }

    // A version 1 app ignores what it does not know, so a middle-button drag
    // would arrive as a left one: refused before anything is written.
    let v1Dir = scratch.appendingPathComponent("v1")
    try? FileManager.default.createDirectory(at: v1Dir, withIntermediateDirectories: true)
    try? "{\"kind\":\"ready\",\"pid\":\(getpid())}\n".write(
      to: v1Dir.appendingPathComponent("events.jsonl"), atomically: true, encoding: .utf8)
    FileManager.default.createFile(
      atPath: v1Dir.appendingPathComponent("commands.jsonl").path, contents: nil)
    let v1 = AppChannel.find(pid: getpid(), in: [v1Dir])
    check("a ready that names no version is version 1", v1?.version == 1)
    let v1Refusal = refusal {
      _ = try v1?.send([
        "verb": "drag", "from": [1, 2], "to": [30, 40], "button": "other",
        "modifiers": ["option"],
      ])
    }
    print("       version 1: \(v1Refusal)")
    check(
      "a version 2 field sent to it is refused, naming the version",
      v1Refusal.contains("version 1") && v1Refusal.contains("1.25.0"))
    check(
      "and nothing was written to it",
      (try? String(contentsOf: v1Dir.appendingPathComponent("commands.jsonl"), encoding: .utf8))
        == "")
    try? FileManager.default.removeItem(at: scratch)

    print("\nlaunching the fixture with a channel")
    for stale in NSRunningApplication.runningApplications(withBundleIdentifier: fixture) {
      stale.forceTerminate()
    }
    Thread.sleep(forTimeInterval: 0.5)
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    // By path, the way a Debug build that shares its bundle id with an installed
    // copy is started.
    let fixturePath =
      FileManager.default.currentDirectoryPath
      + "/apps/apple/.build/channel-fixture/CupertinoChannelFixture.app"
    let launched = call("apple_desktop_launch", ["path": fixturePath, "channel": true])
    check("it starts behind, by path", launched["launched"] as? Bool == true)
    check("and says it opened a channel", launched["channel"] as? Bool == true)
    check("and which process it started", launched["pid"] is Int)
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
      (try? AppChannel.find(bundleId: fixture)) != nil
        && NSRunningApplication.runningApplications(withBundleIdentifier: fixture).count == 1)
    check("the channel is version 2", channel.version == 2)

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
    let keyed = call(
      "apple_desktop_key", ["bundleId": fixture, "key": "a", "modifiers": ["command"]])
    print("       key answer: \(keyed)")
    check("a shortcut goes through the channel", keyed["lane"] as? String == "channel")
    // The selection lives in the field editor, which AX reaches as the field's
    // focused child or as the application's focused element.
    let focused = attr(root, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }
    let selected = focused.flatMap { attr($0, kAXSelectedTextAttribute) as? String }
    check("and selected all of it", selected == "abc")

    print("\nversion 2, read back by the fixture")
    let probe = find(window, "probe")
    let dragLog = { text(find(window, "dragLog")) }
    let scrollLog = { text(find(window, "scrollLog")) }
    check("the probe is readable", probe != nil)
    let p = probe.map(centre) ?? .zero
    let middle = call(
      "apple_desktop_drag",
      [
        "from": ["x": p.x - 100, "y": p.y - 10], "to": ["x": p.x + 60, "y": p.y + 14],
        "bundleId": fixture, "button": "middle", "modifiers": ["option"],
      ])
    print("       middle drag: \(middle)")
    print("       read back: \(dragLog())")
    check(
      "a middle-button drag holding option goes through the channel",
      middle["lane"] as? String == "channel" && middle["button"] as? String == "middle")
    check(
      "and arrives as one, option held, carrying all of its movement",
      dragLog().hasPrefix("middle ") && dragLog().contains("option true")
        && dragLog().contains("delta 160,24"))
    let pacedStarted = Date()
    let paced = call(
      "apple_desktop_drag",
      [
        "from": ["x": p.x - 100, "y": p.y], "to": ["x": p.x + 100, "y": p.y],
        "bundleId": fixture, "paced": true, "durationMs": 400,
      ])
    let pacedSeconds = Date().timeIntervalSince(pacedStarted)
    print("       paced drag: \(paced), \(String(format: "%.2f", pacedSeconds)) s")
    print("       read back: \(dragLog())")
    check(
      "a paced drag is acknowledged once it has taken its time",
      paced["lane"] as? String == "channel" && paced["isError"] == nil && pacedSeconds >= 0.35)
    check(
      "and arrives as a left drag over that time, without option",
      dragLog().hasPrefix("left ") && dragLog().contains("option false")
        && dragLog().contains("delta 200,0")
        && (Int(dragLog().split(separator: " ").last ?? "") ?? 0) >= 300)
    let pixel = call(
      "apple_desktop_scroll",
      ["x": p.x, "y": p.y, "dy": -30, "units": "pixel", "bundleId": fixture])
    print("       pixel scroll: \(pixel)")
    print("       read back: \(scrollLog())")
    check("a pixel scroll goes through the channel", pixel["lane"] as? String == "channel")
    check(
      "and arrives as a trackpad's, 30 points",
      scrollLog().hasPrefix("precise true") && scrollLog().hasSuffix("dy -30"))
    let line = call(
      "apple_desktop_scroll", ["x": p.x, "y": p.y, "dy": 3, "bundleId": fixture])
    print("       read back: \(scrollLog())")
    check(
      "a line scroll arrives as a wheel's",
      line["lane"] as? String == "channel" && scrollLog().hasPrefix("precise false"))
    let hovered = call(
      "apple_desktop_hover",
      [
        "x": p.x, "y": p.y, "from": ["x": p.x - 50, "y": p.y], "durationMs": 100,
        "bundleId": fixture,
      ])
    print("       hover from: \(hovered)")
    check(
      "a hover with a start goes through the channel, the app's note passed on as it was",
      hovered["lane"] as? String == "channel"
        && (hovered["note"] as? String ?? "").contains("hover is not yet measured"))

    print("\ntwo copies, each by its pid")
    // A second copy at a second path, as a worktree's Debug build sits beside
    // the main checkout's.
    let secondPath =
      FileManager.default.currentDirectoryPath
      + "/apps/apple/.build/channel-fixture/second/CupertinoChannelFixture.app"
    try? FileManager.default.removeItem(atPath: secondPath)
    try? FileManager.default.createDirectory(
      atPath: (secondPath as NSString).deletingLastPathComponent,
      withIntermediateDirectories: true)
    try? FileManager.default.copyItem(atPath: fixturePath, toPath: secondPath)
    let plain = call("apple_desktop_launch", ["path": secondPath])
    check(
      "a second copy without a channel is not started",
      plain["launched"] as? Bool == false
        && NSRunningApplication.runningApplications(withBundleIdentifier: fixture).count == 1)
    let beside = call("apple_desktop_launch", ["path": secondPath, "channel": true])
    print("       beside: \(beside)")
    let firstPid = Int(app.processIdentifier)
    let secondPid = beside["pid"] as? Int ?? -1
    check(
      "with a channel it starts beside the first, and answers its pid",
      beside["launched"] as? Bool == true && beside["channel"] as? Bool == true
        && secondPid > 0 && secondPid != firstPid
        && NSRunningApplication.runningApplications(withBundleIdentifier: fixture).count == 2)
    let second = NSRunningApplication(processIdentifier: pid_t(secondPid))
    let listedCopies = (call("apple_desktop_list_apps", [:])["apps"] as? [[String: Any]] ?? [])
      .filter { $0["bundleId"] as? String == fixture }
    check(
      "list_apps tells the two apart by path",
      Set(listedCopies.compactMap { $0["pid"] as? Int }) == [firstPid, secondPid]
        && Set(listedCopies.compactMap { $0["path"] as? String }).count == 2)
    let ambiguous = call("apple_desktop_click", ["x": b.x, "y": b.y, "bundleId": fixture])
    let ambiguousText = ambiguous["text"] as? String ?? ""
    print("       by bundle id: \(ambiguousText)")
    check(
      "a click by bundle id alone is refused, listing both copies",
      ambiguous["isError"] as? Bool == true && ambiguousText.contains("\(firstPid)")
        && ambiguousText.contains("\(secondPid)") && ambiguousText.contains("'pid'"))
    let ambiguousRead = call("apple_desktop_list_windows", ["bundleId": fixture])
    check(
      "and so is a read",
      ambiguousRead["isError"] as? Bool == true
        && (ambiguousRead["text"] as? String ?? "").contains("\(secondPid)"))
    var secondWindow: AXUIElement?
    for _ in 0..<40 where secondWindow == nil {
      secondWindow =
        (attr(AXUIElementCreateApplication(pid_t(secondPid)), kAXWindowsAttribute)
        as? [AXUIElement])?.first
      if secondWindow == nil { Thread.sleep(forTimeInterval: 0.05) }
    }
    let firstTaps = { text(find(window, "nsTaps")) }
    let secondTaps = { secondWindow.map { text(find($0, "nsTaps")) } ?? "?" }
    let before = firstTaps()
    let after = "\((Int(before) ?? 0) + 1)"
    // swift-support-kit acknowledges a click only after an event queued behind
    // its up, and the button's action sets the label inside that up, so the
    // label should read the new count by the time the ack arrives. On six runs
    // on 2026-11-16 it did, on the first read, in 0 to 2 ms. One earlier run
    // failed this read once, and how was not logged. So it is read until it
    // holds, for a second at most, and the log says what the first read gave:
    // "?" is an Accessibility read that came back empty, a harmless flake; the
    // old count would be an effect that trailed its ack, which is a question
    // for swift-support-kit's ack ordering, not a reason to wait longer.
    func settles(_ label: String, _ read: () -> String, _ expected: String) -> Bool {
      let started = Date()
      let first = read()
      var last = first
      var reads = 1
      while last != expected && Date().timeIntervalSince(started) < 1 {
        Thread.sleep(forTimeInterval: 0.05)
        last = read()
        reads += 1
      }
      let ms = Int(Date().timeIntervalSince(started) * 1000)
      print(
        "       \(label): first read \"\(first)\", \(last == expected ? "settled" : "never settled") "
          + "on read \(reads), \(ms) ms")
      return last == expected
    }
    // A label that must NOT change is watched for the same second a settling
    // one is given, so a click that reached the wrong copy late is not missed.
    func stays(_ label: String, _ read: () -> String, _ expected: String) -> Bool {
      let started = Date()
      repeat {
        let now = read()
        guard now == expected else {
          print("       \(label): read \"\(now)\", expected \"\(expected)\"")
          return false
        }
        Thread.sleep(forTimeInterval: 0.05)
      } while Date().timeIntervalSince(started) < 1
      return true
    }
    // The same point: both windows sit in one place, one over the other.
    let toSecond = call("apple_desktop_click", ["x": b.x, "y": b.y, "pid": secondPid])
    print("       to the second: \(toSecond)")
    check(
      "a click by pid reaches that copy through its channel",
      toSecond["lane"] as? String == "channel" && toSecond["pid"] as? Int == secondPid
        && settles("the second copy's count", secondTaps, "1"))
    check("and not the other", stays("the first copy's count", firstTaps, before))
    let toFirst = call(
      "apple_desktop_click", ["x": b.x, "y": b.y, "pid": firstPid, "bundleId": fixture])
    check(
      "a click by pid and bundle id reaches the first",
      toFirst["pid"] as? Int == firstPid && settles("the first copy's count", firstTaps, after))
    check("and not the second", stays("the second copy's count", secondTaps, "1"))
    let mismatched = call(
      "apple_desktop_click", ["x": b.x, "y": b.y, "pid": firstPid, "bundleId": "com.apple.finder"])
    check(
      "a pid and a bundle id that disagree reach nothing",
      mismatched["isError"] as? Bool == true
        && stays("the first copy's count", firstTaps, after)
        && stays("the second copy's count", secondTaps, "1"))
    let found = call(
      "apple_desktop_find_elements", ["pid": secondPid, "id": "nsButton"])
    let foundHandle = (found["elements"] as? [[String: Any]])?.first?["handle"] as? String
    check("a search by pid finds that copy's control", foundHandle != nil)
    let byHandle = call("apple_desktop_hover", ["handle": foundHandle ?? "", "durationMs": 50])
    print("       hover by its handle: \(byHandle)")
    check(
      "and its handle reaches that copy's channel, not the other's",
      byHandle["lane"] as? String == "channel" && byHandle["pid"] as? Int == secondPid)
    let scrolledSecond = call(
      "apple_desktop_scroll",
      ["x": p.x, "y": p.y, "dy": -12, "units": "pixel", "pid": secondPid])
    let secondScroll = secondWindow.map { text(find($0, "scrollLog")) } ?? "?"
    check(
      "a scroll by pid reaches that copy only",
      scrolledSecond["pid"] as? Int == secondPid && secondScroll.hasSuffix("dy -12")
        && !scrollLog().hasSuffix("dy -12"))
    let crossed = call(
      "apple_desktop_hover", ["handle": foundHandle ?? "", "pid": firstPid, "durationMs": 50])
    check(
      "a pid beside a handle of the other copy reaches neither",
      crossed["isError"] as? Bool == true
        && (crossed["text"] as? String ?? "").contains("\(secondPid), not pid \(firstPid)"))
    let acrossCopies = call(
      "apple_desktop_drag",
      [
        "from": ["x": p.x - 50, "y": p.y, "pid": secondPid],
        "to": ["x": p.x + 50, "y": p.y, "pid": firstPid], "button": "middle",
      ])
    print("       middle drag across copies: \(acrossCopies["text"] ?? acrossCopies)")
    check(
      "a middle-button drag from one copy onto the other is refused, blaming the drop",
      acrossCopies["isError"] as? Bool == true
        && (acrossCopies["text"] as? String ?? "").contains("another copy"))
    // The same app built without DEBUG: it opens no channel, so the copy
    // started beside the others is quit again.
    let plainPath =
      FileManager.default.currentDirectoryPath
      + "/apps/apple/.build/channel-fixture/plain/CupertinoChannelFixture.app"
    let plainLaunch = call("apple_desktop_launch", ["path": plainPath, "channel": true])
    print("       beside, without a channel: \(plainLaunch["text"] ?? plainLaunch)")
    Thread.sleep(forTimeInterval: 0.3)
    check(
      "a copy started beside the others that opens no channel is quit again, and refused",
      plainLaunch["isError"] as? Bool == true
        && (plainLaunch["text"] as? String ?? "").contains("opened no driving channel")
        && NSRunningApplication.runningApplications(withBundleIdentifier: fixture)
          .filter { !$0.isTerminated }.count == 2
    )
    check("neither copy became active", !app.isActive && second?.isActive != true)

    print("\nand the person's Mac")
    check("the fixture never became active", !app.isActive)
    check(
      "the application in front is the one that was",
      NSWorkspace.shared.frontmostApplication?.bundleIdentifier == front)
    let released = call("apple_desktop_release", [:])
    check("the session it opened is released", released["released"] as? String == fixture)

    app.terminate()
    second?.terminate()
    // Whatever the code under test left: the plain copy is quit by launch
    // itself, and a failure there must not leave it running.
    Thread.sleep(forTimeInterval: 0.5)
    for left in NSRunningApplication.runningApplications(withBundleIdentifier: fixture) {
      left.forceTerminate()
    }
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
