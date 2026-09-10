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

  static var skipped = 0

  static func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  /// A check that could not run, counted and named rather than omitted.
  ///
  /// Its absence is the thing worth reporting: a check wrapped in `if let` does
  /// not fail on a machine where its subject is missing, it disappears, and the
  /// total quietly drops while the suite still says "passed". The count is the
  /// only line most people read.
  static func skip(_ label: String, _ reason: String) {
    checks += 1
    skipped += 1
    print("  SKIP \(label) — \(reason)")
  }

  static let surface = Surface.named("desktop")!

  static func ask(
    _ method: String, id: Int = 1, params: [String: Any]? = nil, writes: Bool = false,
    anyApp: Bool = false
  ) -> [String: Any]? {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { message["params"] = params }
    let line = String(
      data: try! JSONSerialization.data(withJSONObject: message), encoding: .utf8)!
    guard
      let reply = DesktopServer.handle(
        line, surface: surface, writesAllowed: writes, scope: anyApp ? .any : .brokered),
      let data = reply.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object
  }

  static func toolNames(writes: Bool, anyApp: Bool = false) -> [String] {
    let reply = ask("tools/list", writes: writes, anyApp: anyApp)
    let result = reply?["result"] as? [String: Any]
    let tools = result?["tools"] as? [[String: Any]] ?? []
    return tools.compactMap { $0["name"] as? String }.sorted()
  }

  /// The text of a tool result, which is where a refusal explains itself.
  static func callText(
    _ name: String, _ args: [String: Any], writes: Bool, anyApp: Bool = false
  ) -> (String, Bool) {
    let reply = ask(
      "tools/call", params: ["name": name, "arguments": args], writes: writes, anyApp: anyApp)
    let result = reply?["result"] as? [String: Any]
    let content = result?["content"] as? [[String: Any]] ?? []
    let text = content.first?["text"] as? String ?? ""
    return (text, result?["isError"] as? Bool ?? false)
  }

  /// The verbs that can change the machine. Named once so the two directions of
  /// the gate below are asserted against the same list.
  static let driving = [
    "apple_desktop_activate", "apple_desktop_click", "apple_desktop_focus",
    "apple_desktop_hover", "apple_desktop_key", "apple_desktop_press",
    "apple_desktop_raise_window", "apple_desktop_set_value", "apple_desktop_type",
  ]

  static let observing = [
    "apple_desktop_diagnostics", "apple_desktop_expand", "apple_desktop_find_elements",
    "apple_desktop_get_attribute", "apple_desktop_list_apps", "apple_desktop_list_windows",
    "apple_desktop_ui_tree", "apple_desktop_user_activity",
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
        writesAllowed: false, scope: .brokered) == nil)
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

    // Refused means NOTHING happened, including the notice. `click`, `type` and
    // `key` announce before posting — they are the verbs that actually collide
    // with the person at the keyboard, since they land wherever focus is — so
    // this pins that the announcement sits after the gate rather than before it.
    // Runs before anything in this check deliberately lights the indicator.
    check(
      "a refused driving verb lights no indicator",
      DriveActivity.current() == nil)

    // ─── the observe half answers without a grant ───────────────────────────
    //
    // NSWorkspace.runningApplications is not TCC-gated, and the surface's whole
    // claim to being usable without Accessibility rests on that. Measured in
    // docs/desktop.md; pinned here so it cannot regress into a blank failure.
    let (appsText, appsError) = callText("apple_desktop_list_apps", [:], writes: false)
    check("list_apps answers with no Accessibility grant", !appsError)
    // Scoped to the brokered set with the gate off, so this list is legitimately
    // EMPTY on a machine where no Apple app happens to be open — which is every
    // clean CI runner. The assertion here used to be `contains("bundleId")`,
    // which passed on a developer's Mac with Mail running and failed the first
    // time this check ran on a runner. That tested the machine, not the surface.
    // What is invariant is the envelope and the shape of an entry: a listing
    // that stopped naming bundle ids still fails, an empty one does not.
    check(
      "list_apps answers with an apps list, empty or not",
      appsText.contains("\"apps\""))
    check(
      "every application list_apps names carries a bundle id",
      !appsText.contains("\"name\"") || appsText.contains("\"bundleId\""))
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

    func guideText(writes: Bool, anyApp: Bool = false) -> String {
      let reply = ask(
        "resources/read", params: ["uri": "cupertino://desktop/guide"], writes: writes,
        anyApp: anyApp)
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
    // Simulator.app is a brokered application since the `simulator` surface,
    // so the paragraph about it is true under every scope and must not be
    // gated — a caller on the default reach can address it.
    check(
      "the guide mentions the Simulator under both reaches, now that it is brokered",
      guideText(writes: false, anyApp: true).contains("iOS Simulator")
        && guideText(writes: false, anyApp: false).contains("iOS Simulator"))
    check(
      "the guide sends a caller to the simulator surface for iOS points",
      guideText(writes: false, anyApp: false).contains("`simulator` surface"))
    check(
      "the guide has no hole where a paragraph was",
      !guideText(writes: false, anyApp: false).contains("\n\n\n"))
    check(
      "the writes-on line names every driving verb, focus and activate included",
      guideText(writes: true).contains("focus, activate"))
    check(
      "the Simulator is in reach under the default scope",
      AccessibilityDriver.inScope("com.apple.iphonesimulator", scope: .brokered))
    check(
      "an unknown resource is a JSON-RPC error",
      ((ask("resources/read", params: ["uri": "cupertino://desktop/nope"])?["error"]
        as? [String: Any])?["code"] as? Int) == -32602)

    // ─── the scope gate bounds REACH, independently of writes ───────────────
    //
    // Accessibility does not scope to a target: the grant that reads a Maps
    // place card reads anything. So the bound comes from the closed table or
    // from nowhere, and these assertions are that bound.
    let scopedTools = toolNames(writes: false, anyApp: false)
    let wideTools = toolNames(writes: false, anyApp: true)
    check(
      "the scope gate does not change WHICH tools exist — only what they reach",
      scopedTools == wideTools)

    // Cupertino itself is a brokered app; a code editor is not.
    let (scoped, scopedError) = callText(
      "apple_desktop_list_windows", ["bundleId": "com.microsoft.VSCode"], writes: false,
      anyApp: false)
    check(
      "an unbrokered application is refused when the scope gate is off",
      scopedError && scoped.contains("scoped to those"))
    check(
      "the refusal names the switch rather than just saying no",
      scoped.contains("Reach any application"))

    let (brokered, _) = callText(
      "apple_desktop_list_windows", ["bundleId": "com.apple.Maps"], writes: false, anyApp: false)
    check(
      "a brokered application is NOT refused when the gate is off",
      !brokered.contains("scoped to those"))

    // A handle minted while the gate was on must not survive it being switched
    // off, or the gate is a suggestion rather than a bound.
    // `activate` is the one driving verb that does not resolve a handle, so its
    // refusal path is separate code and has to be exercised separately.
    check(
      "apple_desktop_activate is refused when called with writes off",
      callText("apple_desktop_activate", ["bundleId": "com.apple.Maps"], writes: false).0
        .contains("switched off"))
    check(
      "apple_desktop_focus is refused when called with writes off",
      callText("apple_desktop_focus", ["handle": "e1"], writes: false).0.contains("switched off"))

    // ─── keys resolve against the layout, not a US table ────────────────────
    //
    // The table shipped letter-free, so command-V could not be expressed. The
    // obvious repair is a US map where `a` is 0 — and it is destructive on any
    // layout that moves the letters. MEASURED on an AZERTY Mac: `a` resolves to
    // 12, which in the US table is `q`, so "select all before pasting" would
    // have sent COMMAND-Q and quit the app with an unsaved composer open.
    //
    // Asserted without naming a layout, because this must hold on all of them:
    // every letter resolves to something, and the position-keyed names keep
    // their fixed codes.
    let alphabet = "abcdefghijklmnopqrstuvwxyz".map(String.init)
    check(
      "every letter resolves to a key on this layout",
      alphabet.allSatisfy { AccessibilityDriver.keyCode(for: $0) != nil })
    check(
      "a key that is a position, not a character, keeps its fixed code",
      AccessibilityDriver.keyCode(for: "return") == 36
        && AccessibilityDriver.keyCode(for: "escape") == 53)
    check(
      "an unknown key name is still unknown",
      AccessibilityDriver.keyCode(for: "zzz") == nil)
    check(
      "the refusal lists the keys this layout actually offers",
      AccessibilityDriver.knownKeys().contains("v")
        && AccessibilityDriver.knownKeys().contains("return"))

    // `matched` answers for what was ASKED FOR, not for what was walked. It
    // reported the whole tree for a filtered search — `returned: 1,
    // matched: 136` — which reads as a truncated answer and is exactly the
    // confusion the field exists to prevent. Checked without a grant by driving
    // a refusal-free path: with Accessibility denied the call fails, so this
    // only asserts when it answered.
    //
    // Asserted unconditionally. The first version of this wrapped the whole
    // check in `if let`, so on a machine where Maps was not running it did not
    // fail — it VANISHED, and the suite went from 51 checks to 50 while still
    // printing "passed". A check that disappears when its subject is absent is
    // worse than no check, because the count is the only thing anyone reads.
    //
    // So the two cases are separated: when the call answered, `matched` must
    // equal `returned`; when it could not (no grant, Maps not running), that is
    // reported as a SKIP with a reason rather than folded into a pass.
    let (findText, _) = callText(
      "apple_desktop_find_elements", ["bundleId": "com.apple.Maps", "id": "AddButton"],
      writes: false)
    let findBody = findText.data(using: .utf8).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
    if let findBody, let returned = findBody["returned"] as? Int,
      let matched = findBody["matched"] as? Int
    {
      check(
        "find_elements reports matched for the FILTERED set, not the whole walk",
        matched == returned)
    } else {
      skip(
        "find_elements reports matched for the FILTERED set, not the whole walk",
        "Maps is not running, or Accessibility is not granted")
    }

    // Reads WHEN, never what, and needs no grant — so unlike every other read
    // here it must answer on a machine that has granted nothing.
    let (activityText, _) = callText("apple_desktop_user_activity", [:], writes: false)
    let activity = activityText.data(using: .utf8).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
    check(
      "user activity answers with no Accessibility grant",
      (activity?["secondsSinceInput"] as? Double) != nil)
    check(
      "user activity is a duration, not a flag",
      (activity?["secondsSinceInput"] as? Double).map { $0 >= 0 } ?? false)

    // Announced only once the screen has actually changed. This runs BEFORE the
    // record below, because it asserts on an indicator nothing has lit yet.
    // app(forBundleId:) scans the running applications and never launches, so a
    // bundle id that is not running is a refusal, not a side effect.
    _ = callText(
      "apple_desktop_activate", ["bundleId": "com.example.absent"], writes: true, anyApp: true)
    check(
      "activating an application that is not running does not light the indicator",
      DriveActivity.current() != "com.example.absent")

    // The same rule for the session verbs, which name their target now. Each of
    // these is refused BEFORE an event is built — a stale handle, a target that
    // is not running, a target outside the reach — and that is the only reason
    // they are safe to run here: a shell that holds Accessibility would
    // otherwise post them into whatever the person has in front.
    let (staleText, staleError) = callText(
      "apple_desktop_type", ["text": "", "handle": "e999999"], writes: true, anyApp: true)
    check(
      "type naming a stale handle is refused rather than typed into whatever is in front",
      staleError && staleText.contains("no longer exists"))
    let (_, absentError) = callText(
      "apple_desktop_key", ["key": "return", "bundleId": "com.example.absent"], writes: true,
      anyApp: true)
    check(
      "key naming an application that is not running is refused and lights no indicator",
      absentError && DriveActivity.current() != "com.example.absent")
    let (reachText, reachError) = callText(
      "apple_desktop_click", ["x": 0.0, "y": 0.0, "bundleId": "com.microsoft.VSCode"],
      writes: true, anyApp: false)
    check(
      "click naming an application outside the reach is refused by the switch's name",
      reachError && reachText.contains("Reach any application"))

    // The indicator is state, so it has to lapse on its own. There is no "the
    // agent has finished" signal — a driving sequence is a burst of calls with
    // gaps — so an explicit end would leave it lit forever the first time a
    // client disconnected mid-sequence.
    DriveActivity.record("com.apple.Maps")
    check("driving is reported while it is happening", DriveActivity.current() == "com.apple.Maps")
    check(
      "diagnostics says what is being driven",
      callText("apple_desktop_diagnostics", [:], writes: false).0.contains("com.apple.Maps"))

    // A session thread serves one caller at a time, so an unbounded budget is
    // not a bigger answer — it is an hour in which this surface answers nothing
    // else. The guide already says to reach further with expand.
    check(
      "a walk bound above the ceiling is clamped, not honoured",
      DesktopServer.bounds(["maxNodes": 1_000_000]).nodes == DesktopServer.maxNodesCeiling
        && DesktopServer.bounds(["budgetSeconds": 3600.0]).seconds
          == DesktopServer.maxSecondsCeiling
    )
    check(
      "a walk bound below the floor is still raised to it",
      DesktopServer.bounds(["maxNodes": 0]).nodes == 1
        && DesktopServer.bounds(["budgetSeconds": 0.0]).seconds == 0.1)

    // find_elements has always honoured `window`; for a while it did not say so,
    // which is how a caller learns an argument exists by having it ignored.
    let findSchema =
      ((ask("tools/list", writes: false)?["result"] as? [String: Any])?["tools"]
      as? [[String: Any]] ?? [])
      .first { $0["name"] as? String == "apple_desktop_find_elements" }
      .flatMap { $0["inputSchema"] as? [String: Any] }
      .flatMap { $0["properties"] as? [String: Any] }
    check(
      "find_elements declares every argument it reads",
      Set(
        [
          "bundleId", "id", "role", "name", "pressableOnly", "window", "maxDepth", "maxNodes",
          "budgetSeconds",
        ]
      ).isSubset(of: Set((findSchema ?? [:]).keys)))

    // hover is the one driving verb that takes EITHER a handle or a point, so
    // the schema has to offer both and its refusal has to name both. A verb that
    // required a handle it never says it accepts is how the click/press split
    // became confusing.
    let hoverSchema =
      ((ask("tools/list", writes: true)?["result"] as? [String: Any])?["tools"]
      as? [[String: Any]] ?? [])
      .first { $0["name"] as? String == "apple_desktop_hover" }
      .flatMap { $0["inputSchema"] as? [String: Any] }
      .flatMap { $0["properties"] as? [String: Any] }
    check(
      "hover declares every argument it reads",
      Set(["handle", "x", "y", "bundleId", "durationMs", "settleMs"])
        .isSubset(of: Set((hoverSchema ?? [:]).keys)))
    check(
      "hover requires no argument up front, since either form will do",
      ((ask("tools/list", writes: true)?["result"] as? [String: Any])?["tools"]
        as? [[String: Any]] ?? [])
        .first { $0["name"] as? String == "apple_desktop_hover" }
        .flatMap { $0["inputSchema"] as? [String: Any] }
        .flatMap { $0["required"] as? [String] } == nil)

    // click, type and key used to take no target at all, which is how a click
    // meant for the application an agent had just opened landed in whatever the
    // person had switched to. The target stays optional — leaving it out is the
    // old behaviour, unchanged — so `required` must not grow.
    let sessionSchemas =
      ((ask("tools/list", writes: true)?["result"] as? [String: Any])?["tools"]
      as? [[String: Any]] ?? [])
      .reduce(into: [String: [String: Any]]()) { out, tool in
        if let name = tool["name"] as? String, let schema = tool["inputSchema"] as? [String: Any] {
          out[name] = schema
        }
      }
    for (name, declared, required) in [
      ("apple_desktop_click", ["x", "y", "bundleId"], ["x", "y"]),
      ("apple_desktop_type", ["text", "handle", "bundleId"], ["text"]),
      ("apple_desktop_key", ["key", "modifiers", "handle", "bundleId"], ["key"]),
    ] {
      let schema = sessionSchemas[name]
      check(
        "\(name) declares the application it is meant for",
        Set(declared).isSubset(
          of: Set(((schema?["properties"] as? [String: Any]) ?? [:]).keys)))
      check(
        "\(name) requires no more than it did, so naming the application stays optional",
        (schema?["required"] as? [String]) == required)
    }
    // Reached with writes ON and no grant, so it returns before any event is
    // built: this asserts the argument check, not the posting path.
    let (hoverText, hoverError) = callText("apple_desktop_hover", [:], writes: true)
    check(
      "hover with neither a handle nor a point is refused, naming both",
      hoverError && hoverText.contains("handle") && hoverText.contains("'x'"))
    // Non-destructive and idempotent, unlike click: moving the pointer twice to
    // the same place leaves the same state, and it presses nothing.
    let hoverAnnotations =
      ((ask("tools/list", writes: true)?["result"] as? [String: Any])?["tools"]
      as? [[String: Any]] ?? [])
      .first { $0["name"] as? String == "apple_desktop_hover" }
      .flatMap { $0["annotations"] as? [String: Any] }
    check(
      "hover is annotated as non-destructive and idempotent, unlike click",
      hoverAnnotations?["destructiveHint"] as? Bool == false
        && hoverAnnotations?["idempotentHint"] as? Bool == true
        && hoverAnnotations?["readOnlyHint"] as? Bool == false)
    // The guard has to distinguish this app's own synthetic events from a
    // person's, or a sequence refuses itself on its second hover — the floor
    // sits under the linger for exactly that reason.
    check(
      "the hover idle floor sits under the driving indicator's linger",
      AccessibilityDriver.hoverIdleFloor < DriveActivity.linger)

    // The store fills DURING a walk that is minting into it, so a full wipe
    // strands handles minted earlier in the very answer being composed. The
    // system-wide element needs no grant and no IPC to hold.
    let store = AccessibilityDriver.HandleStore()
    let capacity = AccessibilityDriver.HandleStore.capacity
    var lastHandle = ""
    for _ in 0...capacity {
      lastHandle = store.put(AXUIElementCreateSystemWide(), bundleId: "com.example.filler")
    }
    check(
      "filling the handle store evicts the oldest half, not everything",
      store.get("e1") == nil && store.get("e\(capacity / 2 + 1)") != nil
        && store.get(lastHandle) != nil)
    check(
      "a surviving handle still names the application it came from",
      store.get(lastHandle)?.bundleId == "com.example.filler")

    check(
      "the driver binds scope to the handle, not only to the call",
      AccessibilityDriver.inScope("com.apple.Maps", scope: .brokered)
        && !AccessibilityDriver.inScope("com.microsoft.VSCode", scope: .brokered)
        && AccessibilityDriver.inScope("com.microsoft.VSCode", scope: .any))

    // The third reach, which no gate can widen. A lent scope names one bundle
    // id and admits nothing else — not the brokered set it is drawn from, and
    // not whatever `allowAnyApp` is set to, because it never consults it.
    check(
      "a lent scope admits its own app and nothing else",
      AccessibilityDriver.inScope("com.apple.mail", scope: .only(["com.apple.mail"]))
        && !AccessibilityDriver.inScope("com.apple.Maps", scope: .only(["com.apple.mail"]))
        && !AccessibilityDriver.inScope("com.microsoft.VSCode", scope: .only(["com.apple.mail"])))

    let (scopedApps, _) = callText("apple_desktop_list_apps", [:], writes: false, anyApp: false)
    let (wideApps, _) = callText("apple_desktop_list_apps", [:], writes: false, anyApp: true)
    check(
      "list_apps returns fewer applications when the gate is off",
      scopedApps.count < wideApps.count)

    // ─── key codes resolve off the main thread without asking TIS ───────────
    //
    // The crash this pins: Text Input Services asserts the main queue, every
    // RPC is answered on a `cupertino.session` thread, and four EXC_BREAKPOINT
    // reports between 1.18.0 and 1.20.0 died inside HIToolbox on exactly that.
    //
    // Nothing here drives anything, which this file is otherwise strict about:
    // resolving a name to a CGKeyCode is a table lookup, and no CGEvent is
    // built or posted.
    //
    // Be clear about what this can and cannot hold, because the gap is where
    // the bug lived. It CANNOT reproduce the trap: the assertion sits in
    // HIToolbox's cold branch, and a probe that calls TIS off the main thread
    // comes back fine nearly every time — which is exactly how this shipped in
    // three releases. It also cannot see a TIS call that a later edit puts back
    // inline; only the `dispatchPrecondition` in `refreshLayout` catches that,
    // by being the one place TIS is allowed to be reached from.
    //
    // What it DOES hold is the part a fix is likely to get wrong: that a
    // background lookup answers from the cache, with the right code, without
    // parking on the main thread to get it.
    check(
      "a position-keyed name needs no layout at all",
      AccessibilityDriver.keyCode(for: "return") == 36)

    // The main thread, exactly as at launch.
    AccessibilityDriver.refreshLayout()
    let onMain = AccessibilityDriver.keyCode(for: "v")
    if onMain == nil {
      skip("a character resolves off the main thread", "this input source maps no 'v'")
      skip("and answers from the cache rather than waiting on main", "no 'v' to resolve")
    } else {
      // No run loop runs in this binary, so a lookup that still needed a hop to
      // the main queue could only time out — which is what makes the elapsed
      // time an assertion rather than a flourish. It has to come back from the
      // cache: same answer, no waiting.
      final class Box: @unchecked Sendable {
        var code: CGKeyCode?
        var elapsed = 0.0
      }
      let box = Box()
      let done = DispatchSemaphore(value: 0)
      Thread.detachNewThread {
        let started = Date()
        box.code = AccessibilityDriver.keyCode(for: "v")
        box.elapsed = Date().timeIntervalSince(started)
        done.signal()
      }
      let answered = done.wait(timeout: .now() + 5) == .success
      check("a character resolves off the main thread", answered && box.code == onMain)
      check("and answers from the cache rather than waiting on main", box.elapsed < 0.1)
    }

    // ─── the table agrees with the server ───────────────────────────────────
    // `runtime == .swift` is also the assertion that it has no npm package:
    // generate-surfaces.mjs refuses a swift surface with a non-null npmName, so
    // the two cannot drift apart and Surface does not carry the field.
    check("the table says this surface is served in-process", surface.runtime == .swift)
    check("the table gates it behind Accessibility", surface.storePermission == .accessibility)
    check(
      "the table declares exactly the scope gate", surface.gates.map(\.id) == ["allowAnyApp"])
    check("the table ships it switched off", !surface.defaultEnabled)

    let summary = "\(checks - failures - skipped)/\(checks) passed"
    print("\n" + (skipped > 0 ? "\(summary), \(skipped) skipped" : summary))
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
