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
  static func decide(
    _ settings: Settings, secondsSinceInput: Double, declinedUntil: Date?, now: Date
  ) -> Decision {
    if let declinedUntil, now < declinedUntil {
      return .declined(retryIn: declinedUntil.timeIntervalSince(now))
    }
    guard secondsSinceInput < activeWindow else { return .open }
    switch settings.before {
    case .none: return .open
    case .countdown: return .countdown(settings.countdown)
    case .ask: return .ask(timeout: askTimeout)
    }
  }
}
