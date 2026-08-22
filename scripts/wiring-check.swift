import Foundation

/// Asserts the properties `ClientWiringMerge` promises about somebody else's
/// config file.
///
/// A standalone `swiftc` binary rather than an XCTest bundle: the Xcode project
/// has two synchronized-group targets and no shared schemes, so adding a test
/// target means hand-editing project.pbxproj and authoring a scheme — a bigger
/// and riskier diff than the code under test. CI already does exactly this for
/// packages/mail/native/launcher.c.
///
/// Run with `make wiring-check`.
@main
struct WiringCheck {
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

  /// The surfaces, as `ClientWiring` hands them over. Generated — see surfaces.json.
  // <generated:surfaces> generated from surfaces.json by `make surfaces` — do not edit by hand
  static let surfaces = [
    (id: "mail", label: "Mail"),
    (id: "notes", label: "Notes"),
    (id: "reminders", label: "Reminders"),
    (id: "calendar", label: "Calendar"),
    (id: "contacts", label: "Contacts"),
    (id: "safari", label: "Safari"),
  ]
  // </generated:surfaces>
  static let bridge = "/Applications/Cupertino.app" + ClientWiringMerge.bridgeSuffix

  static func entries(_ command: String = bridge) -> [String: [String: Any]] {
    Dictionary(
      uniqueKeysWithValues: surfaces.map {
        (
          "cupertino-\($0.id)",
          ["command": command, "args": ["--server=\($0.id)"]] as [String: Any]
        )
      })
  }
  static var legacy: [String: String] {
    Dictionary(uniqueKeysWithValues: surfaces.map { ("cupertino-\($0.id)", "apple-\($0.id)") })
  }
  static var expected: [(key: String, label: String)] {
    surfaces.map { (key: "cupertino-\($0.id)", label: $0.label) }
  }

  static func main() {
    unrelatedKeysSurvive()
    rootKeyIsReal()
    legacyMigratesOnlyWhenOurs()
    staleIsDecidedByCommand()
    incompleteVersusNotConfigured()
    nonObjectJSONRefused()
    backupAndNoLitter()

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 { exit(1) }
  }

  // MARK: - 1. Every unrelated key survives

  static func unrelatedKeysSurvive() {
    print("unrelated keys survive")
    let theirs: [String: Any] = ["command": "npx", "args": ["-y", "some-other-server"]]
    let root: [String: Any] = [
      "mcpServers": ["someone-else": theirs],
      "theme": "dark",
      "$schema": "https://example.com/schema.json",
      "globalShortcut": "",
    ]
    let out = ClientWiringMerge.merged(
      into: root, rootKey: "mcpServers", entries: entries(), legacy: legacy)

    check("top-level `theme` kept", out["theme"] as? String == "dark")
    check("top-level `$schema` kept", out["$schema"] as? String != nil)
    check("empty-string value kept", out["globalShortcut"] as? String == "")
    let servers = out["mcpServers"] as? [String: Any] ?? [:]
    let survivor = servers["someone-else"] as? [String: Any]
    check("third-party server kept", survivor?["command"] as? String == "npx")
    check("third-party args kept", (survivor?["args"] as? [String])?.count == 2)
    check("all four surfaces written", surfaces.allSatisfy { servers["cupertino-\($0.id)"] != nil })
  }

  // MARK: - 2. rootKey is a parameter, not a comment

  static func rootKeyIsReal() {
    print("rootKey is honoured")
    let out = ClientWiringMerge.merged(
      into: ["servers": ["someone-else": ["command": "npx"]]],
      rootKey: "servers", entries: entries(), legacy: legacy)

    check("merged under `servers`", (out["servers"] as? [String: Any])?["cupertino-mail"] != nil)
    check("no stray `mcpServers` key", out["mcpServers"] == nil)
    check(
      "third-party kept under `servers`",
      (out["servers"] as? [String: Any])?["someone-else"] != nil)
  }

  // MARK: - 3. Legacy keys migrate only when they are ours

  static func legacyMigratesOnlyWhenOurs() {
    print("legacy apple-* keys")
    let ours: [String: Any] = [
      "command": "/Users/someone/Downloads/Cupertino.app" + ClientWiringMerge.bridgeSuffix,
      "args": ["--server=mail"],
    ]
    let theirs: [String: Any] = ["command": "npx", "args": ["-y", "apple-notes-mcp"]]
    let out = ClientWiringMerge.merged(
      into: ["mcpServers": ["apple-mail": ours, "apple-notes": theirs]],
      rootKey: "mcpServers", entries: entries(), legacy: legacy)
    let servers = out["mcpServers"] as? [String: Any] ?? [:]

    check("ours removed even from an old path", servers["apple-mail"] == nil)
    check("someone else's apple-notes survives", servers["apple-notes"] != nil)
    check(
      "and survives untouched",
      (servers["apple-notes"] as? [String: Any])?["command"] as? String == "npx")
    check("replaced by cupertino-mail", servers["cupertino-mail"] != nil)
    check("coexists with cupertino-notes", servers["cupertino-notes"] != nil)
    check("isOurs rejects a non-object", !ClientWiringMerge.isOurs("cupertino-bridge"))
    check("isOurs rejects a missing command", !ClientWiringMerge.isOurs(["args": []]))
  }

  // MARK: - 4. Stale is a command mismatch, not an absence

  static func staleIsDecidedByCommand() {
    print("stale detection")
    var servers: [String: Any] = [:]
    for (key, entry) in entries("/Users/x/Downloads/Cupertino.app" + ClientWiringMerge.bridgeSuffix)
    {
      servers[key] = entry
    }
    let audit = ClientWiringMerge.audit(
      servers: servers, expectedCommand: bridge, expected: expected)
    if case .stale(let found) = audit {
      check("reports the path it found", found.hasPrefix("/Users/x/Downloads"))
    } else {
      check("all four present but elsewhere is .stale", false)
    }

    var current: [String: Any] = [:]
    for (key, entry) in entries() { current[key] = entry }
    check(
      "matching command is .configured",
      ClientWiringMerge.audit(servers: current, expectedCommand: bridge, expected: expected)
        == .configured)
  }

  // MARK: - 5. incomplete vs notConfigured

  static func incompleteVersusNotConfigured() {
    print("incomplete vs notConfigured")
    var three: [String: Any] = [:]
    for (key, entry) in entries() where key != "cupertino-calendar" { three[key] = entry }
    check(
      "three of four names the missing one",
      ClientWiringMerge.audit(servers: three, expectedCommand: bridge, expected: expected)
        == .incomplete(["Calendar"]))
    check(
      "none is .notConfigured, not .incomplete",
      ClientWiringMerge.audit(servers: [:], expectedCommand: bridge, expected: expected)
        == .notConfigured)
    check(
      "someone else's servers alone is still .notConfigured",
      ClientWiringMerge.audit(
        servers: ["someone-else": ["command": "npx"]], expectedCommand: bridge, expected: expected)
        == .notConfigured)
  }

  // MARK: - 6. A config we cannot parse is left alone

  static func nonObjectJSONRefused() {
    print("unparseable configs refused")
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("wiring-check-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }

    for (label, body) in [
      ("an array", "[1,2,3]"), ("a string", "\"hello\""), ("truncated", "{\"a\":"),
    ] {
      let url = dir.appendingPathComponent("\(label.replacingOccurrences(of: " ", with: "-")).json")
      try? body.write(to: url, atomically: true, encoding: .utf8)
      var threw = false
      do { _ = try ClientWiringMerge.readJSON(url) } catch { threw = true }
      check("\(label) throws", threw)
      check(
        "\(label) left on disk untouched",
        (try? String(contentsOf: url, encoding: .utf8)) == body)
    }

    // An empty file is not a corrupt one — a client that has created the file
    // but never written to it is a config we can safely start from.
    let empty = dir.appendingPathComponent("empty.json")
    try? "".write(to: empty, atomically: true, encoding: .utf8)
    check("an empty file reads as {}", (try? ClientWiringMerge.readJSON(empty))?.isEmpty == true)
  }

  // MARK: - 7. Backup kept, no temp files left behind

  static func backupAndNoLitter() {
    print("backup and atomic swap")
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("wiring-check-\(UUID().uuidString)")
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }

    let config = dir.appendingPathComponent("mcp.json")
    let before = "{\n  \"theme\" : \"dark\"\n}\n"
    try? before.write(to: config, atomically: true, encoding: .utf8)

    guard let root = try? ClientWiringMerge.readJSON(config) else {
      return check("fixture reads back", false)
    }
    let merged = ClientWiringMerge.merged(
      into: root, rootKey: "mcpServers", entries: entries(), legacy: legacy)
    let backup = try? ClientWiringMerge.write(merged, to: config, backupSuffix: "cupertino-backup")

    check("a backup was made", backup != nil)
    check(
      "backup holds the pre-merge bytes",
      backup.flatMap { try? String(contentsOf: $0, encoding: .utf8) } == before)
    check("config was replaced", (try? ClientWiringMerge.readJSON(config))?["mcpServers"] != nil)

    let left = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
    check("no .tmp left behind", !left.contains { $0.hasSuffix(".tmp") })
    check("exactly config + backup", left.count == 2)

    // Writing where nothing exists yet has to create the directory, and has
    // nothing to back up.
    let fresh = dir.appendingPathComponent("nested/deeper/mcp.json")
    let none = try? ClientWiringMerge.write(
      ["mcpServers": [:]], to: fresh, backupSuffix: "cupertino-backup")
    check("no backup for a new file", none == nil)
    check("parent directories created", fm.fileExists(atPath: fresh.path))
  }
}
