import AppKit
import Foundation

/// Writes Cupertino's servers into the MCP clients installed on this Mac.
///
/// This is the step between "installed" and "working", and doing it by hand
/// means typing an absolute path to a binary buried inside the app bundle.
///
/// It is also the feature that cashes in the architecture. `docs/distribution.md`
/// rules the App Store out partly because a sandboxed app "cannot write
/// `~/Library/Application Support/Claude/claude_desktop_config.json` from inside
/// its container". A Developer ID app is not sandboxed, so it can.
///
/// The merge itself lives in `ClientWiringMerge`, which imports nothing but
/// Foundation so `make wiring-check` can compile and exercise it standalone.
/// What stays here is policy: which clients exist, where they keep their
/// config, and what we are willing to write.
enum ClientWiring {
  /// How a client is wired, and whether we are the one doing it.
  enum Wiring: Hashable {
    /// A strict-JSON file we merge into. `rootKey` is the object servers live
    /// under — `mcpServers` for everything so far, `servers` if VS Code's own
    /// file ever becomes safe to write. A parameter rather than an assumption,
    /// because the previous version of this file hardcoded the string in two
    /// places and called the difference an enum with one case.
    case json(path: URL, rootKey: String)

    /// A command to paste, for clients whose config is not ours to rewrite.
    ///
    /// One refusal now, and it is about syntax rather than about stakes. VS
    /// Code, Zed and Goose keep their config in JSONC or YAML and Codex in
    /// TOML; re-serialising any of them through `JSONSerialization` would
    /// delete every comment in a file the user maintains by hand.
    ///
    /// Claude Code used to be here too, on the grounds that `~/.claude.json`
    /// holds credentials and that running sessions write to it concurrently.
    /// Neither survived being checked. The mode is preserved across the swap,
    /// so a 0600 file stays 0600; and the concurrency is the same
    /// read-modify-write `claude mcp add` performs from a second process, so
    /// handing over the command relocated the race rather than avoiding it —
    /// while giving up the one advantage this app has, which is that it already
    /// reads that file and can say when a write has been clobbered.
    ///
    /// `probe` is a strict-JSON file we may *read* to report status, and never
    /// write. nil where the config is not JSON at all.
    case command(recipe: Recipe, probe: Probe?)
  }

  /// One shell line per surface, built by substitution.
  ///
  /// A template rather than an enum of per-client styles, so a new command
  /// client stays what a new drop-in client already is: one row in the table
  /// below and no new code.
  ///
  /// Placeholders, all of which expand **already quoted**. A template must not
  /// add quotes of its own: Cupertino can legally live at a path with a space
  /// or an apostrophe in it, and a table full of hand-placed quotes is where
  /// that bug would live.
  ///
  ///   `{key}`    the server key, e.g. `cupertino-mail`
  ///   `{id}`     the surface id, e.g. `mail`
  ///   `{bridge}` the absolute bridge path
  ///   `{json}`   the entry `configure` writes, on one line, plus its name
  struct Recipe: Hashable {
    let template: String
    /// The line that undoes `template`, or nil where the client has no removal
    /// verb at all.
    ///
    /// VS Code is the nil: `code --help` offers `--add-mcp` and nothing that
    /// takes it back. The row explains rather than emitting a command that does
    /// not exist, which is the same refusal `probe: nil` already makes for a
    /// config this app cannot read.
    let removeTemplate: String?

    init(template: String, removeTemplate: String? = nil) {
      self.template = template
      self.removeTemplate = removeTemplate
    }
  }

  /// A file we read and never write, to say something true about a client we
  /// do not configure.
  struct Probe: Hashable {
    let path: URL
    let rootKey: String
  }

  struct Client: Identifiable, Hashable {
    let id: String
    let displayName: String
    /// An app glyph for GUI clients, `terminal` for the CLIs.
    let symbol: String
    /// Asked of LaunchServices first, which finds the app in `~/Applications`,
    /// on a second volume, anywhere. The hardcoded `/Applications/Cursor.app`
    /// this replaces found it in exactly one place.
    let bundleID: String?
    /// Fallback evidence, and the only evidence a CLI has.
    ///
    /// Deliberately not `which`. This app is launched by Finder or launchd, so
    /// it inherits `PATH=/usr/bin:/bin` and would miss every Homebrew and
    /// npm-global install there is. Nor `/bin/sh -lc`, the fix people reach
    /// for next: sourcing the user's dotfiles from a notarized app holding
    /// Full Disk Access, on every menu open, to draw a status glyph.
    let evidence: [URL]
    let wiring: Wiring

    var isInstalled: Bool {
      let fm = FileManager.default
      if let bundleID,
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
      {
        return true
      }
      if evidence.contains(where: { fm.fileExists(atPath: $0.path) }) { return true }
      // A config file is evidence too, but only for a client we write one for.
      // A command client's probe may be a file every install of the tool has.
      if case .json(let path, _) = wiring { return fm.fileExists(atPath: path.path) }
      return false
    }

    /// nil for command clients: there is no file this app wrote to show, and
    /// pointing Finder at one it only pastes lines for would be a claim it has
    /// not earned.
    var revealTarget: URL? {
      if case .json(let path, _) = wiring { return path }
      return nil
    }
  }

  private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

  /// Claude Code's per-user config, named once rather than spelled out at the
  /// four places that touch it: the client row writes its top-level
  /// `mcpServers`, the folder feature writes a project block inside the same
  /// file, and each reads it back to draw a status.
  static var claudeCodeConfig: URL { home.appendingPathComponent(".claude.json") }

  /// Both halves are deliberate, and the split is not about how popular a
  /// client is. It is about whether its config is a file we can rewrite
  /// without destroying something the user put there.
  ///
  /// Absent entirely: **ChatGPT desktop**, which takes remote HTTP connectors
  /// only and cannot spawn a local stdio server at all. Absence is the whole
  /// implementation — a greyed-out row explaining why would be a support
  /// burden with no action attached.
  ///
  /// **Zed** and **Goose** are absent for now rather than on principle. Zed
  /// wants a `context_servers` entry whose shape has moved between versions
  /// and Goose a YAML `extensions:` block, and neither has a CLI to hide
  /// behind — each would be a bespoke snippet maintained blind. `.command`
  /// accommodates them the day someone asks.
  static let clients: [Client] = [
    // Drop-in: strict JSON, servers under `mcpServers`, nothing to negotiate.
    Client(
      id: "claude-code",
      displayName: "Claude Code",
      symbol: "terminal",
      bundleID: nil,
      evidence: [
        home.appendingPathComponent(".claude.json"),
        home.appendingPathComponent(".claude"),
        URL(fileURLWithPath: "/opt/homebrew/bin/claude"),
        URL(fileURLWithPath: "/usr/local/bin/claude"),
      ],
      // The top-level `mcpServers`, which is what `claude mcp add --scope user`
      // writes and what every session on this Mac reads. The scope is the whole
      // point: the CLI defaults to `local`, which files the server under
      // whichever directory the command ran in, so Cupertino would appear in one
      // repo and be missing from every other. Writing the file directly cannot
      // get that wrong, because there is no cwd involved.
      //
      // Not `projects["<dir>"].mcpServers` either — that is the folder feature
      // below, chosen deliberately, rather than a default a stray terminal picks.
      wiring: .json(path: claudeCodeConfig, rootKey: "mcpServers")),
    Client(
      id: "claude-desktop",
      displayName: "Claude Desktop",
      symbol: "sparkles",
      bundleID: "com.anthropic.claudefordesktop",
      evidence: [URL(fileURLWithPath: "/Applications/Claude.app")],
      wiring: .json(
        path: home.appendingPathComponent(
          "Library/Application Support/Claude/claude_desktop_config.json"),
        rootKey: "mcpServers")),
    Client(
      id: "cursor",
      displayName: "Cursor",
      symbol: "chevron.left.forwardslash.chevron.right",
      bundleID: "com.todesktop.230313mzl4w4u92",
      evidence: [URL(fileURLWithPath: "/Applications/Cursor.app")],
      wiring: .json(
        path: home.appendingPathComponent(".cursor/mcp.json"), rootKey: "mcpServers")),
    Client(
      id: "lm-studio",
      displayName: "LM Studio",
      symbol: "cpu",
      bundleID: "ai.elementlabs.lmstudio",
      evidence: [
        URL(fileURLWithPath: "/Applications/LM Studio.app"),
        home.appendingPathComponent(".lmstudio"),
      ],
      wiring: .json(
        path: home.appendingPathComponent(".lmstudio/mcp.json"), rootKey: "mcpServers")),
    Client(
      id: "windsurf",
      displayName: "Windsurf",
      symbol: "wind",
      bundleID: "com.exafunction.windsurf",
      evidence: [
        URL(fileURLWithPath: "/Applications/Windsurf.app"),
        home.appendingPathComponent(".codeium/windsurf"),
      ],
      wiring: .json(
        path: home.appendingPathComponent(".codeium/windsurf/mcp_config.json"),
        rootKey: "mcpServers")),

    // Copy-a-command: their config is not JSON, so it is not ours to rewrite.
    Client(
      id: "vscode",
      displayName: "Visual Studio Code",
      symbol: "chevron.left.slash.chevron.right",
      bundleID: "com.microsoft.VSCode",
      evidence: [
        URL(fileURLWithPath: "/Applications/Visual Studio Code.app"),
        URL(fileURLWithPath: "/opt/homebrew/bin/code"),
        URL(fileURLWithPath: "/usr/local/bin/code"),
      ],
      // `--add-mcp` rather than writing `Code/User/mcp.json` ourselves, which
      // is JSONC: JSONSerialization would either throw on the comments or,
      // worse, succeed on a file that has none today and delete them the day
      // the user adds one.
      wiring: .command(recipe: Recipe(template: "code --add-mcp {json}"), probe: nil)),
    Client(
      id: "codex",
      displayName: "Codex CLI",
      symbol: "terminal",
      bundleID: nil,
      evidence: [
        home.appendingPathComponent(".codex"),
        URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
        URL(fileURLWithPath: "/usr/local/bin/codex"),
      ],
      // `~/.codex/config.toml` is TOML. Same refusal as VS Code, different
      // syntax. No probe: reading it would need a TOML parser, and the
      // shortcut — grepping the file for the bridge path — cannot tell a stale
      // entry from a missing one, so it would let the app claim "configured"
      // from a substring match.
      wiring: .command(
        recipe: Recipe(
          template: "codex mcp add {key} -- {bridge} --server={id}",
          // Documented upstream alongside `codex mcp add`. UNVERIFIED here —
          // `codex` is not installed on the machine this was written on, so
          // unlike the Claude Code line above nobody has watched this one run.
          removeTemplate: "codex mcp remove {key}"), probe: nil)),
  ]

  // MARK: - What we write

  /// The bridge inside *this* bundle, never a hardcoded path.
  ///
  /// The same reasoning as the bridge launching its own app by path: whatever
  /// copy of Cupertino is doing the configuring is the copy the client should
  /// talk to. It also means this keeps working when the app moves to
  /// /Applications.
  static var bridgePath: String {
    Bundle.main.bundleURL
      .appendingPathComponent("Contents/Helpers/cupertino-bridge")
      .path
  }

  static func entry(for surface: Surface) -> [String: Any] {
    // No `env` block. Writes are the app's toggle now, not a client-side
    // variable that every client would carry its own stale copy of.
    ["command": bridgePath, "args": ["--server=\(surface.id)"]]
  }

  /// Named after the thing that provides the server, not the thing it talks to.
  ///
  /// This key lands in a file the user owns, next to entries the app knows
  /// nothing about, and `configure` writes it unconditionally. `apple-mail` is
  /// a name several public MCP servers already use, so the old key could
  /// silently replace one of them. `cupertino-mail` cannot collide by accident,
  /// and it makes "which of these entries are mine?" a question with an answer.
  ///
  /// The npm packages and the tool names deliberately did **not** follow: the
  /// servers are MIT and run standalone with no app at all, so naming them
  /// after the app would misdescribe them. Someone wiring the package up by
  /// hand still calls it `apple-mail`, and that is right — it is a different
  /// deployment, running under their own grant rather than Cupertino's.
  static func serverKey(for surface: Surface) -> String { "cupertino-\(surface.id)" }

  /// What `serverKey` returned before the rename.
  static func legacyServerKey(for surface: Surface) -> String { "apple-\(surface.id)" }

  private static var entries: [String: [String: Any]] {
    Dictionary(
      uniqueKeysWithValues: SurfaceSettings.enabledSurfaces.map {
        (serverKey(for: $0), entry(for: $0))
      })
  }

  /// The keys to take out: for every surface switched off, the current key AND
  /// the one it replaced. An `apple-maps` left by an install predating the
  /// rename is exactly as stale as a `cupertino-maps`.
  private static var disabledKeys: Set<String> {
    var keys: Set<String> = []
    for surface in Surface.all where !SurfaceSettings.isEnabled(surface) {
      keys.insert(serverKey(for: surface))
      keys.insert(legacyServerKey(for: surface))
    }
    return keys
  }

  private static var legacyKeys: [String: String] {
    Dictionary(
      uniqueKeysWithValues: Surface.all.map { (serverKey(for: $0), legacyServerKey(for: $0)) })
  }

  private static var expected: [(key: String, label: String)] {
    SurfaceSettings.enabledSurfaces.map { (key: serverKey(for: $0), label: $0.displayName) }
  }

  /// The complement of `expected`: what an audit should find and report rather
  /// than quietly accept.
  private static var unexpected: [(key: String, label: String)] {
    Surface.all.filter { !SurfaceSettings.isEnabled($0) }
      .map { (key: serverKey(for: $0), label: $0.displayName) }
  }

  // MARK: - Commands

  /// POSIX single-quoting, `'\''` dance included.
  ///
  /// One helper so no template in the table has to think about it, and so a
  /// path containing a space, a quote or a `$` produces a line that pastes.
  private static func shellQuoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  /// The entry `configure` writes, plus the `name` key and on one line, which
  /// is the shape `code --add-mcp` takes.
  private static func entryJSON(for surface: Surface) -> String {
    var object = entry(for: surface)
    object["name"] = serverKey(for: surface)
    // `.withoutEscapingSlashes` matters here in a way it does not in a file:
    // this string is pasted into a terminal and read by a person, and every
    // path in it would otherwise arrive as `\/Applications\/Cupertino.app`.
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
      let string = String(data: data, encoding: .utf8)
    else { return "" }
    return string
  }

  /// One line per surface, ready to paste.
  static func commands(for recipe: Recipe) -> String {
    SurfaceSettings.enabledSurfaces.map { surface in
      recipe.template
        .replacingOccurrences(of: "{key}", with: serverKey(for: surface))
        .replacingOccurrences(of: "{id}", with: surface.id)
        .replacingOccurrences(of: "{bridge}", with: shellQuoted(bridgePath))
        .replacingOccurrences(of: "{json}", with: shellQuoted(entryJSON(for: surface)))
    }
    .joined(separator: "\n")
  }

  /// nil for clients we configure ourselves.
  static func commands(for client: Client) -> String? {
    guard case .command(let recipe, _) = client.wiring else { return nil }
    return commands(for: recipe)
  }

  /// One line per surface that has been switched off, or nil when there is
  /// nothing to remove or no verb to remove it with.
  ///
  /// Its own copy action rather than appended to `commands`, and that is not a
  /// layout preference: a `codex mcp remove` for a name that was never there
  /// exits non-zero, so pasting one block would report a failure for the half
  /// that had nothing to do. Deletion is also the half somebody should read
  /// before pasting.
  static func removalCommands(for recipe: Recipe) -> String? {
    guard let template = recipe.removeTemplate else { return nil }
    let disabled = Surface.all.filter { !SurfaceSettings.isEnabled($0) }
    guard !disabled.isEmpty else { return nil }
    return disabled.map { surface in
      template
        .replacingOccurrences(of: "{key}", with: serverKey(for: surface))
        .replacingOccurrences(of: "{id}", with: surface.id)
        .replacingOccurrences(of: "{bridge}", with: shellQuoted(bridgePath))
    }
    .joined(separator: "\n")
  }

  static func removalCommands(for client: Client) -> String? {
    guard case .command(let recipe, _) = client.wiring else { return nil }
    return removalCommands(for: recipe)
  }

  /// Whether this client holds keys for switched-off surfaces that the app can
  /// neither remove nor name a command for — VS Code, and only VS Code.
  static func needsManualRemoval(_ client: Client) -> Bool {
    guard case .command(let recipe, _) = client.wiring, recipe.removeTemplate == nil else {
      return false
    }
    return Surface.all.contains { !SurfaceSettings.isEnabled($0) }
  }

  // MARK: - Status

  enum Status: Equatable {
    case notInstalled
    case notConfigured
    case configured
    /// Present, but pointing somewhere else — usually a previous build.
    case stale(String)
    /// Wired for some surfaces and not others — what an existing config looks
    /// like the day a new surface ships.
    case incomplete([String])
    /// Still wired for a surface that has since been switched off. Not a fault:
    /// nothing is broken, it just costs tool definitions the user asked to stop
    /// paying for. The same Update button clears it.
    case extra([String])
    case unreadable(String)
    /// Installed, and we have no way to tell — a command client whose config
    /// is TOML or JSONC. Never gates the button; it only declines to claim a
    /// green check the app has not earned.
    case unknown
  }

  private static func status(from audit: ClientWiringMerge.Audit) -> Status {
    switch audit {
    case .configured: return .configured
    case .notConfigured: return .notConfigured
    case .stale(let found): return .stale(found)
    case .incomplete(let missing): return .incomplete(missing)
    case .extra(let leftover): return .extra(leftover)
    }
  }

  private static func audit(path: URL, rootKey: String) throws -> Status {
    let root = try ClientWiringMerge.readJSON(path)
    let servers = root[rootKey] as? [String: Any] ?? [:]
    return status(
      from: ClientWiringMerge.audit(
        servers: servers, expectedCommand: bridgePath, expected: expected,
        unexpected: unexpected))
  }

  static func status(of client: Client) -> Status {
    guard client.isInstalled else { return .notInstalled }
    switch client.wiring {
    case .json(let path, let rootKey):
      guard FileManager.default.fileExists(atPath: path.path) else { return .notConfigured }
      do { return try audit(path: path, rootKey: rootKey) } catch {
        return .unreadable(error.localizedDescription)
      }
    case .command(_, let probe):
      // Read-only, always, and a failure here is silence rather than
      // `.unreadable`: the file is not ours, so nothing about it is a fault
      // this app should report. The worst case is the row it already drew.
      guard let probe, let status = try? audit(path: probe.path, rootKey: probe.rootKey) else {
        return .unknown
      }
      return status
    }
  }

  // MARK: - Writing

  enum WriteError: LocalizedError {
    /// A `.command` client reached `configure`. The UI never offers the
    /// button, so this is the guard for the day someone adds a row wrong — a
    /// throw rather than a precondition, because `StatusModel.configure`
    /// already routes errors to a red line of text and a trap in a shipping
    /// menu bar app is the worse outcome.
    case notWritable(String)

    var errorDescription: String? {
      switch self {
      case .notWritable(let name):
        return "\(name) is configured with a command, not a file this app writes"
      }
    }
  }

  /// Merge our servers in, prune the ones for surfaces that are switched off,
  /// and leave everything else untouched.
  ///
  /// Three properties this has to hold, because the file belongs to someone
  /// else: everything that is not ours survives, the previous contents are
  /// recoverable, and a crash mid-write cannot leave a truncated config. `make
  /// wiring-check` asserts all three.
  ///
  /// The first used to be true by construction — nothing was ever removed. It is
  /// now held by `ClientWiringMerge.isOurs`, which is a weaker guarantee and
  /// worth saying out loud. One accepted consequence: an entry pointing at a
  /// DIFFERENT copy of Cupertino, a beta in `~/Downloads` say, counts as ours
  /// and will be removed. That was already the established reading, and
  /// `wiring-check` has asserted it since before this could delete anything.
  @discardableResult
  static func configure(_ client: Client) throws -> URL? {
    guard case .json(let path, let rootKey) = client.wiring else {
      throw WriteError.notWritable(client.displayName)
    }
    let backup = try mergeWrite(into: path, newFileMode: 0o600) { root in
      ClientWiringMerge.merged(
        into: root, rootKey: rootKey, entries: entries, legacy: legacyKeys, remove: disabledKeys)
    }
    hostLog("cupertino", .info, "configured \(client.displayName) at \(path.path)")
    return backup
  }

  /// Read, merge, write — with one retry when the file changed in between.
  ///
  /// Every write this app makes goes through here, so the read that a merge is
  /// computed from and the swap that lands it are never separated by anything
  /// but this function. The retry costs one extra read in the rare case and
  /// turns "somebody else's change was silently dropped" into "the change we
  /// were about to drop was merged in instead".
  ///
  /// The second failure is thrown rather than retried forever: a file being
  /// rewritten faster than this can read it is not a race to keep entering, and
  /// `StatusModel` already has somewhere to put the sentence.
  ///
  /// `newFileMode` is 0600 for the per-user client configs — files that live in
  /// `$HOME` and hold, or will come to hold, credentials — and nil for a repo's
  /// `.mcp.json`, which is an ordinary project file the user may well commit.
  private static func mergeWrite(
    into path: URL,
    newFileMode: Int?,
    merge: ([String: Any]) -> [String: Any]
  ) throws -> URL? {
    let attempts = 2
    for attempt in 1...attempts {
      let stamp = ClientWiringMerge.stamp(of: path)
      var root: [String: Any] = [:]
      if case .present = stamp { root = try ClientWiringMerge.readJSON(path) }
      do {
        return try ClientWiringMerge.write(
          merge(root), to: path, backupSuffix: "cupertino-backup",
          expecting: stamp, newFileMode: newFileMode)
      } catch ClientWiringMerge.WriteError.changedUnderneath(_) where attempt < attempts {
        continue
      }
    }
    throw ClientWiringMerge.WriteError.changedUnderneath(path)
  }

  // MARK: - Project folders

  /// Where a folder's wiring is written.
  ///
  /// ## Why this exists at all
  ///
  /// Every client above is wired once per user, which is right for an app on
  /// this Mac. It is wrong for a CLI run in 93 directories: measured on a real
  /// install, 12 of them had ever called a Cupertino tool, so 87% of sessions
  /// were carrying ~73 tool definitions they never used. Wiring a folder is how
  /// someone opts the other 81 out without giving up the 12.
  ///
  /// ## Two files, one write
  ///
  /// Both are read by Claude Code and both are strict JSON with servers under
  /// `mcpServers`, so both go through the same merge, backup and atomic write.
  /// `project` writes `<dir>/.mcp.json`; `local` writes the `projects[<dir>]`
  /// block of `~/.claude.json`, which is the same file the client row writes
  /// and a different key inside it.
  ///
  /// `local` used to hand over a `claude mcp add --scope local` line instead,
  /// for the reason `Wiring` no longer gives. The asymmetry it produced —
  /// one option acting, the other pasting — described the app's caution rather
  /// than any property of the two files, and it is gone.
  enum ProjectScope: String, CaseIterable, Identifiable, Hashable {
    /// `~/.claude.json` under `projects[<dir>]` — where `claude mcp add
    /// --scope local` would have put it.
    case local
    /// `<dir>/.mcp.json`, which this app writes.
    case project

    var id: String { rawValue }

    /// Named after the FILE, not after an audience.
    ///
    /// These read "Just me" and "Shared with the repo" in an earlier draft,
    /// which turned a question about where bytes land into a claim about who
    /// sees them — and the claim was not the app's to make. Whether a
    /// `.mcp.json` is committed, gitignored or never in a repository at all is
    /// the user's decision, taken after this one and somewhere else entirely.
    var displayName: String {
      switch self {
      case .local: "Your Claude Code config"
      case .project: "A .mcp.json file"
      }
    }

    /// Where it goes and what reads it. Descriptive, in both cases.
    var detail: String {
      switch self {
      case .local:
        "Added to ~/.claude.json under this folder's path, so it stays on this Mac and the folder itself is untouched."
      case .project:
        "Written as .mcp.json inside the folder, where any Claude Code session opened there picks it up. Commit it or add it to .gitignore — whichever you prefer."
      }
    }
  }

  /// The file `project` scope writes. Its name is fixed by Claude Code.
  static func projectConfig(in folder: URL) -> URL {
    folder.appendingPathComponent(".mcp.json")
  }

  /// Merge our servers into a folder's `.mcp.json`, leaving everything else be.
  ///
  /// Deliberately the same call as `configure(_:)` makes for a client: a folder
  /// is not a special case of writing, it is the same write at a different
  /// path, and routing it anywhere else is how the two would drift.
  @discardableResult
  static func configureProject(_ folder: URL) throws -> URL? {
    let backup = try mergeWrite(into: projectConfig(in: folder), newFileMode: nil) { root in
      ClientWiringMerge.merged(
        into: root, rootKey: "mcpServers", entries: entries, legacy: legacyKeys,
        remove: disabledKeys)
    }
    hostLog("cupertino", .info, "configured folder \(folder.path)")
    return backup
  }

  /// The same merge, one level deeper: into `projects[<dir>].mcpServers` of
  /// Claude Code's config, leaving every other project block untouched.
  @discardableResult
  static func configureLocal(_ folder: URL) throws -> URL? {
    let backup = try mergeWrite(into: claudeCodeConfig, newFileMode: 0o600) { root in
      ClientWiringMerge.mergedIntoLocalScope(
        into: root, folder: folder.path, entries: entries, legacy: legacyKeys,
        remove: disabledKeys)
    }
    hostLog("cupertino", .info, "configured folder \(folder.path) in Claude Code")
    return backup
  }

  /// What the folder row calls. The scope picks the file; nothing else about
  /// the two paths differs any more.
  @discardableResult
  static func configure(folder: URL, scope: ProjectScope) throws -> URL? {
    switch scope {
    case .local: return try configureLocal(folder)
    case .project: return try configureProject(folder)
    }
  }

  /// Read-only, both scopes.
  ///
  /// `local` reads `projects[<dir>].mcpServers` out of `~/.claude.json` — the
  /// half the client row deliberately ignores, because there it would answer a
  /// question nobody asked. Here it is the question.
  static func projectStatus(_ folder: URL, scope: ProjectScope) -> Status {
    switch scope {
    case .project:
      let path = projectConfig(in: folder)
      guard FileManager.default.fileExists(atPath: path.path) else { return .notConfigured }
      do { return try audit(path: path, rootKey: "mcpServers") } catch {
        return .unreadable(error.localizedDescription)
      }
    case .local:
      guard FileManager.default.fileExists(atPath: claudeCodeConfig.path) else {
        return .notConfigured
      }
      let root: [String: Any]
      do { root = try ClientWiringMerge.readJSON(claudeCodeConfig) } catch {
        return .unreadable(error.localizedDescription)
      }
      // Absent and empty are different answers — see `localScopeServers`. A
      // folder Claude Code has never heard of is not configured; one it knows
      // with nothing of ours in it goes through the audit like any other.
      guard let servers = ClientWiringMerge.localScopeServers(in: root, folder: folder.path)
      else { return .notConfigured }
      return status(
        from: ClientWiringMerge.audit(
          servers: servers, expectedCommand: bridgePath, expected: expected,
          unexpected: unexpected))
    }
  }

  // MARK: - Remembered folders

  private static let foldersKey = "wiredFolders"

  /// Paths, not security-scoped bookmarks: this app is not sandboxed — see
  /// `Cupertino.entitlements`, which declares Apple Events and nothing else —
  /// and a bookmark would buy access it already has while adding a stale-alias
  /// failure mode to a list that is only ever redrawn.
  static var rememberedFolders: [URL] {
    get {
      (UserDefaults.standard.array(forKey: foldersKey) as? [String] ?? [])
        .map { URL(fileURLWithPath: $0) }
    }
    set {
      UserDefaults.standard.set(newValue.map(\.path), forKey: foldersKey)
    }
  }

  static func remember(_ folder: URL) {
    var list = rememberedFolders.filter { $0.path != folder.path }
    list.insert(folder, at: 0)
    // A list, not a history. Ten is past what anyone scrolls in a settings pane.
    rememberedFolders = Array(list.prefix(10))
  }

  static func forget(_ folder: URL) {
    rememberedFolders = rememberedFolders.filter { $0.path != folder.path }
  }

  /// The file the folder's wiring actually landed in, which is not the same
  /// file for the two scopes: `.mcp.json` inside the folder, or Claude Code's
  /// own config in `$HOME`.
  static func reveal(folder: URL, scope: ProjectScope) {
    let target = scope == .project ? projectConfig(in: folder) : claudeCodeConfig
    NSWorkspace.shared.activateFileViewerSelecting([target])
  }

  static func reveal(_ client: Client) {
    guard let target = client.revealTarget else { return }
    NSWorkspace.shared.activateFileViewerSelecting([target])
  }
}
