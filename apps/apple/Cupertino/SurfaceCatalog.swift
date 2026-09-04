import Foundation

/// What a surface's server actually exposes, read from the server itself.
///
/// ## Why this asks rather than knows
///
/// The obvious way to show a capability list in the app is to write one down in
/// Swift. That was rejected: the source of truth is `packages/*/src/tools/` and
/// `packages/*/src/prompts.ts`, a hand-kept copy over here would go stale the
/// first time somebody adds a tool, and `surfaces.json` exists precisely because
/// this repo has already paid for a list maintained in ten places.
///
/// So nothing is written down. This spawns the surface's server exactly the way
/// `ServerHost` does, performs the MCP handshake, and renders whatever comes
/// back. The list cannot drift from the servers because it *is* the servers.
///
/// ## What it is for
///
/// Browsing is the smaller half. The larger half is that this is the only place
/// the write gate can be *seen*: the app has always claimed that writes-off
/// means the mutating tools are never registered rather than refused later, and
/// that claim was asserted in a settings caption and demonstrated nowhere.
/// Because the spawn passes the current `allowWrites` through, flipping the
/// toggle and watching seven prompts and eleven tools appear is the claim,
/// executed.
///
/// ## Costs, and why they are acceptable
///
/// This starts a real node process per read. It is short-lived (handshake, three
/// list calls, exit), it holds no permission the server does not already have,
/// and the result is cached per surface *and per write setting* so switching
/// panes back and forth does not respawn anything. A server that hangs is killed
/// by the deadline below rather than leaving the pane spinning forever.
enum SurfaceCatalog {
  struct Item: Identifiable, Hashable {
    /// Tool or prompt name, or a resource URI.
    let name: String
    /// The first sentence of the description, where there is one.
    let detail: String?
    var id: String { name }
  }

  struct Capabilities: Equatable {
    let tools: [Item]
    let prompts: [Item]
    let resources: [Item]
    /// The write setting this was read under. The whole point of showing it.
    let allowWrites: Bool
  }

  enum Failure: LocalizedError {
    case notLocated(String)
    case noAnswer
    case badAnswer(String)

    var errorDescription: String? {
      switch self {
      case .notLocated(let why): why
      case .noAnswer:
        "The server did not answer. Its own diagnostics tool will say more once a client connects."
      case .badAnswer(let what): what
      }
    }
  }

  /// A server given longer than this is not slow, it is stuck. The handshake and
  /// three list calls are pure in-process work — no store is opened, no Apple
  /// Event is sent — so a healthy server answers in well under a second.
  private static let deadline: TimeInterval = 8

  /// Results already paid for.
  ///
  /// Keyed by the write setting as well as the surface, because that setting is
  /// what the probe is demonstrating: one cache entry per surface would hand
  /// back the pre-toggle list and quietly turn the feature into a lie.
  ///
  /// Never invalidated. A server's capability list is a pure function of its
  /// build and its configuration, and neither changes while the app is running
  /// — the one input that does is `allowWrites`, which is in the key.
  @MainActor private static var cache: [String: Capabilities] = [:]

  /// The cache key: surface, write setting, and every extra gate.
  ///
  /// `gates` is in here for exactly the reason `allowWrites` is, and leaving it
  /// out is a silent bug rather than a slow one. This pane spawns the real
  /// server to show what it registers, so a key that ignored a gate would keep
  /// answering with the pre-toggle tool list — the pane would go on insisting
  /// `find_codes` does not exist after the user had just switched it on, which
  /// is precisely the "demonstrated, not claimed" property this type exists to
  /// provide. Sorted so two identical sets cannot produce two keys.
  private static func key(_ surface: Surface, _ allowWrites: Bool, _ gates: [String]) -> String {
    "\(surface.id)/\(allowWrites)/\(gates.sorted().joined(separator: "+"))"
  }

  @MainActor static func cached(_ surface: Surface, allowWrites: Bool, gates: [String] = [])
    -> Capabilities?
  {
    cache[key(surface, allowWrites, gates)]
  }

  static func read(_ surface: Surface, allowWrites: Bool, gates: [String] = []) async throws
    -> Capabilities
  {
    if let hit = await cached(surface, allowWrites: allowWrites, gates: gates) { return hit }

    // A capability is served in-process, so there is nothing to locate and
    // nothing to spawn. Asking `ServerLocator` produced "dev.json is unusable"
    // on this pane — a real error about a file that has no bearing on a server
    // which is not a node process at all.
    //
    // This still DEMONSTRATES rather than claims, which is the whole point of
    // this type: it drives `InProcessServers.handle` — the same dispatch an MCP
    // client reaches through the bridge — rather than describing the tool list
    // a second time in Swift.
    if surface.runtime == .swift {
      let caps = try inProcess(surface, allowWrites: allowWrites)
      let cacheKey = key(surface, allowWrites, gates)
      await MainActor.run { cache[cacheKey] = caps }
      return caps
    }

    let binaries: ServerBinaries
    do {
      binaries = try ServerLocator.locate(surface)
    } catch {
      throw Failure.notLocated(error.localizedDescription)
    }

    return try await withCheckedThrowingContinuation { continuation in
      onDedicatedThread("catalog-\(surface.id)") {
        do {
          let caps = try probe(surface, binaries, allowWrites: allowWrites, gates: gates)
          let cacheKey = key(surface, allowWrites, gates)
          Task { @MainActor in cache[cacheKey] = caps }
          continuation.resume(returning: caps)
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  /// The same three list calls the spawning probe makes, over the in-process
  /// server. No process, no pipes, no deadline: it cannot hang, because there
  /// is nothing to wait for.
  ///
  /// Every input a registration depends on is passed explicitly — which server,
  /// the write flag, and each gate BY ID — because getting one wrong here is
  /// invisible rather than loud. The card renders a perfectly plausible list
  /// that belongs to another surface, or to another setting, and looks right.
  /// It rendered `screen`'s on the Sound pane.
  private static func inProcess(_ surface: Surface, allowWrites: Bool) throws -> Capabilities {
    func ask(_ method: String) -> InProcessServers.Reply {
      InProcessServers.handle(
        #"{"jsonrpc":"2.0","id":1,"method":"\#(method)"}"#,
        surface: surface,
        // Forwarded rather than dropped, and forwarding it IS the feature: with
        // writes off, `apple_sound_set_volume` is absent from this list because
        // it was never registered, which is the claim this card exists to
        // execute. It arrived here and went nowhere, so the Sound pane could
        // not have shown a write tool even once the server was the right one.
        allowWrites: allowWrites,
        // The cache key already includes the gates, so these are read once per
        // distinct setting rather than once per render.
        gateOn: { SurfaceSettings.isGateOn(surface, id: $0) })
    }

    // A surface whose runtime says swift and which no server claims would
    // otherwise render as three empty lists — a lie that looks like a server
    // with nothing to offer. `ping` because every in-process server answers it
    // and it touches nothing.
    if case .noServer = ask("ping") {
      throw Failure.badAnswer("This build has no in-process server for \(surface.id).")
    }

    func list(_ method: String, _ key: String, _ name: @escaping ([String: Any]) -> String)
      -> [Item]
    {
      guard case .message(let reply) = ask(method),
        let data = reply.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let result = object["result"] as? [String: Any],
        let raw = result[key] as? [[String: Any]]
      else { return [] }
      return raw.map { Item(name: name($0), detail: firstSentence($0["description"] as? String)) }
        .sorted { $0.name < $1.name }
    }
    return Capabilities(
      tools: list("tools/list", "tools") { $0["name"] as? String ?? "?" },
      prompts: list("prompts/list", "prompts") { $0["name"] as? String ?? "?" },
      resources: list("resources/list", "resources") { $0["uri"] as? String ?? "?" },
      allowWrites: allowWrites)
  }

  // ─── the probe ─────────────────────────────────────────────────────────────

  private static func probe(
    _ surface: Surface, _ binaries: ServerBinaries, allowWrites: Bool, gates: [String]
  ) throws -> Capabilities {
    let process = Process()
    process.executableURL = binaries.node
    process.arguments = [binaries.script.path]
    process.environment = ServerLocator.environment(
      for: surface, allowWrites: allowWrites, gates: gates)

    let toChild = Pipe()
    let fromChild = Pipe()
    let childErr = Pipe()
    process.standardInput = toChild
    process.standardOutput = fromChild
    process.standardError = childErr

    try process.run()

    // Killing the process is what unblocks a read that would otherwise wait
    // forever; the reader below sees EOF rather than a timeout it has to model.
    let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + deadline, execute: watchdog)
    defer {
      watchdog.cancel()
      if process.isRunning { process.terminate() }
      // Drain, or the child can block writing into a pipe nobody is reading and
      // never reach exit.
      try? childErr.fileHandleForReading.close()
      try? fromChild.fileHandleForReading.close()
      try? toChild.fileHandleForWriting.close()
    }

    let reader = LineReader(handle: fromChild.fileHandleForReading)
    let out = toChild.fileHandleForWriting

    func send(_ id: Int, _ method: String, _ params: [String: Any] = [:]) throws {
      let message: [String: Any] = [
        "jsonrpc": "2.0", "id": id, "method": method, "params": params,
      ]
      var line = try JSONSerialization.data(withJSONObject: message)
      line.append(0x0A)
      guard writeAll(out.fileDescriptor, line) else { throw Failure.noAnswer }
    }

    func notify(_ method: String) throws {
      var line = try JSONSerialization.data(withJSONObject: [
        "jsonrpc": "2.0", "method": method,
      ])
      line.append(0x0A)
      _ = writeAll(out.fileDescriptor, line)
    }

    /// Read until the response with this id arrives. Anything else on the wire
    /// — a notification, a log line that happens to be JSON — is skipped rather
    /// than mistaken for the answer.
    func awaitResult(_ id: Int) throws -> [String: Any] {
      while let line = reader.next() {
        guard
          let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          object["id"] as? Int == id
        else { continue }
        if let error = object["error"] as? [String: Any] {
          // Not a failure: a server with no prompts registered never declares
          // the capability, so "method not found" here is the write gate or
          // EXPOSE_PROMPTS doing exactly what it promises. An empty list is the
          // honest rendering of that.
          throw Failure.badAnswer(error["message"] as? String ?? "unknown error")
        }
        return object["result"] as? [String: Any] ?? [:]
      }
      throw Failure.noAnswer
    }

    try send(
      1, "initialize",
      [
        "protocolVersion": "2025-06-18", "capabilities": [:],
        "clientInfo": ["name": "Cupertino.app", "version": AppInfo.version],
      ])
    _ = try awaitResult(1)
    try notify("notifications/initialized")

    /// A list that is absent is empty here, not an error — see `awaitResult`.
    func list(_ id: Int, _ method: String, _ key: String, _ name: (([String: Any]) -> String))
      -> [Item]
    {
      guard (try? send(id, method)) != nil, let result = try? awaitResult(id) else { return [] }
      let raw = result[key] as? [[String: Any]] ?? []
      return raw.map { entry in
        Item(name: name(entry), detail: firstSentence(entry["description"] as? String))
      }
      .sorted { $0.name < $1.name }
    }

    let tools = list(2, "tools/list", "tools") { $0["name"] as? String ?? "?" }
    let prompts = list(3, "prompts/list", "prompts") { $0["name"] as? String ?? "?" }
    let resources = list(4, "resources/list", "resources") { $0["uri"] as? String ?? "?" }

    return Capabilities(
      tools: tools, prompts: prompts, resources: resources, allowWrites: allowWrites)
  }

  /// Descriptions in this repo are paragraphs — deliberately, they are where the
  /// constraints live — and a pane is not where you read one. The first sentence
  /// identifies; the rest is for the model.
  private static func firstSentence(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    let flattened = text.replacingOccurrences(of: "\n", with: " ")
    guard let end = flattened.firstIndex(of: ".") else { return flattened }
    return String(flattened[..<end]) + "."
  }
}

/// Newline-delimited reader over a pipe.
///
/// The same framing problem `RequestObserver` documents: reads come back in
/// chunks with no regard for line boundaries, so a response that straddles two
/// of them is lost by anything that splits each chunk on its own.
private final class LineReader {
  private let handle: FileHandle
  private var pending = Data()
  private var done = false

  init(handle: FileHandle) { self.handle = handle }

  func next() -> Data? {
    while true {
      if let index = pending.firstIndex(of: 0x0A) {
        let line = pending[..<index]
        pending = Data(pending[pending.index(after: index)...])
        if !line.isEmpty { return Data(line) }
        continue
      }
      if done { return nil }
      let chunk = handle.availableData
      if chunk.isEmpty {
        done = true
        return pending.isEmpty ? nil : Data(pending)
      }
      pending.append(chunk)
    }
  }
}
