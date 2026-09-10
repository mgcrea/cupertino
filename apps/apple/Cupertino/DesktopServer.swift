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
    _ line: String, surface: Surface, writesAllowed: Bool, scope: AccessibilityDriver.Scope
  ) -> String? {
    InProcessRPC.dispatch(
      line,
      name: "cupertino-desktop",
      tools: { tools(writesAllowed: writesAllowed, scope: scope) },
      resources: { resources() },
      read: { uri, id in
        readResource(uri, id: id, surface: surface, writesAllowed: writesAllowed, scope: scope)
      },
      call: { name, args, id in
        call(name, args: args, id: id, surface: surface, writesAllowed: writesAllowed, scope: scope)
      })
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
  private static func tools(writesAllowed: Bool, scope: AccessibilityDriver.Scope)
    -> [[String: Any]]
  {
    let empty: [String: Any] = [
      "type": "object", "properties": [String: Any](), "required": [Any](),
    ]

    // Stated in the schema rather than left to a refusal. A model that reads
    // "any running application" and gets refused will retry; one that is told
    // the surface is scoped asks for something else, or tells the user which
    // switch to flip.
    let bundleIdDescription: String
    switch scope {
    case .any:
      bundleIdDescription =
        "Bundle identifier of any running application, from apple_desktop_list_apps."
    case .brokered:
      bundleIdDescription =
        "Bundle identifier of one of the Apple applications Cupertino brokers, from "
        + "apple_desktop_list_apps. This surface is scoped to those; \"Reach any application\" "
        + "in Cupertino widens it."
    case .only(let ids):
      // The internal channel. Naming the one app it may address is not a
      // nicety: this driver was lent to a surface for ITS app, and a
      // description promising the brokered set would be an invitation to try
      // the others and collect a refusal each time.
      bundleIdDescription =
        "Bundle identifier of \(ids.sorted().joined(separator: " or ")). This driver was lent "
        + "for that application alone and reaches nothing else."
    }
    let bundleIdProperty: [String: Any] = [
      "type": "string",
      "description": bundleIdDescription,
    ]
    // `type` and `key` accept a handle for the application it names, not for the
    // element: a keystroke still goes wherever the focus is. Said here, because a
    // caller reading "handle" on a typing verb would reasonably expect the text
    // to be put into that field.
    let sessionHandleProperty: [String: Any] = [
      "type": "string",
      "description": "The field you focused, from apple_desktop_find_elements or "
        + "apple_desktop_ui_tree. Its application is brought to the front first; the keystroke "
        + "still goes wherever the focus is, so focus the field with apple_desktop_focus. "
        + "Preferred over 'bundleId', since a handle already knows which application it belongs to.",
    ]
    // One definition, because both the walk and the search honour it. Declaring
    // it on one and not the other is how a caller learns an argument exists by
    // having it silently ignored.
    let windowProperty: [String: Any] = [
      "type": "integer",
      "description": "Index from apple_desktop_list_windows. Omitted means every window, "
        + "which is usually what you want: a popover is its own window.",
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
        "description": "How many elements to visit. Default 4000, at most 50000.",
      ],
      "budgetSeconds": [
        "type": "number",
        "description":
          "Wall-clock budget for the walk. Default 5, at most 60. This is the bound that actually "
          + "protects you: cost per element varies 200x between applications, so a node count "
          + "does not predict how long a walk takes.",
      ],
    ]

    var list: [[String: Any]] = [
      [
        "name": "apple_desktop_list_apps",
        "description":
          "List the applications in reach that are running now — \(scope.described) — with their "
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
            "window": windowProperty,
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
            "window": windowProperty,
          ].merging(boundsProperties) { current, _ in current },
          "required": ["bundleId"],
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_get_attribute",
        "description":
          "Read one named Accessibility attribute off an element — AXBlockQuoteLevel, "
          + "AXFocused, anything the application publishes. The tree carries a fixed field set "
          + "chosen for addressing controls; this is how you verify a write that changed "
          + "something else. An element that does not carry the attribute answers null, which "
          + "is an answer rather than a failure.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "handle": ["type": "string"],
            "attribute": [
              "type": "string",
              "description": "The attribute name, e.g. AXBlockQuoteLevel.",
            ],
          ],
          "required": ["handle", "attribute"],
        ],
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_desktop_user_activity",
        "description":
          "Seconds since a person last touched this machine — keyboard, mouse, trackpad or "
          + "scroll. Reports WHEN, never what: no key, no position, no content. Driving an "
          + "interface competes with whoever is using it, because a keystroke goes to whatever "
          + "is frontmost, so read this before and after a sequence: if the seconds since input "
          + "are LESS than the time your sequence took, somebody typed into the middle of it and "
          + "the result cannot be trusted.",
        "inputSchema": empty,
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
          + "prefer apple_desktop_press whenever the element has one. Pass 'bundleId' for the "
          + "application the point belongs to: it is brought to the front first, and nothing is "
          + "clicked if it does not come. Without it the click lands on whatever window is on top "
          + "at that point, which may be one the person at the keyboard has since put there.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "x": ["type": "number"], "y": ["type": "number"], "bundleId": bundleIdProperty,
          ],
          "required": ["x", "y"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_hover",
        "description":
          "Move the pointer onto something and leave it there, posting real mouse-moved events "
          + "along the way. The verb for anything that only exists under the cursor — a tooltip, "
          + "a hover readout, a SwiftUI onContinuousHover. A click will not do it: a click posts "
          + "a press and a release and no movement at all, so a tracking area never sees the "
          + "pointer arrive. Prefer 'handle' over 'x'/'y' — the point is re-read from the element "
          + "at call time, so a window that has moved since the tree was taken cannot make the "
          + "hover miss in silence. Brings the target application to the front first, because a "
          + "hover is only delivered to the frontmost one. Refused while somebody is using the "
          + "Mac, since it takes the physical pointer away from them.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "handle": [
              "type": "string",
              "description": "Element to hover, from apple_desktop_find_elements or "
                + "apple_desktop_ui_tree. Preferred over a coordinate.",
            ],
            "x": ["type": "number", "description": "Screen point, when no element carries one."],
            "y": ["type": "number"],
            "bundleId": bundleIdProperty,
            "durationMs": [
              "type": "integer",
              "description": "How long the pointer takes to travel, default 600. The pointer is "
                + "walked rather than teleported because a tracking area wants motion.",
            ],
            "settleMs": [
              "type": "integer",
              "description": "Wait this long after arriving, default 0. The hover state is drawn "
                + "by the other application, so a tree read immediately after a move can be "
                + "taken from before the redraw.",
            ],
          ],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
      [
        "name": "apple_desktop_type",
        "description":
          "Type text into whatever has keyboard focus. Sent as unicode, so accented and "
          + "non-Latin characters arrive intact. Pass 'handle' (the field you focused) or "
          + "'bundleId': that application is brought to the front first, and nothing is typed if "
          + "it does not come. Without either, the text goes to whatever is frontmost, which may "
          + "be someone else's window.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "text": ["type": "string"],
            "handle": sessionHandleProperty,
            "bundleId": bundleIdProperty,
          ],
          "required": ["text"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_key",
        "description":
          "Send one named key with optional modifiers — return, tab, escape, an arrow, a "
          + "function key. Anything typeable should go through apple_desktop_type instead. Pass "
          + "'handle' or 'bundleId' exactly as for apple_desktop_type: that application is brought "
          + "to the front first, and no key is sent if it does not come.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "key": ["type": "string", "description": "return, tab, escape, up, down, f1 …"],
            "modifiers": [
              "type": "array", "items": ["type": "string"],
              "description": "command, shift, option, control, function.",
            ],
            "handle": sessionHandleProperty,
            "bundleId": bundleIdProperty,
          ],
          "required": ["key"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_focus",
        "description":
          "Give an element the keyboard focus, and report whether it took. Raising a window is "
          + "NOT this: a raise orders a window forward inside its application, while a "
          + "keystroke goes wherever the focus actually is. Focus the field before you type "
          + "into it.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"]],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
      [
        "name": "apple_desktop_activate",
        "description":
          "Bring an application to the front. Synthetic keystrokes land in whatever is "
          + "frontmost. apple_desktop_click, apple_desktop_type and apple_desktop_key take a "
          + "'bundleId' that does this for them and refuses when it did not take — prefer that to "
          + "a separate call here, which the person at the keyboard can undo before the next one.",
        "inputSchema": [
          "type": "object",
          "properties": ["bundleId": bundleIdProperty],
          "required": ["bundleId"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
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

  /// The ceilings exist because a session thread serves one caller at a time.
  /// `budgetSeconds: 3600` is not a bigger answer, it is an hour in which this
  /// surface answers nothing else — and the guide already says the way to reach
  /// further is apple_desktop_expand rather than a raised bound. Depth needs no
  /// ceiling: the walk is bounded by the real tree, which ends.
  static let maxNodesCeiling = 50_000
  static let maxSecondsCeiling = 60.0

  static func bounds(_ args: [String: Any]) -> AccessibilityDriver.Bounds {
    var out = AccessibilityDriver.Bounds()
    if let depth = args["maxDepth"] as? Int { out.depth = max(1, depth) }
    if let nodes = args["maxNodes"] as? Int { out.nodes = min(max(1, nodes), maxNodesCeiling) }
    if let seconds = args["budgetSeconds"] as? Double {
      out.seconds = min(max(0.1, seconds), maxSecondsCeiling)
    }
    return out
  }

  static func detail(_ args: [String: Any]) -> AccessibilityDriver.Detail {
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

  /// `elements` is what the caller asked for, which is NOT always the whole
  /// walk.
  ///
  /// `find_elements` walks everything and returns a filtered set, and passing
  /// the walk here was a real defect: `matched` came from the tree, so a search
  /// that found ONE control reported `returned: 1, matched: 136` — which reads
  /// exactly like a truncated answer and is the confusion this field exists to
  /// prevent. The byte cap was wrong the same way, measured against elements
  /// that were never going to be sent.
  ///
  /// `render` and `coordinateSpace` exist for the simulator surface, which
  /// answers the same walk in iOS points: the byte cap and the `matched` /
  /// `returned` / `truncated` contract are one implementation here rather
  /// than a copy that would drift.
  static func treeBody(
    _ tree: AccessibilityDriver.Tree, elements: [AccessibilityDriver.Element]? = nil,
    render: ((AccessibilityDriver.Element) -> [String: Any])? = nil,
    coordinateSpace: String = "screen points, top-left origin"
  ) -> [String: Any] {
    let answering = elements ?? tree.elements
    var kept: [[String: Any]] = []
    var bytes = 0
    for element in answering {
      let json = render?(element) ?? element.json
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
      "matched": answering.count,
      "visited": tree.visited,
      "seconds": (tree.seconds * 1000).rounded() / 1000,
      "coordinateSpace": coordinateSpace,
    ]
    // Present only when it happened: elements that arrived by hit-testing a
    // container whose children link was empty (the Simulator's tab bar). A
    // caller who sees it knows those nodes exist because they are on screen,
    // and that a scrolled-away sibling would not have been found the same way.
    if tree.recovered > 0 { body["recovered"] = tree.recovered }

    // Named rather than implied. A truncated answer that does not say so is
    // worse than a slow one, and which bound stopped it tells the caller what to
    // raise — or, for this one, that raising a bound is not the answer.
    var stops: [String] = []
    if let stoppedBy = tree.stoppedBy { stops.append(stoppedBy) }
    if kept.count < answering.count {
      stops.append("bytes(\(maxBytes))")
      body["truncated"] =
        "Returned \(kept.count) of \(answering.count) matching elements. Narrow the query "
        + "with find_elements, or walk down with expand — raising maxNodes will not return more."
    }
    if !stops.isEmpty { body["stoppedBy"] = stops.joined(separator: ",") }
    return body
  }

  private static func call(
    _ name: String, args: [String: Any], id: Any?, surface: Surface, writesAllowed: Bool,
    scope: AccessibilityDriver.Scope
  ) -> String {
    // Every driving tool goes through here. Unreachable through a compliant
    // client, since none of them is listed with writes off — but a server must
    // not rely on its caller being compliant to stay read-only.
    let driving = [
      "apple_desktop_press", "apple_desktop_set_value", "apple_desktop_click",
      "apple_desktop_type", "apple_desktop_key", "apple_desktop_raise_window",
      "apple_desktop_focus", "apple_desktop_activate", "apple_desktop_hover",
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
        let apps = AccessibilityDriver.runningApps(scope: scope)
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
        let windows = try AccessibilityDriver.windows(bundleId: bundleId, scope: scope)
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
          detail: detail(args), bounds: bounds(args), scope: scope)
        return ok(id, treeBody(tree))

      case "apple_desktop_expand":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        let tree = try AccessibilityDriver.expand(
          handle: handle, detail: detail(args), bounds: bounds(args), scope: scope)
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
        //
        // The test goes INTO the walk rather than over its result, because a
        // handle is minted for every element the walk keeps. Filtering
        // afterwards spent 4000 handles to return three, which is how a busy
        // session used to evict handles the caller was still holding.
        let tree = try AccessibilityDriver.tree(
          bundleId: bundleId, windowIndex: args["window"] as? Int,
          detail: .all, bounds: bounds(args), scope: scope,
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
        return ok(id, treeBody(tree, elements: tree.elements))

      case "apple_desktop_user_activity":
        // Not gated on `isTrusted`: this is CoreGraphics rather than
        // Accessibility, and refusing it for want of a grant it does not use
        // would be a lie — the same reasoning `activate` carries.
        return ok(
          id,
          [
            "secondsSinceInput": (AccessibilityDriver.secondsSinceUserInput() * 1000).rounded()
              / 1000
          ])

      case "apple_desktop_diagnostics":
        return ok(
          id,
          diagnostics(
            surface: surface, writesAllowed: writesAllowed, scope: scope))

      case "apple_desktop_press":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.press(handle: handle, scope: scope)
        return ok(id, ["pressed": handle])

      case "apple_desktop_set_value":
        guard let handle = args["handle"] as? String, let value = args["value"] as? String else {
          return failure(id, "Both 'handle' and 'value' are required.")
        }
        let landed = try AccessibilityDriver.setValue(
          handle: handle, value: value, scope: scope)
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
        // A point has no owner, so the caller names one. Brought forward first
        // because a click lands on whatever window is on top at that point, and
        // the person at the keyboard may have put their own there since.
        let owner = args["bundleId"] as? String
        if let owner { try bringForward(owner, verb: "click", scope: scope) }
        try AccessibilityDriver.click(x: x, y: y, announcing: owner)
        var clicked: [String: Any] = ["clicked": [x, y]]
        if let owner { clicked["target"] = owner }
        return ok(id, clicked)

      case "apple_desktop_hover":
        let durationMs = min(5000, max(0, (args["durationMs"] as? Int) ?? 600))
        let settleMs = min(5000, max(0, (args["settleMs"] as? Int) ?? 0))
        let target: CGPoint
        let owner: String?
        if let handle = args["handle"] as? String {
          // Re-read rather than trusting the point the tree reported, and take
          // the owner from the handle rather than from the arguments: the store
          // knows which application it came from and the caller can be wrong.
          let live = try AccessibilityDriver.hoverPoint(handle: handle, scope: scope)
          target = live.point
          owner = live.bundleId
        } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
          target = CGPoint(x: x, y: y)
          owner = args["bundleId"] as? String
        } else {
          return failure(
            id,
            "Either 'handle', or both 'x' and 'y', are required. Prefer 'handle': its point is "
              + "re-read at call time, so a window that has moved cannot make the hover miss.")
        }
        // A hover reaches only the frontmost application, so posting into an app
        // that is behind sweeps the pointer across somebody else's window and
        // reports a success that never happened. Refused rather than posted, as
        // the simulator surface refuses for the same reason.
        if let owner { try bringForward(owner, verb: "hover", scope: scope) }
        // Read BEFORE the sweep: afterwards it reports our own mouse-moved
        // events. The caller compares it against how long its sequence took, the
        // comparison apple_desktop_user_activity describes.
        let idle = (AccessibilityDriver.secondsSinceUserInput() * 1000).rounded() / 1000
        try AccessibilityDriver.hover(
          to: target, durationMs: durationMs, settleMs: settleMs, announcing: owner)
        return ok(
          id,
          [
            "hovered": [target.x, target.y],
            "durationMs": durationMs,
            "secondsSinceInput": idle,
          ])

      case "apple_desktop_type":
        guard let text = args["text"] as? String else {
          return failure(id, "The 'text' argument is required.")
        }
        let owner = try sessionTarget(args, scope: scope)
        if let owner { try bringForward(owner, verb: "text", scope: scope) }
        try AccessibilityDriver.type(text: text, announcing: owner)
        var typed: [String: Any] = ["typed": text.count]
        if let owner { typed["target"] = owner }
        return ok(id, typed)

      case "apple_desktop_key":
        guard let key = args["key"] as? String else {
          return failure(id, "The 'key' argument is required.")
        }
        let modifiers = (args["modifiers"] as? [String]) ?? []
        let owner = try sessionTarget(args, scope: scope)
        if let owner { try bringForward(owner, verb: "key", scope: scope) }
        try AccessibilityDriver.key(key, modifiers: modifiers, announcing: owner)
        var sent: [String: Any] = ["key": key, "modifiers": modifiers]
        if let owner { sent["target"] = owner }
        return ok(id, sent)

      case "apple_desktop_raise_window":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.raise(handle: handle, scope: scope)
        return ok(id, ["raised": handle])

      case "apple_desktop_focus":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        let took = try AccessibilityDriver.focus(handle: handle, scope: scope)
        // Reported rather than thrown, exactly as set_value does: the write was
        // permitted and the application did not honour it, which is a different
        // fact from a refusal and the caller has to be able to tell them apart.
        return ok(id, ["handle": handle, "focused": took])

      case "apple_desktop_activate":
        guard let bundleId = args["bundleId"] as? String else {
          return failure(id, "The 'bundleId' argument is required.")
        }
        try AccessibilityDriver.activate(bundleId: bundleId, scope: scope)
        return ok(id, ["activated": bundleId])

      case "apple_desktop_get_attribute":
        guard let handle = args["handle"] as? String,
          let attribute = args["attribute"] as? String
        else {
          return failure(id, "Both 'handle' and 'attribute' are required.")
        }
        let value = try AccessibilityDriver.attribute(
          handle: handle, name: attribute, scope: scope)
        return ok(
          id,
          [
            "handle": handle, "attribute": attribute,
            // NSNull rather than omitting the key: absent and null are the same
            // in JSON only if the reader is careful, and "this element does not
            // carry that attribute" is an answer worth stating.
            "value": value ?? NSNull(),
          ])

      default:
        return failure(id, "unknown tool '\(name)'")
      }
    } catch {
      return failed(id, error)
    }
  }

  // ─── the application a session verb is meant for ───────────────────────────

  /// Which application `type` or `key` is meant for, or nil when the caller
  /// named none — in which case the event goes wherever it always went.
  ///
  /// A handle wins over a bundle id, as in `hover`: the store knows which
  /// application the handle came from, and a caller can be wrong. A stale or
  /// out-of-scope handle is a refusal here, before anything is posted, rather
  /// than a reason to fall back on the bundle id and type anyway.
  private static func sessionTarget(
    _ args: [String: Any], scope: AccessibilityDriver.Scope
  ) throws -> String? {
    if let handle = args["handle"] as? String {
      return try AccessibilityDriver.owner(of: handle, scope: scope)
    }
    return args["bundleId"] as? String
  }

  /// Bring `owner` to the front and WAIT for it, refusing when it did not come.
  ///
  /// The rule `SimulatorServer.front` enforces for its one application, for the
  /// same measured reason: a click, a keystroke and a pointer sweep are posted to
  /// the session, and the session delivers them to whatever is in front. An agent
  /// driving the application it just opened cannot see that the person at the
  /// keyboard has since switched to their editor — so the event landed there,
  /// and the driving notice, reading the frontmost application, honestly said so.
  private static func bringForward(
    _ owner: String, verb: String, scope: AccessibilityDriver.Scope
  ) throws {
    guard try AccessibilityDriver.activateAndWait(bundleId: owner, scope: scope) else {
      throw AccessibilityDriver.Failure.refused(
        "\(owner) did not come to the front, so nothing was posted — the \(verb) would have "
          + "landed in whatever is frontmost, which is someone else's window.")
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
    surface: Surface, writesAllowed: Bool, scope: AccessibilityDriver.Scope
  ) -> [String: Any] {
    let trusted = AccessibilityDriver.isTrusted()
    let apps = AccessibilityDriver.runningApps(scope: scope)

    var probe = "not attempted"
    if trusted, let first = apps.first(where: { $0.bundleId != Bundle.main.bundleIdentifier }) {
      do {
        let windows = try AccessibilityDriver.windows(
          bundleId: first.bundleId, scope: scope)
        probe = "read \(windows.count) window(s) from \(first.name)"
      } catch {
        probe = "FAILED against \(first.name): \(error.localizedDescription)"
      }
    }

    return [
      "accessibility": trusted ? "granted" : "not granted",
      // What the menu bar is showing right now. Reported because it is the one
      // state in this app that asks something OF the user — a synthetic
      // keystroke goes wherever the focus is — and a caller that can read it can
      // also tell a person why their typing went somewhere unexpected.
      "driving": DriveActivity.current() ?? "nothing",
      "windowRead": probe,
      "runningApps": apps.count,
      "writes": writesAllowed ? "enabled" : "disabled — the driving tools are not registered",
      "reach": {
        switch scope {
        case .any: return "any running application"
        case .brokered:
          return
            "\(scope.described) — switch on \"Reach any application\" for Desktop to widen it"
        case .only:
          return "\(scope.described) — this driver was lent for that application alone"
        }
      }() as String,
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
    _ uri: String, id: Any?, surface: Surface, writesAllowed: Bool,
    scope: AccessibilityDriver.Scope
  ) -> String {
    guard uri == "cupertino://desktop/guide" else {
      return error(id, code: -32602, message: "unknown resource '\(uri)'")
    }
    // Simulator.app is a brokered application now — `simulator` in surfaces.json
    // — so this is reachable under every scope, and the paragraph is no longer
    // gated on the reach. What it says has changed too: the arithmetic it used
    // to ask the model to do by hand is what the simulator surface does.
    //
    // The blank lines belong to the paragraph rather than to the guide around it.
    let simulator = """

      ## An iOS Simulator is a window too

      Simulator.app bridges the simulated device's accessibility tree into this one, so an
      iOS app's own controls are readable and pressable here — no WebDriverAgent and no
      runner process. Frames here are Mac-screen absolute; the `simulator` surface reads the
      same tree in iOS points, with the window scale measured, and is the one to prefer for
      a device. It reaches less than WebDriverAgent does — a tab bar can arrive as an empty
      container — so it is a second opinion and a no-setup lane, not a replacement.

      """
    let text = """
      # Driving macOS applications

      This surface reads and drives any running application's interface through the
      Accessibility API — natively, not through AppleScript or System Events.

      ## Address a control, do not click a coordinate

      `apple_desktop_ui_tree` returns elements carrying a `handle`, an `id`
      (the developer-set AXIdentifier), a `name` and a `point`. Reach for them in that
      order. An identifier is unlocalised and survives a layout change; a point does
      not survive either, and on a non-English Mac a name may not survive at all.

      Do not filter by role to find something clickable. In Catalyst apps controls report
      themselves as AXGenericElement, AXStaticText and AXImage more often than AXButton —
      a role filter misses about 80% of what can be pressed in Maps, Messages and
      Calendar. In AppKit and SwiftUI apps it misses a fifth, and that fifth is the
      clickable heading or row you could not have guessed. The tree already marks
      `pressable`, which is the answer to "what has an AXPress".

      ## The tree is bounded on purpose

      A content-heavy window can hold ten thousand elements, and cost per element varies
      two hundredfold between applications, so the default walk stops at 12 deep, 4000
      elements or 5 seconds. The answer names which bound stopped it in `stoppedBy`.
      Reach further with `apple_desktop_expand` on a handle rather than by raising the
      bounds — that is what it is for.

      A container that lists no children but draws some (a UIKit tab bar seen through the
      Simulator) is swept by hit-testing its frame, and the children found that way are
      walked as its own. `recovered` counts them when it happened; they are what is on
      screen, so a scrolled-away sibling is not among them.

      ## A popover is its own window

      Omitting `window` walks every one of them, which is usually what you want.
      Asking for window 0 is how a search for a control that lives in a popover finds
      nothing at all.
      \(simulator)
      ## Name the application you are typing into

      `apple_desktop_click`, `apple_desktop_type` and `apple_desktop_key` post into the
      session, and the session delivers them to whatever is in front — which is not
      necessarily the application you opened a moment ago, because somebody may be using
      this Mac. Pass `bundleId` (or, for type and key, the `handle` of the field you
      focused) and that application is brought to the front first; if it does not come,
      nothing is posted and the call says so. Leave it out and the event goes wherever the
      focus happens to be.

      ## Handles go stale

      They point at elements in the window as it was. If a press returns a stale-handle
      error, take a fresh tree rather than retrying.

      ## Two switches, and they bound different things

      \(writesAllowed
        ? "Writes are ON: press, set_value, click, hover, type, key, focus, activate and raise_window are available."
        : "Writes are OFF, so this surface can only look. The driving tools are not registered at all.")

      \(scope == .any
        ? "Reach is ANY running application."
        : "Reach is limited to \(scope.described). Another application is refused by name, not by silence — widen it in Cupertino if you meant to address one.")
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
