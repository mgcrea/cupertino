import Foundation
import FoundationModels
import Observation
import os

/// One conversation with the on-device model, against one surface.
///
/// Named a conversation and not a session because `Sessions.Session` is already
/// a noun in this app and means something else — one MCP connection, the thing
/// the Connections pane lists. This owns one of those (through
/// `MCPChatClient`), which is exactly the confusion the name avoids.
///
/// ## The context window is the design
///
/// The on-device model holds 4096 tokens. Mail with writes on lists
/// twenty-one tools whose schemas come to 4858 tokens — the tool list alone is
/// more than the whole window, before a word of conversation. So the pane never
/// offers a surface's tools; it offers as many as fit, in an order chosen so
/// the ones it keeps are ones the model can open with, and it says out loud
/// which ones it left out. `ChatBudget` holds that arithmetic and `make
/// chat-check` asserts it.
///
/// ## What runs where
///
/// Everything that touches the socket goes through `onDedicatedThread`. That is
/// not tuning: `MCPChatClient` explains that a main thread blocked in `read(2)`
/// deadlocks the four in-process surfaces outright.
@MainActor
@Observable
final class ChatConversation {

  /// The whole window the model holds, in tokens.
  ///
  /// No `#available` guard: `contextSize` is declared `macOS 26.0` and carries
  /// `@backDeployed(before: macOS 26.4)`, and this target's floor is 26.0.
  ///
  /// Fixed under a capture, for the reason `DemoSeed` gives everywhere else: a
  /// screenshot whose budget line is read off whichever Mac took it is
  /// machine-dependent, and the runner that takes these has no Apple
  /// Intelligence at all — there is no model there to ask.
  static var contextSize: Int { DemoSeed.isEnabled ? 4096 : measuredContextSize }

  /// Asked once. The model cannot change mid-launch, and this is read on every
  /// header render.
  private static let measuredContextSize = SystemLanguageModel.default.contextSize

  static var budget: Int { ChatBudget.budget(contextSize: contextSize) }

  /// Whether there is a model to talk to at all.
  ///
  /// Short-circuited under a capture for the same reason `contextSize` is: the
  /// plate must photograph the feature, not its absence on the build machine.
  static var isAvailable: Bool {
    if DemoSeed.isEnabled { return true }
    if case .available = SystemLanguageModel.default.availability { return true }
    return false
  }

  static var unavailableReason: String {
    guard case .unavailable(let why) = SystemLanguageModel.default.availability else {
      return "The on-device model is not available."
    }
    return switch why {
    case .deviceNotEligible:
      "This Mac does not support Apple Intelligence, which is what answers here. "
        + "Everything else in Cupertino works without it."
    case .appleIntelligenceNotEnabled:
      "Apple Intelligence is switched off. Turn it on in System Settings to use this pane."
    case .modelNotReady:
      "The on-device model is still downloading. This pane will work once it has finished."
    @unknown default:
      "The on-device model is not available on this Mac right now."
    }
  }

  enum Role: Sendable, Equatable { case you, model }

  struct Message: Identifiable, Equatable {
    let id = UUID()
    let role: Role
    var text: String
    /// Calls the model made while producing this message, in order.
    var calls: [ChatCall] = []
    var failure: String?

    static func == (a: Message, b: Message) -> Bool {
      a.id == b.id && a.text == b.text && a.calls.count == b.calls.count
        && a.failure == b.failure
    }
  }

  // MARK: - State

  private(set) var surface: Surface?
  /// Every tool this surface listed and the pane can express, best first.
  private(set) var tools: [ChatTool] = []
  /// Tools whose schema the subset cannot express, with the reason.
  private(set) var unusable: [String] = []
  private(set) var selected: Set<String> = []

  private(set) var messages: [Message] = []
  private(set) var isResponding = false
  private(set) var isLoading = false
  private(set) var loadFailure: String?
  /// Set when the connection ended under us — the surface was switched off, or
  /// the server exited. The transcript stays; sending does not.
  private(set) var disconnected: String?
  /// How many times the transcript has been trimmed to fit.
  ///
  /// Surfaced, because a model that has quietly forgotten the start of the
  /// conversation is otherwise indistinguishable from one being obtuse. With
  /// 1800 tokens spent on tools, this is the normal path rather than an edge
  /// case, which is the other reason it is worth a line of UI.
  private(set) var trims = 0
  /// Whether the user has acknowledged that this surface can write.
  var acknowledgedWrites = false
  /// What the composer holds. Owned here rather than by the view, so a trip to
  /// the Log and back does not discard a half-typed question.
  var draft = ""
  /// A surface picked while there was a conversation to lose, awaiting the
  /// confirmation. The picker writes it; the dialog consumes it.
  var pendingSwitch: Surface?

  /// The tool a reply is waiting on, so a spinner can name it. A call can block
  /// for a minute, and a spinner that does not say what it is waiting for is
  /// indistinguishable from a hang.
  private(set) var activeTool: String?

  /// The running turn, so it can be let go of. Held here and not in the pane,
  /// because the pane is the thing that gets destroyed.
  private var turn: Task<Void, Never>?

  private struct TurnState {
    /// Bumped whenever everything a running turn has not written yet becomes
    /// stale — a Stop, a Clear, a rebuild, a new surface.
    var era = 0
    /// Tool calls made by the turn in progress.
    var calls = 0
  }

  /// The era and the per-turn call count, under one lock.
  ///
  /// One lock and `nonisolated`, because the bridged tools' closures run on a
  /// dedicated thread and cannot touch main-actor state — see `MCPChatClient`
  /// on why they must not even try.
  private nonisolated let turnState = OSAllocatedUnfairLock(initialState: TurnState())

  private nonisolated var era: Int { turnState.withLock { $0.era } }

  /// Everything the running turn has not written yet is now stale.
  private func endEra() {
    turnState.withLock {
      $0.era += 1
      $0.calls = 0
    }
  }

  /// Take a slot for one tool call, or refuse. Returns the era it was taken in.
  private nonisolated func claim() -> Int? {
    turnState.withLock { state in
      guard state.calls < Self.callsPerTurn else { return nil }
      state.calls += 1
      return state.era
    }
  }

  /// Tool calls one question may make.
  ///
  /// Two things make an unbounded number unaffordable rather than merely
  /// untidy. Every call's output can be 1200 characters, so a handful of them
  /// is the rest of a 4096-token window. And a model looping on a failing tool
  /// would spend six times `MCPChatClient`'s per-call deadline — a minute each
  /// — before anybody could type again. Observed here: two calls in one turn,
  /// both failing on a missing grant, with nothing to stop a third.
  nonisolated static let callsPerTurn = 6

  /// What a stopped row says.
  ///
  /// It has to say something, because `reseat()` drops the stopped question
  /// from what the model remembers while its row stays on screen. Unexplained,
  /// that divergence reads as a model with amnesia.
  static let stopped = "Stopped. This question was dropped from what the model remembers."

  /// Capped, and the cap is not optional at this window size.
  ///
  /// Without one, a model that starts enumerating spends the rest of the window
  /// on it and then throws `exceededContextWindowSize` — which `trimTranscript`
  /// dutifully absorbs, so the only symptom is a conversation that has
  /// forgotten its own opening for no visible reason. The instructions already
  /// ask for short replies; this is the same request the model cannot talk
  /// itself out of.
  private static let options = GenerationOptions(
    sampling: .greedy, maximumResponseTokens: 400)

  private var client: MCPChatClient?
  private var session: LanguageModelSession?
  private var bound: [any Tool] = []

  /// Whether this surface was opened with its write tools registered.
  ///
  /// Read once at load and kept, rather than re-read: it describes the child
  /// that is actually running, and the preference can be changed underneath a
  /// live conversation without changing what that child registered.
  private(set) var allowsWrites = false

  /// A surface is picked and its tools are bound.
  ///
  /// Widened for a capture rather than faked: `LanguageModelSession` is
  /// unconstructible on a Mac with no Apple Intelligence, which is exactly what
  /// the screenshot runner is, so there is no object `adoptDemo` could put in
  /// `session` to make this true the ordinary way.
  var isReady: Bool { session != nil || (DemoSeed.isEnabled && surface != nil) }
  /// Something would be lost by rebuilding.
  var hasTranscript: Bool { !messages.isEmpty }

  var canSend: Bool {
    session != nil && !isResponding && disconnected == nil
      && (!allowsWrites || acknowledgedWrites)
  }

  var used: Int { ChatBudget.used(tools, selected: selected) }
  var isOverBudget: Bool { used > Self.budget }

  // MARK: - Loading a surface

  func load(_ surface: Surface) {
    abandon(noting: false)
    close()
    self.surface = surface
    self.tools = []
    self.unusable = []
    self.selected = []
    self.messages = []
    self.loadFailure = nil
    self.disconnected = nil
    self.trims = 0
    self.acknowledgedWrites = false
    self.allowsWrites = SurfaceSettings.allowWrites(surface)
    self.isLoading = true

    let id = surface.id
    onDedicatedThread("cupertino.chat.open") { [weak self] in
      let outcome: Result<(MCPChatClient, [ChatTool]), Error>
      do {
        let client = try MCPChatClient.open(surface: surface) {
          Task { @MainActor [weak self] in self?.lost(id) }
        }
        outcome = .success((client, try client.listTools()))
      } catch {
        outcome = .failure(error)
      }
      Task { @MainActor [weak self] in self?.finishLoading(id, outcome) }
    }
  }

  private func finishLoading(
    _ id: String, _ outcome: Result<(MCPChatClient, [ChatTool]), Error>
  ) {
    // A second pick landed while this one was opening. Its client is already
    // the live one; hand this one back rather than leaking a node process.
    guard surface?.id == id else {
      if case .success(let (client, _)) = outcome { client.close() }
      return
    }
    isLoading = false
    switch outcome {
    case .failure(let error):
      loadFailure = error.localizedDescription
    case .success(let (client, listed)):
      self.client = client
      // Parse BEFORE filling the budget, which is the one place this diverges
      // from the sibling app it is ported from. Bastion fills from every listed
      // tool and discovers at bind time which schemas will not convert, so an
      // unusable tool spends budget a usable one could have had — measured on
      // this repo's Contacts, 766 of 1313 tokens went to two tools that could
      // not be bound, and the pane offered five tools where seven fit.
      var usable: [ChatTool] = []
      for tool in listed {
        do {
          _ = try ChatSchema.parse(tool)
          usable.append(tool)
        } catch {
          unusable.append("\(tool.name) — \(error.localizedDescription)")
        }
      }
      tools = usable.sorted(by: ChatBudget.before)
      selected = ChatBudget.fill(tools, budget: Self.budget).selected
      rebuild()
    }
  }

  /// The connection ended without us asking.
  ///
  /// `stopSessions` SIGTERMs a surface's servers when it is switched off, and
  /// `serveInProcess` refuses at the top of its next read loop — so this can
  /// arrive mid-call or after a long idle. Deliberately does NOT reconnect:
  /// quietly reopening a connection to a surface somebody just switched off is
  /// exactly what `stopSessions` exists to prevent.
  private func lost(_ id: String) {
    guard surface?.id == id, disconnected == nil else { return }
    abandon(noting: false)
    session = nil
    client = nil
    disconnected =
      "\(surface?.displayName ?? "The surface") stopped answering — it was switched off, or "
      + "its server exited. Pick a surface again to start over."
  }

  // MARK: - The session

  func toggle(_ tool: ChatTool) {
    // Rebuilding discards the conversation, and a reply in flight is writing
    // into it. The popover disables these too; that is the explanation, this is
    // the invariant.
    guard !isResponding else { return }
    if selected.contains(tool.name) {
      selected.remove(tool.name)
    } else {
      selected.insert(tool.name)
    }
    rebuild()
  }

  func clear() {
    guard !isResponding else { return }
    rebuild()
  }

  /// Rebuild from the current selection, discarding the conversation.
  ///
  /// A `LanguageModelSession`'s tools are fixed when it is constructed, so
  /// changing the selection cannot be done in place. The transcript goes with
  /// it, which is why the pane asks before calling this.
  func rebuild() {
    guard let client, let surface else { return }
    abandon(noting: false)
    messages = []
    trims = 0
    var built: [any Tool] = []
    for tool in tools where selected.contains(tool.name) {
      // Every tool here already parsed at load, so a throw would be a bug
      // rather than a schema. Recorded as unusable rather than dropped
      // silently, so the count in the header still adds up.
      do {
        let name = tool.name
        built.append(
          try ChatModelTool.bridge(tool) { [weak self] json in
            guard let self else { return "refused: the conversation has ended." }
            // The budget is enforced here rather than by asking the model
            // nicely, because a model looping on a failing tool cannot be
            // asked anything until it stops.
            guard let stamp = claim() else {
              return "refused: this question has already used its \(Self.callsPerTurn) tool "
                + "calls. Answer with what the previous calls returned."
            }
            Task { @MainActor [weak self] in self?.note(waitingOn: name, era: stamp) }
            let call = client.call(name, argumentsJSON: json)
            Task { @MainActor [weak self] in self?.record(call, era: stamp) }
            return call.output
          })
      } catch {
        unusable.append("\(tool.name) — \(error.localizedDescription)")
        selected.remove(tool.name)
      }
    }
    bound = built
    session = LanguageModelSession(tools: built) { Self.instructions(for: surface) }
  }

  /// What the model is told before anything else.
  ///
  /// Short, and every sentence in it is load-bearing for a small model: name
  /// the surface so it does not invent tools from other ones, ask for small
  /// arguments because a `limit` it invents will otherwise be 100 and one
  /// result fills the window, and tell it to report rather than narrate,
  /// because a 3B model narrating a plan burns the tokens it needed to carry
  /// out the plan.
  private static func instructions(for surface: Surface) -> String {
    """
    You are helping someone try out Cupertino's \(surface.displayName) tools on this Mac.

    Use a tool whenever it can answer the question, and prefer small arguments — if a tool \
    takes a limit or a count, ask for a few rather than many. If no tool fits, say so plainly \
    instead of guessing an answer.

    Keep replies short. Report what a tool returned rather than describing what you are about \
    to do, and if a call fails, say what the error was. Every call runs against the real \
    \(surface.displayName) data on this Mac and is recorded in Cupertino's Log.
    """
  }

  // MARK: - Sending

  /// Returns whether the question was taken, so the composer knows whether to
  /// clear itself. Clearing regardless is how a refused question vanishes as
  /// though it had been asked.
  @discardableResult
  func send(_ text: String) -> Bool {
    let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !prompt.isEmpty, session != nil, canSend else { return false }
    messages.append(Message(role: .you, text: prompt))
    messages.append(Message(role: .model, text: ""))
    isResponding = true
    // A fresh call budget per question, not per conversation.
    turnState.withLock { $0.calls = 0 }

    let stamp = era
    let index = messages.count - 1
    turn = Task { [self] in
      await respond(to: prompt, at: index, era: stamp, retrying: false)
      // An orphan must not unwind a turn that is no longer its own: `stop` has
      // already done that, and may have started another since.
      guard stamp == era else { return }
      isResponding = false
      activeTool = nil
      turn = nil
    }
    return true
  }

  /// Send what the composer holds, and empty it only if it was taken.
  func submit() {
    if send(draft) { draft = "" }
  }

  /// Give up on the reply in flight.
  ///
  /// Nothing here waits. The tool call underneath may be blocked in a socket
  /// read for up to a minute, and there is no way to interrupt it — so the era
  /// ends, the pane unwinds now, and the thread still blocked in the server
  /// finishes into a conversation with no slot left for what it produces. That
  /// costs one thread and one answer nobody reads. It cannot cost correctness,
  /// because every write that turn can still make — a token, a call, a failure
  /// — carries an era that is over.
  func stop() {
    guard isResponding else { return }
    abandon(noting: true)
    reseat()
  }

  /// Let go of the running turn.
  ///
  /// `noting` marks the row on screen, which `stop` wants and a wholesale reset
  /// does not — there, the row is about to go with everything else.
  private func abandon(noting: Bool) {
    turn?.cancel()
    turn = nil
    if noting, let index = messages.indices.last, messages[index].role == .model {
      messages[index].failure = Self.stopped
    }
    endEra()
    isResponding = false
    activeTool = nil
  }

  /// A session of the conversation's own, since the old one belongs to a turn
  /// that has been let go of and may still be generating into it. Asking a busy
  /// `LanguageModelSession` is an error rather than a queue, so without this the
  /// next question after a Stop would fail.
  ///
  /// Truncated at the last completed response, which drops the question that
  /// was stopped: a transcript ending in a prompt with no answer, or in tool
  /// calls with no output, is not one the model's own generator would ever have
  /// produced. It is also why the stopped row says so on screen — the row is
  /// still in the pane, and the model no longer remembers it.
  private func reseat() {
    guard let session else { return }
    let entries = Array(session.transcript)
    let instructions = entries.filter { if case .instructions = $0 { true } else { false } }
    let body = entries.filter { if case .instructions = $0 { false } else { true } }
    let lastAnswer = body.lastIndex { if case .response = $0 { true } else { false } }
    let kept = lastAnswer.map { Array(body[...$0]) } ?? []
    self.session = LanguageModelSession(
      tools: bound, transcript: Transcript(entries: instructions + kept))
  }

  /// Stream one reply into `messages[index]`.
  ///
  /// The index is an identity only for as long as the era holds, and that is
  /// enough. Within one era `messages` only ever grows, and only in `send`,
  /// which is gated on `!isResponding`; everything that replaces the array
  /// wholesale — `load`, `rebuild`, `stop` — ends the era first.
  private func respond(to prompt: String, at index: Int, era stamp: Int, retrying: Bool) async {
    guard let session, stamp == era, messages.indices.contains(index) else { return }
    do {
      // Snapshots are cumulative — `snapshot.content` is the whole answer so
      // far — so this is an assignment rather than an accumulation.
      for try await snapshot in session.streamResponse(to: prompt, options: Self.options) {
        guard stamp == era, messages.indices.contains(index) else { return }
        messages[index].text = snapshot.content
      }
    } catch let error as LanguageModelSession.GenerationError {
      // Overflow is the expected end of a long conversation here, not a fault:
      // the tool budget is a little under half the window, so what is left for
      // everything else is about the same again, and one fat tool result spends
      // a good part of it. Drop the oldest turns and try once more; a second
      // failure is a real one.
      if case .exceededContextWindowSize = error, !retrying, stamp == era, trimTranscript() {
        await respond(to: prompt, at: index, era: stamp, retrying: true)
        return
      }
      fail(error.localizedDescription, at: index, era: stamp)
    } catch {
      fail(error.localizedDescription, at: index, era: stamp)
    }
  }

  /// The one place a failure is written, so there is one place the guard has to
  /// be right.
  private func fail(_ message: String, at index: Int, era stamp: Int) {
    // A stopped turn is not a failed one, and the framework is free to report
    // cancellation as whatever error it likes — so the question asked here is
    // "is this still the current turn", never "which error is this".
    guard stamp == era, !Task.isCancelled, messages.indices.contains(index) else { return }
    messages[index].failure = message
  }

  /// Name the tool a reply is waiting on, so the composer can say so.
  private func note(waitingOn tool: String, era stamp: Int) {
    guard stamp == era else { return }
    activeTool = tool
  }

  /// Record a call against the message that was being produced.
  ///
  /// Guarded by the era, not just by the index. A call that lands after a Stop
  /// or a Clear would otherwise append itself to whatever message happens to be
  /// last, which belongs to a different conversation.
  private func record(_ call: ChatCall, era stamp: Int) {
    guard stamp == era, let index = messages.indices.last, messages[index].role == .model
    else { return }
    messages[index].calls.append(call)
    activeTool = nil
  }

  /// Drop the two oldest entries and try once more.
  ///
  /// The instructions are pulled out and put back so a trim can never discard
  /// them — a model that has forgotten which surface it is talking to invents
  /// tool names.
  private func trimTranscript() -> Bool {
    guard let session else { return false }
    var entries = Array(session.transcript)
    let instructions = entries.filter { if case .instructions = $0 { true } else { false } }
    entries.removeAll { if case .instructions = $0 { true } else { false } }
    guard entries.count > 2 else { return false }
    entries.removeFirst(2)
    trims += 1
    self.session = LanguageModelSession(
      tools: bound, transcript: Transcript(entries: instructions + entries))
    return true
  }

  // MARK: - Closing

  /// Hang up but keep the transcript.
  ///
  /// Called when the pane goes away and when the app is quitting. Without it
  /// the node child for the last surface picked stays resident for the life of
  /// the app: nothing else closes this connection, and `deinit` is not a place
  /// to put it — SwiftUI holds the `@State` object across pane switches.
  func close() {
    client?.close()
    client = nil
    session = nil
  }

  // MARK: - Fixtures

  /// A conversation with a completed exchange in it, for `DemoSeed` only.
  ///
  /// Fills the same fields `load` and `finishLoading` do, in the same order,
  /// and stops short of `rebuild()` — the one step that needs a model. `used`
  /// is deliberately NOT set: it is computed off `ChatBudget.cost` against the
  /// fixture schemas, so the budget line in the header is a claim the fixture
  /// has to satisfy rather than a number typed into a screenshot.
  func adoptDemo(
    surface: Surface, tools: [ChatTool], selected: Set<String>, unusable: [String],
    messages: [Message], allowsWrites: Bool
  ) {
    self.surface = surface
    self.tools = tools.sorted(by: ChatBudget.before)
    self.selected = selected
    self.unusable = unusable
    self.messages = messages
    self.allowsWrites = allowsWrites
    // A transcript exists, so the notice was answered — a fixture that showed a
    // finished conversation behind an unanswered warning would be a picture of
    // a state the app cannot reach.
    self.acknowledgedWrites = true
    self.isLoading = false
  }

  #if DEBUG
    /// `Cupertino --chat=mail --ask="how many unread messages do I have?"`
    ///
    /// The integration test this feature would otherwise not have. Everything
    /// interesting here — the loopback handshake and its licence carve-out, the
    /// forced non-lazy listing, the schema conversion, the budget, and a real
    /// `tools/call` against a real supervised child — is invisible to
    /// `make chat-check`, which by design compiles one file and never opens a
    /// socket. Driving the pane instead means synthetic keystrokes landing in
    /// whatever is frontmost; this is the honest way to exercise it.
    ///
    /// Prints what fit, what did not and why, then every call with the arguments
    /// the model invented, its timing and its output.
    @MainActor
    static func runHeadless() async {
      func argument(_ flag: String) -> String? {
        CommandLine.arguments.first { $0.hasPrefix("\(flag)=") }
          .map { String($0.dropFirst(flag.count + 1)) }
      }
      // Line-buffered, or a hang loses every print that led up to it: stdout to
      // a pipe is block-buffered, and the whole value of this path is seeing
      // how far it got.
      setvbuf(stdout, nil, _IOLBF, 0)
      guard let id = argument("--chat") else { return }
      guard let surface = Surface.named(id) else {
        print("unknown surface '\(id)'")
        exit(2)
      }

      print("model: \(isAvailable ? "available" : "UNAVAILABLE — \(unavailableReason)")")
      print("window: \(contextSize) tokens, budget \(budget)")

      let chat = ChatConversation()
      chat.load(surface)
      // Polled rather than awaited: `load` hands off to a dedicated thread and
      // comes back through a main-actor hop, so there is no continuation to hold.
      while chat.isLoading { try? await Task.sleep(for: .milliseconds(50)) }
      if let failure = chat.loadFailure {
        print("load failed: \(failure)")
        exit(1)
      }

      print("writes: \(chat.allowsWrites ? "ON" : "off")")
      print("listed: \(chat.tools.count + chat.unusable.count), usable \(chat.tools.count)")
      print("loaded \(chat.selected.count) of \(chat.tools.count), \(chat.used)/\(budget) tokens")
      for tool in chat.tools {
        let mark = chat.selected.contains(tool.name) ? "IN " : "out"
        print(
          "  \(mark) \(ChatBudget.cost(of: tool).formatted(.number.grouping(.never)))"
            + "  req=\(tool.requiredCount) ro=\(tool.readOnlyHint == true ? "y" : "n")"
            + "  \(tool.name)")
      }
      for line in chat.unusable { print("  ---  \(line)") }

      guard let question = argument("--ask") else {
        chat.close()
        exit(0)
      }
      print("\nasking: \(question)")
      chat.acknowledgedWrites = true
      chat.send(question)
      while chat.isResponding { try? await Task.sleep(for: .milliseconds(50)) }

      for message in chat.messages {
        for call in message.calls {
          print("\n  \(call.failed ? "✗" : "✓") \(call.tool)  \(Int(call.seconds * 1000))ms")
          print("    args: \(call.arguments)")
          print("    out:  \(call.output.replacingOccurrences(of: "\n", with: "\n          "))")
        }
        if message.role == .model, !message.text.isEmpty { print("\n  said: \(message.text)") }
        if let failure = message.failure { print("\n  FAILED: \(failure)") }
      }
      if chat.trims > 0 { print("\ntranscript trimmed \(chat.trims)×") }
      chat.close()
      exit(0)
    }
  #endif
}
