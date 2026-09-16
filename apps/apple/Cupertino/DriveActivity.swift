import Foundation
import Observation

/// Whether Cupertino is driving somebody's screen right now.
///
/// ## Why this is visible at all
///
/// Every other capability here reads a store or sends an Apple Event, and none
/// of them competes with the person at the keyboard. Driving does: a synthetic
/// keystroke goes to whatever is frontmost and a click goes to a screen point,
/// so a person typing during a sequence does not slow it down, it corrupts it.
/// They cannot avoid that if nothing tells them it is happening.
///
/// `surfaces.json` already argued this for Sound — the microphone case was
/// deliberately NOT routed through QuickTime because that would be "borrowed
/// visibility that hides the agent behind an app the user never asked to
/// record". macOS supplies the indicator there. It supplies none for
/// Accessibility, which is the wider grant of the two, so this is that
/// indicator.
///
/// ## Two tiers, and why driving outranks the other
///
/// Some Node tools change the screen without posting any input: a Safari tab
/// switches, Notes starts. Those deserve a notice too, but not the one asking
/// for hands off the keyboard. So an INFO notice lives beside the driving state
/// rather than inside it: `current()` still means "synthetic input is being
/// posted", which is what both diagnostics read, and a launch landing
/// mid-sequence cannot swap the orange card for one that says keep working.
/// `VisibleTools` decides which tier a Node call gets.
///
/// ## A deadline, held open by a session
///
/// Each verb still pushes a deadline `linger` seconds forward, and that is all
/// the info tier and a borrowed driver outside a session ever get. But the
/// orange card no longer lapses while `DrivingSession` has a session open: the
/// person needs to know the agent still holds the screen while the model thinks
/// between two presses, and a card that vanished after four seconds told them
/// the opposite. The session is what ends it, by `release`, by the person, by
/// going idle or by the client going away — `DrivingSession` records why each
/// of those exists and why none of them can strand the card.
///
/// ## What the card can say, in order of precedence
///
///   1. A countdown or a question, before a session opens (`prompt`).
///   2. The driving or info notice (`target` and `kind`).
///   3. "Done", for a few seconds after a session ends (`handedBack`).
@Observable
@MainActor
final class DriveActivity {
  static let shared = DriveActivity()

  /// The same fact, readable from any thread.
  ///
  /// The observable half above exists for SwiftUI and can only be touched on the
  /// main actor; `apple_desktop_diagnostics` answers on a server thread and must
  /// be able to report what the menu bar is showing. Two readers, one truth,
  /// with the lock rather than a hop — a diagnostics call that awaited the main
  /// actor would block on whatever the UI happened to be doing.
  private nonisolated(unsafe) static var state: (target: String, until: Date)?
  /// The info tier, kept apart so it can never answer `current()`.
  private nonisolated(unsafe) static var info:
    (target: String, kind: VisibleTools.Notice, until: Date)?
  private static let stateLock = NSLock()

  /// What is being driven right now, for callers off the main actor.
  ///
  /// An open session answers first, so the reading stays true through the gaps
  /// a deadline would have let lapse.
  nonisolated static func current() -> String? {
    if let session = DrivingSession.target() { return session }
    stateLock.lock()
    defer { stateLock.unlock() }
    guard let state, Date() < state.until else { return nil }
    return state.target
  }

  nonisolated static func record(_ bundleId: String) {
    stateLock.lock()
    state = (bundleId, Date().addingTimeInterval(linger))
    stateLock.unlock()
    Task { @MainActor in shared.began(bundleId, .driving) }
  }

  /// Forget the driving deadline, when a session ends.
  ///
  /// Without it `current()` would go on naming the application for up to
  /// `linger` seconds after the Mac was handed back, and a verb's card that was
  /// still on its way to the main actor would light the orange notice again
  /// over the "done" one. `began` reads this to tell those late arrivals apart.
  nonisolated static func clearDriving() {
    stateLock.lock()
    state = nil
    stateLock.unlock()
  }

  /// When Cupertino last POSTED synthetic input, as opposed to driving at all.
  ///
  /// `secondsSinceUserInput` reads `.combinedSessionState` on purpose, so it
  /// counts our own events, and a caller comparing it against its sequence found
  /// "input" a moment ago on every run that posted a key: a native Mail reply
  /// blamed "someone using this Mac" for its own ⌘V. Kept apart from `state`
  /// because an AX action lights the notice without posting anything the idle
  /// reading would see. Stamped AFTER the events go out, so both readings of
  /// one keystroke agree.
  private nonisolated(unsafe) static var lastPostedInput: Date?

  nonisolated static func postedInput() {
    stateLock.lock()
    lastPostedInput = Date()
    stateLock.unlock()
  }

  /// Nil when nothing has been posted since launch.
  nonisolated static func secondsSincePostedInput() -> Double? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return lastPostedInput.map { Date().timeIntervalSince($0) }
  }

  /// Light the notice a `VisibleTools` entry asks for.
  ///
  /// `.driving` is `record` under another name, so a caller holding a table
  /// answer does not have to branch on it.
  nonisolated static func inform(_ bundleId: String, _ notice: VisibleTools.Notice) {
    guard notice != .driving else { return record(bundleId) }
    stateLock.lock()
    info = (bundleId, notice, Date().addingTimeInterval(linger))
    stateLock.unlock()
    Task { @MainActor in shared.began(bundleId, notice) }
  }

  /// What the notice is saying right now, driving first.
  nonisolated static func notice() -> (target: String, kind: VisibleTools.Notice)? {
    if let session = DrivingSession.target() { return (session, .driving) }
    stateLock.lock()
    defer { stateLock.unlock() }
    let now = Date()
    if let state, now < state.until { return (state.target, .driving) }
    if let info, now < info.until { return (info.target, info.kind) }
    return nil
  }

  /// How long after the last driving verb the indicator stays lit, outside a
  /// session.
  ///
  /// Long enough to bridge the gaps inside a sequence — a poll-press-verify
  /// cycle spends most of its time waiting for an application to redraw — and
  /// short enough that it is obviously over when it is over. Measured against
  /// the Maps card work, which spent up to ~2 s between presses.
  static let linger: TimeInterval = 4

  private(set) var target: String?
  private(set) var kind: VisibleTools.Notice?
  /// The countdown or question on screen. Outranks every other card.
  private(set) var prompt: DrivingSession.Prompt?
  /// What an open session is driving, which is what the menu bar's Stop acts on.
  private(set) var sessionTarget: String?
  private var handedBack: (target: String, restored: String?, until: Date)?
  private var expiry: Date?
  private var timer: Timer?

  /// Whether synthetic input is being posted, which is what the orange card says.
  var isDriving: Bool { kind == .driving }

  /// Whether any notice is up, of either tier, or the person is being asked.
  var isActive: Bool { target != nil || prompt != nil }

  /// Called by every driving verb. Cheap on purpose: this is on the path of a
  /// press, and a press that waited on the UI to draw an indicator would be a
  /// worse trade than no indicator.
  func began(_ bundleId: String, _ notice: VisibleTools.Notice) {
    // Info never takes the card from a driving notice that is still live. It
    // does not push the deadline either, so the orange card ends when the
    // driving does.
    if notice != .driving, isDriving, let expiry, Date() < expiry { return }
    // A driving notice for a session that has already ended: the verb recorded
    // it, then the Mac was handed back before this hop ran. Lighting it now
    // would put "don't use the keyboard" over "it's yours again".
    if notice == .driving, Self.current() == nil { return }
    target = bundleId
    kind = notice
    expiry = Date().addingTimeInterval(Self.linger)
    if notice == .driving { handedBack = nil }
    render()
    startTimer()
  }

  func prompting(_ prompt: DrivingSession.Prompt?) {
    self.prompt = prompt
    render()
    startTimer()
  }

  func sessionOpened(_ bundleId: String) {
    guard DrivingSession.target() != nil else { return }
    sessionTarget = bundleId
    began(bundleId, .driving)
  }

  func sessionEnded(_ bundleId: String, restored: String?) {
    sessionTarget = nil
    if kind == .driving {
      target = nil
      kind = nil
      expiry = nil
    }
    handedBack = (bundleId, restored, Date().addingTimeInterval(DrivingSession.handBackLinger))
    render()
    startTimer()
  }

  private func startTimer() {
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.sweep() }
    }
  }

  private func sweep() {
    let now = Date()
    if let expiry, now >= expiry {
      if kind == .driving, let session = DrivingSession.target() {
        // Held for as long as the session is open. Renamed too, in case the
        // session moved on to another application since the last verb.
        target = session
        self.expiry = now.addingTimeInterval(Self.linger)
      } else {
        target = nil
        kind = nil
        self.expiry = nil
      }
    }
    if let handedBack, now >= handedBack.until { self.handedBack = nil }
    render()
    if target == nil, prompt == nil, handedBack == nil {
      timer?.invalidate()
      timer = nil
    }
  }

  /// Put the card that outranks the others on screen, or take it down.
  ///
  /// Cheap to repeat: `DrivingOverlay.show` returns at once when it is already
  /// saying the same thing about the same application, so neither a burst of
  /// presses nor the half-second sweep rebuilds a window.
  private func render() {
    let overlay = DrivingOverlay.shared
    if let prompt {
      overlay.show(
        bundleId: prompt.target, name: DrivingSession.appName(prompt.target), phase: prompt.phase)
    } else if let target, let kind {
      overlay.show(bundleId: target, name: displayName ?? target, phase: .notice(kind))
    } else if let handedBack {
      overlay.show(
        bundleId: handedBack.target, name: DrivingSession.appName(handedBack.target),
        phase: .done(restoredName: handedBack.restored.map(DrivingSession.appName)))
    } else {
      overlay.hide()
    }
  }

  /// The name to show, which is the application's rather than a bundle id.
  ///
  /// Falls back to the identifier rather than to "an application": somebody
  /// reading this is being asked to stop touching their Mac, and a sentence
  /// that cannot say what is being driven does not earn that.
  var displayName: String? {
    guard let target else { return nil }
    return DrivingSession.appName(target)
  }

  /// The application a countdown or question names.
  var promptName: String? {
    prompt.map { DrivingSession.appName($0.target) }
  }
}
