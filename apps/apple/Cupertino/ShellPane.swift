import Foundation

/// What the Shell pane decides and says, apart from how it draws it.
///
/// Foundation only, so `make shell-check` can pin it. The views in `SurfaceDetail.swift` and the
/// sheets in `ShellConsent.swift` draw what this returns and never decide anything themselves:
/// which way a switch goes, whether a choice needs a confirming click, and what a line of the
/// run record says.
///
/// ## One place a seal is made
///
/// Shell has three switches (the pane's heading, the Settings row and the sidebar's context
/// menu) and every one of them routes through `switchStep`. Turning Shell off happens at once,
/// wherever it is asked. Turning it on never does: it opens the Shell pane with the confirming
/// sheet up, and only that sheet's confirming button, pressed by hand, calls
/// `ShellSeal.setEnabled(true)`. The same holds for "Don't ask" and `ShellSeal.setBefore(.none)`.
nonisolated enum ShellPane {
  static let surfaceID = "shell"

  /// How many lines of the run record the pane lists, newest first.
  static let recentLimit = 20

  /// What a switch asking for `wantsOn` does, given what is in force now.
  enum SwitchStep: Equatable {
    /// Open the Shell pane with the confirming sheet up.
    case confirmOn
    /// Turn Shell off and stop everything it is doing, with no sheet.
    case turnOff
    /// Leave Shell off, and say why it cannot be turned on.
    case cannotSeal
    /// Nothing to do: the switch already says what is in force.
    case none
  }

  /// `isOn` is the sealed value, `ShellSeal.isEnabled`, never the plain preference: a forged
  /// `defaults write` that set the bool must neither draw Shell as on nor make "off" a no-op.
  /// `sealProblem` is `sealProblem()`'s answer, read just before.
  static func switchStep(isOn: Bool, wantsOn: Bool, sealProblem: String?) -> SwitchStep {
    if wantsOn == isOn { return .none }
    if !wantsOn { return .turnOff }
    return sealProblem == nil ? .confirmOn : .cannotSeal
  }

  /// What choosing `chosen` in "Before running" does, given the setting in force.
  enum BeforeStep: Equatable {
    /// Write it at once through `ShellSeal.setBefore`: it still puts a window in front of a
    /// person, so it needs no seal and no sheet.
    case apply(ShellPolicy.Before)
    /// Show the warning sheet; only its confirming button writes `.none`.
    case confirmDontAsk
    case none
  }

  /// `current` is `ShellSeal.effectiveBefore`, so a forged `none` reads as `ask` here as well,
  /// and choosing "Don't ask" over it still asks for the click.
  static func beforeStep(current: ShellPolicy.Before, chosen: ShellPolicy.Before) -> BeforeStep {
    if chosen == current { return .none }
    return chosen == .none ? .confirmDontAsk : .apply(chosen)
  }

  /// Why a seal could not be made right now, or nil when it could.
  ///
  /// Reads the seal key, so it can cost one Keychain call. That is the point: `isEnabled` does
  /// not touch the key while Shell is off, so without this read `lastKeyError` would say
  /// nothing until somebody had confirmed the sheet for a seal that was never going to hold.
  /// A key that is simply not there yet is no problem; the first seal makes one.
  static func sealProblem() -> String? {
    _ = ShellSeal.source.key()
    return ShellSeal.lastKeyError
  }

  // MARK: - Recent runs

  /// One line of the run record, as the pane shows it. The time is drawn by the view, in the
  /// person's own locale.
  struct Row: Equatable {
    var client: String
    var decision: String
    var outcome: String
    /// The first 12 hex digits of the script's SHA-256, enough to tell two scripts apart at a
    /// glance and to find the full line in the file.
    var hash: String
    /// The agent's `purpose`, as help text.
    var help: String
  }

  static let hashDigits = 12

  static func row(_ entry: ShellRecord.Entry) -> Row {
    Row(
      client: entry.client, decision: label(entry.decision), outcome: outcome(entry),
      hash: String(entry.scriptSHA256.prefix(hashDigits)), help: entry.purpose)
  }

  static func label(_ decision: ShellRecord.Decision) -> String {
    switch decision {
    case .approved: "Approved"
    case .approvedForSession: "Approved for the session"
    case .notAsked: "Not asked"
    case .declined: "Declined"
    case .noAnswer: "No answer"
    case .cooldown: "Refused, just declined"
    case .busy: "Refused, too many running"
    case .cancelled: "Cancelled"
    case .invalid: "Refused, invalid request"
    }
  }

  /// How the script ended, or that it never started. A refusal has neither an exit code nor a
  /// signal, and says it did not run rather than show an empty cell.
  static func outcome(_ entry: ShellRecord.Entry) -> String {
    // Its outcome line never came: the run is still going, or Cupertino ended mid-run.
    if entry.started { return "no outcome recorded" }
    if entry.timedOut { return "timed out" }
    if let code = entry.exitCode { return "exit \(code)" }
    if let signal = entry.signal { return "ended by \(signal)" }
    switch entry.decision {
    case .approved, .approvedForSession, .notAsked: return "no exit code"
    default: return "did not run"
    }
  }

  // MARK: - Copy

  /// Every sentence the pane and its sheets show. No em dashes, as in the rest of the app's UI.
  enum Copy {
    static let enableTitle = "Turn on Shell?"
    static let enableBody =
      "Shell lets an agent run scripts with Cupertino's access. Every other surface reaches one "
      + "app through a few tools, behind write switches and gates. A script gets past all of "
      + "them: it can read your mail, your messages, your Safari history and anything else Full "
      + "Disk Access opens, and it can control every app Cupertino controls. An agent that reads "
      + "a mail or a web page saying \"run this\" is the realistic attack."
    static let enableSafeguard =
      "The window that shows you each script before it runs is the only safeguard left."
    static let enableConfirm = "Turn On Shell"

    static let dontAskTitle = "Run scripts without asking?"
    static let dontAskBody =
      "With Don't ask, a script runs as soon as an agent sends it, and no window shows you the "
      + "script first. That window is the only safeguard Shell has. A mail or a web page the "
      + "agent reads can tell it to run something you would never approve, and with this on, "
      + "nothing asks you before it runs."
    static let dontAskCard =
      "A card still shows while each script runs, and you can stop it there or from the menu bar."
    static let dontAskConfirm = "Don't Ask"

    static let cancel = "Cancel"

    static let sealProblem =
      "Shell can't be turned on, because Cupertino could not keep the key that protects this "
      + "setting in the Keychain."

    static let beforeLabel = "Before running"

    static func choice(_ before: ShellPolicy.Before) -> String {
      switch before {
      case .ask: "Ask every time"
      case .session: "Ask once per session"
      case .none: "Don't ask"
      }
    }

    static func caption(_ before: ShellPolicy.Before) -> String {
      switch before {
      case .ask:
        "Every script is shown to you in a window before it runs. No answer within "
          + "\(Int(ShellPolicy.askTimeout)) s is a no."
      case .session:
        "The window also offers to stop asking for the rest of that connection, for at most "
          + "\(Int(ShellPolicy.sessionLength / 60)) min."
      case .none:
        "Scripts run without a window. A card shows while each one runs, and you can stop it "
          + "there or from the menu bar."
      }
    }

    static let recentTitle = "Recent runs"
    static let recentEmpty = "No requests yet."
    static let recentFooter =
      "Every request is recorded, refusals too, with a hash of the script and never its text. "
      + "Kept for \(ShellRecord.retentionDays) days."
  }
}
