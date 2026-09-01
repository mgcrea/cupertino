import Foundation

/// Asserts that the in-process `screen` server speaks MCP, and that its gate
/// and its closed table hold.
///
/// ## Why this exists
///
/// `scripts/verify-servers.sh` is the gate that proves a server actually runs,
/// and it CANNOT cover this one: it scans a `cli.js` for bare imports and
/// spawns it under the bundled runtime, and a surface the app serves itself has
/// neither. `make bundle` runs only that script, so without this check a broken
/// in-process server would reach a signature — which is precisely the failure
/// that shipped three times and that verify-servers.sh was written for.
///
/// A handshake through the bridge would be the better test and cannot be used
/// as a build gate: the socket is claimed by BUNDLE IDENTIFIER, not by path, so
/// on any machine with Cupertino installed the bridge connects to the installed
/// copy and the gate silently passes while testing the wrong binary. `make
/// smoke-swift` is that handshake, for a developer who knows what is running.
///
/// So this drives `ScreenServer.handle` directly: no socket, no app launch, no
/// licence, no TCC grant. The protocol half was separated from the transport
/// half to make that possible — the gate arrives as a value rather than being
/// read from `UserDefaults`, which is also why these assertions can pin BOTH
/// states of it without touching a preference.
///
/// A standalone `swiftc` binary rather than an XCTest bundle, for the reason
/// `unit-check.swift` and `wiring-check.swift` both give: the Xcode project has
/// synchronized-group targets and no shared schemes, so a test target means
/// hand-editing project.pbxproj.
///
/// **Nothing here captures anything.** Every `tools/call` assertion below is a
/// refusal path that returns before ScreenCaptureKit is reached, so this writes
/// no PNG and takes no picture of the machine running it.
///
/// Run with `make screen-check`.
@main
struct ScreenCheck {
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

  static let surface = Surface.named("screen")!

  /// One request in, the parsed reply out.
  static func ask(_ method: String, id: Int = 1, params: [String: Any]? = nil, gate: Bool = false)
    -> [String: Any]?
  {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { message["params"] = params }
    let line = String(
      data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard let reply = ScreenServer.handle(line, surface: surface, captureAllowed: gate),
      let data = reply.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object
  }

  static func toolNames(gate: Bool) -> [String] {
    let reply = ask("tools/list", gate: gate)
    let result = reply?["result"] as? [String: Any]
    let tools = result?["tools"] as? [[String: Any]] ?? []
    return tools.compactMap { $0["name"] as? String }.sorted()
  }

  /// The text of a tool result, which is where a refusal explains itself.
  static func callText(_ name: String, _ args: [String: Any], gate: Bool) -> (String, Bool) {
    let reply = ask("tools/call", params: ["name": name, "arguments": args], gate: gate)
    let result = reply?["result"] as? [String: Any]
    let content = result?["content"] as? [[String: Any]] ?? []
    let text = content.first?["text"] as? String ?? ""
    return (text, result?["isError"] as? Bool ?? false)
  }

  static func main() {
    print("\nscreen server")

    // ─── handshake ──────────────────────────────────────────────────────────
    let initialize = ask("initialize")
    let info = (initialize?["result"] as? [String: Any])?["serverInfo"] as? [String: Any]
    check("initialize answers with serverInfo", info?["name"] as? String == "cupertino-screen")
    check(
      "negotiates the protocol version the node servers do",
      (initialize?["result"] as? [String: Any])?["protocolVersion"] as? String
        == ScreenServer.protocolVersion)

    // A notification has no id and must draw no reply at all. Answering one is a
    // protocol error rather than a harmless extra.
    check(
      "a notification draws no reply",
      ScreenServer.handle(
        #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, surface: surface,
        captureAllowed: false) == nil)
    check(
      "an unknown method is a JSON-RPC error",
      ((ask("nope/list")?["error"] as? [String: Any])?["code"] as? Int) == -32601)

    // ─── the gate is registration, not refusal ──────────────────────────────
    //
    // The claim docs/alternatives.md makes as a differentiator: a gated tool is
    // INVISIBLE, not refused when called. Pinned in both directions so the
    // capture tool cannot appear by default in some later refactor.
    check(
      "gate off: capture is not registered",
      toolNames(gate: false) == ["apple_screen_diagnostics", "apple_screen_list_targets"])
    check(
      "gate on: capture is registered",
      toolNames(gate: true) == [
        "apple_screen_capture_surface", "apple_screen_diagnostics", "apple_screen_list_targets",
      ])

    // ─── the closed table ───────────────────────────────────────────────────
    //
    // A caller names a surface, never a window. These are the refusals that
    // keep that true; none of them reaches ScreenCaptureKit.
    let (unknown, unknownErrored) = callText(
      "apple_screen_capture_surface", ["surface": "passwords"], gate: true)
    check("an unlisted app is refused", unknownErrored && unknown.contains("No surface named"))

    let (selfCapture, selfErrored) = callText(
      "apple_screen_capture_surface", ["surface": "screen"], gate: true)
    check(
      "a surface with no app behind it is refused",
      selfErrored && selfCapture.contains("no app behind it"))

    let (missing, missingErrored) = callText("apple_screen_capture_surface", [:], gate: true)
    check("a missing surface argument is refused", missingErrored && missing.contains("required"))

    // Defence in depth: the tool is not registered with the gate off, so a
    // compliant client cannot reach this — but an incompliant one must not get
    // a capture out of it either.
    let (gated, gatedErrored) = callText(
      "apple_screen_capture_surface", ["surface": "mail"], gate: false)
    check("calling an unregistered capture is still refused", gatedErrored && !gated.isEmpty)

    // Every capturable id in the schema must be an app. Offering a capability
    // would advertise a target that always refuses.
    let capture =
      ((ask("tools/list", gate: true)?["result"] as? [String: Any])?["tools"] as? [[String: Any]])?
      .first { $0["name"] as? String == "apple_screen_capture_surface" }
    let schema = capture?["inputSchema"] as? [String: Any]
    let properties = schema?["properties"] as? [String: Any]
    let enumerated = (properties?["surface"] as? [String: Any])?["enum"] as? [String] ?? []
    check(
      "the capture schema offers only surfaces with an app",
      !enumerated.isEmpty && enumerated.allSatisfy { Surface.named($0)?.bundleID != nil })

    // ─── resources ──────────────────────────────────────────────────────────
    let resources =
      ((ask("resources/list")?["result"] as? [String: Any])?["resources"] as? [[String: Any]])?
      .compactMap { $0["uri"] as? String }.sorted() ?? []
    check(
      "both resources are listed",
      resources == ["cupertino://screen/diagnostics", "cupertino://screen/guide"])
    check(
      "an unknown resource is an error",
      ask("resources/read", params: ["uri": "cupertino://screen/nope"])?["error"] != nil)

    // The guide is static so it serves on a machine with no grant at all —
    // the property every node surface's own suite asserts.
    let guide =
      ((ask("resources/read", params: ["uri": "cupertino://screen/guide"])?["result"]
        as? [String: Any])?["contents"] as? [[String: Any]])?.first?["text"] as? String ?? ""
    check("the guide is served and non-empty", guide.count > 200)

    // ─── diagnostics, and the finding it must not lose ──────────────────────
    let (diagnosticsText, _) = callText("apple_screen_diagnostics", [:], gate: false)
    let diagnostics =
      (try? JSONSerialization.jsonObject(
        with: Data(diagnosticsText.utf8))) as? [String: Any] ?? [:]
    check("diagnostics answers whatever the grant is", !diagnostics.isEmpty)
    let permission = diagnostics["permission"] as? [String: Any]
    check("diagnostics reports the flag and the capability separately",
      permission?["flag"] != nil && permission?["windowListReadable"] != nil)

    // ABSENT AND EPERM ARE DIFFERENT FINDINGS. An empty target list reads as
    // "no surface is capturable"; the truth may be "the window list could not
    // be read at all". Whichever machine this runs on, the two must not render
    // alike — so `targets` is null exactly when the enumeration failed.
    //
    // Both branches, forced, rather than whichever one this machine happens to
    // produce: with the grant present the unreadable branch would never run and
    // the assertion would pass while testing nothing.
    struct Blind: Error {}
    let blind = ScreenServer.diagnostics(
      surface: surface, captureAllowed: false, probe: { throw Blind() })
    check("unreadable window list renders targets as null", blind["targets"] is NSNull)
    check(
      "and says so rather than reporting an empty machine",
      (blind["permission"] as? [String: Any])?["windowListReadable"] as? Bool != true)

    let seeing = ScreenServer.diagnostics(
      surface: surface, captureAllowed: false,
      probe: { [ScreenCapture.Target(surface: "mail", displayName: "Mail", windows: 0, appRunning: false)] })
    let seen = seeing["targets"] as? [[String: Any]]
    check("a readable but empty machine renders targets as a list", seen?.isEmpty == false)
    check(
      "the two states do not render alike",
      !(blind["targets"] is NSArray) && seeing["targets"] is NSArray)

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in
/// behind it. The server only ever asks it for a version string, which is not
/// what any of the above is testing.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
