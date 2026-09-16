import AppKit
import Foundation

/// Whether Cupertino holds the screen right now, as a session with a start and an end.
///
/// ## Why a session came back
///
/// `DriveActivity` used to argue against one. A driving sequence is a burst of
/// calls with gaps, the app never hears "the agent is finished", and an explicit
/// end would leave the card lit forever the first time a client disconnected
/// mid-sequence. So the notice was a deadline that each verb pushed four seconds
/// forward.
///
/// Both halves of that argument turned out to have answers. The end is a tool the
/// agent can call, `apple_desktop_release`. The disconnect is visible after all:
/// `ServerHost.serveInProcess` runs one thread per connection, and its `defer`
/// fires when the connection goes. Idle release is the last net under both, so
/// nothing can leave a session open.
///
/// What the deadline could not give the person, and this does:
///
///   * **A warning before the first event lands**, rather than in the same
///     instant. `DrivingPolicy` decides whether that is a countdown, a question
///     or nothing.
///   * **A card that stays up while the agent holds the screen**, rather than
///     lapsing four seconds after each verb while the model thinks. Somebody
///     looking at the driven app in front could not tell a pause from the end.
///   * **The app they were in, brought back** when the session ends.
///
/// ## One session for the Mac, not one per connection
///
/// There is one person at the keyboard. A Desktop client, a Simulator client and
/// Mail's borrowed driver all compete with the same person, so all of them share
/// this state. The session records which connections drove in it and ends when
/// the last of them has gone.
///
/// ## Where it is called from
///
/// `admit` runs inside every `AccessibilityDriver` driving verb, AFTER the
/// verb's own checks (grant, reach, a stale handle, an application that is not
/// running) and BEFORE it acts. A refused verb therefore opens no session and
/// shows no countdown, which is the property `desktop-check` pins for the notice.
///
/// ## Blocking, and why it is safe
///
/// A countdown or a question blocks the calling thread until it resolves. Every
/// RPC is answered on its connection's own `cupertino.session` thread, the same
/// arrangement `InProcessRPC.blocking` relies on, so the wait holds up nothing
/// but the caller. The main thread never waits: only a check calls from there,
/// and a main thread blocked on a card it is also meant to draw would hang.
nonisolated enum DrivingSession {

  struct Open {
    /// What the card names: the application the latest verb addressed.
    var target: String
    /// Every application driven in this session, so handing back can tell the
    /// person's own switch from the agent's.
    var driven: Set<String>
    let since: Date
    var lastCall: Date
    /// The application in front when the session opened. Nil when that was the
    /// target itself, Cupertino, or unreadable.
    let handsBackTo: String?
    var connections: Set<UUID>
    /// When the last connection that drove in this session closed.
    var orphanedAt: Date?
  }

  enum Prompt: Equatable, Sendable {
    case countdown(target: String, endsAt: Date)
    case asking(target: String)

    var target: String {
      switch self {
      case .countdown(let target, _), .asking(let target): target
      }
    }
  }

  enum Answer: Sendable {
    case go
    case stop
  }

  enum Reason: String, Sendable {
    /// `apple_desktop_release`, `apple_simulator_release`, or `run` with `releaseAfter`.
    case agent
    /// The Stop button in the menu bar.
    case person
    case idle
    case disconnected
  }

  struct Released: Sendable {
    let target: String
    let restored: String?
    let drivenFor: TimeInterval
    let reason: Reason
  }

  /// The key `ServerHost.serveInProcess` stores its connection id under, in the
  /// thread dictionary of the thread serving that connection. A thread-local
  /// rather than a parameter, so no signature between the host and the driver
  /// had to change to carry it.
  static let connectionKey = "io.mgcrea.cupertino.connection"

  /// How long a session outlives the last connection that drove in it. The same
  /// four seconds `DriveActivity.linger` bridges between two verbs, so a client
  /// that reconnects straight away keeps its session.
  static let disconnectGrace: TimeInterval = 4

  /// How long the "done" card stays up.
  static let handBackLinger: TimeInterval = 3

  private nonisolated(unsafe) static var open: Open?
  private nonisolated(unsafe) static var pending: Pending?
  private nonisolated(unsafe) static var declinedUntil: Date?
  private nonisolated(unsafe) static var sweeper: DispatchSourceTimer?
  private static let lock = NSLock()

  // ─── admission ─────────────────────────────────────────────────────────────

  /// Let a driving verb through, opening the session if none is open.
  ///
  /// Returns at once when a session is already open, which is what lets a burst
  /// of presses pay for one countdown. Throws a refusal the model can read when
  /// the person cancelled, said no, did not answer, or said no a moment ago.
  ///
  /// `settings` and `secondsSinceInput` are for the checks. The app passes
  /// neither, so both are read fresh on each call.
  static func admit(
    _ target: String, settings: DrivingPolicy.Settings? = nil, secondsSinceInput: Double? = nil
  ) throws {
    let connection = Thread.current.threadDictionary[connectionKey] as? UUID
    while true {
      // Read outside the lock, because it is an Accessibility round trip and a
      // slow application must not stall every other reader of this state.
      // Wasted only on the call that finds a session already open.
      let front = isOpen() ? nil : frontmost()

      lock.lock()
      if var session = open {
        let renamed = session.target != target
        session.target = target
        session.driven.insert(target)
        session.lastCall = Date()
        if let connection {
          session.connections.insert(connection)
          session.orphanedAt = nil
        }
        open = session
        lock.unlock()
        if renamed { announce(target) }
        return
      }

      // Somebody else is already warning the person. Wait for that answer
      // rather than stacking a second card on the first.
      if let waiting = pending {
        lock.unlock()
        if waiting.wait() == .stop { throw refusal(for: waiting) }
        continue
      }

      let now = Date()
      let decision = DrivingPolicy.decide(
        settings ?? DrivingPolicy.current,
        secondsSinceInput: secondsSinceInput ?? AccessibilityDriver.secondsSinceUserInput(),
        declinedUntil: declinedUntil, now: now)

      let waiting: Pending
      switch decision {
      case .open:
        openLocked(target, connection: connection, front: front, at: now)
        lock.unlock()
        announce(target)
        return

      case .declined(let retryIn):
        lock.unlock()
        throw AccessibilityDriver.Failure.refused(
          "The person at the keyboard turned Cupertino away "
            + "\(Int((DrivingPolicy.declineCooldown - retryIn).rounded())) s ago, so nothing was "
            + "posted to \(appName(target)) and they were not asked again. Cupertino will not ask "
            + "for another \(Int(retryIn.rounded(.up))) s. Ask them in the conversation first.")

      case .countdown, .ask:
        if Thread.isMainThread {
          openLocked(target, connection: connection, front: front, at: now)
          lock.unlock()
          announce(target)
          return
        }
        if case .countdown(let seconds) = decision {
          let endsAt = now.addingTimeInterval(seconds)
          waiting = Pending(
            .countdown(target: target, endsAt: endsAt), deadline: endsAt, silence: .go)
        } else {
          waiting = Pending(
            .asking(target: target), deadline: now.addingTimeInterval(DrivingPolicy.askTimeout),
            silence: .stop)
        }
        pending = waiting
      }
      lock.unlock()

      show(waiting.prompt)
      let answer = waiting.wait()
      // Re-read: the person had the countdown to switch to what they wanted to
      // finish, and THAT is the application to hand back to.
      let frontNow = answer == .go ? frontmost() : nil

      lock.lock()
      if pending === waiting {
        pending = nil
        switch answer {
        case .go:
          if open == nil {
            openLocked(target, connection: connection, front: frontNow, at: Date())
          }
        case .stop:
          // Silence on a question is not a no. Nobody was there to say it.
          if !waiting.silent {
            declinedUntil = Date().addingTimeInterval(DrivingPolicy.declineCooldown)
          }
        }
      }
      let opened = open != nil
      lock.unlock()
      show(nil)

      guard answer == .go else { throw refusal(for: waiting) }
      if opened {
        announce(target)
        return
      }
      // Released between the answer and here, by the person pressing Stop.
      // Go round again, which asks afresh.
    }
  }

  /// Answer the card on screen. Called by its buttons, and by the menu bar's.
  static func respond(_ answer: Answer) {
    lock.lock()
    let waiting = pending
    lock.unlock()
    waiting?.resolve(answer)
  }

  /// Any call on a connection, reads included, while a session is open. An agent
  /// reading the tree between two presses is still driving.
  static func touch() {
    lock.lock()
    defer { lock.unlock() }
    guard var session = open else { return }
    session.lastCall = Date()
    open = session
  }

  /// From `ServerHost.serveInProcess`, when a connection ends.
  static func connectionClosed(_ id: UUID, now: Date = Date()) {
    lock.lock()
    defer { lock.unlock() }
    guard var session = open, session.connections.remove(id) != nil else { return }
    if session.connections.isEmpty { session.orphanedAt = now }
    open = session
  }

  // ─── ending ────────────────────────────────────────────────────────────────

  /// End the session now, and hand the Mac back. Nil when none was open.
  @discardableResult
  static func release(_ reason: Reason, now: Date = Date()) -> Released? {
    lock.lock()
    let session = open
    closeLocked()
    lock.unlock()
    guard let session else { return nil }
    return finish(session, reason, now: now)
  }

  /// End a session nobody is using: every connection that drove in it has
  /// gone, or no call has arrived for the idle limit. Runs every second while a
  /// session is open, and directly from the checks with a chosen `now`.
  @discardableResult
  static func sweep(now: Date = Date(), settings: DrivingPolicy.Settings? = nil) -> Released? {
    let idleLimit = (settings ?? DrivingPolicy.current).idleRelease
    lock.lock()
    guard let session = open else {
      lock.unlock()
      return nil
    }
    // Decided and taken under one lock, so a verb arriving in between cannot
    // renew a session that is then ended anyway.
    let reason: Reason?
    if let orphaned = session.orphanedAt, now.timeIntervalSince(orphaned) >= disconnectGrace {
      reason = .disconnected
    } else if now.timeIntervalSince(session.lastCall) >= idleLimit {
      reason = .idle
    } else {
      reason = nil
    }
    if reason != nil { closeLocked() }
    lock.unlock()
    guard let reason else { return nil }
    return finish(session, reason, now: now)
  }

  /// Hand the Mac back, off the lock.
  ///
  /// **Only when the driven application is still in front.** If the person has
  /// already switched to something themselves, pulling their previous app
  /// forward would undo a choice they just made, so the rule is: bring it back
  /// when the screen is still the way the agent left it, otherwise leave it.
  private static func finish(_ session: Open, _ reason: Reason, now: Date) -> Released {
    DriveActivity.clearDriving()
    var restored: String?
    if let back = session.handsBackTo, !session.driven.contains(back),
      let front = frontmost(), session.driven.contains(front),
      AccessibilityDriver.handBack(to: back)
    {
      restored = back
    }
    let target = session.target
    Task(priority: .userInitiated) { @MainActor in
      DriveActivity.shared.sessionEnded(target, restored: restored)
    }
    return Released(
      target: target, restored: restored, drivenFor: now.timeIntervalSince(session.since),
      reason: reason)
  }

  // ─── reading ───────────────────────────────────────────────────────────────

  /// What the open session is driving, for callers on any thread.
  static func target() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return open?.target
  }

  static func isOpen() -> Bool { target() != nil }

  /// What `diagnostics` reports while a session is open.
  static func diagnostics(now: Date = Date()) -> [String: Any]? {
    lock.lock()
    let session = open
    lock.unlock()
    guard let session else { return nil }
    var out: [String: Any] = [
      "target": session.target,
      "sinceSeconds": (now.timeIntervalSince(session.since) * 10).rounded() / 10,
      "idleSeconds": (now.timeIntervalSince(session.lastCall) * 10).rounded() / 10,
      "idleReleaseSeconds": DrivingPolicy.current.idleRelease,
    ]
    if let back = session.handsBackTo { out["handsBackTo"] = back }
    return out
  }

  /// The answer `apple_desktop_release` and `apple_simulator_release` give.
  static func answer(_ released: Released?) -> [String: Any] {
    guard let released else {
      return [
        "released": NSNull(), "restored": NSNull(),
        "note": "Nothing was being driven, so there was nothing to hand back.",
      ]
    }
    return [
      "released": released.target,
      "restored": released.restored ?? NSNull(),
      "drivenForSeconds": (released.drivenFor * 10).rounded() / 10,
      "note": released.restored.map {
        "Handed back: \(appName($0)) is in front again, as it was before Cupertino started driving."
      }
        ?? "Session ended. Nothing was brought forward, because the person had already moved on "
        + "from what was driven, or nothing else was in front when the session began.",
    ]
  }

  /// The name a person would use. Falls back to the bundle id rather than to
  /// "an application": a card asking someone to stop typing has to say what for.
  static func appName(_ bundleId: String) -> String {
    Surface.all.first { $0.bundleID == bundleId }?.displayName
      ?? NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first?
      .localizedName
      ?? bundleId
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private static func frontmost() -> String? {
    AccessibilityDriver.frontmostBundleId()
      ?? NSWorkspace.shared.frontmostApplication?.bundleIdentifier
  }

  /// Under the lock.
  private static func openLocked(_ target: String, connection: UUID?, front: String?, at now: Date)
  {
    let back = (front == target || front == Bundle.main.bundleIdentifier) ? nil : front
    open = Open(
      target: target, driven: [target], since: now, lastCall: now, handsBackTo: back,
      connections: connection.map { [$0] } ?? [], orphanedAt: nil)
    guard sweeper == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { sweep() }
    timer.resume()
    sweeper = timer
  }

  /// Under the lock.
  private static func closeLocked() {
    open = nil
    sweeper?.cancel()
    sweeper = nil
  }

  private static func announce(_ target: String) {
    Task(priority: .userInitiated) { @MainActor in DriveActivity.shared.sessionOpened(target) }
  }

  private static func show(_ prompt: Prompt?) {
    Task(priority: .userInitiated) { @MainActor in DriveActivity.shared.prompting(prompt) }
  }

  private static func refusal(for waiting: Pending) -> AccessibilityDriver.Failure {
    let name = appName(waiting.prompt.target)
    switch (waiting.prompt, waiting.silent) {
    case (.asking, true):
      return .refused(
        "Nobody answered the request to drive \(name) within \(Int(DrivingPolicy.askTimeout)) s, "
          + "so nothing was posted. The person was using this Mac a moment ago and may have "
          + "stepped away. Ask them before trying again.")
    case (.asking, false):
      return .refused(
        "The person at the keyboard said no to Cupertino driving \(name). Nothing was posted. "
          + "Do not retry on your own: ask them in the conversation first.")
    case (.countdown, _):
      return .refused(
        "The person at the keyboard cancelled: Cupertino was about to drive \(name) while they "
          + "were using this Mac. Nothing was posted. Do not retry on your own: tell them what "
          + "you were about to do and let them say when.")
    }
  }

  /// One card on screen, and everyone waiting on its answer.
  ///
  /// `@unchecked Sendable` is honest: every field that changes is read and
  /// written under `condition`, and the others are set once in `init`.
  private final class Pending: @unchecked Sendable {
    let prompt: Prompt
    private let deadline: Date
    /// What the deadline answers: go for a countdown, stop for a question.
    private let silence: Answer
    private let condition = NSCondition()
    private var answer: Answer?
    private var timedOut = false

    init(_ prompt: Prompt, deadline: Date, silence: Answer) {
      self.prompt = prompt
      self.deadline = deadline
      self.silence = silence
    }

    /// Whether the answer came from the deadline rather than from a person.
    var silent: Bool {
      condition.lock()
      defer { condition.unlock() }
      return timedOut
    }

    func wait() -> Answer {
      condition.lock()
      defer { condition.unlock() }
      while answer == nil {
        if !condition.wait(until: deadline) { break }
      }
      if answer == nil {
        answer = silence
        timedOut = true
        condition.broadcast()
      }
      return answer ?? silence
    }

    func resolve(_ given: Answer) {
      condition.lock()
      defer { condition.unlock() }
      guard answer == nil else { return }
      answer = given
      condition.broadcast()
    }
  }
}
