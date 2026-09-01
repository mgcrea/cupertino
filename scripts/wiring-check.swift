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
    (id: "messages", label: "Messages"),
    (id: "safari", label: "Safari"),
    (id: "maps", label: "Maps"),
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
    localScopeIsReadCorrectly()
    projectFileIsJustAnotherMerge()
    disabledSurfacesArePruned()
    extraIsReportedAndActionable()
    staleWriteIsRefused()
    newFileModeIsApplied()
    localScopeIsWritten()

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
      into: root, rootKey: "mcpServers", entries: entries(), legacy: legacy, remove: [])

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
      rootKey: "servers", entries: entries(), legacy: legacy, remove: [])

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
      rootKey: "mcpServers", entries: entries(), legacy: legacy, remove: [])
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
      servers: servers, expectedCommand: bridge, expected: expected, unexpected: [])
    if case .stale(let found) = audit {
      check("reports the path it found", found.hasPrefix("/Users/x/Downloads"))
    } else {
      check("all four present but elsewhere is .stale", false)
    }

    var current: [String: Any] = [:]
    for (key, entry) in entries() { current[key] = entry }
    check(
      "matching command is .configured",
      ClientWiringMerge.audit(servers: current, expectedCommand: bridge, expected: expected, unexpected: [])
        == .configured)
  }

  // MARK: - 5. incomplete vs notConfigured

  static func incompleteVersusNotConfigured() {
    print("incomplete vs notConfigured")
    var three: [String: Any] = [:]
    for (key, entry) in entries() where key != "cupertino-calendar" { three[key] = entry }
    check(
      "three of four names the missing one",
      ClientWiringMerge.audit(servers: three, expectedCommand: bridge, expected: expected, unexpected: [])
        == .incomplete(["Calendar"]))
    check(
      "none is .notConfigured, not .incomplete",
      ClientWiringMerge.audit(servers: [:], expectedCommand: bridge, expected: expected, unexpected: [])
        == .notConfigured)
    check(
      "someone else's servers alone is still .notConfigured",
      ClientWiringMerge.audit(
        servers: ["someone-else": ["command": "npx"]], expectedCommand: bridge, expected: expected, unexpected: [])
        == .notConfigured)
  }

  // MARK: - 5b. A surface switched off is pruned, and only when it is ours

  static func disabledSurfacesArePruned() {
    print("disabled surfaces are pruned")
    let off = "cupertino-maps"
    var keep = entries()
    keep.removeValue(forKey: off)

    // Ours, but written by a copy of the app that has since moved. Still ours.
    let elsewhere: [String: Any] = [
      "command": "/Users/x/Downloads/Cupertino.app" + ClientWiringMerge.bridgeSuffix,
      "args": ["--server=maps"],
    ]
    let theirs: [String: Any] = ["command": "npx", "args": ["-y", "cupertino-maps"]]

    var root: [String: Any] = ["mcpServers": [off: elsewhere, "someone-else": theirs]]
    root["theme"] = "dark"
    var out = ClientWiringMerge.merged(
      into: root, rootKey: "mcpServers", entries: keep, legacy: legacy, remove: [off, "apple-maps"])
    var servers = out["mcpServers"] as? [String: Any] ?? [:]
    check("ours is removed even from an old path", servers[off] == nil)
    check("someone else's survives the removal", servers["someone-else"] != nil)
    check("unrelated root keys survive the removal", out["theme"] as? String == "dark")
    check("the other seven are still written", servers.count == keep.count + 1)

    // A third-party entry under OUR key is not ours to delete.
    out = ClientWiringMerge.merged(
      into: ["mcpServers": [off: theirs]], rootKey: "mcpServers", entries: keep, legacy: legacy,
      remove: [off])
    check(
      "a third-party server under our key survives",
      (out["mcpServers"] as? [String: Any])?[off] != nil)

    // The pre-rename key of a disabled surface is just as stale.
    out = ClientWiringMerge.merged(
      into: ["mcpServers": ["apple-maps": elsewhere]], rootKey: "mcpServers", entries: keep,
      legacy: legacy, remove: [off, "apple-maps"])
    check(
      "our legacy key is removed too",
      (out["mcpServers"] as? [String: Any])?["apple-maps"] == nil)
    out = ClientWiringMerge.merged(
      into: ["mcpServers": ["apple-maps": theirs]], rootKey: "mcpServers", entries: keep,
      legacy: legacy, remove: [off, "apple-maps"])
    check(
      "a third-party legacy key survives",
      (out["mcpServers"] as? [String: Any])?["apple-maps"] != nil)

    // Belt and braces: a key in both `entries` and `remove` is written.
    out = ClientWiringMerge.merged(
      into: [:], rootKey: "mcpServers", entries: entries(), legacy: legacy, remove: [off])
    check(
      "a key in both entries and remove is written, not deleted",
      (out["mcpServers"] as? [String: Any])?[off] != nil)

    // Removing what is not there must not invent it.
    out = ClientWiringMerge.merged(
      into: [:], rootKey: "mcpServers", entries: keep, legacy: legacy, remove: [off])
    servers = out["mcpServers"] as? [String: Any] ?? [:]
    check("removing an absent key is a no-op", servers[off] == nil && servers.count == keep.count)
  }

  // MARK: - 5c. A leftover entry is reported, so the row stays actionable

  static func extraIsReportedAndActionable() {
    print("extra vs incomplete vs configured")
    let off = "cupertino-maps"
    let expectedWithoutMaps = expected.filter { $0.key != off }
    let unexpectedMaps = [(key: off, label: "Maps")]

    var withMaps: [String: Any] = [:]
    for (key, entry) in entries() { withMaps[key] = entry }
    check(
      "a key for a switched-off surface is .extra",
      ClientWiringMerge.audit(
        servers: withMaps, expectedCommand: bridge, expected: expectedWithoutMaps,
        unexpected: unexpectedMaps) == .extra(["Maps"]))

    var withoutMaps = withMaps
    withoutMaps.removeValue(forKey: off)
    check(
      "once pruned it is .configured",
      ClientWiringMerge.audit(
        servers: withoutMaps, expectedCommand: bridge, expected: expectedWithoutMaps,
        unexpected: unexpectedMaps) == .configured)

    var missingOne = withMaps
    missingOne.removeValue(forKey: "cupertino-calendar")
    check(
      "missing wins over extra",
      ClientWiringMerge.audit(
        servers: missingOne, expectedCommand: bridge, expected: expectedWithoutMaps,
        unexpected: unexpectedMaps) == .incomplete(["Calendar"]))

    check(
      "a third-party server under our key is not .extra",
      ClientWiringMerge.audit(
        servers: withoutMaps.merging([off: ["command": "npx"]]) { a, _ in a },
        expectedCommand: bridge, expected: expectedWithoutMaps, unexpected: unexpectedMaps)
        == .configured)

    // Every surface off, and the config still holds ours: the row must still
    // have something to do, rather than reading as never configured.
    check(
      "all surfaces off with our keys present is .extra, not .notConfigured",
      ClientWiringMerge.audit(
        servers: withMaps, expectedCommand: bridge, expected: [],
        unexpected: expected) != .notConfigured)
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
      into: root, rootKey: "mcpServers", entries: entries(), legacy: legacy, remove: [])
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

  /// Local scope, which lives at `projects["<dir>"].mcpServers`.
  ///
  /// The distinction under test is the one that decides which button a folder
  /// row shows: a folder Claude Code has never heard of and a folder it knows
  /// with nothing of ours in it are different answers, and collapsing them
  /// would make an unwired folder claim to be merely incomplete.
  static func localScopeIsReadCorrectly() {
    print("local scope lookup")
    let dir = "/Users/someone/Projects/thing"
    let root: [String: Any] = [
      "numStartups": 41,
      "projects": [
        dir: ["mcpServers": ["cupertino-mail": ["command": "/A/bridge"]], "allowedTools": []],
        "/Users/someone/elsewhere": ["allowedTools": []],
      ],
    ]

    let mine = ClientWiringMerge.localScopeServers(in: root, folder: dir)
    check("finds the servers under the folder's own key", mine?.count == 1)

    // Known folder, nothing of ours: an empty dictionary, never nil.
    let empty = ClientWiringMerge.localScopeServers(in: root, folder: "/Users/someone/elsewhere")
    check("a known folder with no servers reads as empty, not absent", empty?.isEmpty == true)

    // Unknown folder: nil, so the caller can say "not configured" rather than
    // running an audit that would report every surface missing.
    check(
      "an unknown folder reads as absent",
      ClientWiringMerge.localScopeServers(in: root, folder: "/nope") == nil)

    // A file with no projects key at all — a fresh install.
    check(
      "no projects key reads as absent",
      ClientWiringMerge.localScopeServers(in: ["numStartups": 1], folder: dir) == nil)

    // The audit still has to work on what comes back.
    let audit = ClientWiringMerge.audit(
      servers: mine ?? [:], expectedCommand: "/A/bridge", expected: expected, unexpected: [])
    if case .incomplete(let missing) = audit {
      check("audits the folder's servers, not the user-scope ones", missing.count == surfaces.count - 1)
    } else {
      check("audits the folder's servers, not the user-scope ones", false)
    }
  }

  /// Project scope writes `<dir>/.mcp.json`, and the whole point of routing it
  /// through the same merge is that a repo's existing servers survive. Asserted
  /// against a realistic committed config rather than a synthetic one.
  static func projectFileIsJustAnotherMerge() {
    print("project .mcp.json merge")
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("cupertino-folder-\(UUID().uuidString)")
    let config = dir.appendingPathComponent(".mcp.json")
    defer { try? FileManager.default.removeItem(at: dir) }

    let existing: [String: Any] = [
      "mcpServers": [
        "postgres": ["command": "npx", "args": ["-y", "@some/pg-mcp"]]
      ]
    ]
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let data = try! JSONSerialization.data(withJSONObject: existing, options: [.prettyPrinted])
    try! data.write(to: config)

    let root = try! ClientWiringMerge.readJSON(config)
    let merged = ClientWiringMerge.merged(
      into: root, rootKey: "mcpServers", entries: entries("/A/bridge"), legacy: legacy, remove: [])
    _ = try! ClientWiringMerge.write(merged, to: config, backupSuffix: "cupertino-backup")

    let after = try! ClientWiringMerge.readJSON(config)
    let servers = after["mcpServers"] as! [String: Any]
    check("the repo's own server survives", servers["postgres"] != nil)
    check("every surface was added", surfaces.allSatisfy { servers["cupertino-\($0.id)"] != nil })
    check("nothing else was invented", servers.count == surfaces.count + 1)
  }


  // MARK: - 12. A merge computed from bytes that have since changed is refused

  /// The property `ClientWiring.mergeWrite` retries on. It does not close the
  /// race — a process holding its own snapshot of the whole file will still
  /// clobber this — but it does mean a merge is never landed on top of a change
  /// that arrived while the file was being read.
  static func staleWriteIsRefused() {
    print("stale write refused")
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("wiring-check-\(UUID().uuidString)")
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }

    let config = dir.appendingPathComponent("mcp.json")
    try? "{\"theme\":\"dark\"}".write(to: config, atomically: true, encoding: .utf8)

    let before = ClientWiringMerge.stamp(of: config)
    let root = (try? ClientWiringMerge.readJSON(config)) ?? [:]
    let merged = ClientWiringMerge.merged(
      into: root, rootKey: "mcpServers", entries: entries(), legacy: legacy, remove: [])

    // Somebody else writes between the read and the swap.
    try? "{\"theme\":\"light\",\"numStartups\":9}".write(
      to: config, atomically: true, encoding: .utf8)

    var refused = false
    do {
      _ = try ClientWiringMerge.write(
        merged, to: config, backupSuffix: "cupertino-backup", expecting: before)
    } catch ClientWiringMerge.WriteError.changedUnderneath(_) {
      refused = true
    } catch {
    }
    check("a changed file is refused", refused)
    let after = (try? ClientWiringMerge.readJSON(config)) ?? [:]
    check("their write survived", after["numStartups"] as? Int == 9)
    check("nothing of ours was written", after["mcpServers"] == nil)
    check(
      "no backup was taken for a write that did not happen",
      !fm.fileExists(atPath: config.appendingPathExtension("cupertino-backup").path))

    // The retry's second pass: a stamp taken after their write goes through.
    let fresh = ClientWiringMerge.stamp(of: config)
    let second = try? ClientWiringMerge.write(
      ClientWiringMerge.merged(
        into: try! ClientWiringMerge.readJSON(config), rootKey: "mcpServers",
        entries: entries(), legacy: legacy, remove: []),
      to: config, backupSuffix: "cupertino-backup", expecting: fresh)
    check("a current stamp writes", second != nil)
    let final = (try? ClientWiringMerge.readJSON(config)) ?? [:]
    check("their key is still there", final["numStartups"] as? Int == 9)
    check("and ours arrived", (final["mcpServers"] as? [String: Any])?["cupertino-mail"] != nil)

    // A file that does not exist yet is a precondition of its own, and one that
    // appears in the window has to be caught the same way.
    let unborn = dir.appendingPathComponent("nothing-here.json")
    let absent = ClientWiringMerge.stamp(of: unborn)
    check("a missing file stamps as absent", absent == .absent)
    try? "{}".write(to: unborn, atomically: true, encoding: .utf8)
    var caught = false
    do {
      _ = try ClientWiringMerge.write(
        ["mcpServers": [:]], to: unborn, backupSuffix: "cupertino-backup", expecting: absent)
    } catch ClientWiringMerge.WriteError.changedUnderneath(_) {
      caught = true
    } catch {
    }
    check("a file created in the window is refused", caught)
  }

  // MARK: - 13. Creating a config does not loosen it

  /// Two halves of one promise. A file this app creates in `$HOME` is 0600,
  /// because Claude Code will put OAuth credentials in it later and will not go
  /// back to tighten a mode it did not set. A file that already exists keeps
  /// whatever mode it has — `replaceItemAt` preserves the original's metadata —
  /// so nothing here can widen a config either.
  static func newFileModeIsApplied() {
    print("file modes")
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("wiring-check-\(UUID().uuidString)")
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }

    func mode(_ url: URL) -> Int? {
      (try? fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)??.intValue
    }

    let fresh = dir.appendingPathComponent("claude.json")
    _ = try? ClientWiringMerge.write(
      ["mcpServers": entries()], to: fresh, backupSuffix: "cupertino-backup", newFileMode: 0o600)
    check("a config we create is 0600", mode(fresh) == 0o600)

    // Asked for the same mode, an existing file is left as it is: the flag
    // names what to do when creating, not a mode to impose on somebody's file.
    let theirs = dir.appendingPathComponent("mcp.json")
    try? "{}".write(to: theirs, atomically: true, encoding: .utf8)
    try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: theirs.path)
    _ = try? ClientWiringMerge.write(
      ["mcpServers": entries()], to: theirs, backupSuffix: "cupertino-backup", newFileMode: 0o600)
    check("an existing config keeps its own mode", mode(theirs) == 0o644)

    // And the mode of a file that was already tight survives the swap, which is
    // the case that matters for `~/.claude.json`.
    let tight = dir.appendingPathComponent("tight.json")
    try? "{}".write(to: tight, atomically: true, encoding: .utf8)
    try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tight.path)
    _ = try? ClientWiringMerge.write(
      ["mcpServers": entries()], to: tight, backupSuffix: "cupertino-backup")
    check("0600 in, 0600 out", mode(tight) == 0o600)
  }

  // MARK: - 14. Local scope is written into one project block only

  /// The write behind the folder rows' `local` scope. The file it edits is the
  /// one holding ninety-nine other project blocks and seventy-six unrelated
  /// top-level keys, so "leaves everything else alone" is the whole test.
  static func localScopeIsWritten() {
    print("local scope merge")
    let dir = "/Users/someone/Projects/thing"
    let other = "/Users/someone/Projects/other"
    let root: [String: Any] = [
      "numStartups": 41,
      "oauthAccount": ["accountUuid": "abc"],
      "projects": [
        dir: [
          "allowedTools": ["Bash"],
          "mcpServers": ["postgres": ["command": "npx", "args": ["-y", "@some/pg-mcp"]]],
        ],
        other: ["allowedTools": [], "history": ["a", "b"]],
      ],
    ]

    let out = ClientWiringMerge.mergedIntoLocalScope(
      into: root, folder: dir, entries: entries(), legacy: legacy, remove: [])

    check("top-level keys survive", out["numStartups"] as? Int == 41)
    check("credentials survive", (out["oauthAccount"] as? [String: Any])?["accountUuid"] != nil)
    let projects = out["projects"] as? [String: Any] ?? [:]
    check("no project block invented or lost", projects.count == 2)
    let untouched = projects[other] as? [String: Any]
    check("the other folder is untouched", (untouched?["history"] as? [String])?.count == 2)
    check("the other folder gained no servers", untouched?["mcpServers"] == nil)

    let mine = projects[dir] as? [String: Any] ?? [:]
    check("the folder's own keys survive", (mine["allowedTools"] as? [String])?.first == "Bash")
    let servers = mine["mcpServers"] as? [String: Any] ?? [:]
    check("the folder's own server survives", servers["postgres"] != nil)
    check("every surface was added", surfaces.allSatisfy { servers["cupertino-\($0.id)"] != nil })

    // Nothing of ours in the file at all: a folder Claude Code has never heard
    // of gets a block, and only that block.
    let cold = ClientWiringMerge.mergedIntoLocalScope(
      into: ["numStartups": 1], folder: dir, entries: entries(), legacy: legacy, remove: [])
    let coldServers = ClientWiringMerge.localScopeServers(in: cold, folder: dir)
    check("an unknown folder gets its block", coldServers?.count == surfaces.count)
    check("and nothing at the top level", cold["mcpServers"] == nil)

    // Switching a surface off prunes it from the folder, not from the file's
    // other project blocks — the same `remove` gate the user-scope merge uses.
    var pruned = entries()
    pruned.removeValue(forKey: "cupertino-maps")
    let after = ClientWiringMerge.mergedIntoLocalScope(
      into: out, folder: dir, entries: pruned, legacy: legacy, remove: ["cupertino-maps"])
    let left = ClientWiringMerge.localScopeServers(in: after, folder: dir) ?? [:]
    check("a switched-off surface is pruned from the folder", left["cupertino-maps"] == nil)
    check("the folder's own server still survives", left["postgres"] != nil)
  }

}
