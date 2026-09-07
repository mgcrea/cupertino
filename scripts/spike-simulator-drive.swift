import AppKit
import Foundation

/// Spike: can the `desktop` lane DRIVE an iOS Simulator with synthetic input,
/// and in which coordinate space?
///
/// docs/simulator.md measured the read half and one AXPress on an alert. It did
/// not measure the two things a `simulator` surface would rest on:
///
///   1. Does a CGEvent click at a Mac screen point land in the simulated
///      device — and does it land when Simulator.app is NOT frontmost?
///   2. Does a mouse drag arrive as a touch pan, and does its duration decide
///      between a scroll and a fling, the way WebDriverAgent's `duration_ms` does?
///
/// It also settles the geometry: the device screen is an AXGroup inside the
/// Simulator window whose size is the device's point size TIMES the window
/// scale, and the scale is any factor — `WindowScale` in the Simulator's
/// preferences was 1 on one device and 0.68 on another on the Mac this was
/// written on. So the mapping is derived from the measured group against the
/// device type's `profile.plist`, never assumed to be 1.
///
/// ## What makes this safe to run
///
/// Nothing is pressed without a flag. The default run lists Simulator windows,
/// resolves each one's device screen, reports the scale, and cross-checks it
/// against CoreSimulator's plists. Each driving leg is its own flag, and every
/// one of them acts on Apple's own Settings app in the simulated device, never
/// on a Mac application.
///
/// ## Read the identity separately
///
/// TCC attributes Accessibility to the responsible GUI ancestor. Run from a
/// terminal this inherits the editor's grant — probe-desktop.swift records an
/// unsigned main.swift answering trusted for exactly that reason — so a green
/// run here says nothing about Cupertino.app's own identity. Without the grant
/// it stops rather than prompting.
///
/// Usage:
///   make simulator-spike SPIKE_ARGS="[--tap] [--activate] [--swipe] [--type] [--home] [--lock]"
///
/// Stage Settings on the booted device first: `xcrun simctl launch booted com.apple.Preferences`.
@main
struct SimulatorDriveSpike {
  static let args = CommandLine.arguments
  static func flag(_ name: String) -> Bool { args.contains(name) }

  static let bundleId = "com.apple.iphonesimulator"
  /// The Simulator is not a brokered app, so the spike reaches it the way the
  /// Desktop surface would with its scope gate on.
  static let scope = AccessibilityDriver.Scope.any

  // ─── output ────────────────────────────────────────────────────────────────

  static func section(_ title: String) {
    print(
      "\n\u{2500}\u{2500} \(title) "
        + String(repeating: "\u{2500}", count: max(0, 60 - title.count)))
  }
  static func row(_ key: String, _ value: String) {
    print("  \(key.padding(toLength: 26, withPad: " ", startingAt: 0)) \(value)")
  }
  static func fmt(_ v: Double) -> String { String(format: "%.1f", v) }
  static func fmt(_ r: [Double]) -> String { "[" + r.map(fmt).joined(separator: ",") + "]" }

  // ─── CoreSimulator, read from plists and never from simctl ─────────────────

  struct SimDevice {
    let udid: String
    let name: String
    let runtime: String
    let deviceType: String
    let state: Int
    var booted: Bool { state == 3 }
    var runtimeLabel: String {
      // com.apple.CoreSimulator.SimRuntime.iOS-26-5 -> iOS 26.5
      let tail = runtime.components(separatedBy: ".").last ?? runtime
      var parts = tail.components(separatedBy: "-")
      guard parts.count >= 2 else { return tail }
      let os = parts.removeFirst()
      return "\(os) \(parts.joined(separator: "."))"
    }
  }

  static func plist(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
  }

  static func devices() -> [SimDevice] {
    let root = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Developer/CoreSimulator/Devices")
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else {
      return []
    }
    return names.compactMap { dir in
      guard let p = plist(root.appendingPathComponent(dir).appendingPathComponent("device.plist")),
        let udid = p["UDID"] as? String, let name = p["name"] as? String,
        let runtime = p["runtime"] as? String, let type = p["deviceType"] as? String,
        let state = p["state"] as? Int
      else { return nil }
      return SimDevice(udid: udid, name: name, runtime: runtime, deviceType: type, state: state)
    }
  }

  /// Portrait point size for a device type, from its profile.plist.
  static func points(forDeviceType wanted: String) -> CGSize? {
    let root = URL(fileURLWithPath: "/Library/Developer/CoreSimulator/Profiles/DeviceTypes")
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else {
      return nil
    }
    for dir in names where dir.hasSuffix(".simdevicetype") {
      let bundle = root.appendingPathComponent(dir)
      guard let info = plist(bundle.appendingPathComponent("Contents/Info.plist")),
        info["CFBundleIdentifier"] as? String == wanted,
        let profile = plist(bundle.appendingPathComponent("Contents/Resources/profile.plist")),
        let w = profile["mainScreenWidth"] as? Double,
        let h = profile["mainScreenHeight"] as? Double,
        let scale = profile["mainScreenScale"] as? Double, scale > 0
      else { continue }
      return CGSize(width: (w / scale).rounded(), height: (h / scale).rounded())
    }
    return nil
  }

  static func windowScalePreference(udid: String) -> [Double] {
    let url = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Preferences/com.apple.iphonesimulator.plist")
    guard let p = plist(url), let prefs = p["DevicePreferences"] as? [String: Any],
      let device = prefs[udid] as? [String: Any],
      let geometry = device["SimulatorWindowGeometry"] as? [String: Any]
    else { return [] }
    return geometry.values.compactMap { ($0 as? [String: Any])?["WindowScale"] as? Double }
  }

  // ─── geometry ──────────────────────────────────────────────────────────────

  struct DeviceFrame {
    let origin: CGPoint
    let scale: Double
    let points: CGSize  // oriented
    let orientation: String
    func toDevice(_ p: CGPoint) -> CGPoint {
      CGPoint(x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale)
    }
    func toScreen(_ p: CGPoint) -> CGPoint {
      CGPoint(x: origin.x + p.x * scale, y: origin.y + p.y * scale)
    }
    func deviceRect(_ r: [Double]) -> [Double] {
      let o = toDevice(CGPoint(x: r[0], y: r[1]))
      return [o.x, o.y, r[2] / scale, r[3] / scale]
    }
  }

  static func resolve(groupRect r: [Double], portrait: CGSize, tolerance: Double = 0.01)
    -> DeviceFrame?
  {
    let candidates: [(CGSize, String)] = [
      (portrait, "portrait"), (CGSize(width: portrait.height, height: portrait.width), "landscape"),
    ]
    for (size, orientation) in candidates {
      let sw = r[2] / size.width
      let sh = r[3] / size.height
      guard sw > 0, sh > 0, abs(sw - sh) / sw <= tolerance else { continue }
      return DeviceFrame(
        origin: CGPoint(x: r[0], y: r[1]), scale: (sw + sh) / 2, points: size,
        orientation: orientation)
    }
    return nil
  }

  // ─── the drag primitive under test ─────────────────────────────────────────

  static func drag(from: CGPoint, to: CGPoint, durationMs: Int) {
    let source = CGEventSource(stateID: .hidSystemState)
    func post(_ type: CGEventType, _ at: CGPoint) {
      guard
        let e = CGEvent(
          mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left)
      else { return }
      e.post(tap: .cghidEventTap)
    }
    let steps = max(2, durationMs / 16)
    post(.mouseMoved, from)
    post(.leftMouseDown, from)
    for i in 1...steps {
      let t = Double(i) / Double(steps)
      post(
        .leftMouseDragged,
        CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
      usleep(16_000)
    }
    post(.leftMouseUp, to)
  }

  // ─── walking the device screen ─────────────────────────────────────────────

  static func screen(_ handle: String, detail: AccessibilityDriver.Detail = .interactive)
    -> [AccessibilityDriver.Element]
  {
    (try? AccessibilityDriver.expand(
      handle: handle, detail: detail, bounds: .init(), scope: scope))?.elements ?? []
  }

  static func find(_ handle: String, named: String, role: String? = nil)
    -> AccessibilityDriver.Element?
  {
    screen(handle, detail: .all).first {
      ($0.name ?? "").localizedCaseInsensitiveContains(named) && (role == nil || $0.role == role)
    }
  }

  /// Poll rather than settle — the trap docs/desktop.md records.
  static func poll(_ seconds: Double, until condition: () -> Bool) -> Double? {
    let started = Date()
    while Date().timeIntervalSince(started) < seconds {
      if condition() { return Date().timeIntervalSince(started) }
      usleep(100_000)
    }
    return nil
  }

  /// The application that holds the focus RIGHT NOW, asked of the window
  /// server through Accessibility. `NSWorkspace.frontmostApplication` is
  /// KVO-fed and never refreshes in a process without a run loop, so a CLI
  /// reads whatever was frontmost when it started — measured: six activation
  /// trials all reported "0.0 ms" because the value never moved.
  static func frontmostBundleId() -> String? {
    var raw: AnyObject?
    guard
      AXUIElementCopyAttributeValue(
        AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &raw)
        == .success, let raw
    else { return nil }
    var pid: pid_t = 0
    guard AXUIElementGetPid(raw as! AXUIElement, &pid) == .success else { return nil }
    return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
  }

  /// Activate and WAIT for it, reporting whether it took. `activate()` is
  /// cooperative on macOS 14+, and from a terminal-launched process it does not
  /// always win the focus — the --home leg's first run sent its chord to the
  /// editor because of exactly that.
  static func activateAndWait(ignoringOthers: Bool = false) -> Double? {
    guard
      let app = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleIdentifier == bundleId
      })
    else { return nil }
    if ignoringOthers {
      _ = app.activate(options: [.activateIgnoringOtherApps])
    } else {
      _ = app.activate()
    }
    return poll(2) { frontmostBundleId() == bundleId }
  }

  /// Type by KEY CODE, one character at a time, resolved against the Mac's
  /// current layout. The Simulator forwards HID key codes to the device and
  /// ignores the unicode string a Mac app would read — measured: the driver's
  /// `type("acc")`, one event carrying the string on virtual key 0, arrived as
  /// a single "Q", which is key code 0 on this AZERTY Mac.
  static func typeByKeys(_ text: String) -> [Character] {
    var unmapped: [Character] = []
    let source = CGEventSource(stateID: .hidSystemState)
    for ch in text {
      let lower = String(ch).lowercased()
      guard let code = AccessibilityDriver.keyCode(for: lower) else {
        unmapped.append(ch)
        continue
      }
      let shifted = String(ch) != lower
      guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
      else { continue }
      if shifted {
        down.flags = .maskShift
        up.flags = .maskShift
      }
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      usleep(20_000)
    }
    return unmapped
  }

  static func relaunchSettings() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    p.arguments = ["simctl", "launch", "booted", "com.apple.Preferences"]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
  }

  static func main() {
    section("identity")
    row("AXIsProcessTrusted()", AccessibilityDriver.isTrusted() ? "true (inherited)" : "FALSE")
    guard AccessibilityDriver.isTrusted() else {
      print("  UNDETERMINED: no Accessibility grant, and this never prompts.")
      exit(2)
    }
    row(
      "Simulator running",
      NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == bundleId }
        ? "yes" : "NO")
    row("frontmost", frontmostBundleId() ?? "?")

    section("CoreSimulator")
    let all = devices()
    let booted = all.filter(\.booted)
    row("devices", "\(all.count), booted \(booted.count)")
    for d in booted {
      let pts = points(forDeviceType: d.deviceType)
      row(
        "  \(d.name)",
        "\(d.runtimeLabel)  \(d.udid)  points \(pts.map { "\(Int($0.width))x\(Int($0.height))" } ?? "?")  WindowScale pref \(windowScalePreference(udid: d.udid))"
      )
    }

    section("Simulator windows")
    let windows: [AccessibilityDriver.WindowRef]
    do {
      windows = try AccessibilityDriver.windows(bundleId: bundleId, scope: scope)
    } catch {
      print("  UNDETERMINED: \(error.localizedDescription)")
      exit(2)
    }

    var frames:
      [(
        window: AccessibilityDriver.WindowRef, device: SimDevice, group: String, frame: DeviceFrame
      )] = []
    for w in windows {
      row("window \(w.index)", "\(w.title ?? "<untitled>")  \(w.rect.map(fmt) ?? "")")
      let started = Date()
      guard
        let tree = try? AccessibilityDriver.tree(
          bundleId: bundleId, windowIndex: w.index, detail: .all,
          bounds: .init(depth: 1, nodes: 200, seconds: 2), scope: scope)
      else { continue }
      let children = tree.elements.filter { $0.depth == 1 }
      row("  children", "\(children.count) in \(fmt(Date().timeIntervalSince(started) * 1000)) ms")
      for c in children {
        row("    \(c.role)", "\(c.name ?? "") \(c.rect.map(fmt) ?? "")")
      }
      // Title -> device. "iPhone 17 Pro – iOS 26.5" (en dash).
      let title = w.title ?? ""
      let matched = booted.first { title.hasPrefix($0.name) && title.hasSuffix($0.runtimeLabel) }
      guard let device = matched else {
        row("  device", "no booted device matches the title")
        continue
      }
      guard let pts = points(forDeviceType: device.deviceType) else {
        row("  device", "\(device.name): no profile.plist")
        continue
      }
      let groups = children.filter { $0.role == "AXGroup" && $0.rect != nil }
      guard
        let hit = groups.lazy.compactMap({ g in
          resolve(groupRect: g.rect!, portrait: pts).map { (g, $0) }
        }).first
      else {
        row(
          "  device screen",
          "NOT FOUND among \(groups.count) AXGroup(s) for \(Int(pts.width))x\(Int(pts.height))")
        continue
      }
      row("  device", "\(device.name) \(device.runtimeLabel)")
      row(
        "  device screen",
        "\(hit.0.handle) origin (\(fmt(hit.1.origin.x)),\(fmt(hit.1.origin.y))) scale \(String(format: "%.4f", hit.1.scale)) \(hit.1.orientation) \(Int(hit.1.points.width))x\(Int(hit.1.points.height))"
      )
      frames.append((w, device, hit.0.handle, hit.1))
    }

    guard let target = frames.first else {
      print("\n  UNDETERMINED: no window resolved to a device screen.")
      exit(2)
    }
    let group = target.group
    let frame = target.frame

    section("screen elements, in iOS points")
    let started = Date()
    let elements = screen(group)
    row("interactive", "\(elements.count) in \(fmt(Date().timeIntervalSince(started) * 1000)) ms")
    for e in elements.prefix(16) {
      row("  \(e.role)", "\(e.name ?? "") \(e.rect.map { fmt(frame.deviceRect($0)) } ?? "")")
    }

    if flag("--activation") {
      section("activation: does activate() win the focus from a CLI?")
      for trial in 1...3 {
        _ = NSWorkspace.shared.runningApplications.first {
          $0.bundleIdentifier == "com.microsoft.VSCode"
        }?.activate(options: [.activateIgnoringOtherApps])
        _ = poll(2) { frontmostBundleId() == "com.microsoft.VSCode" }
        let before = frontmostBundleId() ?? "?"
        let plain = activateAndWait()
        row(
          "plain activate() #\(trial)",
          "from \(before): "
            + (plain.map { "frontmost after \(fmt($0 * 1000)) ms" } ?? "NOT frontmost within 2 s"))
      }
      for trial in 1...3 {
        _ = NSWorkspace.shared.runningApplications.first {
          $0.bundleIdentifier == "com.microsoft.VSCode"
        }?.activate(options: [.activateIgnoringOtherApps])
        _ = poll(2) { frontmostBundleId() == "com.microsoft.VSCode" }
        let before = frontmostBundleId() ?? "?"
        let forced = activateAndWait(ignoringOthers: true)
        row(
          "ignoringOtherApps #\(trial)",
          "from \(before): "
            + (forced.map { "frontmost after \(fmt($0 * 1000)) ms" } ?? "NOT frontmost within 2 s"))
      }
    }

    if flag("--tap") {
      section("tap: CGEvent click on 'General'")
      if flag("--activate") {
        try? AccessibilityDriver.activate(bundleId: bundleId, scope: scope)
        usleep(300_000)
      }
      row("frontmost at click", frontmostBundleId() ?? "?")
      guard let general = find(group, named: "General"), let rect = general.rect else {
        print("  UNDETERMINED: no 'General' on screen — stage Settings' root list first.")
        exit(2)
      }
      let device = frame.deviceRect(rect)
      let centre = CGPoint(x: device[0] + device[2] / 2, y: device[1] + device[3] / 2)
      let at = frame.toScreen(centre)
      row("General (device)", fmt(device))
      row(
        "click at (device)",
        "(\(fmt(centre.x)),\(fmt(centre.y))) -> screen (\(fmt(at.x)),\(fmt(at.y)))")
      let t0 = Date()
      try? AccessibilityDriver.click(x: at.x, y: at.y)
      let landed = poll(4) { find(group, named: "About") != nil }
      row("'About' appeared", landed.map { "after \(fmt($0 * 1000)) ms" } ?? "NO within 4 s")
      row("frontmost after", frontmostBundleId() ?? "?")
      _ = t0
      if landed != nil {
        // Back to the root list so the other legs find it.
        if let back = screen(group, detail: .all).first(where: {
          ($0.name ?? "").hasPrefix("Settings") && $0.pressable
        }) {
          try? AccessibilityDriver.press(handle: back.handle, scope: scope)
          _ = poll(3) { find(group, named: "General") != nil }
          row("back to root", find(group, named: "General") != nil ? "yes" : "no")
        }
      }
    }

    if flag("--swipe") {
      section("swipe: drag as a touch pan")
      // Measured by --tap: a synthetic event lands only once the Simulator has
      // been activated; without it the click went to whatever covered the window.
      try? AccessibilityDriver.activate(bundleId: bundleId, scope: scope)
      usleep(300_000)
      guard let before = find(group, named: "General"), let r0 = before.rect else {
        print("  UNDETERMINED: no 'General' on screen.")
        exit(2)
      }
      row("General y before", fmt(frame.deviceRect(r0)[1]))
      for ms in [400, 120] {
        let from = frame.toScreen(CGPoint(x: 200, y: 700))
        let to = frame.toScreen(CGPoint(x: 200, y: 300))
        let t0 = Date()
        drag(from: from, to: to, durationMs: ms)
        let took = Date().timeIntervalSince(t0)
        usleep(800_000)
        let after = find(group, named: "General")?.rect.map { frame.deviceRect($0)[1] }
        row(
          "\(ms) ms drag of 400 pt",
          "took \(fmt(took * 1000)) ms; General y after \(after.map(fmt) ?? "gone from screen")")
        // Restore: drag back down.
        drag(from: to, to: from, durationMs: 400)
        usleep(800_000)
        if ms == 400 {
          drag(from: to, to: from, durationMs: 400)
          usleep(600_000)
        }
      }
      row(
        "General y restored",
        find(group, named: "General")?.rect.map { fmt(frame.deviceRect($0)[1]) } ?? "?")
    }

    if flag("--unlock") {
      section("unlock: swipe up from the bottom edge")
      // Measured: command-shift-H on the lock screen of a Face ID device does
      // NOT unlock it; the gesture does, which is also a second reading of the
      // drag primitive.
      guard let took = activateAndWait(ignoringOthers: true) else {
        print("  UNDETERMINED: the Simulator never became frontmost.")
        exit(2)
      }
      row("activated", "after \(fmt(took * 1000)) ms")
      row(
        "before",
        screen(group, detail: .all).prefix(6).map { $0.name ?? $0.role }.joined(separator: ", "))
      drag(
        from: frame.toScreen(CGPoint(x: 201, y: 868)), to: frame.toScreen(CGPoint(x: 201, y: 300)),
        durationMs: 300)
      let landed = poll(4) {
        screen(group).count > 2
          && !screen(group, detail: .all).contains { ($0.name ?? "").contains("September") }
      }
      row("unlocked", landed.map { "after \(fmt($0 * 1000)) ms" } ?? "NO within 4 s")
      row("after", screen(group).prefix(6).map { $0.name ?? $0.role }.joined(separator: ", "))
    }

    if flag("--type") {
      section("type: per-key codes into the Settings search field")
      guard let took = activateAndWait(ignoringOthers: true) else {
        print("  UNDETERMINED: the Simulator never became frontmost.")
        exit(2)
      }
      row("activated", "after \(fmt(took * 1000)) ms")
      guard let field = screen(group, detail: .all).first(where: { $0.role == "AXTextField" }),
        let rect = field.rect
      else {
        print("  UNDETERMINED: no AXTextField on screen.")
        exit(2)
      }
      let centre = CGPoint(x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2)
      try? AccessibilityDriver.click(x: centre.x, y: centre.y)
      usleep(600_000)
      let unmapped = typeByKeys("Acc 7")
      row("unmapped characters", unmapped.isEmpty ? "none" : String(unmapped))
      let landed = poll(3) {
        (screen(group, detail: .all).first { $0.role == "AXTextField" }?.value ?? "").contains("cc")
      }
      row("value has 'cc'", landed.map { "after \(fmt($0 * 1000)) ms" } ?? "NO")
      row(
        "field value",
        screen(group, detail: .all).first { $0.role == "AXTextField" }?.value ?? "<nil>")
      if let cancel = screen(group, detail: .all).first(where: {
        ($0.name ?? "") == "Cancel" && $0.pressable
      }) {
        try? AccessibilityDriver.press(handle: cancel.handle, scope: scope)
        row(
          "Cancel pressed",
          poll(2) { find(group, named: "General") != nil } != nil
            ? "root list is back" : "root list NOT back")
      } else {
        row("Cancel", "not found")
      }
    }

    if flag("--home") {
      section("home: command-shift-H with a verified frontmost")
      relaunchSettings()
      guard poll(4, until: { find(group, named: "General") != nil }) != nil else {
        print("  UNDETERMINED: Settings' root list did not come up.")
        exit(2)
      }
      guard let took = activateAndWait(ignoringOthers: true) else {
        print("  UNDETERMINED: the Simulator never became frontmost.")
        exit(2)
      }
      row("activated", "after \(fmt(took * 1000)) ms")
      try? AccessibilityDriver.key("h", modifiers: ["command", "shift"])
      let landed = poll(4) {
        find(group, named: "General") == nil && find(group, named: "Settings") != nil
      }
      row("springboard", landed.map { "after \(fmt($0 * 1000)) ms" } ?? "NO within 4 s")
      row("screen now", screen(group).prefix(8).map { $0.name ?? $0.role }.joined(separator: ", "))
      relaunchSettings()
    }

    if flag("--lock") {
      section("lock: command-L")
      guard let took = activateAndWait(ignoringOthers: true) else {
        print("  UNDETERMINED: the Simulator never became frontmost.")
        exit(2)
      }
      row("activated", "after \(fmt(took * 1000)) ms")
      let before = screen(group, detail: .all).count
      try? AccessibilityDriver.key("l", modifiers: ["command"])
      usleep(1_500_000)
      row("elements before/after", "\(before) / \(screen(group, detail: .all).count)")
      row(
        "screen now",
        screen(group, detail: .all).prefix(8).map { $0.name ?? $0.role }.joined(separator: ", "))
      // Unlock again: home on the lock screen unlocks a device with no passcode.
      try? AccessibilityDriver.key("h", modifiers: ["command", "shift"])
      row(
        "unlocked by home",
        poll(4) {
          screen(group).contains { ($0.name ?? "").contains("Settings") }
            || find(group, named: "General") != nil
        } != nil ? "yes" : "NO")
    }
    print()
  }
}
