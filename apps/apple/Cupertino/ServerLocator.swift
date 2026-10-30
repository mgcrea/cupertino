import Foundation

nonisolated enum ServerLocator {
  /// Production layout, per `docs/distribution.md`:
  ///
  ///     Cupertino.app/Contents/Resources/node
  ///     Cupertino.app/Contents/Resources/servers/<id>/package.json
  ///     Cupertino.app/Contents/Resources/servers/<id>/dist/cli.js
  ///
  /// The `package.json` + `dist/` shape is not decoration: `build-info.ts`
  /// reads its version from `new URL("../package.json", import.meta.url)`, so a
  /// flat `servers/<id>/cli.js` would resolve to one shared file and report the
  /// wrong version in diagnostics.
  ///
  /// Node is embedded rather than borrowed from the system: the official
  /// nodejs.org darwin builds are a single self-contained binary, which pins
  /// the `node:sqlite` requirement and removes any "which node?" question.
  ///
  /// A Debug build also reads `dev.json` beside its socket, written by `make
  /// dev-config`, and when it is there it WINS over anything bundled.
  /// `ServerResolution` records why that order, and checks it on disk.
  static func locate(_ surface: Surface) throws -> ServerBinaries {
    #if DEBUG
      let devConfig: URL? = URL(fileURLWithPath: BridgeProtocol.socketDirectory)
        .appendingPathComponent("dev.json")
    #else
      let devConfig: URL? = nil
    #endif
    return try ServerResolution.resolve(
      id: surface.id, resources: Bundle.main.resourceURL, devConfig: devConfig)
  }

  /// The environment handed to a server process.
  ///
  /// Deliberately minimal, matching what `packages/core/src/osascript.ts` does
  /// when it spawns osascript with `PATH` only: a server inherits nothing it was
  /// not given on purpose.
  /// - Parameter gates: env SUFFIXES of the extra gates that are on, from
  ///   `SurfaceSettings.enabledGates`. Empty for every surface but Messages
  ///   today. Passing the enabled set rather than reading `UserDefaults` here
  ///   keeps this function pure, which is what lets `SurfaceCatalog` ask it for
  ///   a hypothetical configuration when it builds its capability cache.
  /// - Parameter lazyTools: whether this surface should serve a searchable index
  ///   and a dispatcher instead of its tools. Defaults to OFF, and the default
  ///   is load-bearing for `SurfaceCatalog`: the capability cache exists to
  ///   report what a surface can actually do, and a probe that asked a lazy
  ///   server would answer "four tools" for every surface in the app.
  /// The socket a server may call back on, and who it may say it is.
  ///
  /// Host plumbing rather than user configuration, which is why these two are
  /// `CUPERTINO_` and not `APPLE_<SURFACE>_`: nothing a person sets in a client
  /// config should be able to name them, and a server that finds them absent is
  /// simply not hosted by the app. That absence is the fallback signal — the npm
  /// packages are published artifacts and have to keep working with no app on
  /// the machine at all — so it is deliberately load-bearing rather than an
  /// error case.
  ///
  /// Handed to every node surface that HAS an app. A capability has no bundleID,
  /// so there would be nothing to scope a lend to. Presence is not permission:
  /// `ServerHost` still proves the caller with `LOCAL_PEERPID` and still answers
  /// to the borrower's own gates.
  /// The texts the gates that are ON carry, keyed by env suffix, for `environment`.
  ///
  /// A value goes with its gate or not at all: the cookie hosts of a switched-off
  /// cookie gate are not passed, so turning the switch off is the whole of
  /// turning the tool off, whatever is still typed in the field. Whitespace is
  /// trimmed and an empty text is left out, so the server sees its default
  /// (for cookie hosts, none) rather than an empty variable.
  ///
  /// Pure, with the two reads injected, so `make unit` can check it without
  /// `UserDefaults`; `SurfaceSettings.gateValues` supplies them.
  static func gateValues(
    for surface: Surface, isOn: (Surface.Gate) -> Bool, text: (Surface.Gate) -> String?
  ) -> [String: String] {
    var values: [String: String] = [:]
    for gate in surface.gates {
      guard let value = gate.value, isOn(gate) else { continue }
      let trimmed = (text(gate) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { values[value.envSuffix] = trimmed }
    }
    return values
  }

  static let axSocketVar = "CUPERTINO_AX_SOCKET"
  static let axIdentityVar = "CUPERTINO_AX_FOR"

  /// - Parameter values: env SUFFIX → text, from `gateValues`. Passed as is.
  static func environment(
    for surface: Surface, allowWrites: Bool, gates: [String] = [],
    values: [String: String] = [:], lazyTools: Bool = false
  )
    -> [String: String]
  {
    var env = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
    if allowWrites { env["\(surface.envPrefix)ALLOW_WRITES"] = "1" }
    for suffix in gates { env["\(surface.envPrefix)\(suffix)"] = "1" }
    for (suffix, value) in values { env["\(surface.envPrefix)\(suffix)"] = value }
    if lazyTools { env["\(surface.envPrefix)LAZY_TOOLS"] = "1" }
    if surface.runtime == .node, surface.bundleID != nil,
      BridgeProtocol.isAddressable(BridgeProtocol.socketPath)
    {
      env[axSocketVar] = BridgeProtocol.socketPath
      env[axIdentityVar] = surface.id
    }
    return env
  }
}
