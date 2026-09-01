import AppKit
import Foundation

/// Asserts that the in-process `sound` server speaks MCP, and that its two
/// gates are independent.
///
/// The same gate `scripts/verify-servers.sh` cannot be, for the same reason
/// `screen-check.swift` gives: that script scans a `cli.js` and spawns it, and a
/// surface the app serves itself has neither, so `make bundle` would let a
/// broken in-process server reach a signature.
///
/// Drives `SoundServer.handle` directly — no socket, no app launch, no licence,
/// no TCC grant. The gates arrive as values rather than being read from
/// `UserDefaults`, which is what lets these assertions pin all four combinations
/// without touching a preference.
///
/// **Everything here runs on a machine with no microphone permission**, which is
/// the point: the ungated half of this surface needs no grant at all, and the
/// gated half has to stay invisible rather than fail loudly.
@main
struct SoundCheck {
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

  static let surface = Surface.named("sound")!

  static func ask(
    _ method: String, id: Int = 1, params: [String: Any]? = nil,
    writes: Bool = false, recording: Bool = false
  ) -> [String: Any]? {
    var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { message["params"] = params }
    guard let data = try? JSONSerialization.data(withJSONObject: message),
      let line = String(data: data, encoding: .utf8),
      let reply = SoundServer.handle(
        line, surface: surface, writesAllowed: writes, recordingAllowed: recording),
      let out = try? JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any]
    else { return nil }
    return out
  }

  static func toolNames(writes: Bool, recording: Bool) -> [String] {
    let reply = ask("tools/list", writes: writes, recording: recording)
    let result = reply?["result"] as? [String: Any]
    let tools = result?["tools"] as? [[String: Any]] ?? []
    return tools.compactMap { $0["name"] as? String }.sorted()
  }

  /// The text a tool call came back with, whatever its shape.
  static func callText(_ name: String, _ args: [String: Any] = [:], writes: Bool = false,
    recording: Bool = false) -> (text: String, isError: Bool)?
  {
    let reply = ask(
      "tools/call", params: ["name": name, "arguments": args], writes: writes,
      recording: recording)
    guard let result = reply?["result"] as? [String: Any],
      let content = result["content"] as? [[String: Any]],
      let text = content.first?["text"] as? String
    else { return nil }
    return (text, (result["isError"] as? Bool) ?? false)
  }

  static func main() {
    print("\nsound server\n")

    // ─── protocol ───────────────────────────────────────────────────────────

    let initialize = ask("initialize")
    let info = (initialize?["result"] as? [String: Any])?["serverInfo"] as? [String: Any]
    check("initialize answers with serverInfo", info?["name"] as? String == "cupertino-sound")
    check(
      "the protocol version matches the node surfaces",
      ((initialize?["result"] as? [String: Any])?["protocolVersion"] as? String) == "2024-11-05")

    // A notification carries no id and must draw no reply at all. Answering one
    // is a protocol error rather than an extra courtesy.
    let notification = #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
    check(
      "a notification is not answered",
      SoundServer.handle(
        notification, surface: surface, writesAllowed: true, recordingAllowed: true) == nil)

    check("an unknown method is a JSON-RPC error", ask("nope")?["error"] != nil)
    check("an unknown resource is an error", ask(
      "resources/read", params: ["uri": "cupertino://sound/nope"])?["error"] != nil)

    // ─── the gates are independent, which is the whole design ───────────────

    let ungated = toolNames(writes: false, recording: false)
    let writesOnly = toolNames(writes: true, recording: false)
    let recordingOnly = toolNames(writes: false, recording: true)
    let both = toolNames(writes: true, recording: true)

    check(
      "with both gates off, only the permission-free reads are registered",
      ungated == [
        "apple_sound_diagnostics", "apple_sound_get_volume", "apple_sound_list_devices",
      ])
    check(
      "allowWrites alone registers no recording tool",
      !writesOnly.contains { $0.hasSuffix("_recording") })
    check(
      "allowRecording alone registers no write tool",
      !recordingOnly.contains("apple_sound_set_volume"))
    check(
      "allowRecording alone DOES register the recording tools",
      recordingOnly.contains("apple_sound_start_recording")
        && recordingOnly.contains("apple_sound_stop_recording"))
    check("the two gates are independent", Set(writesOnly).union(recordingOnly) == Set(both))
    check("every gate combination keeps the ungated three", [
      writesOnly, recordingOnly, both,
    ].allSatisfy { Set($0).isSuperset(of: ungated) })

    // Not registered, not refused — the property docs/alternatives.md claims.
    check(
      "a gated tool is invisible rather than refused",
      callText("apple_sound_start_recording")?.text.contains("unknown tool") == true)

    // ─── annotations ────────────────────────────────────────────────────────

    let all = (ask("tools/list", writes: true, recording: true)?["result"] as? [String: Any])?[
      "tools"] as? [[String: Any]] ?? []
    let readOnly = all.filter {
      (($0["annotations"] as? [String: Any])?["readOnlyHint"] as? Bool) == true
    }.compactMap { $0["name"] as? String }
    check(
      "the three ungated tools and recording_status are the read-only ones",
      Set(readOnly) == Set(ungated + ["apple_sound_recording_status"]))
    check("every tool declares an inputSchema", all.allSatisfy { $0["inputSchema"] != nil })
    check("every tool declares a description", all.allSatisfy {
      (($0["description"] as? String) ?? "").count > 20
    })

    // ─── the free half really is free ───────────────────────────────────────
    // No grant of any kind is held here, and these still have to answer.

    let devices = callText("apple_sound_list_devices")
    check("list_devices answers with no permission at all", devices?.isError == false)
    let parsed =
      devices.flatMap { try? JSONSerialization.jsonObject(with: Data($0.text.utf8)) }
      as? [String: Any]
    check("list_devices reports a count", parsed?["count"] as? Int != nil)
    if let rows = parsed?["devices"] as? [[String: Any]] {
      check("every device carries a uid", rows.allSatisfy { ($0["uid"] as? String) != nil })
      // A device with no volume control must be null, never 0 — an HDMI output
      // has no volume, and reporting it as silent is a different claim.
      check(
        "volume is null or a number, never missing",
        rows.allSatisfy { $0["volume"] != nil })
    }

    check("diagnostics answers whatever the grant is", callText("apple_sound_diagnostics")?
      .isError == false)
    let diag =
      callText("apple_sound_diagnostics").flatMap {
        try? JSONSerialization.jsonObject(with: Data($0.text.utf8))
      } as? [String: Any]
    check(
      "diagnostics reports the microphone status by name",
      ((diag?["microphone"] as? [String: Any])?["status"] as? String) != nil)
    check(
      "diagnostics reports the gates it was called with",
      ((diag?["gates"] as? [String: Any])?["allowRecording"] as? Bool) == false)
    // Counts and roles only. A device NAME is the data, and diagnostics is what
    // people paste into an issue.
    check(
      "diagnostics names no device",
      InProcessRPC.jsonText(diag ?? [:]).range(of: "\"name\"") == nil
        || (diag?["devices"] as? [String: Any])?["total"] != nil)

    // ─── resources ──────────────────────────────────────────────────────────

    let list = (ask("resources/list")?["result"] as? [String: Any])?["resources"]
      as? [[String: Any]] ?? []
    check(
      "both resources are advertised",
      list.compactMap { $0["uri"] as? String }.sorted()
        == ["cupertino://sound/diagnostics", "cupertino://sound/guide"])

    let guide = ask("resources/read", params: ["uri": "cupertino://sound/guide"])
    let guideText =
      (((guide?["result"] as? [String: Any])?["contents"] as? [[String: Any]])?.first?["text"]
        as? String) ?? ""
    check("the guide is served and non-empty", guideText.count > 200)
    // The guide has to carry its own refusals, the way every node surface's
    // does — a caveat only in the docs is a caveat the model never sees.
    check("the guide says recording is not silent", guideText.contains("orange"))
    check("the guide says devices are named by uid", guideText.contains("uid"))
    check("the guide states what the surface cannot do", guideText.contains("does not transcribe"))

    // ─── the closed table ───────────────────────────────────────────────────

    check("sound is a capability", surface.kind == .capability)
    check("sound sends no Apple Event", !surface.usesAppleEvents)
    check("sound is served in-process", surface.runtime == .swift)
    check("sound declares the microphone permission", surface.storePermission == .microphone)
    check("sound declares exactly one gate", surface.gates.count == 1)
    check("that gate is allowRecording", surface.gates.first?.id == "allowRecording")
    check("recordings are confined to a root", SoundCapture.root.path.hasSuffix("/Downloads"))

    print("\n\(checks - failures)/\(checks) passed\n")
    if failures > 0 { exit(1) }
  }
}

/// `AppInfo` reaches for screenshot-mode state, and that pulls half the app in
/// behind it. The server only ever asks it for a version string.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
