import Foundation

/// What happens before Cupertino takes the screen from somebody, as a pure function.
///
/// ## Why this is its own file
///
/// `DrivingSession` holds the state, and it has to link the driver, the overlay
/// and AppKit. The decision itself is arithmetic over four values: the person's
/// preference, how long since they last touched the Mac, whether they turned
/// Cupertino away a moment ago, and the time. It is also the part that is
/// silent when wrong, because a countdown that never shows looks exactly like a
/// Mac nobody was using. So it lives here with no dependency, and `make unit`
/// pins it.
///
/// ## What "active" means, and the direction it errs in
///
/// `AccessibilityDriver.secondsSinceUserInput` reads `.combinedSessionState`,
/// which counts Cupertino's own posted events as well as a person's. Right after
/// a session that typed something, the Mac therefore looks busy for
/// `activeWindow` seconds even if nobody is there. That errs toward warning,
/// which is the cheap mistake: a countdown nobody watches costs a few seconds,
/// and a keystroke landing in somebody's sentence costs the sentence.
nonisolated enum DrivingPolicy {

  /// What to do when an agent wants the screen and the person was just using it.
  enum Before: String, CaseIterable, Sendable {
    /// Say what is about to happen, wait a few seconds, then go unless cancelled.
    case countdown
    /// Ask, and wait for an answer. No answer is a no.
    case ask
    /// Take it straight away, which is how every version before this one behaved.
    case none
  }

  struct Settings: Equatable, Sendable {
    var before: Before
    /// How long the countdown runs.
    var countdown: TimeInterval
    /// How long a session may go without a call before the Mac is handed back.
    var idleRelease: TimeInterval
  }

  enum Decision: Equatable {
    /// Open the session now.
    case open
    /// Show the countdown for this many seconds, then open unless cancelled.
    case countdown(TimeInterval)
    /// Ask, and wait at most this long for an answer.
    case ask(timeout: TimeInterval)
    /// The person turned Cupertino away recently. Nothing is shown again yet.
    case declined(retryIn: TimeInterval)
  }

  /// Input within this many seconds means somebody is using the Mac.
  static let activeWindow: TimeInterval = 20

  /// How long a question waits. Under the 30 s a lent channel allows a call
  /// (`CALL_TIMEOUT_MS`, packages/core/src/ax.ts), so a Mail reply waiting on
  /// the person hears "nobody answered" rather than a socket timeout.
  static let askTimeout: TimeInterval = 25

  /// After a cancel or a no, how long before Cupertino may ask again. Without
  /// it an agent that retries on refusal puts the same card back in front of
  /// the person who just dismissed it, which trains them to stop reading it.
  static let declineCooldown: TimeInterval = 30

  static let countdownRange: ClosedRange<Int> = 2...10
  static let idleReleaseRange: ClosedRange<Int> = 15...300

  /// Idle release at 45 s rather than lower: a model thinking between two
  /// calls routinely takes 10 to 30 s, and handing the Mac back in the middle of
  /// a sequence would pull the person's editor forward and then take it away
  /// again on the next press.
  static let defaults = Settings(before: .countdown, countdown: 3, idleRelease: 45)

  /// App-wide, not per surface: there is one person at the keyboard, whichever
  /// surface is driving. Desktop and Simulator draw the same control over the
  /// same keys.
  enum Keys {
    static let before = "driving.before"
    static let countdownSeconds = "driving.countdownSeconds"
    static let idleReleaseSeconds = "driving.idleReleaseSeconds"
  }

  static var current: Settings { read(UserDefaults.standard) }

  /// Read as a string or a number, the way `SurfaceSettings.captureMode` reads:
  /// `NSArgumentDomain` stores launch arguments as strings, so a policy pinned
  /// with `-driving.before none` has to read back as `.none` here.
  static func read(_ store: UserDefaults) -> Settings {
    let before = store.string(forKey: Keys.before).flatMap(Before.init(rawValue:))
    return Settings(
      before: before ?? defaults.before,
      countdown: seconds(
        store.object(forKey: Keys.countdownSeconds), in: countdownRange,
        fallback: defaults.countdown),
      idleRelease: seconds(
        store.object(forKey: Keys.idleReleaseSeconds), in: idleReleaseRange,
        fallback: defaults.idleRelease))
  }

  /// A stored number clamped into its range, or the fallback when there is none.
  static func seconds(_ raw: Any?, in range: ClosedRange<Int>, fallback: TimeInterval)
    -> TimeInterval
  {
    let value: Int?
    switch raw {
    case let number as NSNumber: value = number.intValue
    case let text as String: value = Int(text)
    default: value = nil
    }
    guard let value else { return fallback }
    return TimeInterval(min(max(value, range.lowerBound), range.upperBound))
  }

  /// The whole admission rule. Only asked when no session is open: a session
  /// already open admits every verb, which is what lets a burst pay once.
  ///
  /// A recent decline outranks everything, including a preference of `.none`
  /// and an idle Mac. The person said no a moment ago, and neither of those
  /// facts is newer than that.
  ///
  /// `background` is a verb that cannot take the focus: keys posted to one
  /// application's pid, or a command through a Debug build's own driving
  /// channel. Measured 2026-11-11 (`scripts/spike-background-input.swift`):
  /// neither activated the target in 32 cases, and neither touches the person's
  /// keyboard, so the countdown has nothing to protect them from. Since
  /// 2026-11-17 an Accessibility press, select, value write or focus into an app
  /// behind theirs is background too, for the same reason.
  ///
  /// Nor is the person asked under a preference of `.ask`. That question only
  /// comes up when they were using the Mac a moment ago, never on an idle one,
  /// so it is about contending with them, not a consent gate on driving at
  /// all; and it says "It will use the keyboard and mouse", which a background
  /// verb does not. It still opens a session, so the card says an agent is at
  /// work and carries the Stop cross, and a recent no still refuses it: they
  /// said no to Cupertino, not to one lane of it.
  /// Whether a verb that does not take the focus is BACKGROUND for this target.
  ///
  /// Only behind the person's app. Into the app they are in, a posted key or
  /// a channel command still moves their caret and mixes with their own
  /// keystrokes, so it gets the countdown as before. A front that cannot be
  /// read counts as the target, which errs toward warning.
  /// Generic so that two copies of one app, which share a bundle id, are told
  /// apart by their pids.
  /// Whether an element sits in a window another process draws: `windowOwner`
  /// is the window server's owner of the element's window, `process` the pid
  /// the element answers.
  ///
  /// A sandboxed app's open or save panel is drawn by the panel service, and
  /// its elements still answer the app's pid (MEASURED 2026-11-16 on TextEdit's
  /// Open panel: the field answered TextEdit's pid, its window belonged to
  /// "Open and Save Panel Service", and it had no `AXWindow`). A driving
  /// channel delivers to the app's own windows, and keys posted to the app's
  /// pid go to its own first responder, so neither reaches such a field, and
  /// the second could reach another one. Unknown either way is not foreign:
  /// that leaves the verb as it was.
  static func inForeignWindow(windowOwner: pid_t?, process: pid_t?) -> Bool {
    guard let windowOwner, let process else { return false }
    return windowOwner != process
  }

  static func isBackground<ID: Equatable>(target: ID, frontmost: ID?) -> Bool {
    guard let frontmost else { return false }
    return frontmost != target
  }

  // ─── which card a session shows ────────────────────────────────────────────

  /// What the card says while a session is open.
  ///
  /// Decided by the lane each call actually took, not by its verb. On
  /// 2026-11-17 a session that only pressed through Accessibility and clicked
  /// and scrolled through a Debug build's channel, with the person's own copy
  /// of the app in front, showed "Please don't use the keyboard or mouse" for
  /// 86 s. Nothing it did could reach their keyboard or mouse, and they asked
  /// whether the card was true. It was not.
  enum Tier: String, Sendable {
    /// The orange card: "Please don't use the keyboard or mouse."
    case handsOff
    /// The blue card: "You can keep working." Every call so far left the
    /// person's input alone, and none of the processes it reached has come in
    /// front.
    case keepWorking
  }

  /// How a call reaches its application.
  enum Lane: Sendable {
    /// A Debug build's own driving channel: the app delivers the event to its
    /// own windows. Nothing is posted to the session.
    case channel
    /// An Accessibility action or attribute write: `AXPress`, a row's
    /// `AXSelected`, a field's `AXValue` or `AXFocused`. Nothing is posted.
    case accessibility
    /// Keys posted to one process (`postToPid`, the background `type`). They
    /// never reach the person's app, but they are `CGEvent`s from the HID
    /// state source, which can carry modifiers the person is holding, so they
    /// do not count as leaving the person's input alone.
    case processKeys
    /// Events posted to the session, an activation, anything that takes the
    /// front: the person's own keys and clicks mix with these.
    case session
  }

  /// Whether a call on `lane` leaves the person's keyboard and mouse theirs.
  ///
  /// Only behind their app. Into the app they are in, a channel click or a
  /// press still lands where they are typing, and their own keys land in what
  /// is being driven.
  static func leavesInputAlone(_ lane: Lane, behind: Bool) -> Bool {
    switch lane {
    case .channel, .accessibility: behind
    case .processKeys, .session: false
    }
  }

  /// The tier once one more call is admitted. `current` is nil for the call
  /// that opens the session.
  ///
  /// Sticky: once orange, orange until the session ends. A card that went
  /// blue again would tell somebody they can carry on while the agent may
  /// still post into the session, and two flips in one session teach them not
  /// to read it.
  static func tier(_ current: Tier?, admitting leavesInputAlone: Bool) -> Tier {
    current == .handsOff || !leavesInputAlone ? .handsOff : .keepWorking
  }

  /// The tier after looking at what is in front.
  ///
  /// A process the session reached coming in front, whether the app brought
  /// itself forward after a press or the person switched to it, means their
  /// keys now land in what is being driven: orange, and it stays orange. A
  /// front that cannot be read counts the same, which errs toward warning.
  /// Generic, like `isBackground`, so that two copies of one app are told
  /// apart by their pids.
  static func tier<ID: Hashable>(_ current: Tier, frontmost: ID?, driven: Set<ID>) -> Tier {
    guard current == .keepWorking, let frontmost, !driven.contains(frontmost) else {
      return .handsOff
    }
    return .keepWorking
  }

  static func decide(
    _ settings: Settings, secondsSinceInput: Double, declinedUntil: Date?, now: Date,
    background: Bool = false
  ) -> Decision {
    if let declinedUntil, now < declinedUntil {
      return .declined(retryIn: declinedUntil.timeIntervalSince(now))
    }
    if background { return .open }
    guard secondsSinceInput < activeWindow else { return .open }
    switch settings.before {
    case .none: return .open
    case .countdown: return .countdown(settings.countdown)
    case .ask: return .ask(timeout: askTimeout)
    }
  }
}
