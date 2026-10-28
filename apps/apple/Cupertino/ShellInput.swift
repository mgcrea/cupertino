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

/// Whether another program's window is over the Shell window.
///
/// Any program running as the person can put a borderless window above the Shell window's
/// level, drawing a harmless script where the real one is and letting clicks fall through, so a
/// person's genuine click lands on Run once. A hardware click is all `ShellInput` asks for, and
/// that click is one. So the run buttons are off while any window of another process lies over
/// the Shell window, and a click is refused if one does at the moment it lands.
///
/// The window list gives each window's owner pid, bounds and alpha. Its names need Screen
/// Recording; these fields are documented not to, which has not been measured from a process
/// without the grant. A window listed without bounds counts as covering everything, so a list
/// that withholds them leaves Run off rather than on.
///
/// The decision is pure, so `make shell-check` pins it; `above` asks the window server.
nonisolated enum ShellCover {
  struct Window: Equatable {
    /// Nil when the list gave none: then it is never this app's.
    var pid: Int32?
    /// In the window list's coordinates: points, origin at the top left of the main screen.
    /// Nil when the list gave none.
    var bounds: CGRect?
    var alpha: Double
  }

  /// True when a window of another process, not fully transparent, overlaps `frame` by any
  /// area. A window that only touches its edge does not.
  static func isCovered(_ frame: CGRect, by windows: [Window], ownPid: Int32) -> Bool {
    windows.contains { window in
      guard window.pid != ownPid, window.alpha > 0 else { return false }
      guard let bounds = window.bounds else { return true }
      let overlap = frame.intersection(bounds)
      return !overlap.isNull && overlap.width > 0 && overlap.height > 0
    }
  }

  /// The windows in a `CGWindowListCopyWindowInfo` answer.
  static func windows(from list: [[String: Any]]) -> [Window] {
    list.map { info in
      Window(
        pid: (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
        bounds: (info[kCGWindowBounds as String] as? NSDictionary).flatMap {
          CGRect(dictionaryRepresentation: $0 as CFDictionary)
        },
        alpha: (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }
  }

  /// An AppKit frame (origin at the bottom left of the main screen) in the window list's
  /// coordinates.
  static func windowListRect(_ frame: CGRect, primaryScreenHeight: CGFloat) -> CGRect {
    CGRect(
      x: frame.minX, y: primaryScreenHeight - frame.maxY, width: frame.width,
      height: frame.height)
  }

  /// Stands for every window when the list cannot be had: it covers everything.
  static let unknown = Window(pid: nil, bounds: nil, alpha: 1)

  /// The windows on screen above window number `windowNumber`, front to back. `unknown` alone
  /// when the window server gives no list, or the window has no number yet.
  static func above(_ windowNumber: Int) -> [Window] {
    guard windowNumber > 0,
      let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenAboveWindow], CGWindowID(windowNumber)) as? [[String: Any]]
    else { return [unknown] }
    return windows(from: list)
  }
}

/// The Shell window and the sheets that lower the bar, while they are open: where a click from a
/// driving surface must never land.
///
/// The Desktop surface checks that a point is on a window of the app it names, and steps over
/// windows at higher levels, so a click aimed at a window under the Shell window would be posted
/// onto Run once, with only `ShellInput.isHardware` left to drop it. `AccessibilityDriver`'s
/// `click` and `drag` ask `covers` first and refuse. The card is not listed: it sits in a
/// corner over whatever is there, by design, as the driving card does.
///
/// Thread-safe: set on the main thread as a panel shows and closes, read on a connection's
/// worker as a click is about to be posted. Each panel's frame is read from the window list
/// when asked, so a window the person dragged is where it is now; the frame given at `shown`
/// stands in when the list has none for it.
nonisolated enum ShellPanels {
  private static let lock = NSLock()
  // Guarded by `lock`. Window number to frame, in the window list's coordinates.
  nonisolated(unsafe) private static var open: [Int: CGRect] = [:]

  static func shown(_ windowNumber: Int, frame: CGRect) {
    lock.withLock { open[windowNumber] = frame }
  }

  static func closed(_ windowNumber: Int) {
    lock.withLock { _ = open.removeValue(forKey: windowNumber) }
  }

  /// Whether `point`, in the window list's coordinates (where clicks are posted), is on an
  /// open Shell panel.
  static func covers(_ point: CGPoint) -> Bool {
    let panels = lock.withLock { open }
    return panels.contains { number, given in
      (liveFrame(number) ?? given).contains(point)
    }
  }

  private static func liveFrame(_ windowNumber: Int) -> CGRect? {
    guard windowNumber > 0,
      let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(windowNumber))
        as? [[String: Any]],
      let first = list.first
    else { return nil }
    return ShellCover.windows(from: [first]).first?.bounds
  }
}
