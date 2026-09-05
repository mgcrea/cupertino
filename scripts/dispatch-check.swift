import AppKit
import Foundation

/// Asserts that each in-process surface is served by ITS OWN server.
///
/// The gate neither `screen-check.swift` nor `sound-check.swift` can be. Both
/// drive one server directly, and the bug this exists for is in the code that
/// *chooses* the server: `SurfaceCatalog` handed every swift-runtime surface to
/// `ScreenServer`, so the Sound pane's Capabilities card listed
/// `apple_screen_list_targets` and the `cupertino://screen/*` resources. Both
/// server checks passed the whole time, because both servers were fine.
///
/// Drives `InProcessServers.handle`, now the only copy of that choice, with the
/// write flag and the gates as VALUES rather than as `UserDefaults` reads — the
/// same arrangement `sound-check.swift` uses, and what lets every combination
/// be pinned without touching a preference.
@main
struct DispatchCheck {
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

  /// One request through the real dispatch, plus every gate ID it asked about.
  ///
  /// The asked list is half the point: it is how "a gate by ID, never by
  /// position" is asserted mechanically, rather than by reading the switch and
  /// believing it.
  static func send(
    _ surface: Surface, _ method: String, writes: Bool = false, gates: Bool = false
  ) -> (reply: [String: Any]?, asked: [String], outcome: InProcessServers.Reply) {
    let message: [String: Any] = ["jsonrpc": "2.0", "id": 1, "method": method]
    guard let data = try? JSONSerialization.data(withJSONObject: message),
      let line = String(data: data, encoding: .utf8)
    else { return (nil, [], .noReply) }
    var asked: [String] = []
    let outcome = InProcessServers.handle(
      line, surface: surface, allowWrites: writes,
      gateOn: {
        asked.append($0)
        return gates
      })
    guard case .message(let text) = outcome,
      let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    else { return (nil, asked, outcome) }
    return (object, asked, outcome)
  }

  static func names(
    _ surface: Surface, _ method: String, _ key: String, _ field: String,
    writes: Bool = false, gates: Bool = false
  ) -> [String] {
    let result =
      send(surface, method, writes: writes, gates: gates).reply?["result"]
      as? [String: Any]
    let entries = result?[key] as? [[String: Any]] ?? []
    return entries.compactMap { $0[field] as? String }.sorted()
  }

  static func tools(_ surface: Surface, writes: Bool = false, gates: Bool = false) -> [String] {
    names(surface, "tools/list", "tools", "name", writes: writes, gates: gates)
  }

  /// The whole `tools/list` reply, not just the names — a gate that changes a
  /// DESCRIPTION rather than the tool set still has to be visible here.
  static func payload(_ surface: Surface, writes: Bool, gates: Bool) -> String {
    guard
      case .message(let text) = send(surface, "tools/list", writes: writes, gates: gates)
        .outcome
    else { return "" }
    return text
  }

  static func main() {
    print("\nin-process dispatch\n")

    let hosted = Surface.all.filter { $0.runtime == .swift }
    check("the closed table still has swift-hosted surfaces", !hosted.isEmpty)

    for surface in hosted {
      let id = surface.id

      // The one assertion that would have caught the shipped bug on its own:
      // the server that answers has to be the one named after this surface.
      let info =
        (send(surface, "initialize").reply?["result"] as? [String: Any])?["serverInfo"]
        as? [String: Any]
      check(
        "\(id): the server that answers is cupertino-\(id)",
        info?["name"] as? String == "cupertino-\(id)")

      // Every gate combination, because a tool list is only ever wrong for
      // some of them — the pre-fix Sound pane showed Screen's two tools with
      // the gate off and Screen's three with it on.
      for writes in [false, true] {
        for gates in [false, true] {
          let listed = tools(surface, writes: writes, gates: gates)
          check(
            "\(id): every tool is apple_\(id)_* (writes=\(writes) gates=\(gates))",
            !listed.isEmpty && listed.allSatisfy { $0.hasPrefix("apple_\(id)_") })
        }
      }

      let resources = names(
        surface, "resources/list", "resources", "uri", writes: true, gates: true)
      check(
        "\(id): every resource is cupertino://\(id)/*",
        !resources.isEmpty && resources.allSatisfy { $0.hasPrefix("cupertino://\(id)/") })

      // A gate is asked for BY ID. `gates.first` satisfies neither half of
      // this: it would ask for nothing, and a surface that gained a second
      // gate would silently keep reading the first.
      let asked = Set(send(surface, "tools/list", writes: true, gates: true).asked)
      check(
        "\(id): the dispatch asks for exactly the gates the table declares",
        asked == Set(surface.gates.map(\.id)))

      // `allowWrites` reaching the server is what the Capabilities card is for.
      // It was accepted and dropped, so this pins the forwarding rather than
      // the tool names, which the two server checks already own.
      let off = Set(tools(surface, writes: false, gates: false))
      let onlyWrites = Set(tools(surface, writes: true, gates: false))
      check(
        surface.supportsWrites
          ? "\(id): allowWrites reaches the server and registers more"
          : "\(id): no mutating tool, so allowWrites changes nothing",
        surface.supportsWrites ? onlyWrites.isStrictSuperset(of: off) : onlyWrites == off)

      // A gate must make an OBSERVABLE difference, and "more tools" is too
      // narrow a way to say so. It held while every gate was a capability tier
      // — screen's allowCapture, sound's allowRecording — and `desktop` broke it
      // honestly: `allowAnyApp` bounds how far the surface REACHES, not what it
      // can do, so it must NOT add or remove a tool. Hiding tools there would
      // misreport a surface that works perfectly for the apps it is scoped to.
      //
      // The general invariant is two-part: the payload changes at all, and no
      // gate ever takes a tool AWAY.
      let onlyGates = Set(tools(surface, writes: false, gates: true))
      let offPayload = payload(surface, writes: false, gates: false)
      let onPayload = payload(surface, writes: false, gates: true)
      check(
        surface.gates.isEmpty
          ? "\(id): no gate, so a gate changes nothing"
          : "\(id): a gate reaches the server and changes what it advertises",
        surface.gates.isEmpty ? onPayload == offPayload : onPayload != offPayload)
      check(
        "\(id): no gate ever removes a tool",
        onlyGates.isSuperset(of: off))

      // A notification draws no reply, and that is a DIFFERENT fact from "no
      // server for this surface". Collapsing them into one nil is what made
      // the broken call site impossible to write correctly.
      let notification = #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
      var replied = false
      if case .message = InProcessServers.handle(
        notification, surface: surface, allowWrites: true, gateOn: { _ in true })
      {
        replied = true
      }
      check("\(id): a notification draws no reply", !replied)
    }

    // The third case is reachable and distinguishable, so a swift surface added
    // without a case in the dispatch fails here rather than hanging a session
    // or rendering an empty pane.
    var noServer = false
    if case .noServer = InProcessServers.handle(
      #"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, surface: Surface.named("mail")!,
      allowWrites: true, gateOn: { _ in true })
    {
      noServer = true
    }
    check("a surface with no in-process server says so", noServer)

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in
/// behind it. The servers only ever ask it for a version string.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
