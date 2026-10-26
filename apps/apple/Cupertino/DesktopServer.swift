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
nonisolated enum DesktopServer {

  /// Shared with every other in-process surface — see `InProcessRPC`.
  static let protocolVersion = InProcessRPC.protocolVersion

  // ─── dispatch ──────────────────────────────────────────────────────────────

  static func handle(
    _ line: String, surface: Surface, writesAllowed: Bool, scope: AccessibilityDriver.Scope
  ) -> String? {
    InProcessRPC.dispatch(
      line,
      name: "cupertino-desktop",
      instructions: instructions(writesAllowed),
      tools: { tools(writesAllowed: writesAllowed, scope: scope) },
      resources: { resources() },
      read: { uri, id in
        readResource(uri, id: id, surface: surface, writesAllowed: writesAllowed, scope: scope)
      },
      call: { name, args, id in
        let reply = call(
          name, args: args, id: id, surface: surface, writesAllowed: writesAllowed, scope: scope)
        // Any call keeps an open session alive, reads included: an agent reading
        // the tree between two presses is still driving. See `DrivingSession`.
        DrivingSession.touch()
        return reply
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
        "interactive (default) returns only what a press or a select can land on; labelled "
        + "returns anything carrying an identifier, title or description; all returns everything.",
    ]
    let menuPathProperty: [String: Any] = [
      "type": "array",
      "items": ["type": "string"],
      "description":
        "Menu titles from the menu bar down, as the menu shows them: [\"View\"] for a menu, "
        + "[\"View\", \"Show Sidebar\"] for an item in it. The Apple menu is \"Apple\".",
    ]
    let dragEndProperty: [String: Any] = [
      "type": "object",
      "properties": [
        "handle": ["type": "string"], "x": ["type": "number"], "y": ["type": "number"],
        "bundleId": ["type": "string"],
      ],
      "description": "Where the button goes down: {\"handle\"} or {\"x\", \"y\"}.",
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
        "name": "apple_desktop_menu",
        "description":
          "List one of an application's menu-bar menus by title path, e.g. [\"View\"] or "
          + "[\"File\", \"Open Recent\"]; an empty path lists the menu bar itself. The menu bar "
          + "is not a window, so apple_desktop_ui_tree and apple_desktop_find_elements never "
          + "see it. Nothing is opened and the application is not brought forward. Each item "
          + "says whether it is enabled, checked, has a shortcut or opens a submenu. An AppKit "
          + "application in the background reports many items disabled, because it validates "
          + "its menus against a key window it does not have.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "bundleId": bundleIdProperty,
            "path": menuPathProperty,
          ],
          "required": ["bundleId"],
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
          + "the result cannot be trusted. The reading counts Cupertino's own synthetic input too: "
          + "secondsSinceOwnInput says when the last of that was posted (null if none), and input "
          + "no more recent than it is most likely your own.",
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
        "name": "apple_desktop_press_menu",
        "description":
          "Choose a menu-bar item by its title path, e.g. [\"View\", \"Show Sidebar\"] — "
          + "what clicking through the menu bar does, without opening a menu, moving the pointer "
          + "or bringing the application forward. Titles match exactly, then ignoring case and a "
          + "trailing ellipsis. A disabled item is refused rather than pressed, since the "
          + "application would ignore it; apple_desktop_menu shows which items are enabled. "
          + "'wasChecked' says whether a toggle was on before the press; its checkmark can take "
          + "a second to move, so wait before reading the menu again to confirm it.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "bundleId": bundleIdProperty,
            "path": menuPathProperty.merging(["minItems": 2]) { _, new in new },
          ],
          "required": ["bundleId", "path"],
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
          + "clicked if it does not come. Without it the frontmost application stands in, and is "
          + "refused when it is out of reach. Either way nothing is clicked unless the point is on "
          + "one of that application's windows. 'button': \"right\" opens a context menu where "
          + "no element offers one to apple_desktop_show_menu, such as a drawing canvas.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "x": ["type": "number"], "y": ["type": "number"], "bundleId": bundleIdProperty,
            "button": [
              "type": "string", "enum": AccessibilityDriver.MouseButton.allCases.map(\.rawValue),
              "description": "Default left.",
            ],
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
          + "hover is only delivered to the frontmost one.",
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
        "name": "apple_desktop_show_menu",
        "description":
          "Open an element's context menu by its handle — a right-click without moving the "
          + "pointer or bringing the application forward. The element must offer one: the tree "
          + "marks it 'showsMenu'. The open menu's items then lead apple_desktop_ui_tree and "
          + "apple_desktop_find_elements, pressable with apple_desktop_press; key escape, with "
          + "the 'bundleId', closes it without choosing.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"]],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
      [
        "name": "apple_desktop_select",
        "description":
          "Select a list row — a sidebar entry, a table or outline row — by its handle, or by the "
          + "handle of anything inside it, such as the label apple_desktop_find_elements finds "
          + "by name. What clicking the row does, without moving the pointer or bringing the "
          + "application forward. The tree marks such rows 'selectable'; they usually have no "
          + "AXPress, so press refuses them. Replaces the current selection. 'selected' is the "
          + "row's own handle and 'confirmed' whether it read back selected.",
        "inputSchema": [
          "type": "object",
          "properties": ["handle": ["type": "string"]],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
      [
        "name": "apple_desktop_drag",
        "description":
          "Press, move and release the left button — moving something on a canvas, a slider "
          + "thumb, a selection, a splitter. 'from' and 'to' are each {\"handle\"} or "
          + "{\"x\", \"y\"}; a handle's point is re-read at call time, as for hover. The "
          + "application is brought to the front first, and nothing is posted unless both ends "
          + "are on its windows. A drop on another application's window names that one in "
          + "'to.bundleId', which is brought to no front but must be in reach.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "from": dragEndProperty,
            "to": dragEndProperty.merging([
              "description":
                "Where the button is released: {\"handle\"} or {\"x\", \"y\"}, plus "
                + "'bundleId' for a drop on another application's window."
            ]) { _, new in new },
            "bundleId": bundleIdProperty,
            "durationMs": [
              "type": "integer",
              "description": "How long the move takes, default 400. The pointer is walked at "
                + "about 60 steps a second, so what is under it sees a drag with a velocity.",
            ],
          ],
          "required": ["from", "to"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_type",
        "description":
          "Type text into whatever has keyboard focus. Sent as unicode, so accented and "
          + "non-Latin characters arrive intact. Pass 'handle' (the field you focused) or "
          + "'bundleId': that application is brought to the front first, and nothing is typed if "
          + "it does not come. Without either, the text goes to the frontmost application, and is "
          + "refused when that application is out of reach.",
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
      [
        "name": "apple_desktop_set_window_frame",
        "description":
          "Move or resize a window by its handle — the rect apple_desktop_list_windows returns, "
          + "written back. Every component is optional: pass 'width' alone to narrow a window "
          + "without moving it. Screen points, top-left origin, the same space as every rect and "
          + "point here. Reads the frame back and reports it, because a window's own minimum "
          + "size clamps the request silently: ask a 900-point-wide minimum for 600 and it lands "
          + "at 900 with no error anywhere. Compare 'actual' against 'requested' before "
          + "measuring anything.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "handle": ["type": "string", "description": "Window handle from list_windows."],
            "x": ["type": "number"],
            "y": ["type": "number"],
            "width": ["type": "number"],
            "height": ["type": "number"],
          ],
          "required": ["handle"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": false, "idempotentHint": true],
      ],
      [
        "name": "apple_desktop_run",
        "description":
          "Run a sequence of steps in one call, in order, stopping at the first that fails. Each "
          + "step is {\"tool\": <verb>, ...that verb's arguments}, the verb being a desktop tool "
          + "without its apple_desktop_ prefix: \(runSteps.joined(separator: ", ")). 'wait' takes "
          + "'ms'. Every step is checked before the first runs, so a mistake in step 5 leaves "
          + "steps 1 to 4 undone rather than half a form filled. A step cannot use a handle found "
          + "by another step in the same run; take handles from a read before the run. The "
          + "answer carries each step's result and, on failure, which step stopped it — the "
          + "steps before it did happen. Pass 'releaseAfter' to hand the Mac back once every "
          + "step completed.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "steps": [
              "type": "array",
              "maxItems": runStepCeiling,
              "items": [
                "type": "object",
                "properties": ["tool": ["type": "string", "enum": runSteps]],
                "required": ["tool"],
              ],
            ],
            "releaseAfter": [
              "type": "boolean",
              "description": "Call apple_desktop_release when every step completed. Default false.",
            ],
          ],
          "required": ["steps"],
        ],
        "annotations": ["readOnlyHint": false, "destructiveHint": true, "idempotentHint": false],
      ],
      [
        "name": "apple_desktop_release",
        "description":
          "Hand the Mac back when you have finished driving. Ends the driving session, takes "
          + "Cupertino's notice off the screen, and brings back the application the person was "
          + "using before it began, unless they have already switched away themselves. Call it as "
          + "soon as a sequence is done: until then the person sees the driven application in "
          + "front and a notice asking them not to touch anything, and cannot tell a pause from "
          + "the end. Safe to call when nothing is being driven.",
        "inputSchema": empty,
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

  /// What `list_windows` answers: the driver's windows, and an EMPTY list where
  /// the driver says there are none.
  ///
  /// `AccessibilityDriver.windows` throws `noWindows` because every other verb
  /// needs a window to act on. A listing does not, and an app with nothing open
  /// — Mail closed down to the menu bar — has a true answer here, which is none.
  /// Refusing instead cost a reply on 2026-10-17: the Mail lane reads any refusal
  /// as the Accessibility grant, so a granted app was sent to System Settings.
  static func windowListing(
    _ read: () throws -> [AccessibilityDriver.WindowRef]
  ) throws -> [AccessibilityDriver.WindowRef] {
    do {
      return try read()
    } catch AccessibilityDriver.Failure.noWindows {
      return []
    }
  }

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

  /// `matched` counts what the walk kept, which for `find_elements` is what
  /// matched rather than everything visited: the filter runs inside the walk.
  /// It once counted the whole tree, so a search that found ONE control
  /// reported `returned: 1, matched: 136`, which reads exactly like a truncated
  /// answer and is the confusion this field exists to prevent.
  ///
  /// `render` and `coordinateSpace` exist for the simulator surface, which
  /// answers the same walk in iOS points: the byte cap and the `matched` /
  /// `returned` / `truncated` contract are one implementation here rather
  /// than a copy that would drift.
  static func treeBody(
    _ tree: AccessibilityDriver.Tree,
    render: ((AccessibilityDriver.Element) -> [String: Any])? = nil,
    coordinateSpace: String = "screen points, top-left origin"
  ) -> [String: Any] {
    let answering = tree.elements
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
    // Present only when one is: an open menu is modal, so a caller that reads
    // past it and presses something in the window underneath is pressing into
    // a window that will not take it until the menu closes.
    if tree.menus > 0 {
      body["openMenus"] = tree.menus
      body["menuNote"] =
        "A menu is open and its items come first. Press one, or key escape with the bundleId to "
        + "close it."
    }

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
    // The Mail composer verbs do not exist anywhere but the channel lent to
    // Mail, and that includes the writes-off refusal below: answering "switched
    // off" would name a verb a public Desktop client has no business knowing.
    if name.hasPrefix("apple_desktop_mail_") && scope != AXComposerWindow.scope {
      return failure(id, "unknown tool '\(name)'")
    }

    // Every driving tool goes through here. Unreachable through a compliant
    // client, since none of them is listed with writes off — but a server must
    // not rely on its caller being compliant to stay read-only.
    let driving = [
      "apple_desktop_press", "apple_desktop_set_value", "apple_desktop_click",
      "apple_desktop_type", "apple_desktop_key", "apple_desktop_raise_window",
      "apple_desktop_focus", "apple_desktop_activate", "apple_desktop_hover",
      "apple_desktop_set_window_frame", "apple_desktop_run", "apple_desktop_release",
      "apple_desktop_press_menu", "apple_desktop_show_menu", "apple_desktop_drag",
      "apple_desktop_select", "apple_desktop_mail_composer_edit",
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
        let windows = try windowListing {
          try AccessibilityDriver.windows(bundleId: bundleId, scope: scope)
        }
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
        return ok(id, treeBody(tree))

      case "apple_desktop_user_activity":
        // Not gated on `isTrusted`: this is CoreGraphics rather than
        // Accessibility, and refusing it for want of a grant it does not use
        // would be a lie — the same reasoning `activate` carries.
        // The idle reading counts Cupertino's own posted events, so the answer
        // also says when the last of those went out: a caller can then tell its
        // own keystroke from a person's. Null when nothing was posted this launch.
        let own = DriveActivity.secondsSincePostedInput()
        return ok(
          id,
          [
            "secondsSinceInput": (AccessibilityDriver.secondsSinceUserInput() * 1000).rounded()
              / 1000,
            "secondsSinceOwnInput": own.map { ($0 * 1000).rounded() / 1000 } ?? NSNull(),
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

      case "apple_desktop_menu":
        guard let bundleId = args["bundleId"] as? String else {
          return failure(id, "The 'bundleId' argument is required.")
        }
        guard let path = menuPath(args["path"] ?? [String]()) else {
          return failure(id, "'path' is an array of menu titles, none of them empty.")
        }
        let menu = try AccessibilityDriver.menu(bundleId: bundleId, path: path, scope: scope)
        return ok(id, ["path": menu.path, "items": menu.entries.map(\.json)])

      case "apple_desktop_press_menu":
        guard let bundleId = args["bundleId"] as? String else {
          return failure(id, "The 'bundleId' argument is required.")
        }
        guard let path = args["path"].flatMap(menuPath), path.count >= 2 else {
          return failure(
            id,
            "'path' names a menu and then an item in it, e.g. [\"View\", \"Show Sidebar\"]: at "
              + "least two titles, none of them empty.")
        }
        let pressed = try AccessibilityDriver.pressMenuItem(
          bundleId: bundleId, path: path, scope: scope)
        return ok(id, ["pressed": pressed.path, "wasChecked": pressed.wasChecked])

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
        // Absent is the left button; present and unknown is a mistake, and a
        // left click in place of the menu it asked for would act on the canvas.
        let button: AccessibilityDriver.MouseButton
        if let named = args["button"] {
          guard let name = named as? String,
            let known = AccessibilityDriver.MouseButton(rawValue: name)
          else { return failure(id, "The 'button' argument is \"left\" or \"right\".") }
          button = known
        } else {
          button = .left
        }
        // A point has no owner, so the caller names one. Brought forward first
        // because a click lands on whatever window is on top at that point, and
        // the person at the keyboard may have put their own there since.
        let owner = try pointOwner(
          args, at: CGPoint(x: x, y: y), verb: "click", scope: scope)
        try AccessibilityDriver.click(
          x: x, y: y, button: button, scope: scope, announcing: owner)
        var clicked: [String: Any] = ["clicked": [x, y], "target": owner]
        if button != .left { clicked["button"] = button.rawValue }
        return ok(id, clicked)

      case "apple_desktop_show_menu":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.showMenu(handle: handle, scope: scope)
        return ok(
          id,
          [
            "shown": handle,
            "note": "Read the menu with ui_tree or find_elements, where its items come first. "
              + "Press one to choose it, or key escape with the bundleId to close it.",
          ])

      case "apple_desktop_select":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        let selected = try AccessibilityDriver.select(handle: handle, scope: scope)
        var answer: [String: Any] = ["selected": selected.row, "confirmed": selected.confirmed]
        if !selected.confirmed {
          answer["note"] =
            "The application accepted the selection and the row does not read back selected. "
            + "Read the tree again before relying on it."
        }
        return ok(id, answer)

      case "apple_desktop_drag":
        guard let fromSpec = args["from"] as? [String: Any],
          let toSpec = args["to"] as? [String: Any],
          let start = try dragEnd(fromSpec, scope: scope),
          let end = try dragEnd(toSpec, scope: scope)
        else {
          return failure(
            id,
            "Both 'from' and 'to' are required, each {\"handle\"} or {\"x\", \"y\"}. Prefer a "
              + "handle: its point is re-read at call time.")
        }
        let durationMs = min(5000, max(16, (args["durationMs"] as? Int) ?? 400))
        // The press decides which application is driven: a handle names its own,
        // as for hover, and a point is checked as a click's is.
        let owner: String
        if let named = start.owner {
          try bringForward(named, verb: "drag", scope: scope)
          try requireOnWindow(of: named, at: start.point, verb: "drag")
          owner = named
        } else {
          owner = try pointOwner(args, at: start.point, verb: "drag", scope: scope)
        }
        // The release lands on whatever is on top THERE, and a drop is a write
        // into that application, so it is held to the same reach as the press.
        let dropOwner = end.owner ?? owner
        guard scope.admits(dropOwner) else {
          throw AccessibilityDriver.Failure.outOfScope(dropOwner)
        }
        try requireOnWindow(of: dropOwner, at: end.point, verb: "drop")
        try AccessibilityDriver.drag(
          from: start.point, to: end.point, durationMs: durationMs, scope: scope,
          announcing: owner)
        var dragged: [String: Any] = [
          "dragged": ["from": [start.point.x, start.point.y], "to": [end.point.x, end.point.y]],
          "durationMs": durationMs, "target": owner,
        ]
        if dropOwner != owner { dragged["droppedOn"] = dropOwner }
        return ok(id, dragged)

      case "apple_desktop_hover":
        let durationMs = min(5000, max(0, (args["durationMs"] as? Int) ?? 600))
        let settleMs = min(5000, max(0, (args["settleMs"] as? Int) ?? 0))
        let target: CGPoint
        let owner: String
        if let handle = args["handle"] as? String {
          // Re-read rather than trusting the point the tree reported, and take
          // the owner from the handle rather than from the arguments: the store
          // knows which application it came from and the caller can be wrong.
          let live = try AccessibilityDriver.hoverPoint(handle: handle, scope: scope)
          target = live.point
          owner = live.bundleId
          // A hover reaches only the frontmost application, so posting into an
          // app that is behind sweeps the pointer across somebody else's window
          // and reports a success that never happened. Refused rather than
          // posted, as the simulator surface refuses for the same reason.
          try bringForward(owner, verb: "hover", scope: scope)
        } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
          target = CGPoint(x: x, y: y)
          owner = try pointOwner(args, at: target, verb: "hover", scope: scope)
        } else {
          return failure(
            id,
            "Either 'handle', or both 'x' and 'y', are required. Prefer 'handle': its point is "
              + "re-read at call time, so a window that has moved cannot make the hover miss.")
        }
        // Read BEFORE the sweep: afterwards it reports our own mouse-moved
        // events. The caller compares it against how long its sequence took, the
        // comparison apple_desktop_user_activity describes.
        let idle = (AccessibilityDriver.secondsSinceUserInput() * 1000).rounded() / 1000
        try AccessibilityDriver.hover(
          to: target, durationMs: durationMs, settleMs: settleMs, scope: scope, announcing: owner)
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
        try AccessibilityDriver.type(text: text, scope: scope, announcing: owner)
        var typed: [String: Any] = ["typed": text.count]
        if let owner { typed["target"] = owner }
        return ok(id, typed)

      case "apple_desktop_key":
        guard let key = args["key"] as? String else {
          return failure(id, "The 'key' argument is required.")
        }
        // Absent is no modifiers; present and not a list of names is a mistake,
        // and dropping it would send the bare key in place of the shortcut.
        let modifiers: [String]
        if let given = args["modifiers"] {
          guard let names = given as? [String] else {
            return failure(
              id,
              "The 'modifiers' argument is a list of names: command, shift, option, control, "
                + "function.")
          }
          modifiers = names
        } else {
          modifiers = []
        }
        let owner = try sessionTarget(args, scope: scope)
        if let owner { try bringForward(owner, verb: "key", scope: scope) }
        try AccessibilityDriver.key(key, modifiers: modifiers, scope: scope, announcing: owner)
        var sent: [String: Any] = ["key": key, "modifiers": modifiers]
        if let owner { sent["target"] = owner }
        return ok(id, sent)

      case "apple_desktop_raise_window":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        try AccessibilityDriver.raise(handle: handle, scope: scope)
        return ok(id, ["raised": handle])

      case "apple_desktop_set_window_frame":
        guard let handle = args["handle"] as? String else {
          return failure(id, "The 'handle' argument is required.")
        }
        let x = args["x"] as? Double
        let y = args["y"] as? Double
        let width = args["width"] as? Double
        let height = args["height"] as? Double
        guard x != nil || y != nil || width != nil || height != nil else {
          return failure(id, "Pass at least one of 'x', 'y', 'width' or 'height'.")
        }
        let moved = try AccessibilityDriver.setFrame(
          handle: handle, x: x, y: y, width: width, height: height, scope: scope)
        // Reported rather than thrown, exactly as set_value and focus do: a
        // window's own minimum size clamps the write with no error anywhere, and
        // a caller that cannot see the clamp goes on to measure a window it
        // never got.
        let landed = moved.requested == moved.actual
        return ok(
          id,
          [
            "handle": handle, "requested": moved.requested, "actual": moved.actual,
            "confirmed": landed,
            "note": landed
              ? "The frame read back as written."
              : "The window did not take the whole request. Its own minimum or maximum size "
                + "clamped it, silently and with no error — 'actual' is where it really is.",
          ])

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

      case "apple_desktop_release":
        return ok(id, DrivingSession.answer(DrivingSession.release(.agent)))

      case "apple_desktop_run":
        return run(args, id: id, surface: surface, writesAllowed: writesAllowed, scope: scope)

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

      // The Mail composer verbs. Never in `tools/list`, and answered only on the
      // channel `ServerHost` lends to Mail: anywhere else they fall through to
      // the unknown-tool answer below, as if they did not exist.
      case "apple_desktop_mail_composers" where scope == AXComposerWindow.scope:
        guard AccessibilityDriver.isTrusted() else {
          return failure(id, "Accessibility is not granted to Cupertino.")
        }
        let quoteChars = (args["quoteChars"] as? NSNumber)?.intValue ?? 2000
        return ok(
          id,
          [
            "composers": MailComposer.listing(
              try AXComposerWindow.all(scope: scope), quoteChars: quoteChars)
          ])

      // One verified edit of one compose window: every check before anything
      // destructive, and a refusal answered as a result (not an error) in the
      // shape revise.ts refuses with, so the Mail server passes it through.
      case "apple_desktop_mail_composer_edit" where scope == AXComposerWindow.scope:
        guard let handle = args["composer"] as? String else {
          return failure(id, "The 'composer' argument is required.")
        }
        let request = try MailComposer.request(from: args)
        guard let window = MailComposer.resolve(handle) else {
          return ok(id, MailComposer.gone(handle))
        }
        guard AccessibilityDriver.isTrusted() else {
          return failure(id, "Accessibility is not granted to Cupertino.")
        }
        return ok(
          id,
          MailComposer.edit(
            window, request: request, board: LivePasteboard(),
            front: LiveFront(driven: AXComposerWindow.bundleId),
            // A handle re-bound to a tab that may be another draft (the
            // registry's mark) is refused without `expectHead`.
            rebound: MailComposer.isRebound(handle)))

      default:
        return failure(id, "unknown tool '\(name)'")
      }
    } catch {
      return failed(id, error)
    }
  }

  // ─── run: several steps in one call ────────────────────────────────────────

  /// What a step may be. The driving verbs, the reads a sequence needs to check
  /// its own progress, and `wait`. Not `ui_tree` or `expand`, whose answers are
  /// large enough to swamp the one this builds; not `run` or `release`, which are
  /// not steps of a sequence.
  static let runSteps = [
    "press", "press_menu", "show_menu", "select", "set_value", "click", "hover", "drag", "type",
    "key", "focus", "activate", "raise_window", "set_window_frame", "find_elements",
    "get_attribute", "list_windows", "menu", "user_activity", "wait",
  ]
  static let runStepCeiling = 25
  static let runWaitCeilingMs = 5000

  /// Check every step, then run them in order through `call`, stopping at the
  /// first failure.
  ///
  /// **Through `call`, not beside it.** Each step goes through the same write
  /// gate, the same argument checks and the same driver path as the tool it
  /// names, so a step cannot do anything its tool could not. The price is
  /// decoding the JSON each step just encoded, which is nothing next to an
  /// Accessibility round trip.
  ///
  /// **Validated before the first step runs**, because stopping at the first
  /// failure is only half a promise on its own: a missing argument in step 5
  /// would otherwise leave steps 1 to 4 done, which for a form is a form half
  /// filled in by the time the caller hears about it.
  private static func run(
    _ args: [String: Any], id: Any?, surface: Surface, writesAllowed: Bool,
    scope: AccessibilityDriver.Scope
  ) -> String {
    guard let steps = args["steps"] as? [[String: Any]], !steps.isEmpty else {
      return failure(
        id, "'steps' is required: a non-empty array of {\"tool\": <verb>, ...its arguments}.")
    }
    guard steps.count <= runStepCeiling else {
      return failure(
        id,
        "At most \(runStepCeiling) steps in one run, and this had \(steps.count). Split it, and "
          + "read the screen between the halves. Nothing was run.")
    }

    let schemas = tools(writesAllowed: writesAllowed, scope: scope)
      .reduce(into: [String: [String: Any]]()) { out, tool in
        if let name = tool["name"] as? String, let schema = tool["inputSchema"] as? [String: Any] {
          out[name] = schema
        }
      }
    for (index, step) in steps.enumerated() {
      let number = index + 1
      guard let tool = step["tool"] as? String else {
        return failure(id, "Step \(number) names no 'tool'. Nothing was run.")
      }
      guard runSteps.contains(tool) else {
        return failure(
          id,
          "Step \(number): '\(tool)' cannot be a step. A step is one of "
            + "\(runSteps.joined(separator: ", ")). Nothing was run.")
      }
      if tool == "wait" {
        guard let ms = step["ms"] as? Int, (0...runWaitCeilingMs).contains(ms) else {
          return failure(
            id,
            "Step \(number): wait takes 'ms', a whole number from 0 to \(runWaitCeilingMs). "
              + "Nothing was run.")
        }
        continue
      }
      guard let schema = schemas["apple_desktop_\(tool)"] else {
        return failure(
          id,
          "Step \(number): apple_desktop_\(tool) is not available, because driving is switched "
            + "off for this surface. Nothing was run.")
      }
      let missing = (schema["required"] as? [String] ?? []).filter { step[$0] == nil }
      guard missing.isEmpty else {
        return failure(
          id,
          "Step \(number) (\(tool)) is missing \(missing.map { "'\($0)'" }.joined(separator: " and ")). "
            + "Nothing was run.")
      }
      if tool == "hover", step["handle"] == nil, step["x"] == nil || step["y"] == nil {
        return failure(
          id, "Step \(number) (hover) needs 'handle', or both 'x' and 'y'. Nothing was run.")
      }
      if tool == "drag" {
        let ends = [step["from"], step["to"]].map { $0 as? [String: Any] ?? [:] }
        guard
          ends.allSatisfy({ $0["handle"] is String || ($0["x"] is Double && $0["y"] is Double) })
        else {
          return failure(
            id,
            "Step \(number) (drag) needs 'from' and 'to', each {\"handle\"} or {\"x\", \"y\"}. "
              + "Nothing was run.")
        }
      }
    }

    let started = Date()
    var results: [[String: Any]] = []
    for (index, step) in steps.enumerated() {
      let number = index + 1
      let tool = step["tool"] as? String ?? ""
      if tool == "wait" {
        let ms = step["ms"] as? Int ?? 0
        if ms > 0 { Thread.sleep(forTimeInterval: Double(ms) / 1000) }
        DrivingSession.touch()
        results.append(["step": number, "tool": tool, "waitedMs": ms])
        continue
      }
      var arguments = step
      arguments.removeValue(forKey: "tool")
      let reply = call(
        "apple_desktop_\(tool)", args: arguments, id: nil, surface: surface,
        writesAllowed: writesAllowed, scope: scope)
      DrivingSession.touch()
      let (text, isError) = toolText(reply)
      guard !isError else {
        let body: [String: Any] = [
          "completed": index, "total": steps.count, "results": results,
          "failed": ["step": number, "tool": tool, "error": text],
          "note":
            "Stopped at step \(number), so the steps after it did not run. The steps before it "
            + "did, so read the screen before retrying rather than running the whole sequence "
            + "again.",
        ]
        return InProcessRPC.result(
          id,
          ["content": [["type": "text", "text": InProcessRPC.jsonText(body)]], "isError": true])
      }
      results.append(["step": number, "tool": tool, "result": jsonObject(text) ?? text])
    }

    var body: [String: Any] = [
      "completed": steps.count, "total": steps.count, "results": results,
      "seconds": (Date().timeIntervalSince(started) * 100).rounded() / 100,
    ]
    if args["releaseAfter"] as? Bool == true {
      body["release"] = DrivingSession.answer(DrivingSession.release(.agent))
    }
    return ok(id, body)
  }

  /// The text of a tool result and whether it was a failure.
  private static func toolText(_ reply: String) -> (String, Bool) {
    guard let message = jsonObject(reply), let result = message["result"] as? [String: Any]
    else {
      let error = (jsonObject(reply)?["error"] as? [String: Any])?["message"] as? String
      return (error ?? "The step returned nothing readable.", true)
    }
    let text = (result["content"] as? [[String: Any]])?.first?["text"] as? String ?? ""
    return (text, result["isError"] as? Bool ?? false)
  }

  /// A title path, or nil when it is not an array of non-empty strings.
  private static func menuPath(_ raw: Any) -> [String]? {
    guard let titles = raw as? [String], !titles.contains(where: \.isEmpty) else { return nil }
    return titles
  }

  private static func jsonObject(_ text: String) -> [String: Any]? {
    text.data(using: .utf8).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
  }

  // ─── the application a session verb is meant for ───────────────────────────

  /// Which application `type` or `key` is meant for, or nil when the caller
  /// named none — in which case the event goes to the frontmost application,
  /// and only if this surface's scope admits it. That check is in
  /// `AccessibilityDriver.announceSessionInput`, under every session verb,
  /// rather than here where a verb could be added without it.
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

  /// The application a `click` or `hover` at a point is meant for, brought
  /// forward when named, and refused unless the point is on one of its windows.
  ///
  /// Unlike a keystroke, a point event does not go to the frontmost
  /// application: it goes to whichever window is under the point. So neither
  /// half of the scope check is enough alone. Naming Mail and clicking where
  /// Terminal sits clicked Terminal, and so did naming nothing while Mail was
  /// in front. With no `bundleId` the frontmost application stands in, under
  /// the same scope refusal `type` and `key` get.
  private static func pointOwner(
    _ args: [String: Any], at point: CGPoint, verb: String, scope: AccessibilityDriver.Scope
  ) throws -> String {
    let owner: String
    if let named = args["bundleId"] as? String {
      try bringForward(named, verb: verb, scope: scope)
      owner = named
    } else {
      owner = try AccessibilityDriver.frontmostInReach(scope)
    }
    try requireOnWindow(of: owner, at: point, verb: verb)
    return owner
  }

  /// Polled rather than read once, because the window list trails the focus.
  /// `bringForward` returns when Accessibility reports the application focused,
  /// and the window server can still be stacking the old one on top for a
  /// beat: measured 2026-10-12 raising Calque from behind VS Code, focus moved
  /// at 130 ms and the window at the point at 156 ms. A click made in that gap
  /// was refused as "not on a window of" an application whose window filled
  /// the screen. A point that is really covered is refused half a second later.
  private static func requireOnWindow(of owner: String, at point: CGPoint, verb: String) throws {
    let started = Date()
    var onWindow = AccessibilityDriver.pointOnWindow(of: owner, at: point)
    while !onWindow, Date().timeIntervalSince(started) < 0.5 {
      usleep(20_000)
      onWindow = AccessibilityDriver.pointOnWindow(of: owner, at: point)
    }
    guard onWindow else {
      throw AccessibilityDriver.Failure.refused(
        "(\(Int(point.x)), \(Int(point.y))) is not on a window of \(owner), so nothing was posted "
          + "— the \(verb) would have landed in whatever is on top there. Read the window's frame "
          + "again, or prefer 'handle' with apple_desktop_press or hover.")
    }
  }

  /// One end of a drag: a handle's live centre and the application the store
  /// says it came from, or a point with whatever 'bundleId' came with it. Nil
  /// when it is neither, which the caller refuses as a malformed argument.
  private static func dragEnd(
    _ spec: [String: Any], scope: AccessibilityDriver.Scope
  ) throws -> (point: CGPoint, owner: String?)? {
    if let handle = spec["handle"] as? String {
      let live = try AccessibilityDriver.hoverPoint(handle: handle, scope: scope)
      return (live.point, live.bundleId)
    }
    guard let x = spec["x"] as? Double, let y = spec["y"] as? Double else { return nil }
    return (CGPoint(x: x, y: y), spec["bundleId"] as? String)
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
      "driving": DrivingSession.diagnostics().map { $0 as Any }
        ?? (DriveActivity.current() ?? "nothing"),
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

  // ─── instructions ──────────────────────────────────────────────────────────

  /// What a client loads on connect, which the guide never is: a resource is
  /// pull-only, so a caller who never names it drives without reading it. The
  /// session is the one thing about this surface that changes a caller's first
  /// move — a call that waits, a refusal that means "ask, do not retry", a tool
  /// to call at the end — so it is said here. Kept short, because every client
  /// pays for it on every connect.
  private static func instructions(_ writesAllowed: Bool) -> String {
    guard writesAllowed else {
      return """
        Reading macOS applications' interfaces through the Accessibility API. Address controls by
        the handles `apple_desktop_ui_tree` and `apple_desktop_find_elements` return.

        Writes are off, so this surface can only look: the driving tools are not registered at
        all. Fuller notes: `cupertino://desktop/guide`.
        """
    }
    return """
      Reading and driving macOS applications through the Accessibility API. Prefer
      `apple_desktop_press` with a handle from `ui_tree` or `find_elements` over clicking a point,
      and `apple_desktop_press_menu` over clicking the menu bar. Neither brings the application
      forward; only click, hover, drag, type and key do.

      Driving is a session the person at the keyboard can see. The first driving call while they
      are using the Mac may wait a few seconds while Cupertino warns or asks them. If it comes
      back saying they cancelled or said no, nothing happened: ask them in the conversation, do
      not retry. They can also stop a session part way through; a call refused because they
      stopped it means the same. Send a burst as one `apple_desktop_run`. When you are done, call
      `apple_desktop_release` (or pass `releaseAfter` to `run`). It brings back the app they were
      in, and until then they cannot tell whether you have finished.

      Fuller notes: `cupertino://desktop/guide`.
      """
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

      A list row — a sidebar entry, a table or outline row — often has no AXPress, and its
      name sits on a label inside it. The tree marks such a row `selectable`; choose it
      with `apple_desktop_select`, passing the row or the label `find_elements` found by
      name. It is what clicking the row does, without the click.

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

      ## The menu bar is not a window

      `ui_tree` and `find_elements` walk windows, so they never see the menu bar. Read a
      menu with `apple_desktop_menu` (`["View"]`) and choose an item with
      `apple_desktop_press_menu` (`["View", "Show Sidebar"]`). Both work on an application in
      the background, with no menu opened and nothing brought forward.

      A disabled item is refused, because pressing it would report success and do nothing.
      SwiftUI applications keep their menus current in the background. AppKit applications
      validate theirs against the key window, so many items read disabled until the
      application is in front: `apple_desktop_activate` it, then read the menu again.

      ## A context menu is a right-click away

      An element the tree marks `showsMenu` opens its context menu with
      `apple_desktop_show_menu`, without moving the pointer or bringing anything forward. A
      view that is not an element at all — a drawing canvas, a map — has nothing to ask, so
      right-click its point instead: `apple_desktop_click` with `button: "right"`.

      Either way, while the menu is open `ui_tree` and `find_elements` list its items first and
      say `openMenus`. Press one to choose it. A separator is an item with no name. To close the
      menu without choosing, `apple_desktop_key` escape with the `bundleId`.

      ## Seeing what you did

      This surface reads structure, never pixels. To look at a window, use
      `apple_screen_capture_surface` on the `screen` surface: it captures a window even when
      it is covered, without raising or focusing anything. Avoid `screencapture` and other
      shell tools, which see only what is in front, so every look takes the focus from the
      person at the keyboard.
      \(simulator)
      ## Name the application you are typing into

      `apple_desktop_click`, `apple_desktop_type` and `apple_desktop_key` post into the
      session, and the session delivers them to whatever is in front — which is not
      necessarily the application you opened a moment ago, because somebody may be using
      this Mac. Pass `bundleId` (or, for type and key, the `handle` of the field you
      focused) and that application is brought to the front first; if it does not come,
      nothing is posted and the call says so. Leave it out and the event goes to whatever
      is frontmost, and is refused when that is out of this surface's reach. A click or a
      hover at a point is also refused unless the point is on a window of that application.

      ## Dragging

      `apple_desktop_drag` presses the left button at `from`, walks the pointer to `to` and
      releases it. Each end is `{"handle"}` or `{"x", "y"}`, and a handle's point is re-read at
      call time. Both ends must be on the application's windows; a drop onto another application
      names it in `to.bundleId`, and it has to be within reach like any other target. On a canvas
      a drag is an edit: read the result before the next one, the way you would after a press.

      ## Driving is a session the person can see

      The first driving call while somebody is using this Mac does not act straight away.
      Cupertino warns them first, with a countdown they can cancel or a question they answer,
      whichever they chose, and the call waits for it: a few seconds for a countdown. If it
      comes back saying they cancelled or said no, nothing was posted. Stop and ask them in
      the conversation rather than retrying; Cupertino will not ask them again for
      \(Int(DrivingPolicy.declineCooldown)) s anyway.

      The person can also stop a session at any point, from the notice or the menu bar. The next
      call is then refused saying they stopped it, and a `type` or `hover` under way is cut short.
      What you did before the stop may be half done: do not carry on or start over, ask them.

      After that, every call goes straight through until the session ends. Call
      `apple_desktop_release` when you are done. It takes the notice down and brings back the
      application they were in, unless they have switched away themselves. Leaving it out is not
      free: they see the driven application in front and a notice asking them not to touch
      anything, and cannot tell a pause from the end. A session with no call for a while ends
      on its own.

      `apple_desktop_run` takes a whole sequence in one call and stops at the first step that
      fails. Pass `releaseAfter` to hand the Mac back once every step completed.

      ## Handles go stale

      They point at elements in the window as it was. If a press returns a stale-handle
      error, take a fresh tree rather than retrying.

      ## Two switches, and they bound different things

      \(writesAllowed
        ? "Writes are ON: press, press_menu, show_menu, select, set_value, click, hover, drag, type, key, focus, activate, raise_window, set_window_frame, run and release are available."
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
