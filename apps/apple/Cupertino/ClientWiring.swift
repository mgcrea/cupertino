import AppKit
import Foundation
import Observation

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
/// Bumped every time this app writes a client config, so a view can notice.
///
/// Nothing in SwiftUI's dependency graph changes when a file on disk does, and
/// the client detail pane reads a file rather than a model. Configure used to
/// redraw it by luck — the result sentence it sets happens to be `@State` — and
/// a write made from anywhere else redrew nothing at all.
///
/// A revision rather than the status itself. What is observable here is "the
/// file changed"; every reader still goes to the file for what it now says,
/// which is what makes a stale answer impossible rather than merely unlikely.
///
/// It counts THIS app's writes only. A config rewritten by the client that owns
/// it does not bump anything, and the dot beside that client keeps its last
/// answer until something else redraws it. That is the same limit
/// `StatusModel.refresh` has always had, and the reason this is a revision to
/// bump rather than a status to store.
@MainActor
@Observable
final class ClientConfigRevision {
  static let shared = ClientConfigRevision()

  private(set) var value = 0

  func bump() { value += 1 }
}

/// The merge itself lives in `ClientWiringMerge`, which imports nothing but
/// Foundation so `make wiring-check` can compile and exercise it standalone.
/// What stays here is policy: which clients exist, where they keep their
/// config, and what we are willing to write.
enum ClientWiring {
  /// Where a client keeps its servers, and what the file is written in.
  ///
  /// Both cases are written by this app. There used to be a third — a shell line
  /// for the user to paste — and it held VS Code and Codex for two releases, on
  /// a reading of each file that turned out to be wrong in one case and merely
  /// expensive in the other. VS Code's `mcp.json` is strict JSON and always was;
  /// Codex's `config.toml` needed a splicer, which `ClientWiringTOML` now is.
  /// Nothing is left that needs pasting, so nothing here offers it.
  ///
  /// **Zed** and **Goose** are the reason to remember it existed. Zed wants a
  /// `context_servers` entry whose shape has moved between versions and Goose a
  /// YAML `extensions:` block; neither is JSON, neither is TOML, and the honest
  /// way to add them is a third case here rather than a snippet maintained blind.
  enum Wiring: Hashable {
    /// A strict-JSON file we merge into. `rootKey` is the object servers live
    /// under: `mcpServers` for five of the seven, `servers` for VS Code. A
    /// parameter rather than an assumption, because the previous version of this
    /// file hardcoded the string in two places and called the difference an enum
    /// with one case.
    case json(path: URL, rootKey: String)

    /// `~/.codex/config.toml`, spliced in place.
    ///
    /// No rootKey: TOML's is `mcp_servers` and it is `ClientWiringTOML`'s to
    /// know, because unlike the JSON clients the key is part of the table header
    /// syntax rather than a lookup.
    case toml(path: URL)

    var path: URL {
      switch self {
      case .json(let path, _), .toml(let path): return path
      }
    }

    /// What the pane calls the key servers live under, for the sentence that
    /// promises everything else in the file is left alone.
    var rootKey: String {
      switch self {
      case .json(_, let rootKey): return rootKey
      case .toml: return ClientWiringTOML.rootKey
      }
    }
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
      // Which editors this Mac happens to have is a fact about this Mac. Under a
      // capture every row is shown, which is also what the Settings pane this
      // replaced did — it filtered on a status demo mode seeded for all seven.
      if DemoSeed.isEnabled { return true }
      let fm = FileManager.default
      if let bundleID,
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
      {
        return true
      }
      if evidence.contains(where: { fm.fileExists(atPath: $0.path) }) { return true }
      // A config file is evidence too: nothing but the client itself writes one.
      return fm.fileExists(atPath: wiring.path.path)
    }

    var revealTarget: URL? { wiring.path }
  }

  private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
  /// Two clients keep their config here rather than in a dotfile.
  private static var support: URL { home.appendingPathComponent("Library/Application Support") }

  /// Claude Code's per-user config, named once rather than spelled out at the
  /// four places that touch it: the client row writes its top-level
  /// `mcpServers`, the folder feature writes a project block inside the same
  /// file, and each reads it back to draw a status.
  static var claudeCodeConfig: URL { home.appendingPathComponent(".claude.json") }

  /// Both halves are deliberate, and the split is not about how popular a
  /// client is. It is about whether its config is a file we can rewrite
  /// without destroying something the user put there.
  ///
  /// **ChatGPT desktop** has no row of its own, and the reason written here used
  /// to be that it "takes remote HTTP connectors only and cannot spawn a local
  /// stdio server at all". That is wrong, and the file disproves it: the ChatGPT
  /// app writes three stdio servers into `~/.codex/config.toml` itself —
  /// `node_repl`, `computer-use` and `cua_repl`, all `command` entries pointing
  /// into `/Applications/ChatGPT.app` — and sets `CODEX_CLI_PATH` to the Codex
  /// binary bundled inside its own app bundle. Remote-only is true of the
  /// Connectors feature and of nothing else.
  ///
  /// It is still one row, for the better reason: the ChatGPT app, the Codex CLI
  /// and the Codex IDE extension all read that **same file**, so a second row
  /// would write the same keys to the same path twice, and removing either would
  /// take the other out.
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
        path: support.appendingPathComponent("Claude/claude_desktop_config.json"),
        rootKey: "mcpServers")),
    Client(
      id: "cursor",
      displayName: "Cursor",
      // Only ever drawn where Cursor is not installed, and shared with
      // Bastion's row for the same client. The angle brackets went to VS Code
      // there, which is a code editor and nothing else.
      symbol: "cursorarrow",
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
    // The one client that keeps its servers under `servers`. Held back for two
    // releases on a mix-up between two files: `settings.json` is the JSONC one
    // people maintain by hand, but MCP servers live in `User/mcp.json`, which is
    // strict JSON written by VS Code itself. Every write here begins with a read
    // and `JSONSerialization` throws on a comment, so a file that somehow holds
    // one fails closed rather than being silently stripped of it.
    Client(
      id: "vscode",
      displayName: "Visual Studio Code",
      // The angle brackets, per the note on Cursor above: this one is a code
      // editor and nothing else. Only ever drawn where VS Code is not installed.
      symbol: "chevron.left.forwardslash.chevron.right",
      bundleID: "com.microsoft.VSCode",
      evidence: [
        URL(fileURLWithPath: "/Applications/Visual Studio Code.app"),
        URL(fileURLWithPath: "/opt/homebrew/bin/code"),
        URL(fileURLWithPath: "/usr/local/bin/code"),
      ],
      wiring: .json(
        path: support.appendingPathComponent("Code/User/mcp.json"), rootKey: "servers")),
    Client(
      id: "codex",
      // Named for the file rather than for one of the three things that read
      // it. "Codex CLI" sent somebody who had installed only the ChatGPT app
      // looking for a row that was already there.
      displayName: "ChatGPT & Codex",
      symbol: "terminal",
      // The ChatGPT app's, which is `com.openai.codex` — the desktop app took
      // the CLI's name, and it is one row here for the same reason: they read
      // one file. Somebody who has only the CLI gets the terminal glyph.
      bundleID: "com.openai.codex",
      evidence: [
        home.appendingPathComponent(".codex"),
        URL(fileURLWithPath: "/Applications/ChatGPT.app"),
        URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
        URL(fileURLWithPath: "/usr/local/bin/codex"),
      ],
      // The one file this app does not serialise. See `ClientWiringTOML`: it
      // splices the `[mcp_servers]` blocks and quotes every other byte verbatim,
      // because this config is somebody's hand-written prose and structure and a
      // round trip through any serialiser would reformat and de-comment it.
      wiring: .toml(path: home.appendingPathComponent(".codex/config.toml"))),
  ]

  // MARK: - What we write

  /// The bridge inside *this* bundle, never a hardcoded path.
  ///
  /// The same reasoning as the bridge launching its own app by path: whatever
  /// copy of Cupertino is doing the configuring is the copy the client should
  /// talk to. It also means this keeps working when the app moves to
  /// /Applications.
  static var bridgePath: String {
    // Seeded for a capture, and this one is not cosmetic: under screenshot mode
    // the app runs out of a build directory, so the real answer is an absolute
    // path through whoever built the image. It was invisible while the only
    // consumer was a pasteboard; the entries card puts it on screen.
    if DemoSeed.isEnabled { return DemoSeed.bridgePath }
    return Bundle.main.bundleURL
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

    /// One line, for the header of the detail pane and the tooltip on the
    /// sidebar dot.
    ///
    /// Written here rather than in the view so the two cannot drift, and so the
    /// sentence sits next to the case it describes. What it must not do is name
    /// a remedy: the buttons are two lines below it in the pane and nowhere near
    /// it in the sidebar.
    var summary: String {
      switch self {
      case .notInstalled: "Not installed on this Mac."
      case .notConfigured: "No Cupertino servers in this client's config yet."
      case .configured: "Every surface that is switched on is wired."
      case .stale(let found): "Wired to another copy of Cupertino, at \(found)."
      case .incomplete(let missing):
        "Wired, but missing \(missing.joined(separator: ", "))."
      case .extra(let leftover):
        "Still wired for \(leftover.joined(separator: ", ")), which are switched off."
      case .unreadable(let why): why
      }
    }
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
    return audit(servers: servers)
  }

  /// The whole-file verdict, from servers somebody has already read.
  ///
  /// Split out when the detail pane arrived: that pane reads the file once and
  /// derives its rows AND its header from that one read, and it must reach this
  /// verdict rather than a second one computed from a second read.
  static func audit(servers: [String: Any]) -> Status {
    status(
      from: ClientWiringMerge.audit(
        servers: servers, expectedCommand: bridgePath, expected: expected,
        unexpected: unexpected))
  }

  /// Routed through `read` rather than opening the file itself, so there is one
  /// door onto these configs — and so demo mode has one place to answer from.
  ///
  /// One path for both formats. There used to be a second, for the clients whose
  /// config this app would only paste a line for: it could report nothing, so it
  /// reported `.unknown`. Both of those clients are written now.
  static func status(of client: Client) -> Status {
    guard client.isInstalled else { return .notInstalled }
    do {
      guard let config = try read(client) else { return .notConfigured }
      return audit(servers: config.servers)
    } catch {
      return .unreadable(error.localizedDescription)
    }
  }

  // MARK: - Writing

  enum WriteError: LocalizedError {
    /// Somebody else's server is filed under a key `configure` was about to
    /// claim. Nothing was written.
    ///
    /// Recoverable, and the recovery is a decision rather than a retry: the pane
    /// names the keys and offers to overwrite them. See `collisions(of:)`.
    case collision(client: String, keys: [String])

    var errorDescription: String? {
      switch self {
      case .collision(let name, let keys):
        let list = keys.joined(separator: ", ")
        let verb = keys.count == 1 ? "was" : "were"
        return
          "\(list) in \(name)'s config \(verb) not written by Cupertino. Nothing was changed."
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
  /// `force` is the answer to `WriteError.collision` and nothing else. It skips
  /// the collision check and no other guard: the stamp, the retry, the backup
  /// and the atomic swap all still apply, and `isOurs` still decides what may be
  /// pruned.
  @discardableResult
  static func configure(_ client: Client, force: Bool = false) throws -> URL? {
    // Before the read the merge is computed from, so a refusal is never a
    // partial write. It costs one extra read of a file this is about to read
    // anyway, which is the cheapest part of the operation.
    if !force {
      let taken = collisions(of: client)
      guard taken.isEmpty else {
        throw WriteError.collision(client: client.displayName, keys: taken)
      }
    }
    let backup: URL?
    switch client.wiring {
    case .json(let path, let rootKey):
      backup = try mergeWrite(into: path, newFileMode: 0o600) { root in
        ClientWiringMerge.merged(
          into: root, rootKey: rootKey, entries: entries, legacy: legacyKeys, remove: disabledKeys)
      }
    case .toml(let path):
      // The legacy `apple-*` keys and the switched-off ones are removed by name
      // here rather than by the merge, because a splice deletes line ranges and
      // has no dictionary to diff. `spliceWrite` still refuses to delete a span
      // whose entry is not ours — see its `removing` argument.
      backup = try spliceWrite(
        into: path, upserting: entries,
        removing: Set(legacyKeys.values).union(disabledKeys))
    }
    hostLog("cupertino", .info, "configured \(client.displayName) at \(client.wiring.path.path)")
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
        let backup = try ClientWiringMerge.write(
          merge(root), to: path, backupSuffix: "cupertino-backup",
          expecting: stamp, newFileMode: newFileMode)
        // Hopped to the main actor rather than called: this enum is not isolated
        // and its callers are not all on the main thread. One runloop later is
        // soon enough for a redraw, and it is the only thing the revision drives.
        Task { @MainActor in ClientConfigRevision.shared.bump() }
        return backup
      } catch ClientWiringMerge.WriteError.changedUnderneath(_) where attempt < attempts {
        continue
      }
    }
    throw ClientWiringMerge.WriteError.changedUnderneath(path)
  }

  // MARK: - Reading the whole file

  /// One read of a client's config, feeding a whole pane.
  ///
  /// The status, the per-entry badges, the other servers in the file and the
  /// per-folder blocks are four questions about one file, and they used to be
  /// four separate reads — each opening a 130 KB JSON file on every redraw, and
  /// each free to disagree with the others about what was in it.
  struct Config {
    /// The servers under this client's own root key.
    let servers: [String: Any]
    /// The whole file, for the one card that needs a key beside `mcpServers`:
    /// Claude Code's per-folder blocks. See `hasLocalScope`. For a TOML config
    /// this is the servers object and nothing else — the rest of that file is
    /// never decoded, only quoted.
    let root: [String: Any]
    /// Entries the client has switched off with `enabled = false`.
    ///
    /// Codex only; no JSON client has such a key. Worth carrying separately
    /// because it is the one way a config can audit as `configured` while the
    /// client runs none of it — and unlike the equivalent blind spot in Claude
    /// Desktop, this one is a fact written in the file rather than a decision
    /// taken quietly at load.
    var disabled: Set<String> = []
  }

  /// The file this app reads for a client, and the key servers live under.
  ///
  /// A `.command` client answers with its `probe` — a file we read and never
  /// write — and nil where it has none, which is the same refusal `status(of:)`
  /// turns into `.unknown`.
  /// Display and reading only. Every WRITE reaches for `client.wiring` itself —
  /// `configure`, `unwire`, `removeEntry` and `collisions` all pattern-match it
  /// — which is what makes the demo-mode rewrite below safe: nothing can be
  /// written to a path that came out of here.
  static func configFile(of client: Client) -> (path: URL, rootKey: String) {
    let file = (path: client.wiring.path, rootKey: client.wiring.rootKey)
    // The pane prints this path, and all seven of them start at the real home
    // directory. See `DemoSeed.anonymised`.
    guard DemoSeed.isEnabled else { return file }
    return (DemoSeed.anonymised(file.path), file.rootKey)
  }

  /// nil when there is nothing to read — no file this app opens for this client,
  /// or none there yet. Throws when there IS a file and it will not parse, which
  /// is a fault worth reporting rather than an absence.
  static func read(_ client: Client) throws -> Config? {
    // The pane's whole subject is a file this Mac owns. A capture of it is a
    // capture of the developer's own servers, their project folders and their
    // home directory — so demo mode answers from a table, like every other fact
    // in these images. See `DemoSeed.clientConfig`.
    if DemoSeed.isEnabled { return DemoSeed.clientConfig(for: client) }
    let path = client.wiring.path
    guard FileManager.default.fileExists(atPath: path.path) else { return nil }
    switch client.wiring {
    case .json(_, let rootKey):
      let root = try ClientWiringMerge.readJSON(path)
      return Config(servers: root[rootKey] as? [String: Any] ?? [:], root: root)
    case .toml:
      // The only place in the app that learns this file is TOML. Everything
      // downstream — `isOurs`, `state`, `audit`, `collisions`, `foreignEntries`
      // — takes the servers object and cannot tell.
      let document = try ClientWiringTOML.read(path)
      let servers = document.servers
      return Config(
        servers: servers, root: [ClientWiringTOML.rootKey: servers],
        disabled: document.disabled)
    }
  }

  /// Whether this client's config is the one file that also holds per-folder
  /// servers.
  ///
  /// Claude Code's, and only Claude Code's. A `projects` key in anybody else's
  /// config is not an MCP scope, and drawing a card from it would be a
  /// straightforward lie about what the file says. Matched on the PATH rather
  /// than on the client id, because the id is a label and the path is the fact.
  static func hasLocalScope(_ client: Client) -> Bool {
    client.wiring.path.standardizedFileURL == claudeCodeConfig.standardizedFileURL
  }

  /// The keys `configure` would claim that somebody else's entry is under.
  ///
  /// Empty against every file nobody has hand-edited: `serverKey` reserves the
  /// `cupertino-` namespace precisely so this cannot happen by accident. For as
  /// long as nothing checked, though, the accident that could not happen was
  /// also the one that would be silently overwritten — and the asymmetry is what
  /// makes it worth a refusal rather than a comment. Writing our entry over
  /// theirs costs them a server; refusing costs us a second press.
  static func collisions(of client: Client) -> [String] {
    // Never a refusal in a capture: the answer would be read off a real file,
    // and a staged alert is not what these images are for.
    if DemoSeed.isEnabled { return [] }
    guard let config = try? read(client) else { return [] }
    return ClientWiringMerge.collisions(
      servers: config.servers, keys: SurfaceSettings.enabledSurfaces.map { serverKey(for: $0) })
  }

  // MARK: - Taking things back out

  /// Every entry this app wrote, out of one client's config.
  ///
  /// The other direction of `configure`, and deliberately not reachable from it:
  /// one button adds what is switched on, the other removes everything of ours,
  /// and neither can do the other's job. `isOurs` is what keeps the second one
  /// from being a way to delete somebody's config — see `ClientWiringMerge.unmerged`.
  ///
  /// A file that does not exist is nothing to do rather than a file to create.
  @discardableResult
  static func unwire(_ client: Client) throws -> URL? {
    let path = client.wiring.path
    guard FileManager.default.fileExists(atPath: path.path) else { return nil }
    let backup: URL?
    switch client.wiring {
    case .json(_, let rootKey):
      backup = try mergeWrite(into: path, newFileMode: 0o600) { root in
        ClientWiringMerge.unmerged(from: root, rootKey: rootKey)
      }
    case .toml:
      // Every key the file holds that `isOurs` claims — including one for a
      // surface this build has never heard of, which is exactly the entry worth
      // being able to clear.
      let servers = (try? read(client))?.servers ?? [:]
      let ours = servers.filter { ClientWiringMerge.isOurs($0.value) }.keys
      backup = try spliceWrite(into: path, upserting: [:], removing: Set(ours))
    }
    hostLog("cupertino", .info, "removed our entries from \(client.displayName) at \(path.path)")
    return backup
  }

  /// One named entry that this app did NOT write, out of one client's config.
  ///
  /// The last step of moving a hand-configured server over: it is running
  /// through Cupertino now, and the entry that starts its own copy is still
  /// there. `ClientWiringMerge.removing` refuses a key `isOurs` claims, so this
  /// cannot become a second route to `unwire`.
  ///
  /// `folder` names a Claude Code per-folder block, or nil for the user scope.
  @discardableResult
  static func removeEntry(
    _ key: String, from client: Client, inLocalScope folder: String? = nil
  ) throws -> URL? {
    let path = client.wiring.path
    guard FileManager.default.fileExists(atPath: path.path) else { return nil }
    let backup: URL?
    switch client.wiring {
    case .json(_, let rootKey):
      backup = try mergeWrite(into: path, newFileMode: 0o600) { root in
        if let folder {
          return ClientWiringMerge.removing(key: key, inLocalScope: folder, from: root)
        }
        return ClientWiringMerge.removing(key: key, from: root, rootKey: rootKey)
      }
    case .toml:
      // No local scope here: Codex keeps its project servers in a
      // `.codex/config.toml` inside each repository rather than a block in this
      // file, so there is nothing per-folder to remove. `hasLocalScope` is false
      // for this client and the pane draws no such rows.
      backup = try spliceWrite(into: path, upserting: [:], removing: [key])
    }
    hostLog(
      "cupertino", .info,
      "removed '\(key)' from \(client.displayName)"
        + (folder.map { " in \($0)" } ?? ""))
    return backup
  }

  /// Read, splice, write — the TOML counterpart to `mergeWrite`, with the same
  /// stamp, the same one retry, the same backup and the same atomic swap.
  ///
  /// Two things it does that the JSON path does not need to. It refuses to
  /// delete a span whose entry is not ours, because a splice removes lines by
  /// name and has no `isOurs` gate built into a dictionary merge the way
  /// `ClientWiringMerge.merged` does. And it skips the write entirely when the
  /// spliced text is identical to what is already there — which is what makes a
  /// second Configure a no-op rather than a fresh backup of an unchanged file.
  @discardableResult
  private static func spliceWrite(
    into path: URL,
    upserting: [String: [String: Any]],
    removing: Set<String>
  ) throws -> URL? {
    let attempts = 2
    for attempt in 1...attempts {
      let stamp = ClientWiringMerge.stamp(of: path)
      var document = ClientWiringTOML.empty
      if case .present = stamp { document = try ClientWiringTOML.read(path) }
      // Ours only, and decided from the document just read rather than from the
      // caller's list. A key somebody else owns is left where it is.
      let ours = removing.filter { name in
        guard let table = document.tables[name] else { return false }
        return ClientWiringMerge.isOurs(table.value)
      }
      let text = ClientWiringTOML.spliced(
        document, removing: Set(ours), upserting: upserting)
      guard text != document.text else { return nil }
      guard let data = text.data(using: .utf8) else { return nil }
      do {
        let backup = try ClientWiringMerge.write(
          data, to: path, backupSuffix: "cupertino-backup", expecting: stamp, newFileMode: 0o600)
        Task { @MainActor in ClientConfigRevision.shared.bump() }
        return backup
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

  /// Our entries out of one folder, whichever file they landed in.
  ///
  /// `forget` only ever dropped the folder from `UserDefaults`, which left the
  /// entries where they were: a folder "removed" from the list went on giving
  /// every session opened there a tool list nobody had asked for. Forgetting a
  /// folder and unwiring it are still two things — the list is a convenience and
  /// the file is the fact — but now both are possible.
  @discardableResult
  static func unwire(folder: URL, scope: ProjectScope) throws -> URL? {
    switch scope {
    case .project:
      let path = projectConfig(in: folder)
      guard FileManager.default.fileExists(atPath: path.path) else { return nil }
      return try mergeWrite(into: path, newFileMode: nil) { root in
        ClientWiringMerge.unmerged(from: root, rootKey: "mcpServers")
      }
    case .local:
      guard FileManager.default.fileExists(atPath: claudeCodeConfig.path) else { return nil }
      return try mergeWrite(into: claudeCodeConfig, newFileMode: 0o600) { root in
        ClientWiringMerge.unmergedFromLocalScope(from: root, folder: folder.path)
      }
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
