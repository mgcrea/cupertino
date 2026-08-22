import Foundation
import os

/// A full-function evaluation window, started by a person and held in memory.
///
/// The problem it solves is narrow and was real: unlicensed, the gate in
/// `ServerHost` refuses at the handshake, so nobody could find out whether the
/// servers work against *their* mail and *their* calendars before paying. The
/// refund is still the trial for the purchase decision; this is for the
/// *technical* one, which is a different question and is asked first.
///
/// Three properties, and each is load-bearing:
///
/// **Full function.** Every surface, and writes obeying their own toggle. A
/// crippled demo answers the wrong question — the thing being evaluated is
/// whether this works on this Mac, and a degraded mode cannot answer that.
/// docs/licensing.md's objection to trials was to the *subsystem* — a clock, an
/// expiry state, a degraded mode, a per-machine fiction — and this has one of
/// those four.
///
/// **In memory.** The deadline dies with the process, so there is no expiry
/// state on disk, nothing to invalidate, and no "one trial per machine" claim
/// to pretend to enforce. Quitting and reopening starts another one. That is
/// not an oversight: `apps/apple/LICENSE` reserves binaries, not behaviour, and
/// docs/licensing.md rules out anti-tamper work as unenforceable by
/// construction. Somebody relaunching the app every half hour to avoid €14.99
/// was never going to buy it, and the code to stop them would cost more than
/// they are worth.
///
/// **Started by hand.** `start()` is reachable only from a button. The bridge
/// launches Cupertino with `--background` while somebody is mid-sentence at an
/// assistant, and a trial that armed itself there would burn silently in a
/// window nobody was watching.
enum Trial {
  static let duration: TimeInterval = 30 * 60

  /// The lock is not ceremony. `ServerHost` reads this from its connection
  /// queue at handshake time while the button that writes it runs on the main
  /// actor, so the two genuinely race. `SurfaceSettings` gets away with a bare
  /// read because `UserDefaults` is itself thread-safe; a stored `Date?` is not.
  private static let state = OSAllocatedUnfairLock<Date?>(initialState: nil)

  /// Arm the window, or extend nothing. Starting a trial that is already
  /// running returns the existing deadline rather than pushing it out, so
  /// leaning on the button cannot stretch the half hour.
  ///
  /// Arming the reaper is done here rather than at the buttons, because there
  /// are two of them and a third would forget. A trial that only refused *new*
  /// connections would not be a thirty-minute trial at all: an MCP host opens
  /// one stdio connection when the editor starts and holds it until the editor
  /// quits, so the window would really close days later, or never.
  @discardableResult
  static func start() -> Date {
    let (deadline, isFresh) = state.withLock { stored -> (Date, Bool) in
      if let stored, stored > Date() { return (stored, false) }
      let next = Date().addingTimeInterval(duration)
      stored = next
      return (next, true)
    }
    if isFresh {
      // `wallDeadline`, not `deadline`: the dispatch clock stops while the Mac
      // is asleep and `Date` does not, so a monotonic timer would leave the
      // gate refusing while the servers it was meant to reap kept running.
      DispatchQueue.main.asyncAfter(wallDeadline: .now() + duration) {
        ServerHost.shared.endTrialSessions()
      }
    }
    return deadline
  }

  static var deadline: Date? {
    state.withLock { $0 }
  }

  static var isActive: Bool {
    guard let deadline else { return false }
    return deadline > Date()
  }

  /// Whether a window was opened this launch, expired or not. What the pane
  /// needs to tell "not tried yet" from "tried, and it ran out" — two states
  /// that want different words and a different button.
  static var hasRun: Bool {
    deadline != nil
  }

  static var remaining: TimeInterval {
    guard let deadline else { return 0 }
    return max(0, deadline.timeIntervalSinceNow)
  }

  /// Minutes, rounded up, so a window with forty seconds left reads "1 minute"
  /// rather than "0 minutes" while it is still working.
  static var remainingMinutes: Int {
    Int(ceil(remaining / 60))
  }

  /// "27 minutes left", for the three places that say it.
  static var remainingText: String {
    let minutes = remainingMinutes
    return minutes == 1 ? "1 minute left" : "\(minutes) minutes left"
  }
}

/// What this Mac may do right now, as one answer with the reason attached.
///
/// The same argument `LicenseCheck` makes at the top of `License.swift`, one
/// level up: four places ask this question — the gate in `ServerHost`, the
/// popover banner, the main window's status line and `LicensePane` — and each
/// needs the same three-way answer. Joining a key and a trial window at each of
/// them separately is how the banner ends up saying "unlicensed" while the
/// servers are happily running.
enum Entitlement {
  case licensed(License)
  case trial
  case refused(String)

  static var current: Entitlement {
    switch LicenseStore.check {
    case .valid(let license):
      return .licensed(license)
    case .refused(let reason):
      // A key first, always. Someone who has paid must never be told about a
      // trial, and a trial armed before a key was entered must not outrank it.
      return Trial.isActive ? .trial : .refused(reason)
    }
  }

  var allowsServers: Bool {
    if case .refused = self { return false }
    return true
  }
}
