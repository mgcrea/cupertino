import Foundation

/// The MCP server for the `desktop` surface, served by the app itself.
///
/// Same shape as `ScreenServer`, and served in-process for two reasons rather
/// than one. The first is `screen`'s: the grant lives in the app, so a published
/// package could do nothing — Accessibility attaches to the RESPONSIBLE GUI
/// ANCESTOR, and an npm package would be asking a person to grant their editor
/// the right to drive every application on the Mac.
///
/// The second is new here and is about cost. Resolving an element is what an
/// Accessibility walk pays for; reading attributes off one already held is
/// nearly free — 0.015 ms against 0.6-4.5 ms. A long-lived process can hand back
/// handles and keep them. A fork-per-call helper cannot, and would pay ~0.3 s of
/// Swift-with-Cocoa startup on every tool call besides. See docs/desktop.md.
///
/// Hand-rolled rather than built on the MCP SDK for the reason `ScreenServer`
/// gives: there is no Swift SDK in this project and the surface needs six
/// methods. The shape is pinned by `make desktop-check`.
enum DesktopServer {

  /// Shared with every other in-process surface — see `InProcessRPC`.
  static let protocolVersion = InProcessRPC.protocolVersion

  static func nextLine(_ fd: Int32) -> String? { InProcessRPC.nextLine(fd) }

  // ─── dispatch ──────────────────────────────────────────────────────────────

  static func handle(
    _ line: String, surface: Surface, writesAllowed: Bool, anyAppAllowed: Bool
  ) -> String? {
    guard let data = line.data(using: .utf8),
      let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let method = msg["method"] as? String
    else { return nil }

    let id = msg["id"]
    // No id means a notification. Answering one is a protocol error.
    let isNotification = id == nil

    switch method {
    case "initialize":
      return isNotification
        ? nil
        : result(
          id,
          [
            "protocolVersion": protocolVersion,
            "capabilities": ["tools": [String: Any](), "resources": [String: Any]()],
            "serverInfo": ["name": "cupertino-desktop", "version": AppInfo.shortVersion],
          ])

    case "ping":
      return isNotification ? nil : result(id, [String: Any]())

    case "tools/list":
      return isNotification
        ? nil
        : result(id, ["tools": tools(writesAllowed: writesAllowed, anyAppAllowed: anyAppAllowed)])

    case "resources/list":
      return isNotification ? nil : result(id, ["resources": resources()])

    case "resources/read":
      guard !isNotification else { return nil }
      let uri = ((msg["params"] as? [String: Any])?["uri"] as? String) ?? ""
      return readResource(
        uri, id: id, surface: surface, writesAllowed: writesAllowed,
        anyAppAllowed: anyAppAllowed)

    case "prompts/list":
      return isNotification ? nil : result(id, ["prompts": [Any]()])

    case "tools/call":
      guard !isNotification else { return nil }
      let params = msg["params"] as? [String: Any] ?? [:]
      let name = params["name"] as? String ?? ""
      let args = params["arguments"] as? [String: Any] ?? [:]
      return call(
        name, args: args, id: id, surface: surface, writesAllowed: writesAllowed,
        anyAppAllowed: anyAppAllowed)

    default:
      guard !isNotification else { return nil }
      return error(id, code: -32601, message: "unknown method '\(method)'")
    }
  }

  // ─── tools ─────────────────────────────────────────────────────────────────

  /// The tool list is a pure function of the gate.
  ///
  /// The split is OBSERVE versus DRIVE. Observing is always registered, and
  /// deliberately including when nothing is reachable: a surface that answers
  /// "here is what is running and here is why I cannot read it" is worth more
  /// than one whose tools vanished. Driving is registered only when writes are
  /// on, and then it is not merely refused but ABSENT from tools/list — a
  /// refusal still lets a model try, retry and reason about a way around it.
  private static func tools(writesAllowed: Bool, anyAppAllowed: Bool) -> [[String: Any]] {
    let empty: [String: Any] = [
      "type": "object", "properties": [String: Any](), "required": [Any](),
    ]

    // Stated in the schema rather than left to a refusal. A model that reads
    // "any running application" and gets refused will retry; one that is told
    // the surface is scoped asks for something else, or tells the user which
    // switch to flip.
    let bundleIdProperty: [String: Any] = [
      "type": "string",
      "description": anyAppAllowed
        ? "Bundle identifier of any running application, from apple_desktop_list_apps."
        : "Bundle identifier of one of the Apple applications Cupertino brokers, from "
          + "apple_desktop_list_apps. This surface is scoped to those; \"Reach any application\" "
          + "in Cupertino widens it.",
    ]
    let detailProperty: [String: Any] = [
      "type": "string",
      "enum": ["interactive", "labelled", "all"],
      "description":
        "interactive (default) returns only what a press can land on; labelled returns anything "
        + "carrying an identifier, title or description; all returns everything.",
    ]
    let boundsProperties: [String: Any] = [
      "maxDepth": [
        "type": "integer",
        "description": "How deep to walk. Default 12.",
      ],
      "maxNodes": [
        "type": "integer",
        "description": "How many elements to visit. Default 4000.",
      ],
      "budgetSeconds": [
        "type": "number",
        "description":
          "Wall-clock budget for the walk. Default 5. This is the bound that actually protects "
          + "you: cost per element varies 200x between applications, so a node count does not "
          + "predict how long a walk takes.",
      ],
    ]

    var list: [[String: Any]] = [
      [
        "name": "apple_desktop_list_apps",
        "description": anyAppAllowed
          ? "List every application running with a normal user interface, with their bundle "
            + "identifiers and process ids. Works with no Accessibility grant at all."
          : "List the Apple applications Cupertino brokers that are running now, with their "
            + "bundle identifiers and process ids. Works with no Accessibility grant at all.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_list_windows",
        "description":
          "List an application's addressable windows. Titles are withheld unless includeTitles "
          + "is set, because a window title can be a mail subject or a document name.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "bundleId": bundleIdProperty,
            "includeTitles": [
              "type": "boolean",
              "description": "Return window titles. Defaults to false.",
            ],
          ],
          "required": ["bundleId"],
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_ui_tree",
        "description":
          "Read an application's accessibility tree, flattened to addressable elements with a "
          + "click point already computed. Each element carries an opaque handle that "
          + "apple_desktop_press and the other verbs take. Prefer addressing by the element's "
          + "id or name over its point. The answer says which bound stopped the walk.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "bundleId": bundleIdProperty,
            "window": [
              "type": "integer",
              "description": "Index from apple_desktop_list_windows. Omitted means every window, "
                + "which is usually what you want: a popover is its own window.",
            ],
            "detail": detailProperty,
          ].merging(boundsProperties) { current, _ in current },
          "required": ["bundleId"],
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_expand",
        "description":
          "Read the children of one element already returned by apple_desktop_ui_tree. This is "
          + "how to reach into a large window: the default tree is bounded on purpose, and a "
          + "content-heavy application can hold ten thousand elements.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "handle": [
              "type": "string",
              "description": "An element handle from a previous tree or expand call.",
            ],
            "detail": detailProperty,
          ].merging(boundsProperties) { current, _ in current },
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_find_elements",
        "description":
          "Search an application's tree for elements matching an identifier, role or name, "
          + "without reading the whole tree first. Matching is case-insensitive and by substring "
          + "for name, exact for id and role.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "bundleId": bundleIdProperty,
            "id": ["type": "string", "description": "Exact AXIdentifier to match."],
            "role": ["type": "string", "description": "Exact role, e.g. AXButton."],
            "name": ["type": "string", "description": "Substring of the title or description."],
            "pressableOnly": [
              "type": "boolean",
              "description": "Only return elements that can be pressed. Defaults to false.",
            ],
          ].merging(boundsProperties) { current, _ in current },
          "required": ["bundleId"],
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_diagnostics",
        "description":
          "Report whether Accessibility is granted, whether a real window can actually be read, "
          + "and whether the driving tools are registered.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
    ]

    guard writesAllowed else { return list }

    list.append(contentsOf: [
      [
        "name": "apple_desktop_press",
        "description":
          "Press an element by its handle. This is the verb to reach for: it addresses a control "
          + "rather than a coordinate, so it survives the window moving or the layout changing.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"]],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_set_value",
        "description":
          "Set an element's value — a text field, a slider. Reads the value back and reports "
          + "whether it actually took: some applications report a value as settable and then "
          + "drop the write.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"], "value": ["type": "string"]],
          "required": ["handle", "value"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": true],
      ],
      [
        "name": "apple_desktop_click",
        "description":
          "Click at a screen point. The fallback for a control that offers no press action — "
          + "prefer apple_desktop_press whenever the element has one.",
        "inputSchema": [
          "type": "object",
          "properties": ["x": ["type": "number"], "y": ["type": "number"]],
          "required": ["x", "y"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_type",
        "description":
          "Type text into whatever has keyboard focus. Sent as unicode, so accented and "
          + "non-Latin characters arrive intact.",
        "inputSchema": [
          "type": "object",
          "properties": ["text": ["type": "string"]],
          "required": ["text"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_key",
        "description":
          "Send one named key with optional modifiers — return, tab, escape, an arrow, a "
          + "function key. Anything typeable should go through apple_desktop_type instead.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "key": ["type": "string", "description": "return, tab, escape, up, down, f1 …"],
            "modifiers": [
              "type": "array", "items": ["type": "string"],
              "description": "command, shift, option, control, function.",
            ],
          ],
          "required": ["key"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_raise_window",
        "description": "Bring a window to the front by its handle.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"]],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
    ])
    return list
  }

  // ─── calls ─────────────────────────────────────────────────────────────────

  private static func bounds(_ args: [String: Any]) -> AccessibilityDriver.Bounds {
    var out = AccessibilityDriver.Bounds()
    if let depth = args["maxDepth"] as? Int { out.depth = max(1, depth) }
    if let nodes = args["maxNodes"] as? Int { out.nodes = max(1, nodes) }
    if let seconds = args["budgetSeconds"] as? Double { out.seconds = max(0.1, seconds) }
    return out
  }

  private static func detail(_ args: [String: Any]) -> AccessibilityDriver.Detail {
    AccessibilityDriver.Detail(rawValue: args["detail"] as? String ?? "") ?? .interactive
  }

  /// The context-window bound, and the reason it is separate from the three
  /// walk bounds.
  ///
  /// Depth, nodes and seconds bound the WALK. None of them bounds the ANSWER: a
  /// caller that raises maxNodes gets every element serialised, and a real
  /// measurement of Notes returned 9770 elements from one window. That is
  /// megabytes of JSON into a model's context for a question about one button.
  ///
  /// `mcp-ios-core/src/ui-tree.ts` carries the same cap for the same reason and
  /// states it plainly: passing a raw tree through "would not merely cost tokens
  /// — it would make the model walk a tree to find a tappable rect".
  ///
  /// MEASURED AGAINST WHAT IS EMITTED, not against compact JSON, and the first
  /// version of this got that wrong. `InProcessRPC.jsonText` writes
  /// `.prettyPrinted`, which puts every element of `rect` and `point` on its own
  /// line — a 60,000-byte compact budget produced **129,420 characters** on the
  /// wire, 2.2x over. Budgeting against a serialisation nobody sends is a cap
  /// that does not cap.
  private static let maxBytes = 40_000

  private static func treeBody(_ tree: AccessibilityDriver.Tree) -> [String: Any] {
    var kept: [[String: Any]] = []
    var bytes = 0
    for element in tree.elements {
      let json = element.json
      // Measured rather than estimated: an element with a long name and a rect
      // is several times the size of a bare button, so a per-element budget
      // would be wrong in both directions. Serialised with the SAME options
      // `InProcessRPC.jsonText` will use, so the number counted is the number
      // sent.
      let size =
        (try? JSONSerialization.data(
          withJSONObject: json, options: [.prettyPrinted, .sortedKeys]))?.count ?? 400
      if bytes + size > maxBytes { break }
      bytes += size
      kept.append(json)
    }

    var body: [String: Any] = [
      "elements": kept,
      "returned": kept.count,
      // What MATCHED, so a truncated answer is obviously partial rather than
      // looking like a small window.
      "matched": tree.elements.count,
      "visited": tree.visited,
      "seconds": (tree.seconds * 1000).rounded() / 1000,
      "coordinateSpace": "screen points, top-left origin",
    ]

    // Named rather than implied. A truncated answer that does not say so is
    // worse than a slow one, and which bound stopped it tells the caller what to
    // raise — or, for this one, that raising a bound is not the answer.
    var stops: [String] = []
    if let stoppedBy = tree.stoppedBy { stops.append(stoppedBy) }
    if kept.count < tree.elements.count {
      stops.append("bytes(\(maxBytes))")
      body["truncated"] =
        "Returned \(kept.count) of \(tree.elements.count) matching elements. Narrow the query "
        + "with find_elements, or walk down with expand — raising maxNodes will not return more."
    }
    if !stops.isEmpty { body["stoppedBy"] = stops.joined(separator: ",") }
    return body
  }

  private static func call(
    _ name: String, args: [String: Any], id: Any?, surface: Surface, writesAllowed: Bool,
    anyAppAllowed: Bool
  ) -> String {
    // Every driving tool goes through here. Unreachable through a compliant
    // client, since none of them is listed with writes off — but a server must
    // not rely on its caller being compliant to stay read-only.
    let driving = [
      "apple_desktop_press", "apple_desktop_set_value", "apple_desktop_click",
      "apple_desktop_type", "apple_desktop_key", "apple_desktop_raise_window",
    ]
    if driving.contains(name) && !writesAllowed {
      return failure(
        id,
        "Driving \(surface.displayName) is switched off. Turn on writes for this surface in "
          + "Cupertino.")
    }

    do {
      switch name {
      case "apple_desktop_list_apps":
        let apps = AccessibilityDriver.runningApps(anyApp: anyAppAllowed)
        return ok(
          id,
          [
            "apps": apps.map {
              ["name": $0.name, "bundleId": $0.bundleId, "pid": Int($0.pid), "active": $0.active]
            },
            "accessibility": AccessibilityDriver.isTrusted() ? "granted" : "not granted",
          ])

      case "apple_desktop_list_windows":
        guard let bundleId = args["bundleId"] as? String else {
          return failure(id, "The 'bundleId' argument is required.")
        }
        let includeTitles = args["includeTitles"] as? Bool ?? false
        let windows = try AccessibilityDriver.windows(bundleId: bundleId, anyApp: anyAppAllowed)
        return ok(
          id,
          [
            "windows": windows.map { window -> [String: Any] in
              var out: [String: Any] = [
                "handle": window.handle, "index": window.index, "role": window.role,
                "main": window.main, "titled": window.title != nil,
              ]
              if let rect = window.rect { out["rect"] = rect }
              if includeTitles, let title = window.title { out["title"] = title }
              return out
            },
            "note": includeTitles
              ? "Titles included at your request."
              : "Titles withheld — pass includeTitles to read them.",
          ])

      case "apple_desktop_ui_tree":
        guard let bundleId = args["bundleId"] as? String else {
          return failure(id, "The 'bundleId' argument is required.")
        }
        let tree = try AccessibilityDriver.tree(
          bundleId: bundleId, windowIndex: args["window"] as? Int,
          detail: detail(args), bounds: bounds(args), anyApp: anyAppAllowed)
        return ok(id, treeBody(tree))

      case "apple_desktop_expand":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        let tree = try AccessibilityDriver.expand(
          handle: handle, detail: detail(args), bounds: bounds(args), anyApp: anyAppAllowed)
        return ok(id, treeBody(tree))

      case "apple_desktop_find_elements":
        guard let bundleId = args["bundleId"] as? String else {
          return failure(id, "The 'bundleId' argument is required.")
        }
        let wantedId = args["id"] as? String
        let wantedRole = args["role"] as? String
        let wantedName = (args["name"] as? String)?.lowercased()
        let pressableOnly = args["pressableOnly"] as? Bool ?? false
        if wantedId == nil && wantedRole == nil && wantedName == nil && !pressableOnly {
          return failure(id, "Give at least one of id, role, name or pressableOnly.")
        }
        // Searched over `all` regardless of what the caller wants back: a
        // control that carries no name is still findable by role, and filtering
        // before matching would hide it.
        let tree = try AccessibilityDriver.tree(
          bundleId: bundleId, windowIndex: args["window"] as? Int,
          detail: .all, bounds: bounds(args), anyApp: anyAppAllowed)
        let matched = tree.elements.filter { element in
          if pressableOnly && !element.pressable { return false }
          if let wantedId, element.identifier != wantedId { return false }
          if let wantedRole, element.role != wantedRole { return false }
          if let wantedName {
            guard let name = element.name?.lowercased(), name.contains(wantedName) else {
              return false
            }
          }
          return true
        }
        var body = treeBody(tree)
        body["elements"] = matched.map(\.json)
        body["returned"] = matched.count
        return ok(id, body)

      case "apple_desktop_diagnostics":
        return ok(
          id,
          diagnostics(
            surface: surface, writesAllowed: writesAllowed, anyAppAllowed: anyAppAllowed))

      case "apple_desktop_press":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.press(handle: handle, anyApp: anyAppAllowed)
        return ok(id, ["pressed": handle])

      case "apple_desktop_set_value":
        guard let handle = args["handle"] as? String, let value = args["value"] as? String else {
          return failure(id, "Both 'handle' and 'value' are required.")
        }
        let landed = try AccessibilityDriver.setValue(
          handle: handle, value: value, anyApp: anyAppAllowed)
        return ok(
          id,
          [
            "handle": handle, "confirmed": landed,
            "note": landed
              ? "The value read back as written."
              : "The application accepted the write and the value did not change. It reported "
                + "itself settable and dropped it; try focusing the field and typing instead.",
          ])

      case "apple_desktop_click":
        guard let x = args["x"] as? Double, let y = args["y"] as? Double else {
          return failure(id, "Both 'x' and 'y' are required.")
        }
        try AccessibilityDriver.click(x: x, y: y)
        return ok(id, ["clicked": [x, y]])

      case "apple_desktop_type":
        guard let text = args["text"] as? String else {
          return failure(id, "The 'text' argument is required.")
        }
        try AccessibilityDriver.type(text: text)
        return ok(id, ["typed": text.count])

      case "apple_desktop_key":
        guard let key = args["key"] as? String else {
          return failure(id, "The 'key' argument is required.")
        }
        let modifiers = (args["modifiers"] as? [String]) ?? []
        try AccessibilityDriver.key(key, modifiers: modifiers)
        return ok(id, ["key": key, "modifiers": modifiers])

      case "apple_desktop_raise_window":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.raise(handle: handle, anyApp: anyAppAllowed)
        return ok(id, ["raised": handle])

      default:
        return failure(id, "unknown tool '\(name)'")
      }
    } catch {
      return failed(id, error)
    }
  }

  // ─── diagnostics ───────────────────────────────────────────────────────────

  /// Measures the capability rather than asking about it.
  ///
  /// `AXIsProcessTrusted()` is a CLAIM about an identity; reading a real window
  /// is the thing the surface does. They are allowed to disagree, and the
  /// disagreement is the diagnosis — Permissions.swift:449 records a day lost to
  /// a green row over a blind read, caused by four duplicate TCC entries under
  /// one bundle identifier.
  private static func diagnostics(
    surface: Surface, writesAllowed: Bool, anyAppAllowed: Bool
  ) -> [String: Any] {
    let trusted = AccessibilityDriver.isTrusted()
    let apps = AccessibilityDriver.runningApps(anyApp: anyAppAllowed)

    var probe = "not attempted"
    if trusted, let first = apps.first(where: { $0.bundleId != Bundle.main.bundleIdentifier }) {
      do {
        let windows = try AccessibilityDriver.windows(
          bundleId: first.bundleId, anyApp: anyAppAllowed)
        probe = "read \(windows.count) window(s) from \(first.name)"
      } catch {
        probe = "FAILED against \(first.name): \(error.localizedDescription)"
      }
    }

    return [
      "accessibility": trusted ? "granted" : "not granted",
      "windowRead": probe,
      "runningApps": apps.count,
      "writes": writesAllowed ? "enabled" : "disabled — the driving tools are not registered",
      "reach": anyAppAllowed
        ? "any running application"
        : "the \(AccessibilityDriver.brokeredBundleIds.count) applications Cupertino brokers — "
          + "switch on \"Reach any application\" for Desktop to widen it",
      // The RUNNING bundle id, never a literal. A Debug build is
      // io.mgcrea.cupertino.debug and holds a TCC identity of its own, so a
      // hardcoded release identifier sends someone to reset a grant that is not
      // the one failing — which is the same class of mistake as granting again
      // on top, and this note exists to prevent exactly that.
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
        "uri": "cupertino://desktop/guide",
        "name": "Driving macOS applications",
        "description": "How to address a control, and what the bounds mean.",
        "mimeType": "text/markdown",
      ]
    ]
  }

  private static func readResource(
    _ uri: String, id: Any?, surface: Surface, writesAllowed: Bool, anyAppAllowed: Bool
  ) -> String {
    guard uri == "cupertino://desktop/guide" else {
      return error(id, code: -32602, message: "unknown resource '\(uri)'")
    }
    let text = """
      # Driving macOS applications

      This surface reads and drives any running application's interface through the
      Accessibility API — natively, not through AppleScript or System Events.

      ## Address a control, do not click a coordinate

      `apple_desktop_ui_tree` returns elements carrying a `handle`, an `id`
      (the developer-set AXIdentifier), a `name` and a `point`. Reach for them in that
      order. An identifier is unlocalised and survives a layout change; a point does
      not survive either, and on a non-English Mac a name may not survive at all.

      Do not filter by role to find something clickable. Controls report themselves as
      AXGenericElement, AXStaticText and AXImage at least as often as AXButton — in Maps
      a role filter would miss 86% of what can be pressed. The tree already marks
      `pressable`, which is the answer to "what has an AXPress".

      ## The tree is bounded on purpose

      A content-heavy window can hold ten thousand elements, and cost per element varies
      two hundredfold between applications, so the default walk stops at 12 deep, 4000
      elements or 5 seconds. The answer names which bound stopped it in `stoppedBy`.
      Reach further with `apple_desktop_expand` on a handle rather than by raising the
      bounds — that is what it is for.

      ## A popover is its own window

      Omitting `window` walks every one of them, which is usually what you want.
      Asking for window 0 is how a search for a control that lives in a popover finds
      nothing at all.

      ## Handles go stale

      They point at elements in the window as it was. If a press returns a stale-handle
      error, take a fresh tree rather than retrying.

      ## Two switches, and they bound different things

      \(writesAllowed
        ? "Writes are ON: press, set_value, click, type, key and raise_window are available."
        : "Writes are OFF, so this surface can only look. The driving tools are not registered at all.")

      \(anyAppAllowed
        ? "Reach is ANY running application."
        : "Reach is limited to the Apple applications Cupertino brokers. Another application is refused by name, not by silence — widen it in Cupertino if you meant to address one.")
      """
    return result(
      id,
      ["contents": [["uri": uri, "mimeType": "text/markdown", "text": text]]])
  }

  // ─── envelopes ─────────────────────────────────────────────────────────────

  private static func result(_ id: Any?, _ value: Any) -> String {
    InProcessRPC.result(id, value)
  }

  private static func error(_ id: Any?, code: Int, message: String) -> String {
    InProcessRPC.error(id, code: code, message: message)
  }

  private static func ok(_ id: Any?, _ value: [String: Any]) -> String {
    InProcessRPC.ok(id, value)
  }

  /// A tool failure is a result with `isError`, not a JSON-RPC error — the model
  /// has to be able to read why.
  private static func failure(_ id: Any?, _ message: String) -> String {
    InProcessRPC.failure(id, message)
  }

  private static func failed(_ id: Any?, _ error: Error) -> String {
    InProcessRPC.failed(id, error)
  }
}
