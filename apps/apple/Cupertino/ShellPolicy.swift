import Foundation

/// Whether a Shell script runs now, waits for the person, or is turned away, as a pure function.
///
/// ## Why this is its own file
///
/// `ShellServer` holds the state per connection and `ShellConsent` draws the window, and the
/// window needs AppKit. The decision itself is arithmetic over five values: the "Before running"
/// setting, the connection's session approval, its cooldown, how many runs are in flight, and
/// the time. It is also the part that is silent when wrong, because a script that ran without a
/// window looks exactly like one somebody approved. So it lives here with no dependency, never
/// reads `UserDefaults` (the caller passes the effective setting), and `make unit` pins it.
///
/// ## Why a cooldown outranks "Don't ask"
///
/// After "Don't run" or a window nobody answered, the same connection is refused for
/// `declineCooldown` without a window, for `DrivingPolicy.declineCooldown`'s reason: an agent
/// that retries on refusal must not put the window straight back in front of the person who
/// just closed it. The cooldown outranks `.none` and a live session approval as well. The
/// person said no a moment ago, and neither of those facts is newer than that. It outranks a
/// full queue too, so a refused agent hears the refusal rather than "busy, try again".
nonisolated enum ShellPolicy {

  /// What happens before a script runs. Stored under `key`.
  enum Before: String, CaseIterable, Sendable {
    /// Show the window every time, with no "for this session" button.
    case ask
    /// Show the window, which also offers to approve the rest of the session.
    case session
    /// Run straight away, with the card shown while it runs.
    case none
  }

  enum Decision: Equatable {
    /// Run now. `notice` says whether the card shows while it runs.
    case run(notice: Bool)
    /// Show the window and wait at most `timeout` for an answer. No answer is a no.
    case ask(timeout: TimeInterval, offerSession: Bool)
    /// This connection was turned away recently. Nothing is shown again yet.
    case declined(retryIn: TimeInterval)
    /// `maxInFlight` runs are already going on this connection.
    case busy
  }

  static let key = "shell.before"

  /// How long the window waits for an answer.
  static let askTimeout: TimeInterval = 60

  /// After "Don't run" or no answer, how long before the window may show again.
  static let declineCooldown: TimeInterval = 30

  /// How long "for this session" lasts, unless the connection closes first.
  static let sessionLength: TimeInterval = 1800

  static let maxInFlight = 4

  /// The whole rule, in order: cooldown, then busy, then "Don't ask", then a live session
  /// approval, then the window.
  ///
  /// A session approval counts only while the setting is `.session`. Switching to "Ask every
  /// time" withdraws it at once rather than at its expiry, and it never runs a script past a
  /// setting that says to ask. It ends at `sessionApprovedUntil` itself, not a moment after.
  static func decide(
    _ before: Before, sessionApprovedUntil: Date?, declinedUntil: Date?, inFlight: Int, now: Date
  ) -> Decision {
    if let declinedUntil, now < declinedUntil {
      return .declined(retryIn: declinedUntil.timeIntervalSince(now))
    }
    guard inFlight < maxInFlight else { return .busy }
    switch before {
    case .none:
      return .run(notice: true)
    case .session:
      if let sessionApprovedUntil, now < sessionApprovedUntil { return .run(notice: true) }
      return .ask(timeout: askTimeout, offerSession: true)
    case .ask:
      return .ask(timeout: askTimeout, offerSession: false)
    }
  }
}
