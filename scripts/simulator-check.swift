import AppKit
import Foundation

/// Asserts that the in-process `simulator` server speaks MCP, answers in iOS
/// points, and cannot drive with writes off.
///
/// ## Why this exists
///
/// The same gate `scripts/verify-servers.sh` cannot be, for the reason
/// `screen-check.swift` gives: a surface the app serves itself has no `cli.js`
/// to scan and no runtime to spawn it under.
///
/// ## Stricter than desktop-check about what it may touch
///
/// On a developer's Mac the terminal that runs this may hold Accessibility by
/// inheritance — `probe-desktop.swift` records an unsigned script answering
/// trusted for exactly that reason — and a Simulator may be booted with an app
/// on screen. So a driving verb called with writes ON would tap, swipe or type
/// into a real device. Every `tools/call` to a driving verb below runs with
/// writes OFF and is answered by the refusal path before `AccessibilityDriver`
/// is reached. The geometry is pinned on numbers, not on a window.
///
/// The reads it does make — `list_devices`, `diagnostics` — walk a Simulator
/// window when one is open and the grant is held, which reads and never acts.
///
/// Run with `make simulator-check`.
@main
struct SimulatorCheck {
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

  static let surface = Surface.named("simulator")!

  static func ask(_ method: String, id: Int = 1, params: [String: Any]? = nil, writes: Bool = false)
    -> [String: Any]?
  {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { message["params"] = params }
    let line = String(
      data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard
      let reply = SimulatorServer.handle(line, surface: surface, writesAllowed: writes),
      let data = reply.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object
  }

  static func tools(writes: Bool) -> [[String: Any]] {
    let result = ask("tools/list", writes: writes)?["result"] as? [String: Any]
    return result?["tools"] as? [[String: Any]] ?? []
  }

  static func toolNames(writes: Bool) -> [String] {
    tools(writes: writes).compactMap { $0["name"] as? String }.sorted()
  }

  static func callText(_ name: String, _ args: [String: Any], writes: Bool) -> (String, Bool) {
    let reply = ask("tools/call", params: ["name": name, "arguments": args], writes: writes)
    let result = reply?["result"] as? [String: Any]
    let content = result?["content"] as? [[String: Any]] ?? []
    let text = content.first?["text"] as? String ?? ""
    return (text, result?["isError"] as? Bool ?? false)
  }

  static func json(_ text: String) -> [String: Any]? {
    text.data(using: .utf8).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
  }

  static let driving = [
    "apple_simulator_key", "apple_simulator_press", "apple_simulator_press_button",
    "apple_simulator_swipe", "apple_simulator_tap", "apple_simulator_type",
  ]

  static let observing = [
    "apple_simulator_diagnostics", "apple_simulator_find_elements",
    "apple_simulator_list_devices", "apple_simulator_ui_tree",
  ]

  static func main() {
    print("\nsimulator server")

    // ─── the table ──────────────────────────────────────────────────────────
    check("the surface is served in-process", surface.runtime == .swift)
    check("the grant is Accessibility", surface.storePermission == .accessibility)
    check("the surface arrives off", !surface.defaultEnabled)
    check("the surface has no gate — nothing widens its reach", surface.gates.isEmpty)
    check("the surface names the Simulator", surface.bundleID == "com.apple.iphonesimulator")
    // Stated as a decision, not left as a side effect: an app surface with a
    // bundle id joins the set desktop and screen read from Surface.all.
    check(
      "Simulator.app is a brokered application for Desktop, by design",
      AccessibilityDriver.inScope("com.apple.iphonesimulator", scope: .brokered))

    // ─── handshake ──────────────────────────────────────────────────────────
    let initialize = ask("initialize")
    let info = (initialize?["result"] as? [String: Any])?["serverInfo"] as? [String: Any]
    check("initialize answers with serverInfo", info?["name"] as? String == "cupertino-simulator")
    check(
      "negotiates the protocol version the node servers do",
      (initialize?["result"] as? [String: Any])?["protocolVersion"] as? String
        == SimulatorServer.protocolVersion)
    check(
      "a notification draws no reply",
      SimulatorServer.handle(
        #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, surface: surface,
        writesAllowed: false) == nil)
    check(
      "an unknown method is a JSON-RPC error",
      ((ask("nope/list")?["error"] as? [String: Any])?["code"] as? Int) == -32601)

    // ─── the gate is registration, not refusal ──────────────────────────────
    let off = toolNames(writes: false)
    let on = toolNames(writes: true)
    check("with writes off, the observing tools are all registered", off == observing.sorted())
    check("with writes off, NO driving tool appears", driving.allSatisfy { !off.contains($0) })
    check("with writes on, every driving tool appears", driving.allSatisfy { on.contains($0) })
    check(
      "writes on is exactly writes off plus the driving tools", on == (observing + driving).sorted()
    )
    check("the tool list is a pure function of the gate", toolNames(writes: false) == off)

    // There is no way to name another application: no tool takes a bundle id,
    // and the reach is not an argument.
    let schemas = tools(writes: true).compactMap { $0["inputSchema"] as? [String: Any] }
    let properties = schemas.flatMap { ($0["properties"] as? [String: Any])?.keys.map { $0 } ?? [] }
    check("no tool declares a bundleId argument", !properties.contains("bundleId"))
    check("no tool declares a modifiers argument", !properties.contains("modifiers"))

    // Refused BEFORE the driver, which is what makes this safe to run with a
    // device booted and a grant held.
    for name in driving {
      let (text, isError) = callText(
        name,
        [
          "handle": "e1", "x": 1, "y": 1, "fromX": 1, "fromY": 1, "toX": 2, "toY": 2,
          "text": "a", "key": "return", "button": "home",
        ],
        writes: false)
      check(
        "\(name) is refused when called with writes off",
        isError && text.lowercased().contains("switched off"))
    }
    check("a refused driving verb lights no indicator", DriveActivity.current() == nil)

    // ─── the observe half answers without a grant ───────────────────────────
    let (listText, listError) = callText("apple_simulator_list_devices", [:], writes: false)
    check("list_devices answers", !listError)
    let list = json(listText)
    check(
      "list_devices reports CoreSimulator's devices or says why not",
      list?["devices"] != nil)
    check(
      "list_devices names its coordinate space",
      (list?["coordinateSpace"] as? String)?.contains("iOS points") == true)
    check(
      "list_devices distinguishes 'could not look' from 'no window'",
      list?["windows"] != nil)

    let (diagText, diagError) = callText("apple_simulator_diagnostics", [:], writes: false)
    check("diagnostics answers", !diagError)
    let diag = json(diagText)
    check(
      "diagnostics reports writes as disabled when they are",
      (diag?["writes"] as? String)?.contains("not registered") == true)
    check(
      "diagnostics reports the grant state rather than assuming it",
      ["granted", "not granted"].contains(diag?["accessibility"] as? String ?? ""))
    check(
      "diagnostics pins the reach to the Simulator and says nothing widens it",
      (diag?["reach"] as? String) == "com.apple.iphonesimulator only — no switch widens it")
    check(
      "diagnostics points at the WebDriverAgent lane's own diagnostics",
      (diag?["wda"] as? String)?.contains("ios_simulator_diagnostics") == true)
    check(
      "diagnostics names the duplicate-TCC-row cure",
      diagText.contains("tccutil reset Accessibility"))
    check(
      "diagnostics reports writes as enabled when they are",
      (json(callText("apple_simulator_diagnostics", [:], writes: true).0)?["writes"] as? String)
        == "enabled")

    // ─── arguments are validated before anything is reached ─────────────────
    let (noCriteria, noCriteriaError) = callText(
      "apple_simulator_find_elements", [:], writes: false)
    check(
      "find_elements with no criteria refuses rather than walking",
      noCriteriaError && noCriteria.contains("at least one"))
    let (unknown, unknownError) = callText("apple_simulator_nope", [:], writes: true)
    check("an unknown tool is a readable refusal", unknownError && unknown.contains("unknown tool"))
    let (badKey, badKeyError) = callText("apple_simulator_key", ["key": "q"], writes: true)
    check(
      "a key outside the device allowlist is refused by name before anything is posted",
      badKeyError && badKey.contains("Unknown device key") && DriveActivity.current() == nil)
    let (badButton, badButtonError) = callText(
      "apple_simulator_press_button", ["button": "power"], writes: true)
    check(
      "an unknown button is refused before anything is posted",
      badButtonError && badButton.contains("Unknown button") && DriveActivity.current() == nil)

    // ─── resources ──────────────────────────────────────────────────────────
    let resources =
      (ask("resources/list")?["result"] as? [String: Any])?["resources"] as? [[String: Any]] ?? []
    check(
      "every resource is cupertino://simulator/*",
      !resources.isEmpty
        && resources.allSatisfy {
          ($0["uri"] as? String)?.hasPrefix("cupertino://simulator/") == true
        })
    func guideText(writes: Bool) -> String {
      let reply = ask(
        "resources/read", params: ["uri": "cupertino://simulator/guide"], writes: writes)
      let contents = (reply?["result"] as? [String: Any])?["contents"] as? [[String: Any]] ?? []
      return contents.first?["text"] as? String ?? ""
    }
    check("the guide states the coordinate space", guideText(writes: false).contains("iOS points"))
    check(
      "the guide sends screenshots to simctl rather than promising one",
      guideText(writes: false).contains("ios_simulator_screenshot"))
    check(
      "the guide says the Simulator is brought to the front for synthetic input",
      guideText(writes: false).contains("frontmost"))
    check(
      "the guide says writes are off when they are",
      guideText(writes: false).contains("Writes are OFF"))
    check(
      "the guide says writes are on when they are",
      guideText(writes: true).contains("Writes are ON"))
    check(
      "an unknown resource is a JSON-RPC error",
      ((ask("resources/read", params: ["uri": "cupertino://simulator/nope"])?["error"]
        as? [String: Any])?["code"] as? Int) == -32602)

    // ─── geometry, on numbers ───────────────────────────────────────────────
    //
    // The measured case, docs/simulator.md: iPhone 17 Pro, group 402x874 at
    // (484, 416), profile 1206x2622 at 3x.
    let iphone = CGSize(width: 402, height: 874)
    let pointAccurate = SimulatorGeometry.resolve(
      groupOrigin: CGPoint(x: 484, y: 416), groupSize: CGSize(width: 402, height: 874),
      portraitPoints: iphone)
    check(
      "a point-accurate window resolves at scale 1, portrait",
      pointAccurate?.scale == 1 && pointAccurate?.orientation == "portrait")
    check(
      "the origin is subtracted: (484, 416) on the Mac is (0, 0) on the device",
      pointAccurate?.toDevice(CGPoint(x: 484, y: 416)) == CGPoint(x: 0, y: 0))
    check(
      "General's Mac rect maps to the rect WebDriverAgent reports",
      pointAccurate?.deviceRect([500, 709.3, 370, 52]) == [16, 293.3, 370, 52])

    let scaled = SimulatorGeometry.resolve(
      groupOrigin: .zero, groupSize: CGSize(width: 273.5, height: 594.6), portraitPoints: iphone)
    check(
      "a Fit Screen window resolves to a fractional scale",
      scaled.map { abs($0.scale - 0.6803) < 0.001 } ?? false)
    check(
      "a fractional scale maps a device point to a Mac point and back",
      scaled.map {
        let p = CGPoint(x: 201, y: 320)
        let back = $0.toDevice($0.toScreen(p))
        return abs(back.x - p.x) < 0.01 && abs(back.y - p.y) < 0.01
      } ?? false)

    let ipad = CGSize(width: 834, height: 1210)
    let landscape = SimulatorGeometry.resolve(
      groupOrigin: .zero, groupSize: CGSize(width: 1210, height: 834), portraitPoints: ipad)
    check(
      "a rotated iPad resolves as landscape with the point size swapped",
      landscape?.orientation == "landscape" && landscape?.pointWidth == 1210
        && landscape?.pointHeight == 834)

    check(
      "a group that fits neither orientation is not a device screen",
      SimulatorGeometry.resolve(
        groupOrigin: .zero, groupSize: CGSize(width: 402, height: 900), portraitPoints: iphone)
        == nil)
    check(
      "a toolbar-sized group is not a device screen",
      SimulatorGeometry.resolve(
        groupOrigin: .zero, groupSize: CGSize(width: 456, height: 52), portraitPoints: iphone)
        == nil)
    check(
      "the screen is half-open: (0, 0) is on it and (402, 0) is not",
      pointAccurate?.contains(CGPoint(x: 0, y: 0)) == true
        && pointAccurate?.contains(CGPoint(x: 402, y: 0)) == false
        && pointAccurate?.contains(CGPoint(x: -1, y: 0)) == false
        && pointAccurate?.contains(CGPoint(x: 401.9, y: 873.9)) == true)

    // ─── CoreSimulator's records, on numbers ────────────────────────────────
    check(
      "a runtime identifier becomes the label the window title carries",
      CoreSimulatorCatalog.runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-5") == "iOS 26.5"
    )
    check(
      "a window title splits on the en dash the Simulator uses",
      CoreSimulatorCatalog.parseWindowTitle("iPhone 17 Pro – iOS 26.5").map {
        $0.name == "iPhone 17 Pro" && $0.runtime == "iOS 26.5"
      } ?? false)
    check(
      "a window title splits on a hyphen too",
      CoreSimulatorCatalog.parseWindowTitle("iPad Pro 13-inch (M4) - iPadOS 26.4").map {
        $0.name == "iPad Pro 13-inch (M4)" && $0.runtime == "iPadOS 26.4"
      } ?? false)
    check(
      "a title with no separator is not a device",
      CoreSimulatorCatalog.parseWindowTitle("Simulator") == nil)
    check(
      "a profile's pixels become points",
      CoreSimulatorCatalog.Profile(pixelWidth: 1206, pixelHeight: 2622, scale: 3).points
        == CGSize(width: 402, height: 874))
    // Absent and unreadable are different answers. A path that does not exist
    // is the Xcode-less Mac; nothing is created to test it.
    let nowhere = FileManager.default.temporaryDirectory
      .appendingPathComponent("cupertino-simulator-check-\(UUID().uuidString)")
    var absent = false
    if case .absent = CoreSimulatorCatalog.devices(home: nowhere) { absent = true }
    check("a Mac with no CoreSimulator directory reads as absent, not as empty", absent)

    // ─── the notice's two tiers ─────────────────────────────────────────────
    // Last on purpose: `record` lights the indicator for `linger` seconds, and
    // every refusal above asserts that nothing is lit.
    //
    // `current()` is what hover's idle test and both diagnostics read, and it
    // means "synthetic input is being posted". A Safari tab changing is not
    // that, so an info notice must leave it alone or hover would start refusing
    // on the strength of somebody else's page load.
    DriveActivity.inform("com.apple.Safari", .showing(.openingPage))
    check("an info notice is not driving", DriveActivity.current() == nil)
    check(
      "and is reported as what it is",
      DriveActivity.notice()?.target == "com.apple.Safari"
        && DriveActivity.notice()?.kind == .showing(.openingPage))

    DriveActivity.inform("com.apple.mail", .driving)
    check("a driving notice from the table is driving", DriveActivity.current() == "com.apple.mail")

    // The orange card asks for hands off the keyboard. A launch landing in the
    // middle of a sequence must not swap it for one saying "keep working".
    DriveActivity.inform("com.apple.Notes", .launching)
    check(
      "info does not replace a live driving notice",
      DriveActivity.notice()?.kind == .driving
        && DriveActivity.notice()?.target == "com.apple.mail")

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in
/// behind it. The server only ever asks it for a version string.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
