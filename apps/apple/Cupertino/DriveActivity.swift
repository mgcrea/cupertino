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
/// posted", which is what hover's idle test and both diagnostics read, and a
/// launch landing mid-sequence cannot swap the orange card for one that says
/// keep working. `VisibleTools` decides which tier a Node call gets.
///
/// ## Why it expires rather than being switched off
///
/// A driving sequence is a burst of calls with gaps between them, not a session
/// with a beginning and an end that this type can see — the app is told about
/// each press as it happens and never about "the agent is finished". So the
/// state is a DEADLINE that each verb pushes forward, and it lapses on its own.
/// The alternative, an explicit end, would leave the indicator lit forever the
/// first time a client disconnected mid-sequence.
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
  nonisolated static func current() -> String? {
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
    stateLock.lock()
    defer { stateLock.unlock() }
    let now = Date()
    if let state, now < state.until { return (state.target, .driving) }
    if let info, now < info.until { return (info.target, info.kind) }
    return nil
  }

  /// How long after the last driving verb the indicator stays lit.
  ///
  /// Long enough to bridge the gaps inside a sequence — a poll-press-verify
  /// cycle spends most of its time waiting for an application to redraw — and
  /// short enough that it is obviously over when it is over. Measured against
  /// the Maps card work, which spent up to ~2 s between presses.
  static let linger: TimeInterval = 4

  private(set) var target: String?
  private(set) var kind: VisibleTools.Notice?
  private var expiry: Date?
  private var timer: Timer?

  /// Whether synthetic input is being posted, which is what the orange card says.
  var isDriving: Bool { kind == .driving }

  /// Whether any notice is up, of either tier.
  var isActive: Bool { target != nil }

  /// Called by every driving verb. Cheap on purpose: this is on the path of a
  /// press, and a press that waited on the UI to draw an indicator would be a
  /// worse trade than no indicator.
  func began(_ bundleId: String, _ notice: VisibleTools.Notice) {
    // Info never takes the card from a driving notice that is still live. It
    // does not push the deadline either, so the orange card ends when the
    // driving does.
    if notice != .driving, isDriving, let expiry, Date() < expiry { return }
    target = bundleId
    kind = notice
    expiry = Date().addingTimeInterval(Self.linger)
    // The on-screen notice, which is the indicator that actually shows —
    // `DrivingOverlay` records why the menu bar badge could not. Cheap on a
    // repeat: it returns immediately when it is already naming this
    // application, so a burst of presses does not rebuild a window per press.
    DrivingOverlay.shared.show(bundleId: bundleId, name: displayName ?? bundleId, kind: notice)
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.sweep() }
    }
  }

  private func sweep() {
    guard let expiry else { return }
    if Date() >= expiry {
      target = nil
      kind = nil
      self.expiry = nil
      DrivingOverlay.shared.hide()
      timer?.invalidate()
      timer = nil
    }
  }

  /// The name to show, which is the application's rather than a bundle id.
  ///
  /// Falls back to the identifier rather than to "an application": somebody
  /// reading this is being asked to stop touching their Mac, and a sentence
  /// that cannot say what is being driven does not earn that.
  var displayName: String? {
    guard let target else { return nil }
    return Surface.all.first { $0.bundleID == target }?.displayName ?? target
  }
}
