import AppKit
import Foundation

/// Asserts that the in-process `desktop` server speaks MCP, and that its write
/// gate holds in both directions.
///
/// ## Why this exists
///
/// The same gate `scripts/verify-servers.sh` cannot be, for the reason
/// `screen-check.swift` gives at length: that script scans a `cli.js` and spawns
/// it under the bundled runtime, and a surface the app serves itself has
/// neither. `make bundle` runs only that script, so without this a broken
/// in-process server would reach a signature.
///
/// Driven directly rather than through the bridge, because the socket is claimed
/// by BUNDLE IDENTIFIER: on a machine with Cupertino installed a bridge
/// handshake tests the installed copy and passes while the artifact is broken.
///
/// ## Nothing here drives anything
///
/// This is the check with the most to be careful about, because the surface it
/// pins can click. Every `tools/call` assertion below is either a REFUSAL path
/// that returns before `AccessibilityDriver` is reached, or a read against this
/// process's own list of running applications. Nothing is pressed, nothing is
/// typed, and no synthetic event is posted — a check that moved the mouse of the
/// machine running CI would be its own incident.
///
/// It also runs with no Accessibility grant, on purpose: the observe half has to
/// answer without one, and `list_apps` is exactly where that is provable.
///
/// Run with `make desktop-check`.
@main
struct DesktopCheck {
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

  static let surface = Surface.named("desktop")!

  static func ask(
    _ method: String, id: Int = 1, params: [String: Any]? = nil, writes: Bool = false
  ) -> [String: Any]? {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { message["params"] = params }
    let line = String(
      data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard let reply = DesktopServer.handle(line, surface: surface, writesAllowed: writes),
      let data = reply.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object
  }

  static func toolNames(writes: Bool) -> [String] {
    let reply = ask("tools/list", writes: writes)
    let result = reply?["result"] as? [String: Any]
    let tools = result?["tools"] as? [[String: Any]] ?? []
    return tools.compactMap { $0["name"] as? String }.sorted()
  }

  /// The text of a tool result, which is where a refusal explains itself.
  static func callText(_ name: String, _ args: [String: Any], writes: Bool) -> (String, Bool) {
    let reply = ask("tools/call", params: ["name": name, "arguments": args], writes: writes)
    let result = reply?["result"] as? [String: Any]
    let content = result?["content"] as? [[String: Any]] ?? []
    let text = content.first?["text"] as? String ?? ""
    return (text, result?["isError"] as? Bool ?? false)
  }

  /// The verbs that can change the machine. Named once so the two directions of
  /// the gate below are asserted against the same list.
  static let driving = [
    "apple_desktop_click", "apple_desktop_key", "apple_desktop_press",
    "apple_desktop_raise_window", "apple_desktop_set_value", "apple_desktop_type",
  ]

  static let observing = [
    "apple_desktop_diagnostics", "apple_desktop_expand", "apple_desktop_find_elements",
    "apple_desktop_list_apps", "apple_desktop_list_windows", "apple_desktop_ui_tree",
  ]

  static func main() {
    print("\ndesktop server")

    // ─── handshake ──────────────────────────────────────────────────────────
    let initialize = ask("initialize")
    let info = (initialize?["result"] as? [String: Any])?["serverInfo"] as? [String: Any]
    check("initialize answers with serverInfo", info?["name"] as? String == "cupertino-desktop")
    check(
      "negotiates the protocol version the node servers do",
      (initialize?["result"] as? [String: Any])?["protocolVersion"] as? String
        == DesktopServer.protocolVersion)
    check(
      "a notification draws no reply",
      DesktopServer.handle(
        #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, surface: surface,
        writesAllowed: false) == nil)
    check(
      "an unknown method is a JSON-RPC error",
      ((ask("nope/list")?["error"] as? [String: Any])?["code"] as? Int) == -32601)

    // ─── the gate is registration, not refusal ──────────────────────────────
    //
    // docs/alternatives.md claims this as a differentiator, so it has to hold
    // here more than anywhere: this is the surface where a refused-but-visible
    // tool would invite a model to keep looking for a way to press something.
    let off = toolNames(writes: false)
    let on = toolNames(writes: true)

    check("with writes off, the observing tools are all registered", off == observing.sorted())
    check(
      "with writes off, NO driving tool appears in tools/list",
      driving.allSatisfy { !off.contains($0) })
    check(
      "with writes on, every driving tool appears",
      driving.allSatisfy { on.contains($0) })
    check(
      "writes on is exactly writes off plus the driving tools", on == (observing + driving).sorted()
    )
    check("the tool list is a pure function of the gate", toolNames(writes: false) == off)

    // Defence in depth: a non-compliant client can call a tool it was never
    // shown. The server must refuse rather than trust the listing to have done
    // the work — and it must refuse BEFORE reaching AccessibilityDriver, which
    // is what makes this assertion safe to run at all.
    for name in driving {
      let (text, isError) = callText(
        name, ["handle": "e1", "x": 0, "y": 0, "text": "", "key": "return", "value": ""],
        writes: false)
      check(
        "\(name) is refused when called with writes off",
        isError && text.lowercased().contains("switched off"))
    }

    // ─── the observe half answers without a grant ───────────────────────────
    //
    // NSWorkspace.runningApplications is not TCC-gated, and the surface's whole
    // claim to being usable without Accessibility rests on that. Measured in
    // docs/desktop.md; pinned here so it cannot regress into a blank failure.
    let (appsText, appsError) = callText("apple_desktop_list_apps", [:], writes: false)
    check("list_apps answers with no Accessibility grant", !appsError)
    check(
      "list_apps names this process's own bundle among the running apps",
      appsText.contains("bundleId"))
    check(
      "list_apps reports the grant state rather than assuming it",
      appsText.contains("granted"))

    let (diagText, diagError) = callText("apple_desktop_diagnostics", [:], writes: false)
    check("diagnostics answers", !diagError)
    check(
      "diagnostics reports writes as disabled when they are",
      diagText.contains("not registered"))
    check(
      "diagnostics names the duplicate-TCC-row cure rather than saying 'grant it again'",
      diagText.contains("tccutil reset Accessibility"))
    let (diagOn, _) = callText("apple_desktop_diagnostics", [:], writes: true)
    check("diagnostics reports writes as enabled when they are", diagOn.contains("enabled"))

    // ─── arguments are validated before anything is reached ─────────────────
    let (noBundle, noBundleError) = callText("apple_desktop_ui_tree", [:], writes: false)
    check(
      "ui_tree without bundleId is a readable refusal",
      noBundleError && noBundle.contains("bundleId"))
    let (noCriteria, noCriteriaError) = callText(
      "apple_desktop_find_elements", ["bundleId": "com.apple.finder"], writes: false)
    check(
      "find_elements with no criteria refuses rather than returning the whole tree",
      noCriteriaError && noCriteria.contains("at least one"))
    let (unknown, unknownError) = callText("apple_desktop_nope", [:], writes: true)
    check("an unknown tool is a readable refusal", unknownError && unknown.contains("unknown tool"))

    // ─── resources ──────────────────────────────────────────────────────────
    let resources =
      (ask("resources/list")?["result"] as? [String: Any])?["resources"]
      as? [[String: Any]] ?? []
    check(
      "every resource is cupertino://desktop/*",
      !resources.isEmpty
        && resources.allSatisfy {
          ($0["uri"] as? String)?.hasPrefix("cupertino://desktop/") == true
        })

    func guideText(writes: Bool) -> String {
      let reply = ask(
        "resources/read", params: ["uri": "cupertino://desktop/guide"], writes: writes)
      let contents = (reply?["result"] as? [String: Any])?["contents"] as? [[String: Any]] ?? []
      return contents.first?["text"] as? String ?? ""
    }
    check(
      "the guide tells the model to address by identifier",
      guideText(writes: false).contains("AXIdentifier"))
    check(
      "the guide warns against the role filter that misses most controls",
      guideText(writes: false).contains("AXGenericElement"))
    check(
      "the guide says writes are off when they are",
      guideText(writes: false).contains("Writes are OFF"))
    check(
      "the guide says writes are on when they are",
      guideText(writes: true).contains("Writes are ON"))
    check(
      "an unknown resource is a JSON-RPC error",
      ((ask("resources/read", params: ["uri": "cupertino://desktop/nope"])?["error"]
        as? [String: Any])?["code"] as? Int) == -32602)

    // ─── the table agrees with the server ───────────────────────────────────
    // `runtime == .swift` is also the assertion that it has no npm package:
    // generate-surfaces.mjs refuses a swift surface with a non-null npmName, so
    // the two cannot drift apart and Surface does not carry the field.
    check("the table says this surface is served in-process", surface.runtime == .swift)
    check("the table gates it behind Accessibility", surface.storePermission == .accessibility)
    check("the table declares no gate beyond writes", surface.gates.isEmpty)
    check("the table ships it switched off", !surface.defaultEnabled)

    print("\n\(checks - failures)/\(checks) passed")
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
