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
    (id: "screen", label: "Screen"),
    (id: "sound", label: "Sound"),
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

  /// A copy of the app somebody dragged out of a DMG and never moved. Still
  /// ours — `isOurs` is a suffix test for exactly this case.
  static let moved = "/Users/x/Downloads/Cupertino.app" + ClientWiringMerge.bridgeSuffix

  /// Somebody else's server, in the three shapes a real config holds: a stdio
  /// command, a remote url, and an entry that names neither.
  static let npx: [String: Any] = ["command": "npx", "args": ["-y", "some-mcp"]]
  static let remote: [String: Any] = ["type": "http", "url": "https://mcp.example.com/x"]
  static let shapeless: [String: Any] = ["type": "http"]

  /// Structural equality over the `Any` a JSON object decodes to.
  ///
  /// Every "nothing else changed" claim below needs one, and `==` on
  /// `[String: Any]` does not exist. Ported from Bastion's copy of this script.
  static func deepEqual(_ a: Any?, _ b: Any?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case let (x as [String: Any], y as [String: Any]):
      return x.count == y.count && x.allSatisfy { deepEqual($0.value, y[$0.key]) }
    case let (x as [Any], y as [Any]):
      return x.count == y.count && zip(x, y).allSatisfy { deepEqual($0, $1) }
    case (is NSNull, is NSNull): return true
    case let (x as NSObject, y as NSObject): return x.isEqual(y)
    default: return false
    }
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
    perEntryStateAgreesWithAudit()
    foreignEntriesAreEverythingNotOurs()
    removingTakesExactlyOneKey()
    unmergedTakesOnlyOurs()

    // Any paths on the command line are real client configs, read and never
    // written. See `make wiring-check-real`.
    for argument in CommandLine.arguments.dropFirst() {
      realFileSurvives(URL(fileURLWithPath: argument))
    }

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 { exit(1) }
  }

  // MARK: - The same guarantees, against a config somebody actually uses

  /// Everything above is asserted against fixtures, and fixtures are written by
  /// whoever is asserting things about them.
  ///
  /// This runs the same merge against the real files on this Mac — read-only,
  /// nothing is written — because the shapes that break a merge are the ones
  /// nobody thought to fixture: a `projects` map with ninety-eight blocks in it,
  /// an entry that is a bare string, a JSON `null`, seventy-six top-level keys,
  /// an `env` block holding a token. Bastion's copy of this script found two
  /// bugs this way that its fixtures did not.
  ///
  /// A file that is absent or unparseable is skipped rather than failed: which
  /// editors this Mac has is not a property of the code under test.
  static func realFileSurvives(_ url: URL) {
    print("\n\(url.path)")
    guard FileManager.default.fileExists(atPath: url.path) else {
      return print("  skip (not on this Mac)")
    }
    guard let before = try? ClientWiringMerge.readJSON(url) else {
      return check("reads as a JSON object", false)
    }

    let rootKey = before["servers"] != nil && before["mcpServers"] == nil ? "servers" : "mcpServers"
    let originalServers = before[rootKey] as? [String: Any] ?? [:]
    let ours = Set(originalServers.filter { ClientWiringMerge.isOurs($0.value) }.keys)
    let after = ClientWiringMerge.merged(
      into: before, rootKey: rootKey, entries: entries(), legacy: legacy, remove: [])

    var topLevelIntact = true
    for (key, value) in before where key != rootKey {
      if !deepEqual(value, after[key]) { topLevelIntact = false }
    }
    check(
      "every other top-level key is byte-identical (\(before.count - 1) of them)", topLevelIntact)

    let afterServers = after[rootKey] as? [String: Any] ?? [:]
    var untouched = true
    var examined = 0
    for (key, value) in originalServers where !ours.contains(key) && entries()[key] == nil {
      examined += 1
      if !deepEqual(value, afterServers[key]) { untouched = false }
    }
    check("every server we did not write is byte-identical (\(examined) of them)", untouched)
    check(
      "and none of them went missing",
      originalServers.keys.allSatisfy { afterServers[$0] != nil || entries()[$0] != nil })
    check("every surface arrived", entries().keys.allSatisfy { afterServers[$0] != nil })

    // The readers the client pane draws from, over shapes no fixture has: a
    // hundred project blocks, an entry that is a bare string, a `type: http`
    // block with no command in it. They cannot fail an assertion the merge
    // above would not — what they can do is disagree with `isOurs`, which is
    // what puts a Remove button beside an entry that refuses to be removed.
    let foreign = ClientWiringMerge.foreignEntries(in: originalServers)
    check(
      "the other-servers list is exactly what is not ours (\(foreign.count) of them)",
      foreign.count == originalServers.count - ours.count)
    check(
      "and nothing in it is ours",
      foreign.allSatisfy { !ClientWiringMerge.isOurs(originalServers[$0.key]) })

    let byFolder = ClientWiringMerge.foreignLocalScopeEntries(in: before)
    check(
      "every folder listed is a folder in the file (\(byFolder.count) of them)",
      byFolder.allSatisfy { (before["projects"] as? [String: Any])?[$0.folder] != nil })
    check(
      "no folder is listed with nothing in it", byFolder.allSatisfy { !$0.entries.isEmpty })

    // The nested write, which is the one with something to destroy: Claude
    // Code's per-folder blocks. The first folder in the file stands in for all
    // of them, and the assertion is about the other ninety-seven.
    guard let projects = before["projects"] as? [String: Any], let folder = projects.keys.sorted().first
    else { return }
    let nested = ClientWiringMerge.mergedIntoLocalScope(
      into: before, folder: folder, entries: entries(), legacy: legacy, remove: [])
    let nestedProjects = nested["projects"] as? [String: Any] ?? [:]
    var othersIntact = true
    for (key, value) in projects where key != folder {
      if !deepEqual(value, nestedProjects[key]) { othersIntact = false }
    }
    check(
      "a write into one folder leaves the other \(projects.count - 1) alone", othersIntact)
    check(
      "the written folder gained our servers",
      ClientWiringMerge.localScopeServers(in: nested, folder: folder).map { servers in
        entries().keys.allSatisfy { servers[$0] != nil }
      } ?? false)
    check(
      "and the top-level servers object is untouched by it",
      deepEqual(nested[rootKey], before[rootKey]))
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

  // MARK: - 15. A badge per entry, and a header that cannot disagree with it

  /// The detail pane draws a badge per surface and a sentence above them, from
  /// one read of one file. `audit` is `state` reduced, so the two cannot
  /// disagree by construction — what is asserted here is that the reduction
  /// still gives the answers sections 4, 5 and 5c were written against, and that
  /// the finer partition a row needs did not change any of them.
  static func perEntryStateAgreesWithAudit() {
    print("per-entry state")
    let key = "cupertino-mail"
    func state(_ servers: [String: Any], _ k: String = key) -> ClientWiringMerge.EntryState {
      ClientWiringMerge.state(of: servers, key: k, expectedCommand: bridge)
    }

    check("an absent key is .missing", state([:]) == .missing)
    check("a key holding a bare string is .missing", state([key: "nonsense"]) == .missing)
    check(
      "our entry at the current bridge is .matches",
      state([key: ["command": bridge, "args": ["--server=mail"]]]) == .matches)
    check(
      "our entry from a bundle that has moved is .stale, and names where",
      state([key: ["command": moved, "args": ["--server=mail"]]]) == .stale(moved))
    check(
      "our pre-rename key is ours too, not somebody else's",
      state(["apple-mail": ["command": moved, "args": ["--server=mail"]]], "apple-mail")
        == .stale(moved))
    check("a third-party command is .foreign, and names it", state([key: npx]) == .foreign("npx"))
    check(
      "a remote entry is .foreign, and names its url",
      state([key: remote]) == .foreign("https://mcp.example.com/x"))
    check("an entry naming neither is .foreign with nothing to name", state([key: shapeless]) == .foreign(nil))

    // The reduction, against literals rather than against itself. One case per
    // `Audit` case, plus the two payload pins.
    var all: [String: Any] = [:]
    for (k, entry) in entries() { all[k] = entry }
    func verdict(
      _ servers: [String: Any],
      _ exp: [(key: String, label: String)] = expected,
      _ unexp: [(key: String, label: String)] = []
    ) -> ClientWiringMerge.Audit {
      ClientWiringMerge.audit(
        servers: servers, expectedCommand: bridge, expected: exp, unexpected: unexp)
    }

    check("nothing at all is .notConfigured", verdict([:]) == .notConfigured)
    check("every surface at the current bridge is .configured", verdict(all) == .configured)
    var short = all
    short.removeValue(forKey: "cupertino-calendar")
    check("one absent is .incomplete, naming it", verdict(short) == .incomplete(["Calendar"]))
    var oneMoved = all
    oneMoved["cupertino-maps"] = ["command": moved, "args": ["--server=maps"]]
    check("one pointing elsewhere is .stale", verdict(oneMoved) == .stale(moved))
    var taken = all
    taken["cupertino-maps"] = npx
    check(
      "a foreign entry under our key is .stale, naming the squatter",
      verdict(taken) == .stale("npx"))
    check(
      "the row says taken where the header says stale — different words, same verdict",
      state(taken, "cupertino-maps") == .foreign("npx"))
    var shapelessTaken = all
    shapelessTaken["cupertino-maps"] = shapeless
    check(
      "an entry naming neither still audits as .stale(unknown)",
      verdict(shapelessTaken) == .stale("unknown"))
    // The one payload this refactor changed on purpose: `identity` falls back to
    // `url`, so a remote squatter is now named instead of reported as "unknown".
    // The VERDICT is what sections 4 and 5c pin, and it did not move.
    var remoteTaken = all
    remoteTaken["cupertino-maps"] = remote
    check(
      "a remote squatter is named rather than called unknown",
      verdict(remoteTaken) == .stale("https://mcp.example.com/x"))

    let withoutMaps = expected.filter { $0.key != "cupertino-maps" }
    let mapsOff = [(key: "cupertino-maps", label: "Maps")]
    check(
      "a leftover of ours is .extra", verdict(all, withoutMaps, mapsOff) == .extra(["Maps"]))
    check(
      "a leftover that is not ours is not .extra",
      verdict(taken, withoutMaps, mapsOff) == .configured)

    // The property the pane depends on: no row missing and no leftovers can
    // never read as incomplete, whatever else is in the file.
    var clean = all
    clean["someone-else"] = npx
    clean["remote-thing"] = remote
    if case .incomplete = verdict(clean) {
      check("a full config with strangers in it is not .incomplete", false)
    } else {
      check("a full config with strangers in it is not .incomplete", true)
    }
  }

  // MARK: - 16. Everything in the file that is not ours

  /// What the pane lists under "Other servers in this file", which is also the
  /// list every Remove button is drawn from. It has to agree with `removing`'s
  /// refusal exactly: a button beside an entry that cannot be removed is a
  /// button that does nothing.
  static func foreignEntriesAreEverythingNotOurs() {
    print("other people's servers")
    let servers: [String: Any] = [
      "cupertino-mail": ["command": bridge, "args": ["--server=mail"]],
      "cupertino-notes": ["command": moved, "args": ["--server=notes"]],
      "apple-safari": ["command": moved, "args": ["--server=safari"]],
      "apple-notes": npx,
      "remote": remote,
      "junk": shapeless,
      "stringy": "nonsense",
    ]
    let foreign = ClientWiringMerge.foreignEntries(in: servers)

    check(
      "exactly the keys that are not ours",
      foreign.map(\.key) == ["apple-notes", "junk", "remote", "stringy"])
    check("sorted by key", foreign.map(\.key) == foreign.map(\.key).sorted())
    check(
      "a command entry names its command",
      foreign.first { $0.key == "apple-notes" }?.identity == "npx")
    check(
      "a remote entry names its url",
      foreign.first { $0.key == "remote" }?.identity == "https://mcp.example.com/x")
    check(
      "an entry naming neither has nothing to name",
      foreign.first { $0.key == "junk" }?.identity == nil)
    check(
      "a key holding a bare string is listed rather than dropped",
      foreign.contains { $0.key == "stringy" && $0.identity == nil })
    check("nothing at all is an empty list", ClientWiringMerge.foreignEntries(in: [:]).isEmpty)

    // The invariant that keeps the Remove button honest.
    var gateAgrees = true
    for entry in foreign {
      let after = ClientWiringMerge.removing(
        key: entry.key, from: ["mcpServers": servers], rootKey: "mcpServers")
      if (after["mcpServers"] as? [String: Any])?[entry.key] != nil { gateAgrees = false }
    }
    check("every entry listed is one `removing` actually takes out", gateAgrees)

    // Local scope: four folders, one of which has something worth listing.
    let root: [String: Any] = [
      "numStartups": 41,
      "projects": [
        "/Users/you/b": ["mcpServers": ["apple-notes": npx, "cupertino-mail": ["command": bridge]]],
        "/Users/you/a": ["mcpServers": ["cupertino-mail": ["command": bridge]]],
        "/Users/you/c": ["mcpServers": [:] as [String: Any]],
        "/Users/you/d": ["allowedTools": []],
      ],
    ]
    let byFolder = ClientWiringMerge.foreignLocalScopeEntries(in: root)
    check("only folders with something foreign in them are listed", byFolder.count == 1)
    check("and it is the right folder", byFolder.first?.folder == "/Users/you/b")
    check("with its foreign entry named", byFolder.first?.entries.map(\.key) == ["apple-notes"])
    check(
      "a file with no projects key has no local scope at all",
      ClientWiringMerge.foreignLocalScopeEntries(in: ["numStartups": 1]).isEmpty)

    // Sorting, with enough folders for insertion order to differ from it.
    let many: [String: Any] = [
      "projects": [
        "/Users/you/z": ["mcpServers": ["a": npx]],
        "/Users/you/m": ["mcpServers": ["a": npx]],
        "/Users/you/a": ["mcpServers": ["a": npx]],
      ]
    ]
    check(
      "folders come back sorted",
      ClientWiringMerge.foreignLocalScopeEntries(in: many).map(\.folder)
        == ["/Users/you/a", "/Users/you/m", "/Users/you/z"])
  }

  // MARK: - 17. Taking exactly one entry out

  /// The narrowest write this app makes, and the only one that removes something
  /// it did not put there. It must take one key and leave every other byte of a
  /// file it does not own alone.
  static func removingTakesExactlyOneKey() {
    print("removing one entry")
    let root: [String: Any] = [
      "numStartups": 41,
      "mcpServers": [
        "cupertino-mail": ["command": bridge, "args": ["--server=mail"]],
        "apple-mail": ["command": moved, "args": ["--server=mail"]],
        "apple-notes": npx,
        "other": ["command": "uvx", "args": ["thing"], "env": ["TOKEN": "x", "DEBUG": "1"]],
      ],
      "projects": [
        "/Users/you/a": ["mcpServers": ["apple-notes": npx, "kept": remote], "history": []],
        "/Users/you/b": ["mcpServers": ["apple-notes": npx]],
      ],
    ]
    let before = root["mcpServers"] as? [String: Any] ?? [:]

    var out = ClientWiringMerge.removing(key: "apple-notes", from: root, rootKey: "mcpServers")
    var servers = out["mcpServers"] as? [String: Any] ?? [:]
    check("the named entry is gone", servers["apple-notes"] == nil)
    check("exactly one entry went", servers.count == before.count - 1)
    check(
      "its siblings are byte-identical, env blocks included",
      deepEqual(servers["other"], before["other"]))
    check("unrelated top-level keys survive", out["numStartups"] as? Int == 41)
    check(
      "a user-scope removal does not reach the project blocks",
      deepEqual(out["projects"], root["projects"]))

    // The refusal. Cupertino's own entries come out through `unmerged`, which
    // knows about the whole set; this door must not be a second way to do it.
    out = ClientWiringMerge.removing(key: "cupertino-mail", from: root, rootKey: "mcpServers")
    check(
      "removing one of ours is refused",
      (out["mcpServers"] as? [String: Any])?["cupertino-mail"] != nil)
    out = ClientWiringMerge.removing(key: "apple-mail", from: root, rootKey: "mcpServers")
    check(
      "removing our legacy key is refused too, even from a bundle that moved",
      (out["mcpServers"] as? [String: Any])?["apple-mail"] != nil)

    out = ClientWiringMerge.removing(key: "never-there", from: root, rootKey: "mcpServers")
    check("removing an absent key changes nothing", deepEqual(out, root))
    out = ClientWiringMerge.removing(key: "apple-notes", from: root, rootKey: "servers")
    check("a root key the file does not have is a no-op", deepEqual(out, root))
    check("and is not invented", out["servers"] == nil)

    let single: [String: Any] = ["mcpServers": ["apple-notes": npx]]
    out = ClientWiringMerge.removing(key: "apple-notes", from: single, rootKey: "mcpServers")
    check(
      "emptying the object leaves it present and empty, not absent",
      (out["mcpServers"] as? [String: Any])?.isEmpty == true)

    // Nested: the value-type trap `mergedIntoLocalScope` was written against.
    out = ClientWiringMerge.removing(
      key: "apple-notes", inLocalScope: "/Users/you/a", from: root)
    let projects = out["projects"] as? [String: Any] ?? [:]
    let folder = projects["/Users/you/a"] as? [String: Any] ?? [:]
    let folderServers = folder["mcpServers"] as? [String: Any] ?? [:]
    check("the nested removal actually landed", folderServers["apple-notes"] == nil)
    check("the folder's other server survives", folderServers["kept"] != nil)
    check("the folder's own keys survive", folder["history"] != nil)
    check(
      "the other folder is untouched",
      deepEqual(
        projects["/Users/you/b"],
        (root["projects"] as? [String: Any])?["/Users/you/b"]))
    check(
      "user scope is untouched by a local-scope removal",
      deepEqual(out["mcpServers"], root["mcpServers"]))

    out = ClientWiringMerge.removing(key: "apple-notes", inLocalScope: "/nope", from: root)
    check("a folder the file does not know changes nothing", deepEqual(out, root))
    let noServers: [String: Any] = ["projects": ["/Users/you/d": ["allowedTools": []]]]
    out = ClientWiringMerge.removing(key: "apple-notes", inLocalScope: "/Users/you/d", from: noServers)
    check("a folder with no mcpServers changes nothing", deepEqual(out, noServers))
  }

  // MARK: - 18. Removing everything of ours, and only that

  /// What "Remove Cupertino's entries" writes. The guarantee is the same one
  /// `merged` gives from the other direction, and it rests on the same
  /// predicate: `isOurs` decides, so a third-party server under one of our own
  /// key names survives a button that claims to remove ours.
  static func unmergedTakesOnlyOurs() {
    print("removing everything of ours")
    let root: [String: Any] = [
      "numStartups": 41,
      "oauthAccount": ["emailAddress": "someone@example.com"],
      "mcpServers": [
        "cupertino-mail": ["command": bridge, "args": ["--server=mail"]],
        "cupertino-notes": ["command": moved, "args": ["--server=notes"]],
        "apple-safari": ["command": moved, "args": ["--server=safari"]],
        "cupertino-maps": ["command": bridge, "args": ["--server=maps"]],
        "apple-notes": npx,
        "cupertino-squatter": npx,
        "other": ["command": "uvx", "args": ["thing"], "env": ["TOKEN": "x"]],
      ],
      "projects": [
        "/Users/you/a": ["mcpServers": ["cupertino-mail": ["command": bridge]], "history": []]
      ],
    ]
    let before = root["mcpServers"] as? [String: Any] ?? [:]

    let out = ClientWiringMerge.unmerged(from: root, rootKey: "mcpServers")
    let servers = out["mcpServers"] as? [String: Any] ?? [:]

    check("our current entry is gone", servers["cupertino-mail"] == nil)
    check("our entry from a bundle that moved is gone too", servers["cupertino-notes"] == nil)
    check("our pre-rename key is gone", servers["apple-safari"] == nil)
    check("a leftover for a switched-off surface is gone", servers["cupertino-maps"] == nil)
    check(
      "a third-party server under one of OUR key names survives",
      deepEqual(servers["cupertino-squatter"], before["cupertino-squatter"]))
    check("their own servers survive byte-identical", deepEqual(servers["other"], before["other"]))
    check("and so does the one under our old prefix", deepEqual(servers["apple-notes"], npx))
    check("exactly four went", servers.count == before.count - 4)
    check("unrelated top-level keys survive", out["numStartups"] as? Int == 41)
    check("credentials survive", deepEqual(out["oauthAccount"], root["oauthAccount"]))
    check(
      "the project blocks are untouched — this is user scope only",
      deepEqual(out["projects"], root["projects"]))

    // The round trip the button promises.
    check(
      "afterwards the client audits as never configured",
      ClientWiringMerge.audit(
        servers: servers, expectedCommand: bridge, expected: expected, unexpected: []) == .notConfigured)
    check(
      "running it twice changes nothing the second time",
      deepEqual(ClientWiringMerge.unmerged(from: out, rootKey: "mcpServers"), out))

    let onlyOurs: [String: Any] = ["mcpServers": ["cupertino-mail": ["command": bridge]]]
    check(
      "emptying the object leaves it present and empty",
      (ClientWiringMerge.unmerged(from: onlyOurs, rootKey: "mcpServers")["mcpServers"]
        as? [String: Any])?.isEmpty == true)
    check(
      "a file with no root key comes back unchanged",
      deepEqual(
        ClientWiringMerge.unmerged(from: ["numStartups": 1], rootKey: "mcpServers"),
        ["numStartups": 1]))
    check(
      "and gains no empty one",
      ClientWiringMerge.unmerged(from: ["numStartups": 1], rootKey: "mcpServers")["mcpServers"]
        == nil)

    // The folder half, which nothing had until now.
    let folderOut = ClientWiringMerge.unmergedFromLocalScope(from: root, folder: "/Users/you/a")
    let folder =
      (folderOut["projects"] as? [String: Any])?["/Users/you/a"] as? [String: Any] ?? [:]
    check(
      "unwiring a folder empties its servers",
      (folder["mcpServers"] as? [String: Any])?.isEmpty == true)
    check("the folder's own keys survive", folder["history"] != nil)
    check(
      "and user scope is untouched", deepEqual(folderOut["mcpServers"], root["mcpServers"]))
  }
}
