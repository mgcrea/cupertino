import CoreGraphics
import Foundation

/// Whether an input event came from the person's hands or from a program.
///
/// The Shell window is the last safeguard against an agent that was told to run something, and
/// a program can post a click or a keystroke as easily as an agent can ask for one: an approved
/// script, running under Cupertino's own Accessibility grant, could otherwise wait for the next
/// window and press "Run once" in it. `ShellPanel` drops every input event this says no to.
///
/// CoreGraphics only, so `make shell-check` compiles it.
nonisolated enum ShellInput {

  /// True only for an event that came from hardware. Decided from the CGEvent's source fields.
  ///
  /// The rule: the source's process id is 0 AND its state is `.hidSystemState`.
  ///
  /// **UNCONFIRMED.** Not measured on a real Mac yet (Ruling R5: no events are posted on
  /// Olivier's Mac without his go). It is the expected rule, derived from:
  ///
  /// - What a program can build. Measured 2026-10-27, without posting anything: a CGEvent built
  ///   by this process carries its own pid in `eventSourceUnixProcessID` whatever source it is
  ///   built from, and `eventSourceStateID` 0 for `.combinedSessionState`, 1 for
  ///   `.hidSystemState`, and an arbitrary number for `.privateState`. So a program can choose
  ///   the HID state but not, as far as is known, a pid of 0 once the window server has stamped
  ///   the poster's own.
  /// - What `FirstClickHostingView` already relies on: an event Cupertino posts reaches its own
  ///   windows with Cupertino's pid in that field.
  /// - Events the HID system generates are expected to read pid 0 and state 1.
  ///
  /// What Olivier must measure before this is relied on, in a scratch panel logging both fields:
  /// a real click and a real keystroke (expected pid 0, state 1); a `CGEvent` posted at
  /// `.cghidEventTap` by a separate process (expected that process's pid); one posted by
  /// Cupertino itself (expected Cupertino's pid). If a real event reads otherwise, the window
  /// cannot be answered at all and times out as a no, which fails safe; if a posted one reads
  /// pid 0 and state 1, the rule is wrong and must change.
  static func isHardware(_ event: CGEvent) -> Bool {
    event.getIntegerValueField(.eventSourceUnixProcessID) == 0
      && event.getIntegerValueField(.eventSourceStateID)
        == Int64(CGEventSourceStateID.hidSystemState.rawValue)
  }
}
