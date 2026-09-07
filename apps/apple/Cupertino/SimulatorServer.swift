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
enum SimulatorServer {

  static let protocolVersion = InProcessRPC.protocolVersion

  static func nextLine(_ fd: Int32) -> String? { InProcessRPC.nextLine(fd) }

  /// The one application this surface reaches. Read off the table rather than
  /// spelled here, so the manifest stays the only copy of the bundle id.
  static func bundleId(_ surface: Surface) -> String {
    surface.bundleID ?? "com.apple.iphonesimulator"
  }

  /// Pinned. Not `.brokered`, which would let a handle minted here address
  /// Mail, and not `.any`. The same value a lend gets, for the same reason.
  static func scope(_ surface: Surface) -> AccessibilityDriver.Scope {
    .only([bundleId(surface)])
  }

  // ─── dispatch ──────────────────────────────────────────────────────────────

  static func handle(_ line: String, surface: Surface, writesAllowed: Bool) -> String? {
    InProcessRPC.dispatch(
      line,
      name: "cupertino-simulator",
      tools: { tools(writesAllowed: writesAllowed) },
      resources: { resources() },
      read: { uri, id in readResource(uri, id: id, surface: surface, writesAllowed: writesAllowed)
      },
      call: { name, args, id in
        call(name, args: args, id: id, surface: surface, writesAllowed: writesAllowed)
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
          + "Simulator.app — with each window's device screen located: origin on the Mac, point "
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
          "Report whether Accessibility is granted, whether Simulator.app is running, which "
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
          + "whatever covers the window. Refused outside the screen.",
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
          + "the Simulator to the front. Needs I/O › Keyboard › Send Keyboard Input to Device "
          + "left on, which is its default.",
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
    ]
    list.append(contentsOf: driving)
    return list
  }

  static let drivingNames = [
    "apple_simulator_press", "apple_simulator_tap", "apple_simulator_swipe",
    "apple_simulator_type", "apple_simulator_key", "apple_simulator_press_button",
  ]

  // ─── the device screen ─────────────────────────────────────────────────────

  /// One Simulator window, and what was found behind it.
  struct Target {
    let window: AccessibilityDriver.WindowRef
    let device: CoreSimulatorCatalog.Device?
    /// The device-screen group's handle and frame, or nil with the reason.
    let screen: (handle: String, frame: SimulatorGeometry.DeviceFrame)?
    let problem: String?

    var json: [String: Any] {
      var out: [String: Any] = ["window": window.index, "title": window.title ?? ""]
      if let device {
        out["device"] = ["udid": device.udid, "name": device.name, "runtime": device.runtimeLabel]
      }
      if let screen {
        out["screen"] = screen.frame.json
        out["screenHandle"] = screen.handle
      } else {
        out["screen"] = problem ?? "not found"
      }
      return out
    }
  }

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

  /// Resolve every Simulator window to a device screen, freshly, every call.
  ///
  /// A depth-1 walk of a window costs ~7 ms and the group's frame moves with
  /// the window, so nothing is cached across calls: a frame read a minute ago
  /// is a frame for a window that may have been dragged, resized or rotated
  /// since. Re-reading is cheaper than being wrong.
  static func targets(surface: Surface) throws -> [Target] {
    let id = bundleId(surface)
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

      let children: [AccessibilityDriver.Element]
      do {
        let tree = try AccessibilityDriver.tree(
          bundleId: id, windowIndex: window.index, detail: .all,
          bounds: .init(depth: 1, nodes: 200, seconds: 2), scope: reach)
        children = tree.elements.filter { $0.depth == 1 }
      } catch {
        return Target(
          window: window, device: byTitle, screen: nil, problem: error.localizedDescription)
      }
      let groups = children.filter { $0.role == "AXGroup" && $0.rect != nil }
      guard !groups.isEmpty else {
        return Target(
          window: window, device: byTitle, screen: nil,
          problem: "no AXGroup in the window — the device has not drawn yet; poll")
      }
      guard !candidates.isEmpty else {
        return Target(
          window: window, device: byTitle, screen: nil,
          problem: "no booted device to match the window against")
      }
      for device in candidates {
        guard let profile = profile(for: device.deviceType) else { continue }
        for group in groups {
          let rect = group.rect!
          if let frame = SimulatorGeometry.resolve(
            groupOrigin: CGPoint(x: rect[0], y: rect[1]),
            groupSize: CGSize(width: rect[2], height: rect[3]),
            portraitPoints: profile.points)
          {
            return Target(
              window: window, device: device, screen: (group.handle, frame), problem: nil)
          }
        }
      }
      let sizes = groups.map { "\(Int($0.rect![2]))x\(Int($0.rect![3]))" }.joined(separator: ", ")
      let wanted = candidates.compactMap { d in
        profile(for: d.deviceType).map {
          "\(d.name) \(Int($0.points.width))x\(Int($0.points.height))"
        }
      }.joined(separator: ", ")
      return Target(
        window: window, device: byTitle, screen: nil,
        problem:
          "no AXGroup matches a device's point size at any scale — groups \(sizes); wanted \(wanted)"
      )
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
          ? "Simulator.app has no window."
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

  private static func body(_ tree: AccessibilityDriver.Tree, target: Target, filtered: Bool)
    -> [String: Any]
  {
    var out = DesktopServer.treeBody(
      tree, elements: filtered ? tree.elements : nil, render: render(target.screen!.frame),
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
    let simulator = bundleId(surface)

    do {
      switch name {
      case "apple_simulator_list_devices":
        return ok(id, listDevices(surface: surface))

      case "apple_simulator_ui_tree":
        let target = try target(surface: surface, args: args)
        let tree = try AccessibilityDriver.expand(
          handle: target.screen!.handle, detail: DesktopServer.detail(args),
          bounds: DesktopServer.bounds(args), scope: reach)
        return ok(id, body(tree, target: target, filtered: false))

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
        return ok(id, body(tree, target: target, filtered: true))

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
        try AccessibilityDriver.click(x: at.x, y: at.y, announcing: simulator)
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
        try AccessibilityDriver.drag(
          from: frame.toScreen(from), to: frame.toScreen(to), durationMs: durationMs,
          announcing: simulator)
        return ok(
          id, ["swiped": ["from": [fromX, fromY], "to": [toX, toY], "durationMs": durationMs]])

      case "apple_simulator_type":
        guard let text = args["text"] as? String, !text.isEmpty else {
          return failure(id, "The 'text' argument is required.")
        }
        _ = try target(surface: surface, args: args)
        try front(simulator, scope: reach)
        let unmapped = try AccessibilityDriver.typeByKeyCodes(text, announcing: simulator)
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
        try AccessibilityDriver.key(key, modifiers: [], announcing: simulator)
        return ok(id, ["key": key])

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
        try AccessibilityDriver.key(chord.key, modifiers: chord.modifiers, announcing: simulator)
        return ok(id, ["pressed": button])

      default:
        return failure(id, "unknown tool '\(name)'")
      }
    } catch {
      return failed(id, error)
    }
  }

  /// Bring the Simulator to the front and WAIT for it, refusing to post when
  /// it did not come. Measured: a click posted before activation reached
  /// nothing — or worse, whatever covered the window.
  private static func front(_ simulator: String, scope: AccessibilityDriver.Scope) throws {
    guard try AccessibilityDriver.activateAndWait(bundleId: simulator, scope: scope) else {
      throw AccessibilityDriver.Failure.refused(
        "Simulator.app did not come to the front, so nothing was posted — a synthetic event "
          + "lands in whatever is frontmost, which would have been someone else's window.")
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
    let simulator = bundleId(surface)
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
      windows = "Simulator.app is not running"
    }

    return [
      "accessibility": trusted ? "granted" : "not granted",
      "simulatorRunning": running,
      "coreSimulator": coreSimulator,
      "windows": windows,
      "driving": DriveActivity.current() ?? "nothing",
      "writes": writesAllowed ? "enabled" : "disabled — the driving tools are not registered",
      "reach": "\(simulator) only — no switch widens it",
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

  /// Static apart from the write line: no probe fact, so it reads on a Mac
  /// that has granted nothing.
  private static func guide(_ writesAllowed: Bool) -> String {
    """
    # Driving an iOS Simulator

    Simulator.app bridges the simulated device's accessibility tree into the Mac's, so an
    iOS app's own controls are readable and pressable here with no WebDriverAgent and no
    runner process to keep alive.

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

    \(writesAllowed
      ? "Writes are ON: press, tap, swipe, type, key and press_button are available."
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
