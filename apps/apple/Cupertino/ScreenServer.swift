import Foundation

/// The MCP server for the `screen` surface, served by the app itself.
///
/// Every other surface is a node package `ServerLocator` spawns. This one
/// cannot be: ScreenCaptureKit is unreachable from node, and a server is handed
/// `PATH=/usr/bin:/bin`, so `screencapture` is not callable either. The capture
/// has to happen in this process, and once it does, a node hop exists only to
/// forward a request — a second IPC protocol, a second auth boundary, and a
/// second place the closed table would have to be re-validated.
///
/// **The bridge cannot tell the difference.** It relays bytes between stdin and
/// the socket and never parses JSON-RPC, so `--server=screen` reaches here by
/// exactly the path `--server=mail` reaches a node child.
///
/// Hand-rolled rather than built on the MCP SDK because there is no Swift SDK in
/// this project and the surface needs six methods. The shape is pinned by
/// `test/…` on the node side and by `make smoke` here.
enum ScreenServer {

  /// Shared with every other in-process surface — see `InProcessRPC`.
  static let protocolVersion = InProcessRPC.protocolVersion

  // ─── the loop ──────────────────────────────────────────────────────────────

  /// One newline-delimited JSON-RPC message. MCP's stdio framing, which the
  /// socket carries verbatim.
  static func nextLine(_ fd: Int32) -> String? { InProcessRPC.nextLine(fd) }

  // ─── dispatch ──────────────────────────────────────────────────────────────

  static func handle(_ line: String, surface: Surface, captureAllowed: Bool) -> String? {
    guard let data = line.data(using: .utf8),
      let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let method = msg["method"] as? String
    else { return nil }

    let id = msg["id"]
    // No id means a notification: `notifications/initialized` and friends get
    // no reply at all. Answering one is a protocol error, not a nicety.
    let isNotification = id == nil

    switch method {
    case "initialize":
      return isNotification ? nil : result(id, [
        "protocolVersion": protocolVersion,
        "capabilities": ["tools": [String: Any](), "resources": [String: Any]()],
        "serverInfo": ["name": "cupertino-screen", "version": AppInfo.shortVersion],
      ])

    case "ping":
      return isNotification ? nil : result(id, [String: Any]())

    case "tools/list":
      return isNotification
        ? nil : result(id, ["tools": tools(surface: surface, captureAllowed: captureAllowed)])

    case "resources/list":
      return isNotification ? nil : result(id, ["resources": resources()])

    case "resources/read":
      guard !isNotification else { return nil }
      let uri = ((msg["params"] as? [String: Any])?["uri"] as? String) ?? ""
      return readResource(uri, id: id, surface: surface, captureAllowed: captureAllowed)

    case "prompts/list":
      return isNotification ? nil : result(id, ["prompts": [Any]()])

    case "tools/call":
      guard !isNotification else { return nil }
      let params = msg["params"] as? [String: Any] ?? [:]
      let name = params["name"] as? String ?? ""
      let args = params["arguments"] as? [String: Any] ?? [:]
      return call(name, args: args, id: id, surface: surface, captureAllowed: captureAllowed)

    default:
      guard !isNotification else { return nil }
      return error(id, code: -32601, message: "unknown method '\(method)'")
    }
  }

  // ─── tools ─────────────────────────────────────────────────────────────────

  /// The tool list is a pure function of the gate.
  ///
  /// With `allowCapture` off, `apple_screen_capture_surface` is NOT REGISTERED
  /// — invisible to the model rather than refused when called. That is the same
  /// property `allowWrites` has on every other surface, and docs/alternatives.md
  /// claims it as a differentiator, so it has to hold here too.
  private static func tools(surface: Surface, captureAllowed: Bool) -> [[String: Any]] {
    let empty: [String: Any] = ["type": "object", "properties": [String: Any](), "required": [Any]()]
    var list: [[String: Any]] = [
      [
        "name": "apple_screen_list_targets",
        "description":
          "List the surfaces whose windows can be captured, with how many capturable windows each "
          + "has right now. Window titles are never returned.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
      [
        "name": "apple_screen_diagnostics",
        "description":
          "Report whether Screen Recording is granted, whether the window list can actually be "
          + "read, and which surfaces are capturable. Answers on a machine with no grant at all.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
    ]

    guard captureAllowed else { return list }
    list.append([
      "name": "apple_screen_capture_surface",
      "description":
        "Capture the largest window of one surface app to a PNG and return its path. The window "
        + "does not have to be visible: a window fully covered by another app captures its own "
        + "content, and nothing is raised or focused. Captures only the surfaces Cupertino "
        + "brokers — never an arbitrary app, window or region.",
      "inputSchema": [
        "type": "object",
        "properties": [
          "surface": [
            "type": "string",
            "enum": Surface.all.filter { $0.bundleID != nil }.map(\.id),
            "description": "Which surface's window to capture.",
          ],
          "directory": [
            "type": "string",
            "description":
              "Optional directory to write into. Must be inside \(ScreenCapture.root.path).",
          ],
          "overwrite": [
            "type": "boolean",
            "description": "Replace an existing file of the same name. Defaults to false.",
          ],
        ],
        "required": ["surface"],
      ],
      // It mutates nothing, but it puts a file on disk — the same reasoning the
      // three save_attachment tools give for their annotations.
      "annotations": [
        "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false,
      ],
    ])
    return list
  }

  private static func call(
    _ name: String, args: [String: Any], id: Any?, surface: Surface, captureAllowed: Bool
  ) -> String {
    switch name {
    case "apple_screen_list_targets":
      do {
        let targets = try blocking { try await ScreenCapture.targets() }
        return ok(id, [
          "targets": targets.map {
            [
              "surface": $0.surface, "displayName": $0.displayName,
              "windows": $0.windows, "appRunning": $0.appRunning,
            ]
          },
          "note": "Window titles are withheld deliberately — see docs/screen.md.",
        ])
      } catch { return failed(id, error) }

    case "apple_screen_diagnostics":
      return ok(id, diagnostics(surface: surface, captureAllowed: captureAllowed))

    case "apple_screen_capture_surface":
      guard captureAllowed else {
        // Unreachable through a compliant client, since the tool is not listed.
        return failure(id, "Screen capture is switched off. Turn on \"\(surface.gates.first?.label ?? "capture")\" in Cupertino.")
      }
      guard let wanted = args["surface"] as? String else {
        return failure(id, "The 'surface' argument is required.")
      }
      guard let target = Surface.named(wanted) else {
        return failure(id, ScreenCapture.Failure.unknownSurface(wanted).localizedDescription)
      }
      let directory = (args["directory"] as? String).map { URL(fileURLWithPath: $0) }
      let overwrite = args["overwrite"] as? Bool ?? false
      do {
        let shot = try blocking {
          try await ScreenCapture.capture(
            surface: target, into: directory, overwrite: overwrite)
        }
        return ok(id, [
          "path": shot.path, "bytes": shot.bytes,
          "width": shot.width, "height": shot.height, "surface": shot.surface,
        ])
      } catch { return failed(id, error) }

    default:
      return failure(id, "unknown tool '\(name)'")
    }
  }

  // ─── resources ─────────────────────────────────────────────────────────────

  private static func resources() -> [[String: Any]] {
    [
      [
        "uri": "cupertino://screen/guide", "name": "Screen guide",
        "description": "How capture is bounded, and what it will not do.",
        "mimeType": "text/markdown",
      ],
      [
        "uri": "cupertino://screen/diagnostics", "name": "Screen diagnostics",
        "description": "Permission state and capturable targets.",
        "mimeType": "application/json",
      ],
    ]
  }

  private static func readResource(
    _ uri: String, id: Any?, surface: Surface, captureAllowed: Bool
  ) -> String {
    switch uri {
    case "cupertino://screen/guide":
      return result(id, [
        "contents": [["uri": uri, "mimeType": "text/markdown", "text": guide]]
      ])
    case "cupertino://screen/diagnostics":
      let text = jsonText(diagnostics(surface: surface, captureAllowed: captureAllowed))
      return result(id, [
        "contents": [["uri": uri, "mimeType": "application/json", "text": text]]
      ])
    default:
      return error(id, code: -32602, message: "unknown resource '\(uri)'")
    }
  }

  /// Static, so it is served correctly on a machine with no grant at all —
  /// the property every surface's `surface.test.ts` asserts.
  private static let guide = """
    # Screen

    Captures the window of an app Cupertino already brokers, to a PNG on disk.

    ## What it will and will not do

    - Captures **only** the surfaces in Cupertino's table. Not an arbitrary
      application, not a window id, not a display, not a region. There is no
      argument that reaches the system with a target you chose.
    - Does **not** raise, focus or move anything. A window fully covered by
      another app still captures its own content.
    - Returns a **path**, never the image itself, so a capture costs no context
      until something reads it.
    - Never returns window titles. They leak subjects and participant names.

    ## Before it works

    Screen Recording must be granted to Cupertino in System Settings, and the
    grant only takes effect after Cupertino is relaunched. `apple_screen_diagnostics`
    reports whether the grant is real, and distinguishes "the flag says yes" from
    "the window list can actually be read" — those disagree on a Mac that has run
    Cupertino from more than one path.

    ## Limits worth knowing

    - A window the app has never drawn captures blank; the tool reports that
      rather than handing back an empty image.
    - A window can appear in the target count and still refuse to composite.
    - Capture supersedes the one-time-code gates: whatever a Safari window is
      showing is in the picture.
    """

  /// `probe` exists for the check, and for one assertion specifically.
  ///
  /// Whether the window list is readable is a fact about the machine, so the
  /// null-versus-empty invariant below could otherwise only be exercised on a
  /// Mac without the grant — it would pass on a developer's machine while
  /// silently testing nothing. Injecting the lookup makes both branches
  /// reachable anywhere.
  static func diagnostics(
    surface: Surface, captureAllowed: Bool, probe: (() throws -> [ScreenCapture.Target])? = nil
  ) -> [String: Any] {
    let flag = ScreenCapture.isGranted()
    var enumerated: Any = "not attempted"
    // NULL, not []. An empty array reads as "no surface is capturable" when the
    // truth is "the window list could not be read at all" — the same
    // absent-versus-EPERM conflation docs/surfaces.md records getting wrong
    // three times about the Maps store. The two states must not render alike.
    var targets: Any = NSNull()
    do {
      let list = try probe?() ?? blocking { try await ScreenCapture.targets() }
      enumerated = true
      targets = list.map {
        ["surface": $0.surface, "windows": $0.windows, "appRunning": $0.appRunning]
      }
    } catch {
      enumerated = "\(error.localizedDescription)"
    }
    let gate = surface.gates.first
    return [
      "server": ["name": "cupertino-screen", "version": AppInfo.shortVersion, "runtime": "swift"],
      "permission": [
        "service": "kTCCServiceScreenCapture",
        // Two answers, deliberately, because they disagree on a machine holding
        // several TCC rows for one identifier. The flag is a claim about an
        // identity; the enumeration is the capability.
        "flag": flag,
        "windowListReadable": enumerated,
        "note":
          "If the flag is true and the window list is not readable, the identifier holds more "
          + "than one TCC row. The cure is `tccutil reset ScreenCapture io.mgcrea.cupertino`, "
          + "not another grant.",
      ],
      "gate": ["id": gate?.id ?? "", "on": captureAllowed],
      "captureDirectory": ScreenCapture.root.path,
      "targets": targets,
      "caveats": [
        "Screen Recording is per-process and all-or-nothing; the surface table bounds what this "
          + "server points it at, not what the grant covers.",
        "Capture supersedes the one-time-code gates on Messages and Safari.",
        "Window titles are never returned.",
      ],
    ]
  }

  // ─── plumbing ──────────────────────────────────────────────────────────────

  /// Shared with every other in-process surface — see `InProcessRPC.blocking`.
  private static func blocking<T>(_ body: @escaping () async throws -> T) throws -> T {
    try InProcessRPC.blocking(body)
  }

  private static func jsonText(_ object: Any) -> String { InProcessRPC.jsonText(object) }

  private static func envelope(_ id: Any?, _ body: [String: Any]) -> String {
    InProcessRPC.envelope(id, body)
  }

  private static func result(_ id: Any?, _ value: Any) -> String {
    InProcessRPC.result(id, value)
  }

  private static func error(_ id: Any?, code: Int, message: String) -> String {
    InProcessRPC.error(id, code: code, message: message)
  }

  /// A tool RESULT carrying text, which is what every node surface returns.
  private static func ok(_ id: Any?, _ value: [String: Any]) -> String {
    InProcessRPC.ok(id, value)
  }

  /// A tool failure is a result with `isError`, not a JSON-RPC error — the
  /// model has to be able to read why.
  private static func failure(_ id: Any?, _ message: String) -> String {
    InProcessRPC.failure(id, message)
  }

  private static func failed(_ id: Any?, _ error: Error) -> String {
    failure(id, error.localizedDescription)
  }
}
