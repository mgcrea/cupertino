import Foundation

/// Tokens in memory: a check that reached the login Keychain would leave items
/// behind in the real one.
final class MemoryTokenVault: TokenVault, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: String] = [:]

  /// Which clients hold a token, for "nothing was minted" checks.
  var holders: Set<String> { lock.withLock { Set(items.keys) } }

  func read(_ client: String) throws -> String? { lock.withLock { items[client] } }
  func write(_ client: String, _ token: String) throws { lock.withLock { items[client] = token } }
  func delete(_ client: String) throws { _ = lock.withLock { items.removeValue(forKey: client) } }
  func all() throws -> [String: String] { lock.withLock { items } }
}

/// Wiring a client over HTTP, through `ClientWiring` itself.
///
/// Everything above this drives `ClientWiringMerge` with fixtures; these drive
/// the policy on top of it — which client gets which transport, when a token is
/// written and when it is revoked — against config files in a scratch home.
extension WiringCheck {
  static let scratchHome = FileManager.default.temporaryDirectory
    .appendingPathComponent("wiring-check-home-\(UUID().uuidString)")
  static let vault = MemoryTokenVault()
  nonisolated(unsafe) static var port = 8830

  /// Points every path `ClientWiring` writes at the scratch home, and its
  /// tokens at memory, before anything reads them. Refuses to go on if any
  /// client's config still resolves outside the scratch home.
  static func isolateClientWiring() {
    ClientWiring.home = scratchHome
    ClientWiring.tokens = HTTPTokens(vault: vault)
    ClientWiring.httpPort = { port }
    let paths = ClientWiring.clients.map(\.wiring.path) + [ClientWiring.claudeCodeConfig]
    guard paths.allSatisfy({ $0.path.hasPrefix(scratchHome.path + "/") }) else {
      print("FAIL a client config resolves outside \(scratchHome.path); stopping before any write")
      exit(1)
    }
  }

  static func client(_ id: String) -> ClientWiring.Client {
    ClientWiring.clients.first { $0.id == id }!
  }

  /// A clean slate: no config, no token, no login item, every surface on.
  static func reset() {
    try? FileManager.default.removeItem(at: scratchHome)
    try? FileManager.default.createDirectory(at: scratchHome, withIntermediateDirectories: true)
    for holder in vault.holders { try? vault.delete(holder) }
    ClientWiring.tokens = HTTPTokens(vault: vault)
    port = 8830
    SurfaceSettings.off = []
    LoginItem.isEnabled = false
    LoginItem.requests = []
    LoginItem.failure = nil
    InstallLocation.current = .applications(URL(fileURLWithPath: "/Applications/Cupertino.app"))
    loggedLines = []
  }

  static func mode(_ url: URL) -> Int? {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)??
      .intValue
  }

  static func place(_ text: String, at url: URL, mode: Int = 0o644) {
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? text.write(to: url, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
  }

  static func servers(of client: ClientWiring.Client) -> [String: Any] {
    (try? ClientWiring.read(client))??.servers ?? [:]
  }

  static func token(_ id: String) -> String { (try? ClientWiring.tokens.token(for: id)) ?? "" }

  static func url(_ surface: String, port: Int = 8830) -> String {
    "http://127.0.0.1:\(port)/s/\(surface)"
  }

  /// Whether every surface switched on is an HTTP entry at `port` carrying
  /// `token`, in the JSON shape or Codex's.
  static func allHTTP(_ servers: [String: Any], token: String, port: Int = 8830) -> Bool {
    SurfaceSettings.enabledSurfaces.allSatisfy { surface in
      guard let entry = servers["cupertino-\(surface.id)"] as? [String: Any] else { return false }
      let headers = (entry["headers"] ?? entry["http_headers"]) as? [String: Any]
      return entry["command"] == nil && entry["url"] as? String == url(surface.id, port: port)
        && headers?["Authorization"] as? String == "Bearer \(token)"
    }
  }

  static func allBridge(_ servers: [String: Any]) -> Bool {
    SurfaceSettings.enabledSurfaces.allSatisfy { surface in
      let entry = servers["cupertino-\(surface.id)"] as? [String: Any]
      return entry?["command"] as? String == ClientWiring.bridgePath && entry?["url"] == nil
    }
  }

  /// Bridge entries for every surface switched on, as an older Cupertino wrote
  /// them, under `rootKey` beside somebody else's server.
  static func bridgeConfig(rootKey: String = "mcpServers", leaving: Set<String> = []) -> String {
    var servers: [String: Any] = ["other": npx]
    for surface in SurfaceSettings.enabledSurfaces where !leaving.contains(surface.id) {
      servers["cupertino-\(surface.id)"] = ClientWiring.entry(for: surface, client: "x")
    }
    let data = try! JSONSerialization.data(
      withJSONObject: [rootKey: servers], options: [.sortedKeys, .withoutEscapingSlashes])
    return String(decoding: data, as: UTF8.self)
  }

  /// The lines `new` adds to `original`, when that is all it does: one
  /// contiguous run, nothing removed or changed. Nil otherwise.
  static func oneAddedHunk(_ original: String, _ new: String) -> [Substring]? {
    let a = original.split(separator: "\n", omittingEmptySubsequences: false)
    let b = new.split(separator: "\n", omittingEmptySubsequences: false)
    var prefix = 0
    while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < a.count - prefix, suffix < b.count - prefix,
      a[a.count - 1 - suffix] == b[b.count - 1 - suffix]
    {
      suffix += 1
    }
    guard prefix + suffix == a.count, b.count > a.count else { return nil }
    return Array(b[prefix..<(b.count - suffix)])
  }

  static func httpChecks() {
    isolateClientWiring()
    defer { try? FileManager.default.removeItem(at: scratchHome) }
    httpClientIsWiredOverHTTP()
    bridgeEntriesOnAnHTTPClientAreOldTransport()
    bridgeClientStaysBridge()
    codexIsWiredWithOneAddedHunk()
    portChangeIsStale()
    tokenChangeIsStale()
    unwireRevokes()
    projectScopeNeverGetsAToken()
    localScopeIsHTTP()
    autoRewireNeverSwitches()
    isOursClaimsOnlyOurs()
  }

  // MARK: - HTTP wiring

  static func httpClientIsWiredOverHTTP() {
    print("\nhttp client wired over http")
    reset()
    let claude = client("claude-code")
    let config = ClientWiring.claudeCodeConfig
    place(#"{"numStartups": 41, "mcpServers": {"other": {"command": "npx"}}}"#, at: config)

    let outcome = try? ClientWiring.switchToHTTP(claude)
    check("Switch to HTTP writes", outcome?.backup != nil)
    let written = servers(of: claude)
    check(
      "every surface switched on is type, url and headers",
      SurfaceSettings.enabledSurfaces.allSatisfy {
        (written["cupertino-\($0.id)"] as? [String: Any])?["type"] as? String == "http"
      } && allHTTP(written, token: token("claude-code")))
    check("somebody else's server survives", written["other"] != nil)
    check(
      "the rest of the file survives",
      (try? ClientWiringMerge.readJSON(config))?["numStartups"] as? Int == 41)
    check("the file is mode 0600, though it was 0644", mode(config) == 0o600)
    check(
      "and so is its backup, which a later write fills with a token",
      mode(config.appendingPathExtension("cupertino-backup")) == 0o600)
    check("it reads back as configured", ClientWiring.status(of: claude) == .configured)
    check("it turned on launch at login", LoginItem.requests == [true])

    // VS Code keeps its servers under `servers`, and takes the same shape.
    let vscode = client("vscode")
    _ = try? ClientWiring.switchToHTTP(vscode)
    check(
      "VS Code gets the same shape under servers",
      allHTTP(servers(of: vscode), token: token("vscode")))
    check("with a token of its own", token("vscode") != token("claude-code"))
    check(
      "a fresh config it created is 0600 too", mode(vscode.wiring.path) == 0o600)

    // A client nobody wired gets HTTP from Configure as well: there is nothing
    // to migrate, so nothing is switched behind anybody's back.
    let cursor = client("cursor")
    _ = try? ClientWiring.configure(cursor)
    check(
      "Configure on a fresh HTTP client writes HTTP",
      allHTTP(servers(of: cursor), token: token("cursor")))

    // Launch at login is asked for, never required: a refusal is a log line.
    reset()
    LoginItem.failure = "Operation not permitted"
    let refused = try? ClientWiring.switchToHTTP(client("cursor"))
    check("a launch-at-login refusal does not fail the switch", refused != nil)
    check(
      "and is logged",
      loggedLines.contains { $0.hasPrefix("error:") && $0.contains("Operation not permitted") })

    reset()
    InstallLocation.current = .elsewhere(URL(fileURLWithPath: "/Users/x/Downloads/Cupertino.app"))
    _ = try? ClientWiring.switchToHTTP(client("cursor"))
    check("a copy outside Applications registers no login item", LoginItem.requests.isEmpty)
  }

  static func bridgeEntriesOnAnHTTPClientAreOldTransport() {
    print("\nbridge entries on an http client are oldTransport")
    reset()
    let cursor = client("cursor")
    place(bridgeConfig(), at: cursor.wiring.path)
    let status = ClientWiring.status(of: cursor)
    check("reads as oldTransport", status == .oldTransport)
    check(
      "with the brief's sentence",
      status.summary
        == "Wired the old way, with a bridge per server. Switch to HTTP to drop them.")
    check("reading it minted no token", vault.holders.isEmpty)

    // Wired for fewer surfaces than are on: still the old way first, since
    // Switch to HTTP finishes both.
    reset()
    place(bridgeConfig(leaving: ["maps"]), at: cursor.wiring.path)
    check(
      "an incomplete bridge config is oldTransport too",
      ClientWiring.status(of: cursor) == .oldTransport)

    _ = try? ClientWiring.switchToHTTP(cursor)
    let switched = servers(of: cursor)
    check("Switch to HTTP rewrites it", allHTTP(switched, token: token("cursor")))
    check(
      "no bridge entry is left",
      !switched.values.contains {
        ($0 as? [String: Any])?["command"] as? String == ClientWiring.bridgePath
      })
    check("and it is configured", ClientWiring.status(of: cursor) == .configured)
  }

  static func bridgeClientStaysBridge() {
    print("\nbridge client stays bridge")
    reset()
    let desktop = client("claude-desktop")
    _ = try? ClientWiring.configure(desktop)
    let written = servers(of: desktop)
    check("Claude Desktop is written with command", allBridge(written))
    check("and reads as configured", ClientWiring.status(of: desktop) == .configured)
    check("no token minted for it", vault.holders.isEmpty)
    check("no login item asked for", LoginItem.requests.isEmpty)
    check(
      "Switch to HTTP refuses a bridge-only client",
      (try? ClientWiring.switchToHTTP(desktop)) == nil && allBridge(servers(of: desktop)))
    for id in ["lm-studio", "windsurf"] {
      check("\(id) stays on the bridge", client(id).transport == .bridge)
    }
    for id in ["claude-code", "vscode", "cursor", "codex"] {
      check("\(id) is an HTTP client", client(id).transport == .http)
    }
  }

  static func codexIsWiredWithOneAddedHunk() {
    print("\ncodex toml")
    reset()
    let codex = client("codex")
    place(codexConfig, at: codex.wiring.path)
    _ = try? ClientWiring.switchToHTTP(codex)
    let after = (try? String(contentsOf: codex.wiring.path, encoding: .utf8)) ?? ""
    let added = oneAddedHunk(codexConfig, after)
    check("the diff against the original is one hunk, pure addition", added != nil)
    let block = added?.joined(separator: "\n") ?? ""
    check(
      "with url",
      block.contains("url = \"\(url("mail"))\""))
    check(
      "and http_headers",
      block.contains("http_headers = { Authorization = \"Bearer \(token("codex"))\" }"))
    check("and no command or type", !block.contains("command =") && !block.contains("type ="))
    check("it reads back as configured", ClientWiring.status(of: codex) == .configured)
    check("the file is 0600, though it was 0644", mode(codex.wiring.path) == 0o600)

    // An unwire gives back the original bytes.
    _ = try? ClientWiring.unwire(codex)
    check(
      "and unwiring gives back the original",
      (try? String(contentsOf: codex.wiring.path, encoding: .utf8)) == codexConfig)
  }

  // MARK: - Changes that make HTTP entries stale

  static func portChangeIsStale() {
    print("\nport change is stale")
    reset()
    let claude = client("claude-code")
    _ = try? ClientWiring.switchToHTTP(claude)
    port = 8840
    let status = ClientWiring.status(of: claude)
    check(
      "an entry on 8830 with the setting at 8840 is stale",
      {
        if case .stale = status { return true }
        return false
      }())
    check("and says which port", status.summary.contains("8830"))
    check(
      "every row says so",
      ClientWiring.entryState(of: servers(of: claude), key: "cupertino-mail", client: claude)
        == .stale("port 8830"))

    // An automatic pass keeps HTTP entries HTTP, at the new port.
    ClientWiring.rewire(claude, because: "a check")
    check(
      "the automatic rewrite moves them to the new port",
      allHTTP(servers(of: claude), token: token("claude-code"), port: 8840))
    check("and it is configured again", ClientWiring.status(of: claude) == .configured)
    check("without asking for a login item again", LoginItem.requests == [true])

    // Another build's port with a token this copy never issued is that build's
    // wiring (a Debug build beside the release), and an automatic pass leaves it.
    reset()
    let cursor = client("cursor")
    var theirs: [String: Any] = [:]
    for surface in SurfaceSettings.enabledSurfaces {
      theirs["cupertino-\(surface.id)"] = ClientWiring.httpEntry(
        for: surface, token: String(repeating: "d", count: 64), port: 8831)
    }
    try? ClientWiringMerge.write(
      ["mcpServers": theirs], to: cursor.wiring.path, backupSuffix: "cupertino-backup")
    ClientWiring.rewire(cursor, because: "a check")
    check(
      "another build's entries are left alone",
      allHTTP(servers(of: cursor), token: String(repeating: "d", count: 64), port: 8831))
  }

  static func tokenChangeIsStale() {
    print("\ntoken change is stale")
    reset()
    let cursor = client("cursor")
    _ = try? ClientWiring.switchToHTTP(cursor)
    let old = token("cursor")
    try? ClientWiring.tokens.revoke("cursor")
    let status = ClientWiring.status(of: cursor)
    check(
      "an entry whose token is not the client's is stale",
      {
        if case .stale = status { return true }
        return false
      }())
    check("and the sentence never quotes the token", !status.summary.contains(old))

    // Somebody else's token under our URL reads the same.
    reset()
    var forged: [String: Any] = [:]
    for surface in SurfaceSettings.enabledSurfaces {
      forged["cupertino-\(surface.id)"] = ClientWiring.httpEntry(
        for: surface, token: String(repeating: "0", count: 64), port: 8830)
    }
    try? ClientWiringMerge.write(
      ["mcpServers": forged], to: cursor.wiring.path, backupSuffix: "cupertino-backup")
    let forgedStatus = ClientWiring.status(of: cursor)
    check(
      "a token nobody issued is stale",
      {
        if case .stale = forgedStatus { return true }
        return false
      }())

    // The automatic pass rewrites it with the client's own token.
    ClientWiring.rewire(cursor, because: "a check")
    check(
      "and the automatic rewrite gives it the client's token",
      allHTTP(servers(of: cursor), token: token("cursor")))
  }

  // MARK: - Unwiring, folders and silent rewrites

  static func unwireRevokes() {
    print("\nunwire revokes")
    reset()
    let cursor = client("cursor")
    _ = try? ClientWiring.switchToHTTP(cursor)
    let old = token("cursor")
    check("the token is live before", ClientWiring.tokens.client(for: old) == "cursor")
    _ = try? ClientWiring.unwire(cursor)
    check(
      "after unwire the entries are gone",
      !servers(of: cursor).values.contains { ClientWiringMerge.isOurs($0) })
    check("and the token is revoked", ClientWiring.tokens.client(for: old) == nil)

    // A removal that fails leaves the token: the entries holding it are still
    // in the file.
    reset()
    _ = try? ClientWiring.switchToHTTP(cursor)
    let kept = token("cursor")
    place("{ not json", at: cursor.wiring.path)
    check("an unreadable config refuses the unwire", (try? ClientWiring.unwire(cursor)) == nil)
    check("and keeps the token", ClientWiring.tokens.client(for: kept) == "cursor")

    // Claude Code's token is also the one its folders carry. Removing the
    // user-scope entries leaves the folders working.
    reset()
    let claude = client("claude-code")
    _ = try? ClientWiring.switchToHTTP(claude)
    _ = try? ClientWiring.configureLocal(scratchHome.appendingPathComponent("Projects/app"))
    let shared = token("claude-code")
    _ = try? ClientWiring.unwire(claude)
    check(
      "a token a folder still carries is kept",
      ClientWiring.tokens.client(for: shared) == "claude-code")
    _ = try? ClientWiring.unwire(
      folder: scratchHome.appendingPathComponent("Projects/app"), scope: .local)
    _ = try? ClientWiring.unwire(claude)
    check(
      "and revoked once nothing carries it",
      ClientWiring.tokens.client(for: shared) == nil)

    // A bridge client has no token to revoke, and unwiring it mints none.
    reset()
    let desktop = client("claude-desktop")
    _ = try? ClientWiring.configure(desktop)
    _ = try? ClientWiring.unwire(desktop)
    check("unwiring a bridge client touches no token", vault.holders.isEmpty)
  }

  static func projectScopeNeverGetsAToken() {
    print("\nproject scope never gets a token")
    reset()
    let folder = scratchHome.appendingPathComponent("Projects/repo")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    _ = try? ClientWiring.configureProject(folder)
    let file = ClientWiring.projectConfig(in: folder)
    let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    let written = (try? ClientWiringMerge.readJSON(file))?["mcpServers"] as? [String: Any] ?? [:]
    check("configureProject writes command entries", allBridge(written))
    check(
      "and no Authorization anywhere in the file",
      !text.isEmpty && !text.contains("Authorization") && !text.contains("Bearer"))
    check("no token was minted for it", vault.holders.isEmpty)
    check(
      "it reads back as configured",
      ClientWiring.projectStatus(folder, scope: .project) == .configured)
  }

  static func localScopeIsHTTP() {
    print("\nlocal scope is http")
    reset()
    let folder = scratchHome.appendingPathComponent("Projects/app")
    let config = ClientWiring.claudeCodeConfig
    place(#"{"numStartups": 41, "projects": {"/elsewhere": {"history": []}}}"#, at: config)
    _ = try? ClientWiring.configureLocal(folder)
    let root = (try? ClientWiringMerge.readJSON(config)) ?? [:]
    let local = ClientWiringMerge.localScopeServers(in: root, folder: folder.path) ?? [:]
    check(
      "configureLocal writes HTTP entries under projects[dir].mcpServers",
      allHTTP(local, token: token("claude-code")))
    check("with the claude-code token", vault.holders == ["claude-code"])
    check(
      "the other folder is untouched", (root["projects"] as? [String: Any])?["/elsewhere"] != nil)
    check("in a 0600 file, though it was 0644", mode(config) == 0o600)
    check(
      "it reads back as configured",
      ClientWiring.projectStatus(folder, scope: .local) == .configured)

    // A folder wired the old way says so, and its Update moves it.
    reset()
    let old = scratchHome.appendingPathComponent("Projects/old")
    var bridge: [String: Any] = [:]
    for surface in SurfaceSettings.enabledSurfaces {
      bridge["cupertino-\(surface.id)"] = ClientWiring.entry(for: surface, client: "claude-code")
    }
    try? ClientWiringMerge.write(
      ["projects": [old.path: ["mcpServers": bridge]]], to: config,
      backupSuffix: "cupertino-backup")
    check(
      "a bridge-wired folder is oldTransport",
      ClientWiring.projectStatus(old, scope: .local) == .oldTransport)
  }

  static func autoRewireNeverSwitches() {
    print("\nauto-rewire never switches")
    reset()
    let cursor = client("cursor")
    place(bridgeConfig(leaving: ["maps"]), at: cursor.wiring.path)
    ClientWiring.rewire(cursor, because: "a check")
    let after = servers(of: cursor)
    check("the automatic rewrite leaves bridge entries in place", allBridge(after))
    check("and adds the missing surface as a bridge", after["cupertino-maps"] != nil)
    check("no token minted", vault.holders.isEmpty)
    check("no login item asked for", LoginItem.requests.isEmpty)
    check("still the old way", ClientWiring.status(of: cursor) == .oldTransport)

    // The Update button is not the switch either.
    reset()
    place(bridgeConfig(leaving: ["maps"]), at: cursor.wiring.path)
    _ = try? ClientWiring.configure(cursor)
    check("Update on an old-way client keeps the bridge", allBridge(servers(of: cursor)))
    check("and mints nothing", vault.holders.isEmpty)

    // An HTTP client stays HTTP through the same pass.
    reset()
    _ = try? ClientWiring.switchToHTTP(cursor)
    SurfaceSettings.off = ["maps"]
    _ = try? ClientWiring.switchToHTTP(cursor)
    SurfaceSettings.off = []
    ClientWiring.rewire(cursor, because: "a check")
    check(
      "a surface switched on reaches an HTTP client as HTTP",
      allHTTP(servers(of: cursor), token: token("cursor")))

    // And a client nobody wired is still left alone.
    reset()
    ClientWiring.rewire(client("vscode"), because: "a check")
    check(
      "a client with nothing of ours is not wired",
      !FileManager.default.fileExists(atPath: client("vscode").wiring.path.path))
  }

  static func isOursClaimsOnlyOurs() {
    print("\nisOurs claims only ours")
    func http(_ url: String) -> [String: Any] {
      ["type": "http", "url": url, "headers": ["Authorization": "Bearer x"]]
    }
    check("our loopback URL is ours", ClientWiringMerge.isOurs(http(url("mail"))))
    check(
      "on another port too, so a port change is cleaned up",
      ClientWiringMerge.isOurs(http(url("voice-memos", port: 9999))))
    check(
      "Codex's shape is ours",
      ClientWiringMerge.isOurs(["url": url("mail"), "http_headers": ["Authorization": "Bearer x"]]))
    check(
      "a non-/s/ path is not",
      !ClientWiringMerge.isOurs(http("http://127.0.0.1:9999/mcp")))
    check(
      "Bastion's three segments are not",
      !ClientWiringMerge.isOurs(http("http://127.0.0.1:8720/s/prod/stripe")))
    check(
      "localhost is not", !ClientWiringMerge.isOurs(http("http://localhost:8830/s/mail")))
    check("https is not", !ClientWiringMerge.isOurs(http("https://127.0.0.1:8830/s/mail")))
    check(
      "another host is not", !ClientWiringMerge.isOurs(http("http://127.0.0.2:8830/s/mail")))
    check(
      "a surface nobody ships is not",
      !ClientWiringMerge.isOurs(http("http://127.0.0.1:8830/s/stripe")))
    check(
      "a trailing slash or a query is not",
      !ClientWiringMerge.isOurs(http(url("mail") + "/"))
        && !ClientWiringMerge.isOurs(http(url("mail") + "?x=1")))
    check(
      "a port that is not digits is not",
      !ClientWiringMerge.isOurs(http("http://127.0.0.1:/s/mail"))
        && !ClientWiringMerge.isOurs(http("http://127.0.0.1:88a0/s/mail")))

    let bastion = http("http://127.0.0.1:8720/s/prod/stripe")
    let root: [String: Any] = [
      "mcpServers": ["prod-stripe": bastion, "cupertino-mail": http(url("mail"))]
    ]
    let out = ClientWiringMerge.unmerged(from: root, rootKey: "mcpServers")
    let left = out["mcpServers"] as? [String: Any] ?? [:]
    check(
      "Remove Cupertino's entries takes ours and leaves Bastion's",
      left["cupertino-mail"] == nil && deepEqual(left["prod-stripe"], bastion))
  }
}
