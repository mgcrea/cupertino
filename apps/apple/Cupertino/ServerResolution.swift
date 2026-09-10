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

/// The decision `ServerLocator.locate` makes, with every input passed in.
///
/// Apart from the locator so `make unit` can build it on disk and check it: the
/// locator reads `Bundle.main` and the socket directory, and a rule about which
/// file wins is only worth trusting once it has been run against real files.
///
/// ## dev.json wins, and why that is not the obvious order
///
/// The bundle used to be asked first and `dev.json` only when the bundle had no
/// copy. That reads as "prefer what ships", and in a Debug build it is backwards.
/// `dev.json` exists only because somebody ran `make dev-config` to point the app
/// at the workspace, while a bundled copy inside a Debug app is whatever was last
/// copied in by hand, and nothing ever removes it. MEASURED on 2026-09-10: a
/// Debug app held servers from 31 August, reported version 1.5.0 against a
/// workspace at 1.20.1, and ran them for days while dev.json named the workspace.
/// Every probe read month-old code, and it looked like the new code not working.
///
/// So an explicit opt-in that cannot be honoured is an error, never a quiet fall
/// back to the bundle. The quiet fall back is precisely the failure above.
enum ServerResolution {
  /// - Parameter devConfig: where a Debug build reads `dev.json`. Nil in a
  ///   Release build, which therefore resolves exactly as it always has.
  static func resolve(id: String, resources: URL?, devConfig: URL?) throws -> ServerBinaries {
    if let devConfig, let development = try development(id: id, config: devConfig) {
      return development
    }

    guard let resources else {
      throw LocateError.notBundled(surface: id, expected: "Contents/Resources")
    }
    let node = resources.appendingPathComponent("node")
    let script =
      resources
      .appendingPathComponent("servers")
      .appendingPathComponent(id)
      .appendingPathComponent("dist/cli.js")

    let exists = FileManager.default.fileExists(atPath:)
    if exists(node.path), exists(script.path) {
      return ServerBinaries(node: node, script: script, isDevelopment: false)
    }
    throw LocateError.notBundled(surface: id, expected: script.path)
  }

  /// The workspace build `dev.json` names, or nil when there is no `dev.json`.
  ///
  ///     { "node": "/opt/homebrew/opt/node@24/bin/node",
  ///       "repo": "/Users/you/Projects/apps/cupertino" }
  ///
  /// Read from a file rather than the environment because LaunchServices does
  /// not hand an app the developer's shell environment.
  private static func development(id: String, config: URL) throws -> ServerBinaries? {
    guard let data = try? Data(contentsOf: config) else { return nil }

    guard
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let node = json["node"], let repo = json["repo"]
    else { throw LocateError.devConfigInvalid("expected {\"node\": …, \"repo\": …}") }

    let script = URL(fileURLWithPath: repo)
      .appendingPathComponent("packages")
      .appendingPathComponent(id)
      .appendingPathComponent("dist/cli.js")

    let exists = FileManager.default.fileExists(atPath:)
    guard exists(node) else { throw LocateError.devConfigInvalid("no node at \(node)") }
    guard exists(script.path) else {
      throw LocateError.devConfigInvalid("no build at \(script.path) — run `pnpm -r build`")
    }
    return ServerBinaries(node: URL(fileURLWithPath: node), script: script, isDevelopment: true)
  }
}
