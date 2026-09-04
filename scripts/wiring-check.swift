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
  // Generated, and asserted byte for byte by `make surfaces-check`. Outside the
  // marker so regenerating keeps it.
  // swift-format-ignore
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
    tomlScannerFindsEveryServer()
    tomlScannerIsNotFooledByProse()
    tomlValuesDegradeRatherThanLie()
    tomlNamesWhatItCannotParse()
    tomlRefusesShapesItCannotSplice()
    tomlSpliceLeavesEveryOtherByteAlone()
    tomlKeepsComments()
    tomlWireIsIdempotent()
    tomlInsertionPointAndBlankLines()
    tomlRendersOnlyOurOwnShape()
    tomlNeverRewritesAHandWrittenEntry()
    tomlDuplicateKeyIsImpossible()
    tomlBackupAtomicityAndMode()
    tomlStaleWriteIsRefused()

    // Any paths on the command line are real client configs, read and never
    // written. See `make wiring-check-real`.
    for argument in CommandLine.arguments.dropFirst() {
      let url = URL(fileURLWithPath: argument)
      if url.pathExtension == "toml" {
        realTOMLFileSurvives(url)
      } else {
        realFileSurvives(url)
      }
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

  // MARK: - The TOML client

  /// Shaped like the real `~/.codex/config.toml`: hand-written structure around
  /// the servers, a quoted-key table, and a multi-line string full of prose
  /// sitting exactly where it can do the most damage.
  static let codexConfig = """
    model = "gpt-5.6-sol"

    [features]
    multi_agent = true

    [projects."/Users/olivier/Projects/swift-r2"]
    trust_level = "trusted"

    [desktop]
    git-commit-instructions = \"\"\"
    ## Notes

    - Never write [mcp_servers.ghost] in a commit message
    - A # here is prose, not a comment
    \"\"\"

    # the servers Codex starts itself
    [mcp_servers.node_repl]
    args = []
    command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"
    startup_timeout_sec = 120

    [mcp_servers.node_repl.env]
    CODEX_HOME = "/Users/olivier/.codex"

    [mcp_servers.computer-use]
    command = "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"
    args = ["mcp"]
    enabled = false

    [shell_environment_policy.set]
    SHA = "9230e2bd"

    """

  static func scanned(_ text: String) -> ClientWiringTOML.Document? {
    try? ClientWiringTOML.scan(text)
  }

  /// A server's spans as 1-based inclusive line pairs, for readable checks.
  static func spans(_ document: ClientWiringTOML.Document, _ name: String) -> [[Int]] {
    (document.tables[name]?.ranges ?? []).map { [$0.lowerBound + 1, $0.upperBound] }
  }

  static func line(_ document: ClientWiringTOML.Document, _ index: Int) -> String {
    index < document.lines.count ? String(document.text[document.lines[index]]) : ""
  }

  static func names(_ document: ClientWiringTOML.Document?) -> [String] {
    (document?.tables.keys.map { $0 } ?? []).sorted()
  }

  static func tomlScannerFindsEveryServer() {
    print("\nFinding the servers in a TOML config")
    guard let doc = scanned(codexConfig) else { return check("the fixture scans", false) }

    check("both servers are found", names(doc) == ["computer-use", "node_repl"])
    check(
      "a quoted project table is not a server",
      doc.tables["/Users/olivier/Projects/swift-r2"] == nil)

    // Header through last-line-that-says-something, twice: the table and its
    // subtable, with the blank line between them belonging to neither.
    check("the spans are exactly the lines that hold it", spans(doc, "node_repl") == [[18, 21], [23, 24]])
    check(
      "a subtable extends its server rather than starting a new one",
      spans(doc, "node_repl").count == 2)
    check(
      "and the second span is that subtable",
      line(doc, doc.tables["node_repl"]?.ranges.last?.lowerBound ?? 0)
        .hasPrefix("[mcp_servers.node_repl.env]"))

    // A span ends at the last line that says something. The blank line under it
    // belongs to the table below, which is what stops an unwire eating somebody
    // else's separator.
    check(
      "a span stops before the blank line under it",
      line(doc, doc.tables["computer-use"]?.ranges.first?.upperBound ?? 0)
        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

    check("values are read", doc.tables["node_repl"]?.value["args"] as? [Any] != nil)
    check(
      "including the command a foreign entry is recognised by",
      (doc.tables["node_repl"]?.value["command"] as? String)?.hasSuffix("node_repl") == true)
    check(
      "a subtable's values land under it",
      ((doc.tables["node_repl"]?.value["env"] as? [String: Any])?["CODEX_HOME"] as? String)
        == "/Users/olivier/.codex")
    check("a hyphenated bare name is a name", doc.tables["computer-use"] != nil)
    check("enabled = false is read", doc.tables["computer-use"]?.isDisabled == true)
    check("and a server without it is not disabled", doc.tables["node_repl"]?.isDisabled == false)
    check("the disabled set names it", doc.disabled == ["computer-use"])

    // Where new blocks land: past the last server, before the blank line that
    // separates it from the next table.
    check(
      "the anchor is just past the last server span",
      doc.anchor == (doc.tables["computer-use"]?.ranges.first?.upperBound ?? -1))

    let quoted = scanned("[mcp_servers.\"my server\"]\nurl = \"http://x/\"\n")
    check("a quoted table name is unquoted", quoted?.tables["my server"] != nil)

    let parent = scanned(
      "[mcp_servers]\nfoo = { command = \"/bin/foo\" }\nbar = { url = \"http://y/\" }\n")
    check("a bare [mcp_servers] table names its keys as servers", names(parent) == ["bar", "foo"])
    check("and parses them", (parent?.tables["foo"]?.value["command"] as? String) == "/bin/foo")
    check("each inline entry owns exactly its own line", parent?.tables["bar"]?.ranges == [2..<3])

    check("a file with no servers has none", scanned("model = \"x\"\n")?.tables.isEmpty == true)
    check("and anchors at the end of it", scanned("model = \"x\"\n")?.anchor == 1)
    check("an empty file scans", scanned("")?.tables.isEmpty == true)
  }

  /// The failure a line-oriented scanner walks into, stated as a check.
  ///
  /// The real config keeps a multi-line string of markdown directly above its
  /// first server. Prose is allowed to contain a bracket at column 0, a hash,
  /// and the words of a table header; none of it is TOML.
  static func tomlScannerIsNotFooledByProse() {
    print("\nProse in a TOML config is not TOML")
    guard let doc = scanned(codexConfig) else { return check("the fixture scans", false) }

    check("a table header inside a string mints no server", doc.tables["ghost"] == nil)
    check("exactly two servers, not three", doc.tables.count == 2)
    check(
      "and the real header after the string is found at its own line",
      line(doc, doc.tables["node_repl"]?.ranges.first?.lowerBound ?? 0)
        .hasPrefix("[mcp_servers.node_repl]"))

    let literal = scanned(
      "a = '''\n[mcp_servers.ghost]\n# not a comment\n'''\n"
        + "[mcp_servers.real]\nurl = \"http://z/\"\n")
    check("a literal multi-line string is opaque too", names(literal) == ["real"])

    check(
      "a hash inside a literal string does not start a comment",
      (scanned("[mcp_servers.a]\ncommand = '/bin/x#y'\n")?.tables["a"]?.value["command"]
        as? String) == "/bin/x#y")
    check(
      "an escaped quote does not end a basic string",
      (scanned("[mcp_servers.a]\ncommand = \"/bin/\\\"x\"\n")?.tables["a"]?.value["command"]
        as? String) == "/bin/\"x")
    check(
      "a comment naming a table is still a comment",
      scanned("# [mcp_servers.ghost]\nmodel = \"x\"\n")?.tables.isEmpty == true)
    check(
      "a dot inside a quoted key is not a path separator",
      scanned("[mcp_servers.\"a.b\"]\nurl = \"http://q/\"\n")?.tables["a.b"] != nil)
  }

  /// Values are best effort, and best effort means omitting rather than
  /// guessing. Nothing omitted here could have been a `command` or a `url`, so
  /// nothing downstream is poorer for it.
  static func tomlValuesDegradeRatherThanLie() {
    print("\nA value this cannot type is omitted, not guessed")
    let text = """
      [mcp_servers.a]
      command = "/bin/a"
      when = 1979-05-27T07:32:00Z
      ratio = 0.5
      big = 1_000
      nested = [[1, 2], [3]]
      spread = [
        "one",
      ]
      after = "still read"

      """
    guard let doc = scanned(text), let table = doc.tables["a"] else {
      return check("it scans", false)
    }
    check("the command is right", (table.value["command"] as? String) == "/bin/a")
    check("a datetime is omitted", table.value["when"] == nil)
    check("a float is omitted", table.value["ratio"] == nil)
    check("an underscored integer is omitted", table.value["big"] == nil)
    check("a nested array is read", (table.value["nested"] as? [Any])?.count == 2)
    check("a multi-line array is omitted", table.value["spread"] == nil)
    check("and the key after it is still read", (table.value["after"] as? String) == "still read")
    check("the span covers all of it, continuation lines included", spans(doc, "a") == [[1, 10]])
    check(
      "a plain integer is read",
      (scanned("[mcp_servers.a]\nn = 12\n")?.tables["a"]?.value["n"] as? Int) == 12)
  }

  /// The invariant, from both ends.
  ///
  /// A server this can see but not describe must still be NAMED, because the
  /// name is what `collisions` refuses on. Dropping it would let a wire append a
  /// second `[mcp_servers.<name>]`, and a duplicate key does not cost one entry
  /// — it costs the whole file.
  static func tomlNamesWhatItCannotParse() {
    print("\nA server this cannot describe is still a server")
    let text = """
      [mcp_servers.cupertino-notes]
      when = 1979-05-27T07:32:00Z
      ratio = 0.5

      [mcp_servers.opaque]

      [mcp_servers.inline]
      command = { not = "a string" }

      """
    guard let doc = scanned(text) else { return check("it scans", false) }
    check("all three are named", names(doc) == ["cupertino-notes", "inline", "opaque"])
    check("even with nothing typed under it", doc.tables["cupertino-notes"]?.value.isEmpty == true)
    check("even with nothing under it at all", doc.tables["opaque"]?.value.isEmpty == true)

    // The consequence, which is the whole reason for the invariant.
    let servers = doc.servers
    check(
      "so none of them reads as ours",
      servers.allSatisfy { !ClientWiringMerge.isOurs($0.value) })
    check(
      "and a key we would write is refused rather than duplicated",
      ClientWiringMerge.collisions(servers: servers, keys: ["cupertino-notes", "keycloak"]) == ["cupertino-notes"])
    check(
      "an entry whose command is not a string names no identity",
      ClientWiringMerge.identity(of: doc.tables["inline"]?.value) == nil)
    check(
      "and is listed as foreign anyway",
      ClientWiringMerge.foreignEntries(in: servers).map { $0.key }
        == ["cupertino-notes", "inline", "opaque"])
  }

  /// What it refuses, and why a refusal is enough: every write path begins with
  /// a read, so a scan that throws is a client that cannot be written to.
  static func tomlRefusesShapesItCannotSplice() {
    print("\nShapes this refuses rather than guesses at")
    func refuses(_ label: String, _ text: String) {
      var threw = false
      do { _ = try ClientWiringTOML.scan(text) } catch { threw = true }
      check(label, threw)
    }

    refuses("a dotted key under [mcp_servers]", "[mcp_servers]\nfoo.command = \"/bin/foo\"\n")
    refuses("an array of tables", "[[mcp_servers.foo]]\ncommand = \"/bin/foo\"\n")
    refuses("an unterminated multi-line string", "a = \"\"\"\nnever closed\n")
    refuses("an unterminated single-line string", "[mcp_servers.a]\ncommand = \"/bin/a\n")
    refuses("an unclosed table header", "[mcp_servers.a\n")
    refuses("trailing junk after a header", "[mcp_servers.a] oops\n")
    refuses("a key with no value", "[mcp_servers.a]\ncommand\n")
    refuses("an unclosed inline table", "[mcp_servers]\nfoo = { command = \"/bin/foo\"\n")

    check(
      "non-UTF-8 bytes are refused by name",
      {
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("cupertino-check-\(UUID().uuidString).toml")
        try? Data([0xFF, 0xFE, 0x00]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        do {
          _ = try ClientWiringTOML.read(url)
          return false
        } catch {
          return true
        }
      }())

    check(
      "a refusal names the line, because the remedy is a person looking at it",
      {
        do {
          _ = try ClientWiringTOML.scan("model = \"x\"\n[mcp_servers]\nfoo.bar = 1\n")
          return false
        } catch {
          return error.localizedDescription.contains("line 3")
        }
      }())
  }

  /// What Cupertino writes into a TOML config, in the shape Codex reads.
  ///
  /// No `type` key: Codex has none, a `url` implies streamable HTTP, and
  /// `http_headers` takes a literal — which is the fact that makes wiring it
  /// possible at all, since `bearer_token_env_var` names an environment
  /// variable Cupertino has no way to set.
  /// What Cupertino would write, which is where this port diverges from the one
  /// it came from: Cupertino hands Codex a loopback `url` and a bearer header, and
  /// this hands it the same stdio `command` and `args` every other client gets.
  /// Neither `ClientWiringTOML` nor `ClientWiringMerge` can tell, which is the
  /// property the port rests on — so these assertions are about the splicer and
  /// not about the shape being spliced.
  static func tomlEntry(_ id: String) -> [String: Any] {
    ["command": bridge, "args": ["--server=\(id)"]]
  }

  static func tomlEntries(_ ids: [String] = ["mail", "notes"]) -> [String: [String: Any]] {
    Dictionary(uniqueKeysWithValues: ids.map { ("cupertino-\($0)", tomlEntry($0)) })
  }

  static func wire(_ text: String, _ ids: [String] = ["mail", "notes"]) -> String? {
    guard let doc = scanned(text) else { return nil }
    return ClientWiringTOML.spliced(doc, removing: [], upserting: tomlEntries(ids))
  }

  static func unwire(_ text: String, _ ids: [String] = ["mail", "notes"]) -> String? {
    unwireRaw(text, ids.map { "cupertino-\($0)" })
  }

  /// Removing a key by the name the file actually files it under, for the
  /// entries somebody else wrote. `unwire` takes surface ids and adds the
  /// prefix; this takes names and adds nothing.
  static func unwireRaw(_ text: String, _ names: [String]) -> String? {
    guard let doc = scanned(text) else { return nil }
    return ClientWiringTOML.spliced(doc, removing: Set(names), upserting: [:])
  }

  /// The headline claim: a wire adds lines and changes none.
  static func tomlSpliceLeavesEveryOtherByteAlone() {
    print("\nA TOML splice leaves every other byte alone")
    guard let wired = wire(codexConfig) else { return check("it wires", false) }

    // Stated as a subtraction rather than a comparison of parsed values: take
    // our blocks back out and the file must be what it was, to the byte.
    check("taking our blocks back out gives the original", unwire(wired) == codexConfig)
    check("it is strictly longer", wired.count > codexConfig.count)
    check(
      "and every original line is still in it, in order",
      {
        var rest = Substring(wired)
        for line in codexConfig.split(separator: "\n") where !line.isEmpty {
          guard let found = rest.range(of: line) else { return false }
          rest = rest[found.upperBound...]
        }
        return true
      }())

    // Line endings and whitespace on lines nobody touched.
    let crlf = "model = \"x\"\r\n\r\n[mcp_servers.a]\r\nurl = \"http://a/\"\r\n\r\n[other]\r\nk = 1\r\n"
    guard let wiredCRLF = wire(crlf) else { return check("CRLF wires", false) }
    check("a CRLF file stays CRLF", !wiredCRLF.contains("\n\n") || wiredCRLF.contains("\r\n\r\n"))
    check("our own blocks use its line ending", wiredCRLF.contains("[mcp_servers.cupertino-mail]\r\n"))
    check("and it round-trips", unwire(wiredCRLF) == crlf)

    let ragged = "\u{FEFF}model\t=  \"x\"   \n\n[mcp_servers.a]\nurl = \"http://a/\"\n"
    guard let wiredRagged = wire(ragged) else { return check("a ragged file wires", false) }
    check("a byte-order mark survives", wiredRagged.hasPrefix("\u{FEFF}"))
    check("tabs and alignment inside a line survive", wiredRagged.contains("model\t=  \"x\"   \n"))
    check("and it round-trips", unwire(wiredRagged) == ragged)
  }

  /// Comments are the thing a serialiser would have eaten, so they get their
  /// own section.
  static func tomlKeepsComments() {
    print("\nComments in a TOML config survive both directions")
    let text = """
      # the top of somebody's file
      model = "x"

      # above the servers
      [mcp_servers.node_repl]
      # inside the block
      command = "/bin/node"  # and trailing

      # this one belongs to the table below, not the one above
      [other]
      k = 1

      """
    guard let wired = wire(text), let back = unwire(wired) else {
      return check("it wires", false)
    }
    for comment in [
      "# the top of somebody's file", "# above the servers", "# inside the block",
      "# and trailing", "# this one belongs to the table below",
    ] {
      check("kept through a wire: \(comment)", wired.contains(comment))
    }
    check("and an unwire gives the file back exactly", back == text)

    // The span rule that makes the last one work: a block ends at its last
    // meaningful line, so the comment under it is the next table's.
    let removed = unwireRaw(wired, ["node_repl"])
    check(
      "removing a foreign entry leaves the comment below it",
      removed?.contains("# this one belongs to the table below") == true)
    check("but takes the entry", removed?.contains("[mcp_servers.node_repl]") == false)
  }

  /// Writing the same thing twice must be a no-op, and writing then removing
  /// must be a round trip. Both are about blank lines, which is why they are
  /// checked to the byte rather than by parsing.
  static func tomlWireIsIdempotent() {
    print("\nWiring a TOML config twice changes nothing the second time")
    for (label, text) in [
      ("the realistic file", codexConfig),
      ("no servers at all", "model = \"x\"\n"),
      ("an empty file", ""),
      ("a trailing blank line", "[other]\nk = 1\n\n"),
      ("servers last in the file", "[other]\nk = 1\n\n[mcp_servers.a]\nurl = \"http://a/\"\n"),
      ("no blank line before the next table", "[mcp_servers.a]\nurl = \"http://a/\"\n[other]\nk = 1\n"),
    ] {
      guard let once = wire(text), let twice = wire(once) else {
        check("\(label): it wires", false)
        continue
      }
      check("\(label): wiring twice is the same file", once == twice)
      check("\(label): wire then unwire is the original", unwire(once) == text)
      check(
        "\(label): ten rounds accumulate nothing",
        {
          var current = text
          for _ in 0..<10 {
            guard let up = wire(current), let down = unwire(up) else { return false }
            current = down
          }
          return current == text
        }())
    }

    check(
      "unwiring a file that holds none of ours writes nothing new",
      unwire(codexConfig) == codexConfig)

    // The one case that cannot round-trip exactly, stated rather than glossed:
    // a file with no final newline has to gain one before anything can be
    // appended, and an unwire has no way to know that newline was ours.
    check(
      "a file with no final newline comes back with one, and nothing else added",
      unwire(wire("model = \"x\"") ?? "") == "model = \"x\"\n")
  }

  static func tomlInsertionPointAndBlankLines() {
    print("\nWhere a TOML block lands, and the blank lines around it")

    // Grouped with the servers already there, not appended past unrelated
    // tables -- which is also what makes a second wire land in the same place.
    guard let wired = wire(codexConfig) else { return check("it wires", false) }
    let lines = wired.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    let ours = lines.firstIndex(of: "[mcp_servers.cupertino-mail]") ?? -1
    let lastForeign = lines.firstIndex(of: "enabled = false") ?? -1
    let nextTable = lines.firstIndex(of: "[shell_environment_policy.set]") ?? -1
    check("our block goes after the servers already there", ours > lastForeign)
    check("and before the unrelated table below them", ours < nextTable)
    check("with exactly one blank line above it", lines[ours - 1].isEmpty && !lines[ours - 2].isEmpty)
    check(
      "and exactly one between two of our blocks",
      {
        guard let second = lines.firstIndex(of: "[mcp_servers.cupertino-notes]") else { return false }
        return lines[second - 1].isEmpty && !lines[second - 2].isEmpty
      }())

    check(
      "a file with no servers gets them at the end",
      wire("model = \"x\"\n")?.hasSuffix("[mcp_servers.cupertino-notes]\n"
        + "command = \"\(bridge)\"\n"
        + "args = [\"--server=notes\"]\n") == true)
    check(
      "an empty file gets them and nothing else",
      wire("")?.hasPrefix("[mcp_servers.cupertino-mail]\n") == true)
    check(
      "a file with no final newline gains exactly one",
      {
        guard let out = wire("model = \"x\"") else { return false }
        return out.hasPrefix("model = \"x\"\n\n[mcp_servers.") && out.hasSuffix("]\n")
      }())
    // The block brings its own blank line even when one is already there. The
    // cost is a second blank line in that one case; the gain is that an unwire
    // gives back the blank line the user wrote instead of eating it.
    check(
      "a block always brings its own blank line",
      wire("model = \"x\"\n\n")?.contains("model = \"x\"\n\n\n[mcp_servers.") == true)
    check(
      "which the unwire takes back, leaving theirs",
      unwire(wire("model = \"x\"\n\n") ?? "") == "model = \"x\"\n\n")
  }

  /// Rendering is only ever pointed at Cupertino's own shape, so this checks that
  /// shape and the escaping it has to survive.
  static func tomlRendersOnlyOurOwnShape() {
    print("\nWhat a rendered TOML block says")
    let block = ClientWiringTOML.render(
      name: "cupertino-notes", entry: tomlEntry("notes"), newline: "\n")
    check("it is a table header for the server", block.hasPrefix("[mcp_servers.cupertino-notes]\n"))
    check("the command comes first, because that is what a reader wants", {
      let lines = block.split(separator: "\n")
      return lines.count > 1 && lines[1].hasPrefix("command = ")
    }())
    check("the args are an array, not a string", block.contains("args = [\"--server="))
    check("and there is no type key, because Codex has none", !block.contains("type"))
    // The sentence the pane makes about every client, checked against the one
    // format that could most easily break it.
    check("no token, no credential, no env block", !block.contains("env") && !block.contains("Bearer"))

    // Re-reading our own output is the only round trip that has to hold.
    let doc = scanned(block)
    check("it re-scans to one server", names(doc) == ["cupertino-notes"])
    check(
      "with the command it was given",
      (doc?.tables["cupertino-notes"]?.value["command"] as? String) == bridge)
    check(
      "and the args it was given, as an array rather than a string",
      (doc?.tables["cupertino-notes"]?.value["args"] as? [Any])?.first as? String
        == "--server=notes")
    check("which reads as ours", ClientWiringMerge.isOurs(doc?.tables["cupertino-notes"]?.value))
    check(
      "and audits as configured, through a policy layer that never learns it is TOML",
      ClientWiringMerge.state(
        of: doc?.servers ?? [:], key: "cupertino-notes", expectedCommand: bridge) == .matches)

    // A token is a secret Cupertino did not choose the alphabet of.
    let hostile = "a\"b\\c\nd\te"
    let escaped = ClientWiringTOML.render(
      name: "a", entry: ["url": "http://x/", "http_headers": ["Authorization": hostile]],
      newline: "\n")
    check(
      "a token holding a quote, a backslash and a newline round-trips",
      ((scanned(escaped)?.tables["a"]?.value["http_headers"] as? [String: Any])?["Authorization"]
        as? String) == hostile)

    let odd = ClientWiringTOML.render(name: "my server", entry: ["url": "http://x/"], newline: "\n")
    check("a name needing quotes is quoted", odd.hasPrefix("[mcp_servers.\"my server\"]"))
    check("and comes back unquoted", scanned(odd)?.tables["my server"] != nil)
  }

  static func tomlNeverRewritesAHandWrittenEntry() {
    print("\nA hand-written TOML entry is never re-rendered")
    guard let doc = scanned(codexConfig) else { return check("it scans", false) }
    // One contiguous run of its lines: the table's own span. Its subtable is a
    // second span with a blank line between, checked separately below.
    let foreign = (doc.tables["node_repl"]?.ranges.first.map { $0.map { line(doc, $0) }.joined() })
      ?? ""
    check("there is something to preserve", foreign.contains("startup_timeout_sec = 120"))

    for (label, output) in [
      ("a wire", wire(codexConfig)),
      ("an unwire of ours", unwire(wire(codexConfig) ?? "")),
      ("removing a different entry", unwire(codexConfig, ["computer-use"])),
    ] {
      check("\(label) leaves it byte-identical", output?.contains(foreign) == true)
      check(
        "\(label) leaves its subtable alone too",
        output?.contains("[mcp_servers.node_repl.env]\nCODEX_HOME = \"/Users/olivier/.codex\"")
          == true)
    }

    // Removing it takes both its spans -- the table and its subtable -- and
    // nothing else.
    guard let removed = unwireRaw(codexConfig, ["node_repl"]) else {
      return check("it removes", false)
    }
    check("the table is gone", !removed.contains("[mcp_servers.node_repl]"))
    check("its subtable went with it", !removed.contains("[mcp_servers.node_repl.env]"))
    check("and its values with that", !removed.contains("CODEX_HOME"))
    check("the other server is untouched", removed.contains("[mcp_servers.computer-use]"))
    check("and so is everything that is not a server", removed.contains("[shell_environment_policy.set]"))
    check("including the prose above them", removed.contains("- A # here is prose, not a comment"))
  }

  /// The TOML-specific catastrophe, checked over every fixture: a name written
  /// twice is not a lost entry, it is a file Codex cannot parse at all.
  static func tomlDuplicateKeyIsImpossible() {
    print("\nA splice can never write a name twice")
    let fixtures = [
      "the realistic file": codexConfig,
      "an empty file": "",
      "no servers": "model = \"x\"\n",
      "a parent table": "[mcp_servers]\nshopify = { command = \"/bin/theirs\" }\n",
      "one of ours already there":
        "[mcp_servers.cupertino-mail]\ncommand = \"\(bridge)\"\n",
      "one of ours from a bundle that moved":
        "[mcp_servers.cupertino-mail]\ncommand = \"\(moved)\"\n",
    ]
    for (label, text) in fixtures.sorted(by: { $0.key < $1.key }) {
      guard let doc = scanned(text) else {
        check("\(label): it scans", false)
        continue
      }
      // Write over everything, including a key somebody else owns -- the shape
      // `force` produces, and the one most able to duplicate a name.
      let out = ClientWiringTOML.spliced(doc, removing: [], upserting: tomlEntries())
      guard let rescanned = scanned(out) else {
        check("\(label): the result still scans", false)
        continue
      }
      check("\(label): the result still scans", true)
      var headers = 0
      for raw in out.split(separator: "\n", omittingEmptySubsequences: false)
      where raw.hasPrefix("[mcp_servers.cupertino-mail]") {
        headers += 1
      }
      check("\(label): the name appears as a header exactly once", headers == 1)
      check(
        "\(label): and the rescan agrees it is one server",
        rescanned.tables["cupertino-mail"]?.ranges.count == 1)
      check(
        "\(label): pointing where we put it",
        (rescanned.tables["cupertino-mail"]?.value["command"] as? String) == bridge)
    }
  }

  /// The byte overload, through the same properties `backupAndNoLitter` asserts
  /// for the JSON one -- because a TOML write goes through it too, and "the
  /// backup is recoverable" is not a claim worth holding on one format only.
  static func tomlBackupAtomicityAndMode() {
    print("\nWriting a TOML config")
    let fm = FileManager.default
    let directory = fm.temporaryDirectory
      .appendingPathComponent("cupertino-toml-\(UUID().uuidString)")
    try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: directory) }

    let config = directory.appendingPathComponent("config.toml")
    try? codexConfig.write(to: config, atomically: true, encoding: .utf8)

    guard let document = try? ClientWiringTOML.read(config) else {
      return check("the fixture reads back", false)
    }
    let text = ClientWiringTOML.spliced(document, removing: [], upserting: tomlEntries())
    let backup = try? ClientWiringMerge.write(
      Data(text.utf8), to: config, backupSuffix: "cupertino-backup")

    check("a backup was made", backup != nil)
    check(
      "the backup holds the original bytes",
      (try? String(contentsOf: backup!, encoding: .utf8)) == codexConfig)
    check(
      "the config on disk is the spliced text, to the byte",
      (try? String(contentsOf: config, encoding: .utf8)) == text)
    check(
      "and it reads back with our entries in it",
      names(try? ClientWiringTOML.read(config))
        == ["computer-use", "cupertino-mail", "cupertino-notes", "node_repl"])

    let mode = (try? fm.attributesOfItem(atPath: config.path))?[.posixPermissions] as? NSNumber
    // Not 0600. The JSON path and this one share `write`, and it applies
    // `newFileMode` only to a file it creates — replacing an existing config
    // keeps whatever mode its owner gave it. Codex's is 0644 on the machine this
    // was ported against, and tightening somebody's file under them is not a
    // splice's business. Section 13 asserts the other half of the same rule.
    check("an existing config keeps its own mode", mode?.intValue == 0o644)

    let left = (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
    check("no .tmp left behind", !left.contains { $0.hasSuffix(".tmp") })
    check("exactly config + backup", left.count == 2)

    // A `~/.codex` that does not exist yet is the ordinary first-run case.
    let fresh = directory.appendingPathComponent("nested/.codex/config.toml")
    let blocks = ClientWiringTOML.spliced(
      ClientWiringTOML.empty, removing: [], upserting: tomlEntries())
    let none = try? ClientWiringMerge.write(
      Data(blocks.utf8), to: fresh, backupSuffix: "cupertino-backup")
    check("no backup for a file that did not exist", none == nil)
    check("parent directories created", fm.fileExists(atPath: fresh.path))
    check("and the new file is exactly our blocks", names(try? ClientWiringTOML.read(fresh)) == ["cupertino-mail", "cupertino-notes"])
  }

  /// The `wiring-check-real` half for a TOML config.
  ///
  /// Read-only: scanned, spliced in memory and compared. Fixtures only cover
  /// the shapes somebody thought of, and a config.toml that has been lived in
  /// holds the ones nobody would have invented.
  static func realTOMLFileSurvives(_ url: URL) {
    print("\n\(url.path)")
    let document: ClientWiringTOML.Document
    do {
      document = try ClientWiringTOML.read(url)
    } catch {
      return check("it scans (\(error.localizedDescription))", false)
    }
    check("it scans, \(document.lines.count) lines", true)

    let ours = Set(document.tables.filter { ClientWiringMerge.isOurs($0.value.value) }.keys)
    let theirs = document.tables.keys.filter { !ours.contains($0) }.sorted()
    check(
      "\(document.tables.count) servers found, \(theirs.count) of them not ours", true)

    let written = tomlEntries()
    let out = ClientWiringTOML.spliced(document, removing: [], upserting: written)

    // The claim, against a file nobody wrote for a test.
    check(
      "taking our blocks back out gives the file back, to the byte",
      ClientWiringTOML.spliced(
        try! ClientWiringTOML.scan(out), removing: Set(written.keys), upserting: [:])
        == document.text)
    check(
      "wiring it twice changes nothing the second time",
      ClientWiringTOML.spliced(
        try! ClientWiringTOML.scan(out), removing: [], upserting: written) == out)

    let rescanned = try? ClientWiringTOML.scan(out)
    check("the result still scans", rescanned != nil)
    check(
      "every server it held is still there",
      theirs.allSatisfy { rescanned?.tables[$0] != nil })
    check(
      "and says exactly what it said",
      theirs.allSatisfy { deepEqual(document.tables[$0]?.value, rescanned?.tables[$0]?.value) })
    check(
      "no name was written twice",
      rescanned?.tables.values.allSatisfy { $0.ranges.count <= 2 } == true)
    check("our entries were added", written.keys.allSatisfy { rescanned?.tables[$0] != nil })
    check(
      "and read back as ours",
      written.keys.allSatisfy { ClientWiringMerge.isOurs(rescanned?.tables[$0]?.value) })
  }

  /// A merge computed from bytes that have since changed is refused.
  ///
  /// The property `ClientWiring.retryingIfChanged` rests on. It does not close
  /// the race — a process holding its own copy of the whole file still wins —
  /// but it does mean a merge is never landed on top of a change that arrived
  /// while the file was being read. Which matters more here than it would for a
  /// config full of commands: these entries carry a bearer token, so a lost
  /// write leaves a client that reaches the endpoint and fails to authenticate.
  static func tomlStaleWriteIsRefused() {
    print("\nRefusing a stale TOML write")
    let fm = FileManager.default
    let directory = fm.temporaryDirectory
      .appendingPathComponent("cupertino-toml-stale-\(UUID().uuidString)")
    try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: directory) }

    let config = directory.appendingPathComponent("config.toml")
    try? codexConfig.write(to: config, atomically: true, encoding: .utf8)

    let before = ClientWiringMerge.stamp(of: config)
    guard let document = try? ClientWiringTOML.read(config) else {
      return check("the fixture reads back", false)
    }
    let text = ClientWiringTOML.spliced(document, removing: [], upserting: tomlEntries())

    // The ChatGPT app rewrites the file while the splice is being computed.
    let theirs = codexConfig + "\n[mcp_servers.something_new]\ncommand = \"npx\"\n"
    try? theirs.write(to: config, atomically: true, encoding: .utf8)

    var refused = false
    do {
      _ = try ClientWiringMerge.write(
        Data(text.utf8), to: config, backupSuffix: "cupertino-backup", expecting: before)
    } catch ClientWiringMerge.WriteError.changedUnderneath(_) {
      refused = true
    } catch {
    }
    check("a changed config.toml is refused", refused)
    check(
      "their table survived, to the byte",
      (try? String(contentsOf: config, encoding: .utf8)) == theirs)
    check(
      "and the splice that would have dropped it never landed",
      names(try? ClientWiringTOML.read(config)) == [
        "computer-use", "node_repl", "something_new",
      ])
  }
}
