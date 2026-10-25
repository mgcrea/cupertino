import AppKit
import Foundation

/// The MCP server for the `simulator` surface, served by the app itself.
///
/// The same lane `DesktopServer` drives, pointed at one application and
/// answering in a different coordinate space. Simulator.app bridges the
/// simulated device's accessibility tree into the Mac's, so an iOS app's own
/// controls are readable and pressable here with no WebDriverAgent and no
/// runner process — measured in docs/simulator.md, where the numbers and the
/// traps live.
///
/// ## Why a surface rather than Desktop's guide paragraph
///
/// Simulator.app was not a brokered application, so reaching it through
/// Desktop cost "Reach any application": opening every window on the Mac in
/// order to touch a developer's own app. This surface pins its reach to the
/// Simulator's bundle id the way `ServerHost` pins a lend, and nothing widens
/// it. It also does the arithmetic Desktop's guide asked the model to do by
/// hand — find the device screen, subtract its origin, divide by the window
/// scale — because a caller that does that by hand gets it wrong once and
/// clicks the bezel.
///
/// ## What it deliberately does not do
///
/// No boot, install, launch, screenshot, push or staging. None of those needs
/// a grant, and `@mgcrea/mcp-ios-simulator` already does them through
/// `simctl`; a copy of that behind Accessibility would be a worse copy. What
/// this adds is the one lane that server cannot have.
nonisolated enum SimulatorServer {

  static let protocolVersion = InProcessRPC.protocolVersion

  /// The one application this surface reaches. Read off the table rather than
  /// spelled here, so the manifest stays the only copy of the bundle id.
  static func bundleId(_ surface: Surface) -> String {
    surface.bundleID ?? "com.apple.iphonesimulator"
  }

  /// Xcode 27's home for the simulator's window. It ships no Simulator.app;
  /// DeviceHub draws the device inside its own window and bridges the device's
  /// accessibility tree the same way, under an `AXGroup` whose subrole is
  /// `iOSContentGroup` — measured on Xcode 27.0 (27A266a), docs/simulator.md.
  static let deviceHub = "com.apple.dt.Devices"

  /// The application showing the simulator right now: Simulator.app where it
  /// runs, which is every Xcode before 27; DeviceHub where it does not.
  /// Falls back to the Simulator's own id, so a Mac with neither says so in the
  /// words it would have used before.
  static func host(_ surface: Surface) -> String {
    let simulator = bundleId(surface)
    let running = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
    if running.contains(simulator) { return simulator }
    if running.contains(deviceHub) { return deviceHub }
    return simulator
  }

  static func hostName(_ host: String) -> String {
    host == deviceHub ? "DeviceHub" : "Simulator.app"
  }

  /// Pinned. Not `.brokered`, which would let a handle minted here address
  /// Mail, and not `.any`. The same value a lend gets, for the same reason.
  /// Two ids because the simulator has two possible hosts, and nothing else.
  static func scope(_ surface: Surface) -> AccessibilityDriver.Scope {
    .only([bundleId(surface), deviceHub])
  }

  // ─── dispatch ──────────────────────────────────────────────────────────────

  static func handle(_ line: String, surface: Surface, writesAllowed: Bool) -> String? {
    InProcessRPC.dispatch(
      line,
      name: "cupertino-simulator",
      instructions: instructions(writesAllowed),
      tools: { tools(writesAllowed: writesAllowed) },
      resources: { resources() },
      read: { uri, id in readResource(uri, id: id, surface: surface, writesAllowed: writesAllowed)
      },
      call: { name, args, id in
        let reply = call(name, args: args, id: id, surface: surface, writesAllowed: writesAllowed)
        // Any call keeps an open driving session alive — see `DrivingSession`.
        DrivingSession.touch()
        return reply
      })
  }

  // ─── tools ─────────────────────────────────────────────────────────────────

  /// Every device key this surface will send unmodified. No `modifiers`
  /// argument exists on any tool: command-Q quits the Simulator, command-W
  /// closes the device window, command-S writes a screenshot to the Desktop.
  /// The chords a device needs are behind `press_button`, by name.
  static let deviceKeys = [
    "return", "tab", "escape", "delete", "space", "up", "down", "left", "right",
  ]

  /// The Simulator's own menu shortcuts, which are the only way to reach the
  /// bezel from a keyboard. `lock` and the unlock gesture were measured; see
  /// the guide for which.
  static let buttons: [String: (key: String, modifiers: [String])] = [
    "home": ("h", ["command", "shift"]),
    "lock": ("l", ["command"]),
    "rotate_left": ("left", ["command"]),
    "rotate_right": ("right", ["command"]),
  ]

  /// A foldable's poses, by the name a caller passes, to the label of the
  /// button DeviceHub draws under the device for it. Measured on Xcode 27.1
  /// with iPhone Duo; no menu item and no `simctl` or `devicectl` command sets
  /// one, so the button is the only way.
  static let poses: [String: String] = [
    "closed": "Closed", "partially_open": "Partially Open", "open": "Open",
  ]

  private static func tools(writesAllowed: Bool) -> [[String: Any]] {
    let empty: [String: Any] = [
      "type": "object", "properties": [String: Any](), "required": [Any](),
    ]
    let deviceProperty: [String: Any] = [
      "type": "string",
      "description":
        "Which simulator, by UDID or name as apple_simulator_list_devices reports it. Omit it "
        + "when exactly one device window is open, which is the normal case.",
    ]
    let detailProperty: [String: Any] = [
      "type": "string",
      "enum": ["interactive", "labelled", "all"],
      "description":
        "interactive (default) returns only what a press can land on; labelled returns anything "
        + "carrying an identifier, title or description; all returns everything.",
    ]
    let boundsProperties: [String: Any] = [
      "maxDepth": ["type": "integer", "description": "How deep to walk. Default 12."],
      "maxNodes": [
        "type": "integer",
        "description": "How many elements to visit. Default 4000, at most 50000.",
      ],
      "budgetSeconds": [
        "type": "number",
        "description": "Wall-clock budget for the walk. Default 5, at most 60.",
      ],
    ]
    let pointDescription =
      " in iOS points, top-left of the device screen — the space ios_simulator_tap and "
      + "ios_simulator_screenshot use."

    var list: [[String: Any]] = [
      [
        "name": "apple_simulator_list_devices",
        "description":
          "The simulators CoreSimulator knows, which are booted, and which have a window open in "
          + "Simulator.app, or in DeviceHub on Xcode 27 — with each window's device screen "
          + "located: origin on the Mac, point "
          + "size, window scale and orientation. The device list needs no grant; the windows need "
          + "Accessibility, and the answer says so rather than reporting none.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_simulator_ui_tree",
        "description":
          "Read the iOS app's own controls on a simulator's screen, flattened to addressable "
          + "elements with a tap point already computed" + pointDescription
          + " Each element carries an opaque handle apple_simulator_press takes. Rooted at the "
          + "device screen, so the Simulator's own bezel and toolbar never appear. It reaches a "
          + "subset of what WebDriverAgent reaches, and needs no runner at all. A tab bar's items "
          + "carry their SF Symbol name as `id`, which is stable across locales.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "device": deviceProperty,
            "detail": detailProperty,
          ].merging(boundsProperties) { current, _ in current },
          "required": [Any](),
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_simulator_find_elements",
        "description":
          "Search a simulator's screen for elements matching an identifier, role or name, "
          + "without reading the whole tree first. Matching is case-insensitive and by substring "
          + "for name, exact for id and role. Coordinates come back" + pointDescription,
        "inputSchema": [
          "type": "object",
          "properties": [
            "device": deviceProperty,
            "id": ["type": "string", "description": "Exact accessibility identifier to match."],
            "role": ["type": "string", "description": "Exact role, e.g. AXButton."],
            "name": ["type": "string", "description": "Substring of the label."],
            "pressableOnly": [
              "type": "boolean",
              "description": "Only return elements that can be pressed. Defaults to false.",
            ],
          ].merging(boundsProperties) { current, _ in current },
          "required": [Any](),
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_simulator_diagnostics",
        "description":
          "Report whether Accessibility is granted, which app hosts the simulator (Simulator.app, "
          + "or DeviceHub on Xcode 27), which "
          + "device windows resolve to a device screen and at what scale, and whether the "
          + "driving tools are registered. Answers on a Mac with no grant and no Xcode.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
    ]

    guard writesAllowed else { return list }

    let driving: [[String: Any]] = [
      [
        "name": "apple_simulator_press",
        "description":
          "Press an element by its handle. The verb to prefer: it addresses a control rather "
          + "than a point, needs no activation, and survives the window moving.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"]],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_simulator_tap",
        "description":
          "Tap a point on the device" + pointDescription
          + " Brings the Simulator to the front first, because a synthetic click lands in "
          + "whatever covers the window. Refused outside the screen, and wherever the point "
          + "would not land on the Simulator's own window, which on iPhone Duo is everywhere.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "x": ["type": "number"], "y": ["type": "number"], "device": deviceProperty,
          ],
          "required": ["x", "y"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_simulator_swipe",
        "description":
          "Drag from one point to another" + pointDescription
          + " The Simulator turns it into a touch pan, which is how a list scrolls and how a "
          + "Face ID device unlocks (up from the bottom edge). Brings the Simulator to the front.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "fromX": ["type": "number"], "fromY": ["type": "number"],
            "toX": ["type": "number"], "toY": ["type": "number"],
            "durationMs": [
              "type": "integer",
              "description": "How long the drag takes. Default 400; shorter is more of a fling.",
            ],
            "device": deviceProperty,
          ],
          "required": ["fromX", "fromY", "toX", "toY"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_simulator_type",
        "description":
          "Type into whatever field the device has focused, one key at a time on the Mac's "
          + "current keyboard layout. The Simulator forwards key codes, not characters, so a "
          + "character this layout has no key for is reported back rather than typed. Brings "
          + "the Simulator to the front. On Simulator.app it needs I/O › Keyboard › Send Keyboard "
          + "Input to Device left on, which is its default. Focus the field with "
          + "apple_simulator_press first: a tap does not always focus a floating search bar.",
        "inputSchema": [
          "type": "object",
          "properties": ["text": ["type": "string"], "device": deviceProperty],
          "required": ["text"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_simulator_key",
        "description":
          "Send one unmodified device key: \(deviceKeys.joined(separator: ", ")). There is "
          + "no modifiers argument on purpose; the device's buttons are apple_simulator_press_button.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "key": ["type": "string", "enum": deviceKeys], "device": deviceProperty,
          ],
          "required": ["key"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_simulator_press_button",
        "description":
          "Press one of the device's hardware buttons through the Simulator's own shortcuts: "
          + "home, lock, rotate_left, rotate_right. To unlock a locked device, swipe up from the "
          + "bottom edge instead — home does not unlock a Face ID device.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "button": ["type": "string", "enum": buttons.keys.sorted()],
            "device": deviceProperty,
          ],
          "required": ["button"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_simulator_set_pose",
        "description":
          "Fold or unfold a foldable simulator such as iPhone Duo: closed shows the outer "
          + "screen, partially_open and open the inner one. DeviceHub only (Xcode 27), whose "
          + "pose buttons are the one way to set it; the device is selected in DeviceHub's "
          + "sidebar first if no window shows it. 'confirmed' says the screen switched to the "
          + "expected panel, which cannot tell partially_open from open. The pose resets when "
          + "the simulator reboots, and quitting DeviceHub shuts it down. DeviceHub misplaces "
          + "the Duo's screen, so tap and swipe are refused on it: press handles from ui_tree.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "pose": ["type": "string", "enum": poses.keys.sorted()],
            "device": deviceProperty,
          ],
          "required": ["pose"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
      [
        "name": "apple_simulator_release",
        "description":
          "Hand the Mac back when you have finished driving the Simulator. Ends the driving "
          + "session, takes Cupertino's notice off the screen, and brings back the application "
          + "the person was using before it began, unless they have already switched away "
          + "themselves. Safe to call when nothing is being driven.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
    ]
    list.append(contentsOf: driving)
    return list
  }

  static let drivingNames = [
    "apple_simulator_press", "apple_simulator_tap", "apple_simulator_swipe",
    "apple_simulator_type", "apple_simulator_key", "apple_simulator_press_button",
    "apple_simulator_release", "apple_simulator_set_pose",
  ]

  // ─── the device screen ─────────────────────────────────────────────────────

  /// One Simulator window, and what was found behind it.
  struct Target {
    let window: AccessibilityDriver.WindowRef
    let device: CoreSimulatorCatalog.Device?
    /// The device-screen group's handle and frame, or nil with the reason.
    let screen: (handle: String, frame: SimulatorGeometry.DeviceFrame)?
    let problem: String?
    /// Which panel the screen matched, set only for a device with more than
    /// one: the Duo's outer `LCD` folded, its inner `LCD-1` open.
    var panel: CoreSimulatorCatalog.Panel? = nil
    /// Whether the screen group lies inside its window, which a point needs.
    /// See `SimulatorGeometry.onWindow` for the device where it does not.
    var onWindow = true

    var json: [String: Any] {
      var out: [String: Any] = ["window": window.index, "title": window.title ?? ""]
      if let device {
        out["device"] = ["udid": device.udid, "name": device.name, "runtime": device.runtimeLabel]
      }
      if let screen {
        out["screen"] = screen.frame.json
        out["screenHandle"] = screen.handle
        if let panel { out["display"] = panel.name }
        if !onWindow { out["pointer"] = SimulatorServer.offWindow }
      } else {
        out["screen"] = problem ?? "not found"
      }
      return out
    }
  }

  /// What `tap` and `swipe` refuse with, and what the window listings say,
  /// when the screen group is not on its window.
  static let offWindow =
    "refused: DeviceHub reports this device's screen outside its window, so a point cannot be "
    + "placed on it and tap and swipe would land elsewhere on the Mac. Use press with a handle "
    + "from ui_tree, and type and key after it."

  /// Profiles by device type, because the lookup scans 124 bundles and a
  /// device type's screen does not change while the app runs.
  private nonisolated(unsafe) static var profileCache: [String: CoreSimulatorCatalog.Profile] =
    [:]
  private static let profileLock = NSLock()

  private static func profile(for deviceType: String) -> CoreSimulatorCatalog.Profile? {
    profileLock.lock()
    if let cached = profileCache[deviceType] {
      profileLock.unlock()
      return cached
    }
    profileLock.unlock()
    guard let found = CoreSimulatorCatalog.profile(deviceType: deviceType) else { return nil }
    profileLock.lock()
    profileCache[deviceType] = found
    profileLock.unlock()
    return found
  }

  private nonisolated(unsafe) static var panelCache: [String: [CoreSimulatorCatalog.Panel]] = [:]

  /// Which panel a booted device is drawing, by screen id, from `devicectl`:
  /// about 80 ms a read, so it is asked only of a device with more than one
  /// panel. Nil when devicectl is missing, slow or says nothing usable, and the
  /// tree is matched as before. See `CoreSimulatorCatalog.activeScreenID`.
  static func activePanel(udid: String) -> Int? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = [
      "devicectl", "--quiet", "--timeout", "5", "--json-output", "-",
      "device", "info", "displays", "--device", udid,
    ]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return CoreSimulatorCatalog.activeScreenID(devicectlJSON: data)
  }

  /// The screens a device's window may show: each built-in panel, or the main
  /// screen alone where the device type lists none.
  static func panels(for deviceType: String) -> [CoreSimulatorCatalog.Panel] {
    profileLock.lock()
    if let cached = panelCache[deviceType] {
      profileLock.unlock()
      return cached
    }
    profileLock.unlock()
    var found = CoreSimulatorCatalog.panels(deviceType: deviceType)
    if found.isEmpty, let main = profile(for: deviceType) {
      found = [CoreSimulatorCatalog.Panel(name: "LCD", screenID: 1, profile: main)]
    }
    guard !found.isEmpty else { return [] }
    profileLock.lock()
    panelCache[deviceType] = found
    profileLock.unlock()
    return found
  }

  /// Resolve every Simulator window to a device screen, freshly, every call.
  ///
  /// A depth-1 walk of a window costs ~7 ms and the group's frame moves with
  /// the window, so nothing is cached across calls: a frame read a minute ago
  /// is a frame for a window that may have been dragged, resized or rotated
  /// since. Re-reading is cheaper than being wrong.
  static func targets(surface: Surface) throws -> [Target] {
    let id = host(surface)
    let reach = scope(surface)
    let windows = try AccessibilityDriver.windows(bundleId: id, scope: reach)
    let devices: [CoreSimulatorCatalog.Device]
    if case .found(let list) = CoreSimulatorCatalog.devices() {
      devices = list
    } else {
      devices = []
    }
    let booted = devices.filter(\.booted)

    return windows.map { window -> Target in
      // The title names the device: "iPhone 17 Pro – iOS 26.5".
      let parsed = window.title.flatMap(CoreSimulatorCatalog.parseWindowTitle)
      let byTitle = parsed.flatMap { title in
        booted.first { $0.name == title.name && $0.runtimeLabel == title.runtime }
          ?? devices.first { $0.name == title.name && $0.runtimeLabel == title.runtime }
      }
      // Candidates for the point size: the titled device, else every booted one.
      let candidates = byTitle.map { [$0] } ?? booted

      let groups: [AccessibilityDriver.Element]
      do {
        groups = try screenGroups(host: id, windowIndex: window.index, scope: reach)
      } catch {
        return Target(
          window: window, device: byTitle, screen: nil, problem: error.localizedDescription)
      }
      guard !groups.isEmpty else {
        // DeviceHub keeps a window titled for a device after that device shuts
        // down, where Simulator.app closed it. "Poll" would wait forever.
        if let byTitle, !byTitle.booted {
          return Target(
            window: window, device: byTitle, screen: nil,
            problem: "\(byTitle.name) is not booted — the window still carries its name")
        }
        return Target(
          window: window, device: byTitle, screen: nil,
          problem: "no device screen in the window — the device has not drawn yet; poll")
      }
      guard !candidates.isEmpty else {
        return Target(
          window: window, device: byTitle, screen: nil,
          problem: "no booted device to match the window against")
      }
      // Every panel, not only the main screen: an unfolded iPhone Duo draws its
      // inner panel, 669x951 points, which the main screen's 466x678 never
      // matched, so the device was "not found" the moment it opened.
      for device in candidates {
        let shapes = panels(for: device.deviceType)
        // DeviceHub keeps a group per panel once a foldable has been opened, so
        // only the one devicectl says is drawn may match.
        var tried = shapes
        if shapes.count > 1, device.booted, let active = activePanel(udid: device.udid) {
          let drawn = shapes.filter { $0.screenID == active }
          if !drawn.isEmpty { tried = drawn }
        }
        for shape in tried {
          for group in groups {
            let rect = group.rect!
            if let frame = SimulatorGeometry.resolve(
              groupOrigin: CGPoint(x: rect[0], y: rect[1]),
              groupSize: CGSize(width: rect[2], height: rect[3]),
              portraitPoints: shape.profile.points)
            {
              var found = Target(
                window: window, device: device, screen: (group.handle, frame), problem: nil)
              if shapes.count > 1 { found.panel = shape }
              found.onWindow =
                window.rect.map {
                  SimulatorGeometry.onWindow(screen: rect, window: $0)
                } ?? false
              return found
            }
          }
        }
      }
      let sizes = groups.map { "\(Int($0.rect![2]))x\(Int($0.rect![3]))" }.joined(separator: ", ")
      let wanted = candidates.flatMap { d in
        panels(for: d.deviceType).map {
          "\(d.name) \(Int($0.profile.points.width))x\(Int($0.profile.points.height))"
        }
      }.joined(separator: ", ")
      return Target(
        window: window, device: byTitle, screen: nil,
        problem:
          "no AXGroup matches a device's point size at any scale — groups \(sizes); wanted \(wanted)"
      )
    }
  }

  /// The groups that may be the device screen, cheapest walk first.
  ///
  /// Simulator.app puts the screen directly under the window, so a depth-1 walk
  /// finds it. DeviceHub nests it about seven levels down, beside a sidebar,
  /// an inspector and its own toolbar, and marks it with the subrole
  /// `iOSContentGroup`; the same group is reachable along two paths, so it is
  /// deduped by frame. Only groups with that subrole are taken there — a
  /// DeviceHub pane that happens to have a device's proportions is not a screen.
  static func screenGroups(host: String, windowIndex: Int, scope: AccessibilityDriver.Scope)
    throws -> [AccessibilityDriver.Element]
  {
    if host != deviceHub {
      let tree = try AccessibilityDriver.tree(
        bundleId: host, windowIndex: windowIndex, detail: .all,
        bounds: .init(depth: 1, nodes: 200, seconds: 2), scope: scope)
      return tree.elements.filter { $0.depth == 1 && $0.role == "AXGroup" && $0.rect != nil }
    }
    // Depth 8 first. Measured 2026-10-25, Xcode 27.1: the group sat at depth 6
    // and 7 for an iPhone 18 Pro, 7 and 8 for iPhone Duo's two panels, and
    // everything below it is the iOS app's own tree. Walking into that to depth
    // 10 took 2.4 s on the iPhone and 4.9 s on the Duo, so the 3 s budget ran
    // out on the Duo before the walk reached the group being drawn; to 8 it
    // took 0.7 s and 0.9 s. 10 stays as the fallback it was written against.
    for depth in [8, 10] {
      let tree = try AccessibilityDriver.tree(
        bundleId: host, windowIndex: windowIndex, detail: .all,
        bounds: .init(depth: depth, nodes: 1500, seconds: 3), scope: scope)
      let screens = deviceHubScreens(tree.elements)
      if !screens.isEmpty || depth == 10 { return screens }
    }
    return []
  }

  /// Split out so simulator-check can pin it with no DeviceHub running.
  static func deviceHubScreens(_ elements: [AccessibilityDriver.Element])
    -> [AccessibilityDriver.Element]
  {
    var seen: [[Double]] = []
    return elements.filter { element in
      guard element.role == "AXGroup", element.subrole == "iOSContentGroup",
        let rect = element.rect, rect.allSatisfy(\.isFinite), !seen.contains(rect)
      else { return false }
      seen.append(rect)
      return true
    }
  }

  /// The one target a call addresses.
  private static func target(surface: Surface, args: [String: Any]) throws -> Target {
    let all = try targets(surface: surface)
    let resolved = all.filter { $0.screen != nil }
    if let wanted = (args["device"] as? String)?.trimmingCharacters(in: .whitespaces),
      !wanted.isEmpty
    {
      let hit = resolved.first {
        $0.device?.udid.caseInsensitiveCompare(wanted) == .orderedSame
          || $0.device?.name.caseInsensitiveCompare(wanted) == .orderedSame
      }
      guard let hit else {
        let names = resolved.compactMap { $0.device?.name }
        throw AccessibilityDriver.Failure.refused(
          "No open device window named '\(wanted)'. "
            + (names.isEmpty
              ? "No window resolves to a device screen."
              : "Open: \(names.joined(separator: ", "))."))
      }
      return hit
    }
    switch resolved.count {
    case 1:
      return resolved[0]
    case 0:
      let reasons = all.map { "window \($0.window.index): \($0.problem ?? "?")" }
      throw AccessibilityDriver.Failure.refused(
        all.isEmpty
          ? "\(hostName(host(surface))) has no window."
          : "No window resolves to a device screen. " + reasons.joined(separator: "; "))
    default:
      let names = resolved.compactMap { $0.device?.name }
      throw AccessibilityDriver.Failure.refused(
        "\(resolved.count) device windows are open; pass device to say which: "
          + names.joined(separator: ", ") + ".")
    }
  }

  private static func render(_ frame: SimulatorGeometry.DeviceFrame)
    -> (AccessibilityDriver.Element) -> [String: Any]
  {
    { element in
      var json = element.json
      if let rect = element.rect {
        let device = frame.deviceRect(rect)
        json["rect"] = device
        json["point"] = [
          ((device[0] + device[2] / 2) * 10).rounded() / 10,
          ((device[1] + device[3] / 2) * 10).rounded() / 10,
        ]
        if let point = element.point { json["screenPoint"] = point }
      }
      return json
    }
  }

  private static let coordinateSpace =
    "iOS points, top-left of the device screen — the space ios_simulator_tap uses"

  private static func body(_ tree: AccessibilityDriver.Tree, target: Target) -> [String: Any] {
    var out = DesktopServer.treeBody(
      tree, render: render(target.screen!.frame),
      coordinateSpace: coordinateSpace)
    if let device = target.device {
      out["device"] = ["udid": device.udid, "name": device.name, "runtime": device.runtimeLabel]
    }
    out["screen"] = target.screen!.frame.json
    return out
  }

  // ─── calls ─────────────────────────────────────────────────────────────────

  private static func call(
    _ name: String, args: [String: Any], id: Any?, surface: Surface, writesAllowed: Bool
  ) -> String {
    // Refused BEFORE the driver is reached. None of these is listed with
    // writes off, and a server must not rely on its caller being compliant.
    if drivingNames.contains(name) && !writesAllowed {
      return failure(
        id,
        "Driving \(surface.displayName) is switched off. Turn on writes for this surface in "
          + "Cupertino.")
    }
    let reach = scope(surface)
    let simulator = host(surface)

    do {
      switch name {
      case "apple_simulator_list_devices":
        return ok(id, listDevices(surface: surface))

      case "apple_simulator_ui_tree":
        let target = try target(surface: surface, args: args)
        let tree = try AccessibilityDriver.expand(
          handle: target.screen!.handle, detail: DesktopServer.detail(args),
          bounds: DesktopServer.bounds(args), scope: reach)
        return ok(id, body(tree, target: target))

      case "apple_simulator_find_elements":
        let wantedId = args["id"] as? String
        let wantedRole = args["role"] as? String
        let wantedName = (args["name"] as? String)?.lowercased()
        let pressableOnly = args["pressableOnly"] as? Bool ?? false
        if wantedId == nil && wantedRole == nil && wantedName == nil && !pressableOnly {
          return failure(id, "Give at least one of id, role, name or pressableOnly.")
        }
        let target = try target(surface: surface, args: args)
        let tree = try AccessibilityDriver.expand(
          handle: target.screen!.handle, detail: .all, bounds: DesktopServer.bounds(args),
          scope: reach,
          match: { candidate in
            if pressableOnly && !candidate.pressable { return false }
            if let wantedId, candidate.identifier != wantedId { return false }
            if let wantedRole, candidate.role != wantedRole { return false }
            if let wantedName {
              guard let name = candidate.name?.lowercased(), name.contains(wantedName) else {
                return false
              }
            }
            return true
          })
        return ok(id, body(tree, target: target))

      case "apple_simulator_diagnostics":
        return ok(id, diagnostics(surface: surface, writesAllowed: writesAllowed))

      case "apple_simulator_press":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.press(handle: handle, scope: reach)
        return ok(id, ["pressed": handle])

      case "apple_simulator_tap":
        guard let x = number(args["x"]), let y = number(args["y"]) else {
          return failure(id, "Both 'x' and 'y' are required, in iOS points.")
        }
        let target = try target(surface: surface, args: args)
        guard target.onWindow else { return failure(id, "Tap " + offWindow) }
        let frame = target.screen!.frame
        let point = CGPoint(x: x, y: y)
        guard frame.contains(point) else {
          return failure(
            id,
            "(\(x), \(y)) is outside the device screen, which is "
              + "\(Int(frame.pointWidth))x\(Int(frame.pointHeight)) points in \(frame.orientation)."
          )
        }
        try front(simulator, scope: reach)
        let at = frame.toScreen(point)
        try requireOnHost(simulator, at: at)
        try AccessibilityDriver.click(x: at.x, y: at.y, scope: reach, announcing: simulator)
        return ok(
          id,
          [
            "tapped": [x, y], "screenPoint": [at.x, at.y],
            "note": "Read the screen again rather than assuming what the tap did.",
          ])

      case "apple_simulator_swipe":
        guard let fromX = number(args["fromX"]), let fromY = number(args["fromY"]),
          let toX = number(args["toX"]), let toY = number(args["toY"])
        else {
          return failure(id, "fromX, fromY, toX and toY are all required, in iOS points.")
        }
        let durationMs = max(16, min(args["durationMs"] as? Int ?? 400, 5000))
        let target = try target(surface: surface, args: args)
        guard target.onWindow else { return failure(id, "Swipe " + offWindow) }
        let frame = target.screen!.frame
        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)
        guard frame.contains(from), frame.contains(to) else {
          return failure(
            id,
            "Both ends must be on the device screen, which is "
              + "\(Int(frame.pointWidth))x\(Int(frame.pointHeight)) points in \(frame.orientation)."
          )
        }
        try front(simulator, scope: reach)
        try requireOnHost(simulator, at: frame.toScreen(from))
        try requireOnHost(simulator, at: frame.toScreen(to))
        try AccessibilityDriver.drag(
          from: frame.toScreen(from), to: frame.toScreen(to), durationMs: durationMs,
          scope: reach, announcing: simulator)
        return ok(
          id, ["swiped": ["from": [fromX, fromY], "to": [toX, toY], "durationMs": durationMs]])

      case "apple_simulator_type":
        guard let text = args["text"] as? String, !text.isEmpty else {
          return failure(id, "The 'text' argument is required.")
        }
        _ = try target(surface: surface, args: args)
        try front(simulator, scope: reach)
        let unmapped = try AccessibilityDriver.typeByKeyCodes(
          text, scope: reach, announcing: simulator)
        var out: [String: Any] = ["typed": text.count - unmapped.count]
        if !unmapped.isEmpty {
          out["notTyped"] = String(unmapped)
          out["note"] =
            "This keyboard layout has no key for those characters, so they were skipped. "
            + "Read the field back before relying on what landed."
        }
        return ok(id, out)

      case "apple_simulator_key":
        guard let key = (args["key"] as? String)?.lowercased() else {
          return failure(id, "The 'key' argument is required.")
        }
        guard deviceKeys.contains(key) else {
          return failure(
            id, "Unknown device key '\(key)'. Known: \(deviceKeys.joined(separator: ", ")).")
        }
        _ = try target(surface: surface, args: args)
        try front(simulator, scope: reach)
        try AccessibilityDriver.key(key, modifiers: [], scope: reach, announcing: simulator)
        return ok(id, ["key": key])

      case "apple_simulator_release":
        return ok(id, DrivingSession.answer(DrivingSession.release(.agent)))

      case "apple_simulator_press_button":
        guard let button = (args["button"] as? String)?.lowercased() else {
          return failure(id, "The 'button' argument is required.")
        }
        guard let chord = buttons[button] else {
          return failure(
            id,
            "Unknown button '\(button)'. Known: \(buttons.keys.sorted().joined(separator: ", ")).")
        }
        _ = try target(surface: surface, args: args)
        try front(simulator, scope: reach)
        try AccessibilityDriver.key(
          chord.key, modifiers: chord.modifiers, scope: reach, announcing: simulator)
        return ok(id, ["pressed": button])

      case "apple_simulator_set_pose":
        guard let pose = (args["pose"] as? String)?.lowercased(), poses[pose] != nil else {
          return failure(
            id, "'pose' is one of \(poses.keys.sorted().joined(separator: ", ")).")
        }
        return ok(id, try setPose(pose, args: args, surface: surface))

      default:
        return failure(id, "unknown tool '\(name)'")
      }
    } catch {
      return failed(id, error)
    }
  }

  /// Bring the simulator's host to the front and WAIT for it, refusing to post
  /// when it did not come. Measured: a click posted before activation reached
  /// nothing — or worse, whatever covered the window.
  private static func front(_ simulator: String, scope: AccessibilityDriver.Scope) throws {
    guard try AccessibilityDriver.activateAndWait(bundleId: simulator, scope: scope) else {
      throw AccessibilityDriver.Failure.refused(
        "\(hostName(simulator)) did not come to the front, so nothing was "
          + "posted — a synthetic event "
          + "lands in whatever is frontmost, which would have been someone else's window.")
    }
  }

  // ─── poses ─────────────────────────────────────────────────────────────────

  /// Press DeviceHub's button for `pose` under the device, and read back which
  /// panel the device then draws.
  ///
  /// Measured 2026-10-25, Xcode 27.1, iPhone Duo: Closed draws the outer `LCD`,
  /// and both Partially Open and Open draw the inner `LCD-1` (devicectl's
  /// `info displays` agreed: the inner panel active, the outer not). So the read
  /// back confirms the fold, never which of the two open poses it is.
  private static func setPose(_ pose: String, args: [String: Any], surface: Surface) throws
    -> [String: Any]
  {
    let reach = scope(surface)
    guard host(surface) == deviceHub else {
      throw AccessibilityDriver.Failure.refused(
        "A pose is set in DeviceHub, Xcode 27's device window, and \(hostName(host(surface))) "
          + "is hosting the simulator here.")
    }
    let device = try poseDevice(args: args, surface: surface)
    let shapes = panels(for: device.deviceType)
    guard shapes.count > 1 else {
      throw AccessibilityDriver.Failure.refused(
        "\(device.name) has one screen and no pose; only a foldable such as iPhone Duo has one.")
    }
    guard device.booted else {
      throw AccessibilityDriver.Failure.refused(
        "\(device.name) is not booted; boot it with ios_simulator_boot or simctl first.")
    }
    let window = try windowShowing(device, surface: surface)

    let label = poses[pose]!
    let found = try AccessibilityDriver.tree(
      bundleId: deviceHub, windowIndex: window, detail: .interactive,
      bounds: .init(depth: 10, nodes: 1500, seconds: 3), scope: reach,
      match: { $0.name == label })
    guard let button = found.elements.first else {
      throw AccessibilityDriver.Failure.refused(
        "DeviceHub shows no '\(label)' button under \(device.name). The pose buttons are found "
          + "by their English labels, which another language renames.")
    }
    try AccessibilityDriver.press(handle: button.handle, scope: reach)

    // The outer panel is the lowest screen id, `LCD`, which is also the device
    // type's main screen.
    let wantOuter = pose == "closed"
    var panel: CoreSimulatorCatalog.Panel?
    let started = Date()
    repeat {
      panel =
        (try? targets(surface: surface))?
        .first { $0.device?.udid == device.udid && $0.screen != nil }?.panel
      if let panel, (panel == shapes[0]) == wantOuter { break }
      usleep(150_000)
    } while Date().timeIntervalSince(started) < 3
    let confirmed = panel.map { ($0 == shapes[0]) == wantOuter } ?? false

    var answer: [String: Any] = [
      "device": device.name, "pose": pose, "display": panel?.name ?? NSNull(),
      "confirmed": confirmed,
    ]
    answer["note"] =
      confirmed
      ? "The pose holds until the simulator reboots. tap and swipe are refused on this device; "
        + "press handles from ui_tree."
      : "The button was pressed and the screen did not switch to the expected panel within "
        + "3 seconds. Read list_devices before relying on the pose."
    return answer
  }

  /// The device a pose is for: the one named, else the one foldable a window
  /// shows.
  private static func poseDevice(args: [String: Any], surface: Surface) throws
    -> CoreSimulatorCatalog.Device
  {
    if let wanted = (args["device"] as? String)?.trimmingCharacters(in: .whitespaces),
      !wanted.isEmpty
    {
      guard case .found(let devices) = CoreSimulatorCatalog.devices() else {
        throw AccessibilityDriver.Failure.refused("CoreSimulator's devices could not be read.")
      }
      let named = devices.filter {
        $0.udid.caseInsensitiveCompare(wanted) == .orderedSame
          || $0.name.caseInsensitiveCompare(wanted) == .orderedSame
      }
      // A name can be shared across runtimes; the booted one is the one meant.
      guard let device = named.first(where: \.booted) ?? named.first else {
        throw AccessibilityDriver.Failure.refused("No simulator named '\(wanted)'.")
      }
      return device
    }
    let foldables = try targets(surface: surface).compactMap(\.device)
      .filter { panels(for: $0.deviceType).count > 1 }
    guard foldables.count == 1 else {
      throw AccessibilityDriver.Failure.refused(
        foldables.isEmpty
          ? "No DeviceHub window shows a foldable simulator; pass 'device' to say which."
          : "Several windows show a foldable; pass 'device' to say which.")
    }
    return foldables[0]
  }

  /// The DeviceHub window showing `device`, selecting it in the sidebar first
  /// when none does. Its row carries the identifier `TableRow.Device.<UDID>` on
  /// the labels inside it; `select` walks up to the row (docs/desktop.md,
  /// "Selecting a row").
  private static func windowShowing(_ device: CoreSimulatorCatalog.Device, surface: Surface)
    throws -> Int
  {
    func showing() -> Int? {
      (try? targets(surface: surface))?.first { $0.device?.udid == device.udid }?.window.index
    }
    if let window = showing() { return window }
    let reach = scope(surface)
    let wanted = "TableRow.Device.\(device.udid)"
    let rows = try AccessibilityDriver.tree(
      bundleId: deviceHub, windowIndex: nil, detail: .all,
      bounds: .init(depth: 12, nodes: 3000, seconds: 3), scope: reach,
      match: { $0.identifier?.caseInsensitiveCompare(wanted) == .orderedSame })
    guard let label = rows.elements.first else {
      throw AccessibilityDriver.Failure.refused(
        "\(device.name) is not in DeviceHub's sidebar, so it cannot be shown. Open DeviceHub's "
          + "device list and try again.")
    }
    _ = try AccessibilityDriver.select(handle: label.handle, scope: reach)
    let started = Date()
    repeat {
      if let window = showing() { return window }
      usleep(150_000)
    } while Date().timeIntervalSince(started) < 3
    throw AccessibilityDriver.Failure.refused(
      "\(device.name) was selected in DeviceHub's sidebar and no window showed it within 3 "
        + "seconds.")
  }

  /// The Mac point a tap or a swipe end resolved to must be on the host's own
  /// window, the check desktop `click` makes. `tap` used to post wherever the
  /// device frame mapped the point, and for a frame DeviceHub misreports that
  /// is someone else's window. Polled for half a second, because the window
  /// list trails the activation `front` waited for (docs/desktop.md, 2026-10-12).
  private static func requireOnHost(_ simulator: String, at point: CGPoint) throws {
    let started = Date()
    var onWindow = AccessibilityDriver.pointOnWindow(of: simulator, at: point)
    while !onWindow, Date().timeIntervalSince(started) < 0.5 {
      usleep(20_000)
      onWindow = AccessibilityDriver.pointOnWindow(of: simulator, at: point)
    }
    guard onWindow else {
      throw AccessibilityDriver.Failure.refused(
        "(\(Int(point.x)), \(Int(point.y))) on the Mac is not on \(hostName(simulator))'s window, "
          + "so nothing was posted. Something covers the device there, or its frame is wrong; "
          + "press a handle from ui_tree instead.")
    }
  }

  private static func number(_ value: Any?) -> Double? {
    switch value {
    case let d as Double: return d
    case let i as Int: return Double(i)
    case let n as NSNumber: return n.doubleValue
    default: return nil
    }
  }

  // ─── list_devices and diagnostics ──────────────────────────────────────────

  private static func listDevices(surface: Surface) -> [String: Any] {
    var out: [String: Any] = [:]
    switch CoreSimulatorCatalog.devices() {
    case .found(let devices):
      out["devices"] = devices.map { device -> [String: Any] in
        var row: [String: Any] = [
          "udid": device.udid, "name": device.name, "runtime": device.runtimeLabel,
          "booted": device.booted,
        ]
        if let profile = profile(for: device.deviceType) {
          row["pointWidth"] = profile.points.width
          row["pointHeight"] = profile.points.height
          row["pointScale"] = profile.scale
        }
        return row
      }
      out["booted"] = devices.filter(\.booted).count
    case .absent:
      out["devices"] = NSNull()
      out["note"] = "CoreSimulator has no devices directory on this Mac — Xcode is not installed."
    case .unreadable(let why):
      out["devices"] = NSNull()
      out["note"] = "CoreSimulator's devices directory could not be read: \(why)"
    }
    do {
      out["windows"] = try targets(surface: surface).map(\.json)
    } catch {
      // NULL, not []. An empty list reads as "no window is open" when the truth
      // is "we could not look".
      out["windows"] = NSNull()
      out["windowsNote"] = error.localizedDescription
    }
    out["coordinateSpace"] = coordinateSpace
    return out
  }

  private static func diagnostics(surface: Surface, writesAllowed: Bool) -> [String: Any] {
    let trusted = AccessibilityDriver.isTrusted()
    let simulator = host(surface)
    let running = NSWorkspace.shared.runningApplications.contains {
      $0.bundleIdentifier == simulator
    }
    var coreSimulator: Any
    switch CoreSimulatorCatalog.devices() {
    case .found(let devices):
      coreSimulator = ["devices": devices.count, "booted": devices.filter(\.booted).count]
    case .absent:
      coreSimulator = "absent — Xcode's CoreSimulator directory is not on this Mac"
    case .unreadable(let why):
      coreSimulator = "unreadable: \(why)"
    }

    var windows: Any = "not attempted"
    if trusted && running {
      do {
        windows = try targets(surface: surface).map { target -> [String: Any] in
          var row: [String: Any] = ["window": target.window.index]
          if let device = target.device { row["device"] = device.name }
          if let screen = target.screen {
            row["screen"] = screen.frame.json
            if let panel = target.panel { row["display"] = panel.name }
            if !target.onWindow { row["pointer"] = offWindow }
            if let device = target.device {
              row["windowScalePreference"] = CoreSimulatorCatalog.windowScalePreferences(
                udid: device.udid)
            }
          } else {
            row["screen"] = target.problem ?? "not found"
          }
          return row
        }
      } catch {
        windows = error.localizedDescription
      }
    } else if !running {
      windows = "Neither Simulator.app nor DeviceHub is running"
    }

    return [
      "accessibility": trusted ? "granted" : "not granted",
      "simulatorRunning": running,
      "host": running ? simulator : NSNull(),
      "coreSimulator": coreSimulator,
      "windows": windows,
      "driving": DrivingSession.diagnostics().map { $0 as Any }
        ?? (DriveActivity.current() ?? "nothing"),
      "writes": writesAllowed ? "enabled" : "disabled — the driving tools are not registered",
      "reach": "\(bundleId(surface)) and \(deviceHub) only — no switch widens it",
      "wda": "not used here; for the WebDriverAgent lane run ios_simulator_diagnostics",
      "note":
        "A granted flag over a failed window read means duplicate Accessibility entries for one "
        + "bundle id. Run `tccutil reset Accessibility \(Bundle.main.bundleIdentifier ?? "io.mgcrea.cupertino")` "
        + "and grant it once from the running copy — never add another grant on top.",
    ]
  }

  // ─── resources ─────────────────────────────────────────────────────────────

  private static func resources() -> [[String: Any]] {
    [
      [
        "uri": "cupertino://simulator/guide",
        "name": "Driving an iOS Simulator",
        "description": "What this lane reaches, its coordinate space, and what stays with simctl.",
        "mimeType": "text/markdown",
      ],
      [
        "uri": "cupertino://simulator/diagnostics",
        "name": "Simulator diagnostics",
        "description": "Permission state, open device windows and their geometry.",
        "mimeType": "application/json",
      ],
    ]
  }

  private static func readResource(
    _ uri: String, id: Any?, surface: Surface, writesAllowed: Bool
  ) -> String {
    switch uri {
    case "cupertino://simulator/guide":
      return result(
        id,
        ["contents": [["uri": uri, "mimeType": "text/markdown", "text": guide(writesAllowed)]]])
    case "cupertino://simulator/diagnostics":
      let text = InProcessRPC.jsonText(diagnostics(surface: surface, writesAllowed: writesAllowed))
      return result(
        id, ["contents": [["uri": uri, "mimeType": "application/json", "text": text]]])
    default:
      return error(id, code: -32602, message: "unknown resource '\(uri)'")
    }
  }

  /// What a client loads on connect, which a resource never is: `guide` is
  /// pull-only, so a caller who never names the uri drives the Simulator
  /// without ever seeing it. This is the short version — only what changes the
  /// first move — and it names the guide for the rest. Kept deliberately small:
  /// it is paid on every connect, alongside every other surface's.
  private static func instructions(_ writesAllowed: Bool) -> String {
    guard writesAllowed else {
      return """
        Reading an iOS app's own controls on a Simulator through the Mac's accessibility tree —
        no WebDriverAgent and no runner process. Every `rect` and `point` is in iOS points,
        top-left of the device screen.

        Writes are off, so this surface can only look: the driving tools are not registered at
        all. Fuller notes: `cupertino://simulator/guide`.
        """
    }
    return """
      Driving an iOS app on a Simulator through the Mac's accessibility tree — no WebDriverAgent
      and no runner process to keep alive.

      Prefer `apple_simulator_press` with a handle from `ui_tree` or `find_elements`: it
      addresses the control, needs no activation and survives the window moving. `tap`, `swipe`,
      `type` and `key` are synthetic input the Simulator only takes when it is frontmost, so each
      one takes the focus from whoever is using the Mac — read the screen again after any of them
      rather than assuming the result. Every `rect` and `point` is in iOS points, top-left of the
      device screen.

      The first driving call while the person is using the Mac may wait a few seconds while
      Cupertino warns or asks them; if they cancel or say no, ask them rather than retrying. Call
      `apple_simulator_release` when you are done, which brings back the app they were in.

      Fuller notes, including what this lane reaches and what stays with `ios_simulator_*`:
      `cupertino://simulator/guide`.
      """
  }

  /// Static apart from the write line: no probe fact, so it reads on a Mac
  /// that has granted nothing.
  private static func guide(_ writesAllowed: Bool) -> String {
    """
    # Driving an iOS Simulator

    Simulator.app bridges the simulated device's accessibility tree into the Mac's, so an
    iOS app's own controls are readable and pressable here with no WebDriverAgent and no
    runner process to keep alive. Xcode 27 ships no Simulator.app: DeviceHub hosts the
    window instead and bridges the same tree, so this lane follows it there. DeviceHub shows
    one device per window — select it in DeviceHub's sidebar, or Open in New Window for a
    second — and quitting DeviceHub shuts the booted simulators down. A physical device in
    DeviceHub is a video of its screen with no tree behind it, so it is not reachable here.

    ## Coordinates are iOS points

    Every `rect` and `point` is in iOS points, top-left of the device screen — the same
    space `ios_simulator_tap`, `ios_simulator_swipe` and `ios_simulator_screenshot` use, so a
    point from here can be handed to those tools unchanged. `screenPoint` is where the same
    element sits on the Mac, for anyone driving through Desktop. The window scale is measured
    on every call and reported under `screen`; a window set to Fit Screen changes the scale
    and none of the iOS-point numbers.

    ## Address a control, then tap a point

    Prefer `apple_simulator_press` with a handle from `ui_tree` or `find_elements`: it
    addresses the control, needs no activation and survives the window moving. `tap`, `swipe`,
    `type` and `key` are synthetic input, and the Simulator only takes those when it is
    frontmost — so each one brings it to the front first, which takes the focus from whoever
    is using the Mac. Read the screen again after any of them rather than assuming the result.

    ## Driving is a session the person can see

    The first driving call while somebody is using this Mac waits while Cupertino warns them,
    with a countdown they can cancel or a question they answer. A refusal saying they cancelled
    or said no means nothing was posted: ask them in the conversation rather than retrying.
    After that every call goes straight through until the session ends, or until they stop it
    from the notice or the menu bar: a refusal saying they stopped it means what you did before
    may be half done, so ask them rather than carrying on. Call
    `apple_simulator_release` when you are done: it takes the notice down and brings back the
    application they were in, unless they have switched away themselves.

    ## What this reaches, and what it does not

    A strict subset of what WebDriverAgent reaches, and a subset that is fully named. A tab
    bar's items report their SF Symbol name (`leaf`, `calendar`) as `id`, which does not
    change with the device's language, so prefer it over the label. When a control you can
    see is not in the tree, `ios_simulator_ui_tree` sees it, or a `swipe` reaches it. Poll
    rather than settle: the window exists before the device has drawn anything into it.

    ## What stays with simctl

    Booting, installing, launching, screenshots, push, media, appearance and location need
    no grant, and `ios_simulator_*` does them. `apple_screen_capture_surface` with `simulator`
    photographs the Mac window, chrome included and at window scale; for the device's screen
    in points use `ios_simulator_screenshot`.

    ## The device's buttons

    `press_button` sends the Simulator's own shortcuts: home, lock, rotate. A locked Face ID
    device is unlocked by a `swipe` up from the bottom edge, not by home. Typing goes one key
    at a time on the Mac's current layout, and a character the layout cannot produce is
    reported back rather than silently dropped.

    ## A foldable: iPhone Duo

    `set_pose` folds and unfolds it through DeviceHub's pose buttons, the only way there is:
    `closed` draws the outer screen (466x678 points), `partially_open` and `open` the inner
    one (669x951). The window listings name the panel as `display` (`LCD` outer, `LCD-1`
    inner). The pose resets when the simulator reboots, and quitting DeviceHub shuts it down.

    DeviceHub places the Duo's screen in its accessibility tree away from where it draws it,
    folded or open, so a point cannot be mapped onto it. `tap` and `swipe` are refused there,
    and the listings say so under `pointer`. `press` with a handle from `ui_tree`, then `type`
    and `key`, still work. The `rect`s come out of that same frame, and open they overrun the
    screen's width, so on the Duo go by handles and labels, not coordinates.

    \(writesAllowed
      ? "Writes are ON: press, tap, swipe, type, key, press_button, set_pose and release are available."
      : "Writes are OFF, so this surface can only look. The driving tools are not registered at all.")
    """
  }

  // ─── envelopes ─────────────────────────────────────────────────────────────

  private static func result(_ id: Any?, _ value: Any) -> String { InProcessRPC.result(id, value) }
  private static func error(_ id: Any?, code: Int, message: String) -> String {
    InProcessRPC.error(id, code: code, message: message)
  }
  private static func ok(_ id: Any?, _ value: [String: Any]) -> String {
    InProcessRPC.ok(id, value)
  }
  private static func failure(_ id: Any?, _ message: String) -> String {
    InProcessRPC.failure(id, message)
  }
  private static func failed(_ id: Any?, _ error: Error) -> String {
    InProcessRPC.failed(id, error)
  }
}
