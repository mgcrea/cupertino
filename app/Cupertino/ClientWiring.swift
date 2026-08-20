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
enum ClientWiring {
  /// How a client's config file is shaped.
  enum Shape {
    /// Strict JSON, servers under a top-level `mcpServers` object.
    case mcpServersJSON
  }

  struct Client: Identifiable, Hashable {
    let id: String
    let displayName: String
    /// Config file, which may not exist yet.
    let configPath: URL
    /// Something that proves the client is installed even with no config yet.
    let evidencePath: URL?
    let shape: Shape

    var isInstalled: Bool {
      let fm = FileManager.default
      if let evidence = evidencePath, fm.fileExists(atPath: evidence.path) { return true }
      return fm.fileExists(atPath: configPath.path)
    }
  }

  private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

  /// Deliberately a short list. Two clients are **excluded on purpose**:
  ///
  /// - **VS Code** keeps its settings in JSONC. Re-serialising it would delete
  ///   every comment in a file the user maintains by hand.
  /// - **Claude Code** (`~/.claude.json`) is a large file — 71 top-level keys on
  ///   this machine, including API credentials — that running sessions write to
  ///   concurrently. Rewriting it risks losing someone else's edit. It gets a
  ///   copyable `claude mcp add` command instead, which is the supported path.
  static let clients: [Client] = [
    Client(
      id: "claude-desktop",
      displayName: "Claude Desktop",
      configPath: home.appendingPathComponent(
        "Library/Application Support/Claude/claude_desktop_config.json"),
      evidencePath: URL(fileURLWithPath: "/Applications/Claude.app"),
      shape: .mcpServersJSON),
    Client(
      id: "cursor",
      displayName: "Cursor",
      configPath: home.appendingPathComponent(".cursor/mcp.json"),
      evidencePath: URL(fileURLWithPath: "/Applications/Cursor.app"),
      shape: .mcpServersJSON),
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

  static func serverKey(for surface: Surface) -> String { "apple-\(surface.id)" }

  /// The command for clients we decline to edit.
  static var claudeCodeCommands: String {
    Surface.all.map { surface in
      "claude mcp add \(serverKey(for: surface)) -- \"\(bridgePath)\" --server=\(surface.id)"
    }
    .joined(separator: "\n")
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
    case unreadable(String)
  }

  static func status(of client: Client) -> Status {
    guard client.isInstalled else { return .notInstalled }
    guard FileManager.default.fileExists(atPath: client.configPath.path) else {
      return .notConfigured
    }
    do {
      let root = try readJSON(client.configPath)
      let servers = root["mcpServers"] as? [String: Any] ?? [:]
      let expected = bridgePath
      var missing: [String] = []
      for surface in Surface.all {
        guard let entry = servers[serverKey(for: surface)] as? [String: Any] else {
          missing.append(surface.displayName)
          continue
        }
        if (entry["command"] as? String) != expected {
          return .stale((entry["command"] as? String) ?? "unknown")
        }
      }
      // A partially wired config used to report `.configured`, because any one
      // matching entry was enough. That made every new surface invisible to
      // everyone who had already configured the client — a green check beside a
      // config that would never gain the new server.
      if missing.count == Surface.all.count { return .notConfigured }
      return missing.isEmpty ? .configured : .incomplete(missing)
    } catch {
      return .unreadable(error.localizedDescription)
    }
  }

  // MARK: - Writing

  enum WriteError: LocalizedError {
    case notJSONObject(URL)

    var errorDescription: String? {
      switch self {
      case .notJSONObject(let url):
        return "\(url.lastPathComponent) is not a JSON object; leaving it alone"
      }
    }
  }

  private static func readJSON(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    if data.isEmpty { return [:] }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw WriteError.notJSONObject(url)
    }
    return object
  }

  /// Merge our servers in, leaving everything else untouched.
  ///
  /// Three properties this has to hold, because the file belongs to someone
  /// else: every unrelated key survives, the previous contents are recoverable,
  /// and a crash mid-write cannot leave a truncated config.
  @discardableResult
  static func configure(_ client: Client) throws -> URL? {
    let fm = FileManager.default
    var root: [String: Any] = [:]
    var backup: URL?

    if fm.fileExists(atPath: client.configPath.path) {
      root = try readJSON(client.configPath)
      backup = client.configPath.appendingPathExtension("cupertino-backup")
      try? fm.removeItem(at: backup!)
      try fm.copyItem(at: client.configPath, to: backup!)
    } else {
      try fm.createDirectory(
        at: client.configPath.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    var servers = root["mcpServers"] as? [String: Any] ?? [:]
    for surface in Surface.all {
      servers[serverKey(for: surface)] = entry(for: surface)
    }
    root["mcpServers"] = servers

    let data = try JSONSerialization.data(
      withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])

    // Write beside the target, then swap: a config half-written because the
    // machine slept is worse than one not written at all.
    let temp = client.configPath.deletingLastPathComponent()
      .appendingPathComponent(".cupertino-\(UUID().uuidString).tmp")
    try data.write(to: temp, options: .atomic)
    _ = try fm.replaceItemAt(client.configPath, withItemAt: temp)

    hostLog("cupertino", .info, "configured \(client.displayName) at \(client.configPath.path)")
    return backup
  }

  static func reveal(_ client: Client) {
    NSWorkspace.shared.activateFileViewerSelecting([client.configPath])
  }
}
