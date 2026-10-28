import Foundation

/// What the person answered in the Shell window.
nonisolated enum ShellPromptAnswer: Sendable, Equatable {
  case runOnce
  /// "Run, and stop asking this session". Counts only when the window offered it.
  case runForSession
  case dontRun
  /// The window closed itself after `ShellPolicy.askTimeout`.
  case noAnswer
  /// The window was closed for the person: the call was cancelled, the client hung up, or
  /// Shell was switched off. Nothing they chose.
  case cancelled
}

/// Everything the window shows, and what identifies the request a cancel names.
nonisolated struct ShellPrompt: Sendable {
  /// The MCP `clientInfo.name`, which the client chooses and Cupertino cannot verify.
  var client: String
  /// The agent's own words.
  var purpose: String
  /// The full text, never a summary or an excerpt.
  var script: String
  var stdin: String?
  var interpreter: ShellRunner.Interpreter
  /// Absolute, with `~` already expanded.
  var cwd: String
  var timeoutSeconds: Int
  /// Whether to show "Run, and stop asking this session".
  var offerSession: Bool
  var connection: UUID
  /// The key `InProcessCalls` knows the request by, and the one `cancel` names.
  var requestId: String
}

/// The window and the card, as `ShellServer` needs them. `ShellConsent` in the app; a fake in
/// the checks, so nothing here needs a screen.
nonisolated protocol ShellConsenting: Sendable {
  /// Show the window and block the calling (worker) thread until it is answered, closed after
  /// `ShellPolicy.askTimeout`, or cancelled.
  func ask(_ prompt: ShellPrompt) -> ShellPromptAnswer
  /// Close the window for this request, or drop it from the queue, answering `.cancelled`.
  ///
  /// It can arrive just before the `ask` it names, on another thread: the server marks the
  /// request as being asked, then calls `ask`, and a cancel can land in between. That `ask`
  /// must then answer `.cancelled` at once rather than show the window. The server never runs a
  /// request whose cancel it has seen, whatever `ask` answers, so getting this wrong costs a
  /// window left up, not a run.
  func cancel(connection: UUID, requestId: String)
  /// Show the card for a run that had no window. Called just before the script starts, and
  /// `stop` cancels the run from then on, so calling it here, inside `running`, means the script
  /// never starts. The returned token's `ended()` removes the card once the run is over.
  func running(_ prompt: ShellPrompt, stop: @escaping @Sendable () -> Void) -> any ShellNoticeToken
}

/// One card on screen. `ended()` takes it down.
nonisolated protocol ShellNoticeToken: Sendable {
  func ended()
}

/// The MCP server for the `shell` surface: one script, run under Cupertino's grants, after the
/// person approves it.
///
/// Served in-process, like `ScreenServer`, because the point of the surface is that the script
/// is Cupertino's own child and so holds Cupertino's grants. A node hop would make the child the
/// node server's.
///
/// ## The order a run goes through
///
/// 1. The arguments. A request that fails them is refused before anything is decided, and
///    shows no window.
/// 2. `ShellPolicy.decide`, over "Before running" as `ShellSeal` reads it, this connection's
///    session approval and cooldown, and the runs in flight.
/// 3. The window, through `consent`, when the decision is to ask.
/// 4. A started line in `ShellRecord`, on disk before the script is spawned, then
///    `ShellRunner`, with the card when no window was shown.
/// 5. One line in `ShellRecord` for how it ended, whatever happened, a refusal as much as a
///    run. A run's two lines share a `runId`.
///
/// ## Cancelling
///
/// A call that will ask or run registers one canceller with `InProcessCalls` before it does
/// either. The canceller only sets a flag under the call's own lock and stops what already
/// exists: it closes the window if one is up, and stops the run if one has started. The call
/// checks the flag before it asks, after the window answers, before it starts the script and
/// again right after. So a cancel that lands before any of that (a request queued behind
/// another, a client that hung up first) means nothing is asked and nothing runs, and the
/// request is recorded as `cancelled`. `register` is never called with a lock held that the
/// canceller takes, because it may run the canceller inline.
///
/// ## Four at once
///
/// The count of runs in flight is this server's own, app-wide, and never `ShellRunner.live`, so
/// it counts only requests this server let run. A slot is taken under the same lock as the
/// decision, so two requests that were both approved cannot make five.
///
/// Windows are capped the same way: at most `ShellPolicy.maxWaiting` requests wait for the
/// person at once, app-wide, the one on screen included. One past that is refused as busy and
/// opens nothing, so an agent cannot stack windows in front of somebody to wear them down.
///
/// ## A cooldown follows the client's name
///
/// After "Don't run" or no answer, the connection and also the client's name are refused for
/// `ShellPolicy.declineCooldown`. An agent with a shell can open a new connection per retry, so
/// a cooldown kept per connection alone would cost it nothing. Closing a connection drops its
/// own state, never its name's cooldown, which ends on its own. The name is whatever the client
/// says it is, so two clients that share one share a cooldown.
///
/// Foundation only, so `make shell-check` drives it with a fake window.
nonisolated enum ShellServer {

  /// The window. Until the app wires in its own at launch, a stand-in that answers `.cancelled`
  /// without asking, so nothing can run in a build where no window can be shown.
  nonisolated(unsafe) static var consent: any ShellConsenting = NoWindow()

  /// The client's `clientInfo.name` for a connection. The app looks it up in `Sessions`.
  nonisolated(unsafe) static var clientName: @Sendable (UUID) -> String = { _ in "a client" }

  /// Whether Cupertino holds Full Disk Access, for the diagnostics. `Permissions` imports
  /// AppKit, which `make shell-check` cannot compile, so the app wires its check in at launch
  /// and the checks stub it. Until then it says no rather than guess.
  nonisolated(unsafe) static var fullDiskAccess: @Sendable () -> Bool = { false }

  /// Where "Before running" is read from, through `ShellSeal`. The checks set a scratch suite.
  nonisolated(unsafe) static var defaults: UserDefaults = .standard

  /// The time cooldowns and session approvals are measured by. The checks move it on rather
  /// than wait.
  nonisolated(unsafe) static var clock: @Sendable () -> Date = { Date() }

  static let maxScriptBytes = 512 * 1024
  /// With the script at its limit, still well inside the host's 1 MiB line, which drops a
  /// longer one with no answer at all.
  static let maxStdinBytes = 256 * 1024
  static let maxPurposeChars = 500
  static let defaultTimeoutSeconds = 60
  static let timeoutRange = 1...600

  static let instructions =
    "Runs a script with Cupertino's access, including Full Disk Access when Cupertino has it. The "
    + "person sees the full script and decides each run unless they have chosen otherwise. A "
    + "refusal means ask them in the conversation, not retry. Put related work in one script "
    + "rather than many small runs: each run can cost them a decision."

  // MARK: - Dispatch

  /// `connection` is the session the request arrived on: a session approval, a cooldown and a
  /// cancel all belong to it. nil from a capability probe, which only lists tools.
  static func handle(_ line: String, surface: Surface, connection: UUID?) -> String? {
    InProcessRPC.dispatch(
      line,
      name: "cupertino-shell",
      instructions: instructions,
      tools: { tools },
      resources: { resources },
      read: { uri, id in readResource(uri, id: id) },
      call: { name, args, id in call(name, args: args, id: id, connection: connection) })
  }

  /// The connection closed: its session approval and its own cooldown go with it. Its client
  /// name's cooldown stays until it ends.
  static func connectionClosed(_ connection: UUID) {
    state.lock.withLock { _ = state.connections.removeValue(forKey: connection) }
  }

  /// "Before running" is `before` now. When that is a change from the last value seen, every
  /// session approval goes: a person who moves away from "Ask once per session" has withdrawn
  /// them, even if they move back before they would have run out. The app calls this whenever
  /// its defaults change, and every request calls it with the value it was decided under, so a
  /// change is seen at the latest by the next request.
  static func beforeObserved(_ before: ShellPolicy.Before) {
    state.lock.withLock { noteBefore(before) }
  }

  /// Under `state.lock`.
  private static func noteBefore(_ before: ShellPolicy.Before) {
    defer { state.lastBefore = before }
    guard let last = state.lastBefore, last != before else { return }
    for key in state.connections.keys { state.connections[key]?.approvedUntil = nil }
  }

  /// Shell was switched off: close every window still waiting, stop every run, and drop every
  /// session approval. A request already past the host's switch check is turned away too.
  static func stopAll() {
    let calls = state.lock.withLock { () -> [Call] in
      state.generation += 1
      for key in state.connections.keys { state.connections[key]?.approvedUntil = nil }
      return Array(state.calls.values)
    }
    for call in calls { call.cancel() }
  }

  /// Runs in flight now, app-wide.
  static var inFlight: Int { state.lock.withLock { state.inFlight } }

  /// Calls that are asking or running and have not yet recorded how they ended. For quit,
  /// which waits for them before draining `ShellRecord`.
  static var openCalls: Int { state.lock.withLock { state.calls.count } }

  // MARK: - Copy

  static let declinedCopy =
    "The person chose not to run this. Nothing ran. Ask them in the conversation what they want; "
    + "do not retry on your own."
  static let noAnswerCopy =
    "Nobody answered within \(Int(ShellPolicy.askTimeout)) s, so nothing ran. They may have "
    + "stepped away. Ask them before trying again."
  static let busyCopy = "Four commands are already running. Nothing ran. Wait for one to finish."
  static let cancelledCopy = "Cancelled. The command was stopped."

  static func cooldownCopy(_ retryIn: TimeInterval) -> String {
    "The person turned down a command from this client a moment ago. Nothing ran, and "
      + "Cupertino will not ask again for another \(max(1, Int(retryIn.rounded(.up)))) s. Ask "
      + "them in the conversation first."
  }

  // MARK: - State

  private final class State: @unchecked Sendable {
    let lock = NSLock()
    // Everything below is guarded by `lock`.
    var connections: [UUID: (approvedUntil: Date?, declinedUntil: Date?)] = [:]
    /// Each client name's cooldown, kept across its connections.
    var declinedClients: [String: Date] = [:]
    var inFlight = 0
    /// Requests waiting for the window, the one on screen included.
    var waiting = 0
    /// "Before running" as last seen, by `beforeObserved` or a request.
    var lastBefore: ShellPolicy.Before?
    /// Calls that may ask or run, for `stopAll`.
    var calls: [ObjectIdentifier: Call] = [:]
    /// Moved on by `stopAll`, so a request that started before it cannot go on to ask or run.
    var generation = 0
  }

  private static let state = State()

  /// One request on its way to the window or the script, and what a cancel has to stop.
  private final class Call: @unchecked Sendable {
    let consent: any ShellConsenting
    let connection: UUID
    let requestId: String
    private let lock = NSLock()
    // Guarded by `lock`.
    private var cancelled = false
    private var asking = false
    private var running: ShellRunner.Running?

    init(consent: any ShellConsenting, connection: UUID, requestId: String) {
      self.consent = consent
      self.connection = connection
      self.requestId = requestId
    }

    /// The canceller: from `InProcessCalls` (a cancel or a hang-up, perhaps inline inside
    /// `register`), from `stopAll`. Quick, and never answers the call itself.
    func cancel() {
      lock.lock()
      cancelled = true
      let asking = self.asking
      let running = self.running
      lock.unlock()
      if asking { consent.cancel(connection: connection, requestId: requestId) }
      running?.cancel()
    }

    var isCancelled: Bool { lock.withLock { cancelled } }

    /// Marks the window as up, unless the call was cancelled first. False means do not ask.
    func beginAsking() -> Bool {
      lock.withLock {
        guard !cancelled else { return false }
        asking = true
        return true
      }
    }

    /// The window answered. True when the call was cancelled meanwhile.
    func endAsking() -> Bool {
      lock.withLock {
        asking = false
        return cancelled
      }
    }

    /// Hands over the run, right after it started. True when the call was cancelled first.
    func attach(_ run: ShellRunner.Running) -> Bool {
      lock.withLock {
        running = run
        return cancelled
      }
    }
  }

  // MARK: - Tools

  /// Computed, as `ScreenServer`'s are: a `[String: Any]` constant is not `Sendable`.
  private static var tools: [[String: Any]] {
    [
      [
        "name": "apple_shell_run",
        "description":
          "Run a one-shot script on this Mac with Cupertino's access, including Full Disk Access "
          + "when Cupertino has it, and return its exit code, stdout and stderr. The person sees "
          + "the full script and your purpose in a window and decides, unless they have chosen "
          + "otherwise. A refusal comes back as an error: ask them in the conversation, do not "
          + "retry. Nothing interactive: no terminal, no typed input, no sudo. The script and "
          + "everything it starts are stopped at the timeout.",
        "inputSchema": [
          "type": "object",
          "properties": [
            "script": [
              "type": "string",
              "description": "The program text, run as given. At most 512 KB.",
            ],
            "purpose": [
              "type": "string",
              "description":
                "One sentence saying why you want to run this. The person reads it beside the "
                + "script, as your words. At most 500 characters.",
            ],
            "interpreter": [
              "type": "string",
              "enum": ShellRunner.Interpreter.allCases.map(\.rawValue),
              "default": "zsh",
              "description":
                "What runs the script. jxa is JavaScript for Automation. It starts through zsh "
                + "without the person's shell startup files, so PATH is the system's plus "
                + "Homebrew's, and a version manager such as nvm is not set up unless the script "
                + "does it, for example with source ~/.nvm/nvm.sh. python3 runs isolated (-I): "
                + "the user site-packages are not on its path, and a script that needs them adds "
                + "them itself.",
            ],
            "cwd": [
              "type": "string",
              "description": "The working directory: an absolute path, or ~. Defaults to ~.",
            ],
            "stdin": [
              "type": "string",
              "description":
                "Written to the script's standard input, then closed. At most 256 KB. None by "
                + "default.",
            ],
            "timeoutSeconds": [
              "type": "integer",
              "minimum": timeoutRange.lowerBound,
              "maximum": timeoutRange.upperBound,
              "default": defaultTimeoutSeconds,
              "description":
                "How long the script may run, not counting the time the window waits. 60 by "
                + "default.",
            ],
          ],
          "required": ["script", "purpose"],
        ],
        "annotations": [
          "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false,
          "openWorldHint": true,
        ],
      ],
      [
        "name": "apple_shell_diagnostics",
        "description":
          "Report the \"Before running\" setting in force, whether Cupertino holds Full Disk "
          + "Access, which interpreters a script's PATH finds, how many runs are in flight, and "
          + "whether the run record is intact. Runs nothing of the caller's.",
        "inputSchema": [
          "type": "object", "properties": [String: Any](), "required": [Any](),
        ],
        "annotations": ["readOnlyHint": true],
      ],
    ]
  }

  private static func call(_ name: String, args: [String: Any], id: Any?, connection: UUID?)
    -> String
  {
    switch name {
    case "apple_shell_run":
      return run(args, id: id, connection: connection)
    case "apple_shell_diagnostics":
      return InProcessRPC.ok(id, diagnostics())
    default:
      return InProcessRPC.failure(id, "unknown tool '\(name)'")
    }
  }

  // MARK: - A run

  /// A request's fields as given, for the record, whether or not they passed.
  private struct Asked {
    var script = ""
    var purpose = ""
    var interpreter = ShellRunner.Interpreter.zsh.rawValue
    var cwd = "~"
    var stdin: String?
  }

  /// A request that passed every argument check.
  private struct Valid {
    var script: String
    var purpose: String
    var interpreter: ShellRunner.Interpreter
    /// Absolute, `~` expanded.
    var cwd: String
    var stdin: String?
    var timeoutSeconds: Int
  }

  private static func run(_ args: [String: Any], id: Any?, connection: UUID?) -> String {
    let at = Date()
    let generation = state.lock.withLock { state.generation }
    // A request with no connection (a check driving the server directly) is a connection of
    // its own: no approval or cooldown is kept for it.
    let who = connection ?? UUID()
    let client = ShellText.client(clientName(who))
    var asked = given(args)
    let runId = UUID()

    /// The outcome line, or a refusal's only line. With `started`, the run's started line,
    /// written before it returns.
    func record(
      _ decision: ShellRecord.Decision, _ outcome: ShellRunner.Outcome? = nil,
      started: Bool = false
    ) {
      let entry = ShellRecord.Entry(
        at: at, client: client, connection: who, purpose: asked.purpose,
        interpreter: asked.interpreter, cwd: asked.cwd, scriptBytes: asked.script.utf8.count,
        scriptSHA256: AuditChain.digest(asked.script), stdinBytes: asked.stdin?.utf8.count,
        stdinSHA256: asked.stdin.map(AuditChain.digest), decision: decision,
        exitCode: outcome?.exitCode, signal: outcome?.signal,
        timedOut: outcome?.timedOut ?? false,
        durationMs: outcome?.durationMs, runId: runId, started: started)
      if started { ShellRecord.appendNow(entry) } else { ShellRecord.append(entry) }
    }

    /// Record a request that did not run to the end, and answer it.
    func refuse(_ decision: ShellRecord.Decision, _ message: String) -> String {
      record(decision)
      return refusal(id, decision, message)
    }

    let request: Valid
    switch validate(args) {
    case .failure(let refusal):
      return refuse(.invalid, refusal.message)
    case .success(let valid):
      request = valid
      // As it will run: the folder with `~` expanded, the interpreter by its name.
      asked.cwd = valid.cwd
      asked.interpreter = valid.interpreter.rawValue
    }

    let before = ShellSeal.effectiveBefore(defaults)
    let requestId = InProcessCalls.requestId(id) ?? "u\(UUID().uuidString)"
    let call = Call(consent: consent, connection: who, requestId: requestId)

    // The decision, the slot it takes and the call `stopAll` can reach, in one step.
    let decision = state.lock.withLock { () -> ShellPolicy.Decision? in
      guard state.generation == generation else { return nil }
      noteBefore(before)
      let now = clock()
      let standing = connection.flatMap { state.connections[$0] }
      state.declinedClients = state.declinedClients.filter { $0.value > now }
      let declinedUntil = [standing?.declinedUntil, state.declinedClients[client]]
        .compactMap { $0 }.max()
      var decision = ShellPolicy.decide(
        before, sessionApprovedUntil: standing?.approvedUntil,
        declinedUntil: declinedUntil, inFlight: state.inFlight, now: now)
      if case .ask = decision, state.waiting >= ShellPolicy.maxWaiting { decision = .busy }
      switch decision {
      case .run:
        state.inFlight += 1
        state.calls[ObjectIdentifier(call)] = call
      case .ask:
        state.waiting += 1
        state.calls[ObjectIdentifier(call)] = call
      case .declined, .busy:
        break
      }
      return decision
    }
    defer { state.lock.withLock { _ = state.calls.removeValue(forKey: ObjectIdentifier(call)) } }

    let offerSession: Bool
    switch decision {
    case nil:
      return refuse(.cancelled, cancelledCopy)
    case .declined(let retryIn):
      return refuse(.cooldown, cooldownCopy(retryIn))
    case .busy:
      return refuse(.busy, busyCopy)
    case .run:
      // Its slot is already taken; `execute` gives it back.
      offerSession = false
    case .ask(_, let offered):
      offerSession = offered
    }

    // Outside every lock: `register` may run the canceller inline, and the canceller takes the
    // call's lock. An id that is no key (null, a fraction) is registered under the private
    // `u<UUID>` one: no cancel can name it, but a hang-up's `cancelAll` still reaches it.
    let token = connection.map { connection in
      InProcessCalls.register(connection: connection, requestId: requestId) { call.cancel() }
    }
    defer { token?.done() }

    let prompt = ShellPrompt(
      client: client, purpose: request.purpose, script: request.script, stdin: request.stdin,
      interpreter: request.interpreter, cwd: request.cwd, timeoutSeconds: request.timeoutSeconds,
      offerSession: offerSession, connection: who, requestId: requestId)

    if case .run(let notice) = decision {
      return execute(
        request, prompt: prompt, call: call, id: id, notice: notice,
        decision: before == .none ? .notAsked : .approvedForSession, record: record)
    }

    // The window. Its place among the waiting is given back once it has answered.
    let answer: ShellPromptAnswer
    do {
      defer { state.lock.withLock { state.waiting -= 1 } }
      guard call.beginAsking() else {
        return refuse(.cancelled, cancelledCopy)
      }
      answer = call.consent.ask(prompt)
    }
    if call.endAsking() || answer == .cancelled {
      return refuse(.cancelled, cancelledCopy)
    }

    switch answer {
    case .dontRun, .noAnswer:
      state.lock.withLock {
        let until = clock().addingTimeInterval(ShellPolicy.declineCooldown)
        state.declinedClients[client] = until
        if let connection {
          state.connections[connection, default: (nil, nil)].declinedUntil = until
        }
      }
      return answer == .dontRun
        ? refuse(.declined, declinedCopy) : refuse(.noAnswer, noAnswerCopy)

    case .runOnce, .runForSession:
      // The session answer counts only when the window offered it: under "Ask every time" a
      // window that somehow sent it still approved this one run and no more.
      let forSession = answer == .runForSession && offerSession
      enum Slot { case taken, full, switchedOff }
      let slot = state.lock.withLock { () -> Slot in
        // Shell went off after the window answered: no approval survives that, and no run.
        guard state.generation == generation else { return .switchedOff }
        if forSession, let connection {
          state.connections[connection, default: (nil, nil)].approvedUntil =
            clock().addingTimeInterval(ShellPolicy.sessionLength)
        }
        // Taken again now: other runs may have started while the window waited.
        guard state.inFlight < ShellPolicy.maxInFlight else { return .full }
        state.inFlight += 1
        return .taken
      }
      switch slot {
      case .taken:
        break
      case .switchedOff:
        return refuse(.cancelled, cancelledCopy)
      case .full:
        return refuse(.busy, busyCopy)
      }
      return execute(
        request, prompt: prompt, call: call, id: id, notice: false,
        decision: forSession ? .approvedForSession : .approved, record: record)

    case .cancelled:
      // Answered above; kept so a new answer has to be placed here.
      return refuse(.cancelled, cancelledCopy)
    }
  }

  /// Start the script, wait it out and answer. The caller has already taken a slot, which is
  /// given back here whatever happens.
  ///
  /// The card goes up before the script starts, so no run that skipped the window is ever
  /// unseen, even for an instant. Its Stop cancels the call, which stops the run, or keeps it
  /// from starting when pressed first. A consent that cannot show a card stops it at once.
  private static func execute(
    _ request: Valid, prompt: ShellPrompt, call: Call, id: Any?, notice: Bool,
    decision: ShellRecord.Decision,
    record: (ShellRecord.Decision, ShellRunner.Outcome?, Bool) -> Void
  ) -> String {
    defer { state.lock.withLock { state.inFlight -= 1 } }
    let card = notice ? call.consent.running(prompt, stop: { call.cancel() }) : nil
    defer { card?.ended() }
    guard !call.isCancelled else {
      record(.cancelled, nil, false)
      return refusal(id, .cancelled, cancelledCopy)
    }
    // On disk before the spawn: a script that ends this process still leaves its request on
    // the record.
    record(decision, nil, true)
    let running: ShellRunner.Running
    do {
      running = try ShellRunner.start(
        ShellRunner.Request(
          script: request.script, interpreter: request.interpreter,
          cwd: URL(fileURLWithPath: request.cwd, isDirectory: true), stdin: request.stdin,
          timeout: TimeInterval(request.timeoutSeconds)))
    } catch {
      // Recorded under the decision that was made, with no exit: approved, and never started.
      record(decision, nil, false)
      return refusal(id, decision, "The command could not be started (\(error)). Nothing ran.")
    }
    if call.attach(running) { running.cancel() }
    let outcome = running.wait()
    record(outcome.cancelled ? .cancelled : decision, outcome, false)
    guard !outcome.cancelled else { return refusal(id, .cancelled, cancelledCopy) }
    return answer(
      id,
      [
        "decision": decision.rawValue,
        "exitCode": outcome.exitCode.map { Int($0) as Any } ?? NSNull(),
        "signal": outcome.signal.map { $0 as Any } ?? NSNull(),
        "timedOut": outcome.timedOut,
        "durationMs": outcome.durationMs,
        "stdout": outcome.stdout,
        "stdoutTruncated": outcome.stdoutTruncated,
        "stderr": outcome.stderr,
        "stderrTruncated": outcome.stderrTruncated,
      ])
  }

  /// A run's result: the fields as JSON text, which is what every surface answers with, and
  /// the same object as `structuredContent`, which is what `CallCapture` keeps the structure of
  /// when the content switch is off.
  private static func answer(_ id: Any?, _ value: [String: Any]) -> String {
    InProcessRPC.result(
      id,
      [
        "content": [["type": "text", "text": InProcessRPC.jsonText(value)]],
        "structuredContent": value,
      ])
  }

  /// A request that did not run to the end: the sentence for the agent, and the decision beside
  /// it, so the log tells a decline from a cooldown without reading the copy.
  private static func refusal(_ id: Any?, _ decision: ShellRecord.Decision, _ message: String)
    -> String
  {
    InProcessRPC.result(
      id,
      [
        "content": [["type": "text", "text": message]],
        "isError": true,
        "structuredContent": ["decision": decision.rawValue],
      ])
  }

  // MARK: - Arguments

  private struct Refusal: Error {
    var message: String
  }

  /// The fields as given, for the record line of any request, a refused one included. Free text
  /// is capped so a refused request cannot make a line of any size.
  private static func given(_ args: [String: Any]) -> Asked {
    var asked = Asked()
    if let script = args["script"] as? String { asked.script = script }
    if let purpose = args["purpose"] as? String {
      asked.purpose = String(purpose.prefix(maxPurposeChars))
    }
    if let interpreter = args["interpreter"] as? String {
      asked.interpreter = String(interpreter.prefix(64))
    }
    if let cwd = args["cwd"] as? String { asked.cwd = String(cwd.prefix(1024)) }
    if let stdin = args["stdin"] as? String { asked.stdin = stdin }
    return asked
  }

  /// JSON null reads as absent, for the optional arguments.
  private static func optional(_ args: [String: Any], _ key: String) -> Any? {
    guard let value = args[key], !(value is NSNull) else { return nil }
    return value
  }

  private static func validate(_ args: [String: Any]) -> Result<Valid, Refusal> {
    func refuse(_ message: String) -> Result<Valid, Refusal> {
      .failure(Refusal(message: message + " Nothing ran."))
    }

    guard let script = args["script"] as? String else {
      return refuse("'script' is required, as a string holding the program to run.")
    }
    guard !script.isEmpty else { return refuse("'script' is empty.") }
    // For zsh the script is a C string in argv, which ends at the first NUL: the window and
    // the record would hold the whole text while only the part before it ran.
    guard !script.utf8.contains(0) else {
      return refuse("'script' contains a NUL character, and only the text before it would run.")
    }
    let bytes = script.utf8.count
    guard bytes <= maxScriptBytes else {
      return refuse(
        "'script' is \(bytes) bytes, and the limit is \(maxScriptBytes) (512 KB). Have the "
          + "script read what it needs from a file instead.")
    }

    guard let purpose = args["purpose"] as? String,
      !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      return refuse(
        "'purpose' is required: one sentence saying why you want to run this. The person reads "
          + "it beside the script.")
    }
    guard purpose.count <= maxPurposeChars else {
      return refuse(
        "'purpose' is \(purpose.count) characters, and the limit is \(maxPurposeChars).")
    }

    var interpreter = ShellRunner.Interpreter.zsh
    if let raw = optional(args, "interpreter") {
      guard let name = raw as? String, let named = ShellRunner.Interpreter(rawValue: name) else {
        let names = ShellRunner.Interpreter.allCases.map(\.rawValue).joined(separator: ", ")
        return refuse("'interpreter' must be one of \(names).")
      }
      interpreter = named
    }

    var cwd = "~"
    if let raw = optional(args, "cwd") {
      guard let path = raw as? String else { return refuse("'cwd' must be a string.") }
      cwd = path
    }
    if cwd == "~" || cwd.hasPrefix("~/") { cwd = NSHomeDirectory() + cwd.dropFirst() }
    guard cwd.hasPrefix("/") else {
      return refuse("'cwd' must be an absolute path, or start with ~/.")
    }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDirectory),
      isDirectory.boolValue
    else {
      return refuse("'cwd' (\(cwd)) does not exist or is not a folder.")
    }

    var stdin: String?
    if let raw = optional(args, "stdin") {
      guard let text = raw as? String else { return refuse("'stdin' must be a string.") }
      let bytes = text.utf8.count
      guard bytes <= maxStdinBytes else {
        return refuse(
          "'stdin' is \(bytes) bytes, and the limit is \(maxStdinBytes) (256 KB). Have the "
            + "script read it from a file instead.")
      }
      // Refused like the script's, so the window never shows text the script does not get.
      guard !text.utf8.contains(0) else { return refuse("'stdin' contains a NUL character.") }
      stdin = text
    }

    var timeoutSeconds = defaultTimeoutSeconds
    if let raw = optional(args, "timeoutSeconds") {
      // A boolean arrives as an NSNumber too, and `true` is not a timeout.
      guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
        let whole = Int(exactly: number.doubleValue), timeoutRange.contains(whole)
      else {
        return refuse(
          "'timeoutSeconds' must be a whole number from \(timeoutRange.lowerBound) to "
            + "\(timeoutRange.upperBound).")
      }
      timeoutSeconds = whole
    }

    return .success(
      Valid(
        script: script, purpose: purpose, interpreter: interpreter, cwd: cwd, stdin: stdin,
        timeoutSeconds: timeoutSeconds))
  }

  // MARK: - Diagnostics

  static func diagnostics() -> [String: Any] {
    // Finding the interpreters starts no process: it reads PATH's folders.
    let running = inFlight
    var interpreters: [String: Any] = [:]
    for interpreter in ShellRunner.Interpreter.allCases {
      interpreters[interpreter.rawValue] = ShellRunner.resolve(interpreter) ?? NSNull()
    }
    return [
      "server": ["name": "cupertino-shell", "version": AppInfo.shortVersion, "runtime": "swift"],
      "before": ShellSeal.effectiveBefore(defaults).rawValue,
      "fullDiskAccess": fullDiskAccess(),
      "interpreters": interpreters,
      "inFlight": running,
      "recordIntact": ShellRecord.verify().isIntact,
      "sealKeyError": ShellSeal.lastKeyError ?? NSNull(),
    ]
  }

  // MARK: - Resources

  private static var resources: [[String: Any]] {
    [
      [
        "uri": "cupertino://shell/guide", "name": "Shell guide",
        "description": "What a script run here can reach, and how a run is decided.",
        "mimeType": "text/markdown",
      ],
      [
        "uri": "cupertino://shell/diagnostics", "name": "Shell diagnostics",
        "description": "The setting in force, Full Disk Access, interpreters and runs in flight.",
        "mimeType": "application/json",
      ],
    ]
  }

  private static func readResource(_ uri: String, id: Any?) -> String {
    switch uri {
    case "cupertino://shell/guide":
      return InProcessRPC.result(
        id, ["contents": [["uri": uri, "mimeType": "text/markdown", "text": guide]]])
    case "cupertino://shell/diagnostics":
      return InProcessRPC.result(
        id,
        [
          "contents": [
            [
              "uri": uri, "mimeType": "application/json",
              "text": InProcessRPC.jsonText(diagnostics()),
            ]
          ]
        ])
    default:
      return InProcessRPC.error(id, code: -32602, message: "unknown resource '\(uri)'")
    }
  }

  private static let guide = """
    # Shell

    Runs a script as a child of Cupertino, so it holds every grant Cupertino holds, Full
    Disk Access included when Cupertino has it. Each run is decided on its own.

    ## How a run is decided

    - The person sees the full script, your purpose, the interpreter, the folder and the
      timeout, and chooses. "Don't run", or no answer within 60 s, is a no.
    - After a no, this connection, and any connection under the same client name, is
      refused for 30 s without asking again. Ask the person in the conversation rather than
      retrying.
    - They may approve the rest of the session (30 min, or until the connection closes), or
      have turned asking off. A run that shows no window still shows a card they can stop it
      from.
    - At most four runs at once, and at most four windows waiting. One more is refused,
      not queued.

    ## What a script gets

    - zsh without the person's shell startup files (`/bin/zsh -f -c`): `~/.zshenv`,
      `~/.zprofile`, `~/.zshrc` and `~/.zlogin` are not read. Other interpreters start
      through it.
    - The script is passed as an argument (`bash -c`, `python3 -I -c`, `node --eval=`,
      `osascript -e`), never written to a file, so `$0`, `__file__` and `__filename` do not
      name a script file.
    - python3 runs isolated (`python3 -I`): the user site-packages are not on its path,
      and neither is the folder it runs in. A script that needs the user site-packages adds
      them itself.
    - PATH is the system's, from `/etc/paths` and `/etc/paths.d`, then Homebrew's folders.
      A script that needs a version manager sets it up itself, for example
      `source ~/.nvm/nvm.sh`, and the person sees that line in the window with the rest.
    - Its own process group. At the timeout, or when the call is cancelled, the whole group
      is stopped, backgrounded children too.
    - No terminal and no typed input: `sudo` and anything interactive fail.
    - stdout and stderr are each kept to their first 256 KB.

    ## What is kept

    Every request leaves a line in Cupertino's run record: the time, the client, your
    purpose, the script's length and SHA-256, the decision and how it ended. Never the
    script's text or its output.
    """

  // MARK: - No window

  /// The consent in force until the app wires its window in: it answers `.cancelled` without
  /// asking, and, having no card to show, stops a run that would skip the window before it
  /// starts. So nothing runs unseen, whatever "Before running" says.
  private struct NoWindow: ShellConsenting {
    func ask(_ prompt: ShellPrompt) -> ShellPromptAnswer { .cancelled }
    func cancel(connection: UUID, requestId: String) {}
    func running(_ prompt: ShellPrompt, stop: @escaping @Sendable () -> Void)
      -> any ShellNoticeToken
    {
      stop()
      return NoCard()
    }
  }

  private struct NoCard: ShellNoticeToken {
    func ended() {}
  }
}

/// What a client says about itself, made safe to keep and to show.
///
/// The client name, the purpose and the folder are the agent's words, and the window, the card
/// and Recent runs draw them beside the person's decision. A bidirectional override or a
/// zero-width character can make a name read as another (`Claude\u{202E}…`), and a name a
/// thousand characters long can push everything else off the card. So the name is capped
/// wherever it is used, the record included, and all three are stripped of control and format
/// characters wherever they are shown. The record keeps them as they came, capped, so the file
/// says what the client sent.
///
/// Foundation only, so `make shell-check` pins it.
nonisolated enum ShellText {
  static let clientLimit = 100

  /// The client name as Shell uses it everywhere: its first `clientLimit` characters.
  static func client(_ name: String) -> String {
    String(name.prefix(clientLimit))
  }

  static let ownerLimit = 40

  /// A window owner's name, from the window list, as the Shell window shows it: stripped as
  /// `display` strips, trimmed, and its first `ownerLimit` characters. Nil when there is none
  /// or nothing is left. Any program names itself, so it says whose window it is, not that the
  /// window is safe.
  static func owner(_ name: String?) -> String? {
    guard let name else { return nil }
    let shown = String(display(name).trimmingCharacters(in: .whitespaces).prefix(ownerLimit))
    return shown.isEmpty ? nil : shown
  }

  /// `text` without control or format characters (Unicode categories Cc and Cf: bidirectional
  /// overrides, zero-width spaces, a BOM, a bell). A tab, line feed or carriage return becomes
  /// a space instead, so the words on either side stay apart.
  static func display(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in text.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .control:
        if scalar == "\n" || scalar == "\t" || scalar == "\r" { out.append(" ") }
      case .format:
        break
      default:
        out.append(scalar)
      }
    }
    return String(out)
  }
}
