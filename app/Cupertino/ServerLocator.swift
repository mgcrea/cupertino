import Foundation

/// Where a surface's server actually lives.
struct ServerBinaries {
  let node: URL
  let script: URL
  /// True when these came from the dev override rather than the bundle.
  let isDevelopment: Bool
}

enum LocateError: LocalizedError {
  case notBundled(surface: String, expected: String)
  case devConfigInvalid(String)

  var errorDescription: String? {
    switch self {
    case .notBundled(let surface, let expected):
      return "the \(surface) server is not in this build (expected \(expected))"
    case .devConfigInvalid(let detail):
      return "dev.json is unusable: \(detail)"
    }
  }
}

enum ServerLocator {
  /// Production layout, per `docs/distribution.md`:
  ///
  ///     Cupertino.app/Contents/Resources/node
  ///     Cupertino.app/Contents/Resources/servers/<id>/cli.js
  ///
  /// Node is embedded rather than borrowed from the system: the official
  /// nodejs.org darwin builds are a single self-contained binary, which pins
  /// the `node:sqlite` requirement and removes any "which node?" question.
  static func locate(_ surface: Surface) throws -> ServerBinaries {
    guard let resources = Bundle.main.resourceURL else {
      throw LocateError.notBundled(surface: surface.id, expected: "Contents/Resources")
    }
    let node = resources.appendingPathComponent("node")
    let script = resources
      .appendingPathComponent("servers")
      .appendingPathComponent(surface.id)
      .appendingPathComponent("cli.js")

    let exists = FileManager.default.fileExists(atPath:)
    if exists(node.path), exists(script.path) {
      return ServerBinaries(node: node, script: script, isDevelopment: false)
    }

    #if DEBUG
      // Before the Makefile staging in docs/distribution.md exists, run the
      // servers straight out of the workspace. Read from a file rather than the
      // environment because LaunchServices does not hand an app the developer's
      // shell environment.
      if let dev = try developmentBinaries(surface) { return dev }
    #endif

    throw LocateError.notBundled(surface: surface.id, expected: script.path)
  }

  #if DEBUG
    /// `~/Library/Application Support/io.mgcrea.cupertino/dev.json`:
    ///
    ///     { "node": "/opt/homebrew/opt/node@24/bin/node",
    ///       "repo": "/Users/you/Projects/.../mcp-apple-mail" }
    private static func developmentBinaries(_ surface: Surface) throws -> ServerBinaries? {
      let url = URL(fileURLWithPath: BridgeProtocol.socketDirectory)
        .appendingPathComponent("dev.json")
      guard let data = try? Data(contentsOf: url) else { return nil }

      guard
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
        let node = json["node"], let repo = json["repo"]
      else { throw LocateError.devConfigInvalid("expected {\"node\": …, \"repo\": …}") }

      let script = URL(fileURLWithPath: repo)
        .appendingPathComponent("packages")
        .appendingPathComponent(surface.id)
        .appendingPathComponent("dist/cli.js")

      let exists = FileManager.default.fileExists(atPath:)
      guard exists(node) else { throw LocateError.devConfigInvalid("no node at \(node)") }
      guard exists(script.path) else {
        throw LocateError.devConfigInvalid("no build at \(script.path) — run `pnpm -r build`")
      }
      return ServerBinaries(
        node: URL(fileURLWithPath: node), script: script, isDevelopment: true)
    }
  #endif

  /// The environment handed to a server process.
  ///
  /// Deliberately minimal, matching what `packages/core/src/osascript.ts` does
  /// when it spawns osascript with `PATH` only: a server inherits nothing it was
  /// not given on purpose.
  static func environment(for surface: Surface, allowWrites: Bool) -> [String: String] {
    var env = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
    if allowWrites { env["\(surface.envPrefix)ALLOW_WRITES"] = "1" }
    return env
  }
}
