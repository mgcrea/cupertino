import CoreGraphics
import Foundation
import Security

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
/// The system's own interface is the exception: the menu bar, the Dock and `screencaptureui`
/// keep windows above the Shell window's level over the whole screen, and would keep Run off
/// for good. The level cannot tell them apart, since a program can pick any level; the code
/// signature can, since a program running as the person cannot make its window belong to one
/// of those processes. `isPlatform` is that test (`ShellPlatform` in the app).
///
/// The window list gives each window's owner pid, owner name, bounds and alpha. Window titles
/// need Screen Recording; these fields are documented not to, which has not been measured from
/// a process without the grant. A window listed without bounds, unless it is the system's, counts as
/// covering everything, and so does one listed without a pid, so a list that withholds them
/// leaves Run off rather than on.
///
/// The decision is pure, so `make shell-check` pins it; `above` asks the window server.
nonisolated enum ShellCover {
  struct Window: Equatable {
    /// Nil when the list gave none: then it is never this app's, nor the system's.
    var pid: Int32?
    /// In the window list's coordinates: points, origin at the top left of the main screen.
    /// Nil when the list gave none.
    var bounds: CGRect?
    var alpha: Double
    /// The owning program's name, as the list gives it. Its own words: shown only through
    /// `ShellText.owner`.
    var owner: String? = nil
  }

  /// True when a window of another process, not fully transparent and not the system's own,
  /// overlaps `frame` by any area. A window that only touches its edge does not.
  static func isCovered(
    _ frame: CGRect, by windows: [Window], ownPid: Int32, isPlatform: (Int32) -> Bool
  ) -> Bool {
    coverer(frame, by: windows, ownPid: ownPid, isPlatform: isPlatform) != nil
  }

  /// The first window, front to back, that covers `frame` as `isCovered` counts it. Nil when
  /// none does. `isPlatform` is asked only for a window that would otherwise cover.
  static func coverer(
    _ frame: CGRect, by windows: [Window], ownPid: Int32, isPlatform: (Int32) -> Bool
  ) -> Window? {
    windows.first { window in
      guard window.pid != ownPid, window.alpha > 0 else { return false }
      if let bounds = window.bounds {
        let overlap = frame.intersection(bounds)
        guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { return false }
      }
      guard let pid = window.pid else { return true }
      return !isPlatform(pid)
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
        alpha: (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
        owner: info[kCGWindowOwnerName as String] as? String)
    }
  }

  /// An AppKit frame (origin at the bottom left of the main screen) in the window list's
  /// coordinates.
  static func windowListRect(_ frame: CGRect, primaryScreenHeight: CGFloat) -> CGRect {
    CGRect(
      x: frame.minX, y: primaryScreenHeight - frame.maxY, width: frame.width,
      height: frame.height)
  }

  /// Where a window of `size` goes on a screen whose visible area is `visible`, both in
  /// AppKit's coordinates: centred, and never outside it, cut down to it when larger. The
  /// system's own windows do not count as covering, so a Shell window under the menu bar or the
  /// Dock would be partly hidden with Run still on.
  static func placed(_ size: CGSize, in visible: CGRect) -> CGRect {
    let width = min(size.width, visible.width)
    let height = min(size.height, visible.height)
    // Rounded to whole points, then held inside, which rounding alone could step past.
    let x = min(max((visible.midX - width / 2).rounded(), visible.minX), visible.maxX - width)
    let y = min(max((visible.midY - height / 2).rounded(), visible.minY), visible.maxY - height)
    return CGRect(x: x, y: y, width: width, height: height)
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

/// Whether a process is one of the system's own interface processes, the menu bar, the Dock and
/// the like: its running code is signed by Apple and has an identifier on `systemUI`. See there
/// for why not every program Apple signed.
///
/// Any error is a no, so a window whose owner cannot be checked still covers. Each verdict is
/// kept for its process, a pid together with the time it started, so a pid the system hands to
/// a new process is asked about afresh. A process whose start time cannot be read is not
/// trusted and is not kept, nor is one whose start time changed while it was asked about. At
/// most `limit` verdicts are kept; past that, all are let go.
///
/// Thread-safe: `CoverWatch` asks on the main thread every 0.1 s. `started` and `verify` are
/// given, so `make shell-check` pins the keeping without real processes.
nonisolated final class ShellPlatform: @unchecked Sendable {
  struct Start: Hashable {
    var seconds: Int
    var microseconds: Int
  }

  private struct Key: Hashable {
    let pid: Int32
    let start: Start
  }

  static let limit = 256
  static let shared = ShellPlatform(started: started, verify: isSystemUI)

  /// The processes whose windows never count as covering the Shell window, by signing
  /// identifier, each also required to be signed by Apple (`anchor apple`).
  ///
  /// An allowlist, not every program `anchor apple` meets: that one says who signed a program,
  /// not who wrote what it shows. `osascript` meets it, and its JavaScript reaches AppKit through
  /// its Objective-C bridge, where `NSWindow` answers `setLevel:` and `setIgnoresMouseEvents:`
  /// (measured 2026-10-28, without making a window); `/usr/bin/swift` and the Command Line
  /// Tools' `python3` meet it too. So a program running as the person could put a borderless,
  /// click-through window of theirs over the Shell window, and it would have been trusted.
  ///
  /// Every entry is system chrome: it draws the menu bar, the Dock, screenshots, Spotlight, the
  /// login and input-source windows, and no content a program running as the person writes
  /// into a click-through window. Notification Center comes nearest: it shows text a program
  /// wrote (`display notification`), but in banners that take clicks rather than letting them
  /// through, so one can hide Run but not trick a click onto it. A process added here later
  /// must meet the same rule.
  static let systemUI = [
    "com.apple.WindowServer",
    "com.apple.dock",
    "com.apple.screencaptureui",
    "com.apple.notificationcenterui",
    "com.apple.controlcenter",
    "com.apple.systemuiserver",
    "com.apple.Spotlight",
    "com.apple.WindowManager",
    "com.apple.loginwindow",
    "com.apple.TextInputMenuAgent",
    "com.apple.TextInputSwitcher",
  ]

  /// The code requirement `isSystemUI` checks, in Security's requirement language.
  static let requirementText = requirement(for: systemUI)

  /// `anchor apple and (identifier "a" or identifier "b" …)`.
  static func requirement(for identifiers: [String]) -> String {
    let any = identifiers.map { "identifier \"\($0)\"" }.joined(separator: " or ")
    return "anchor apple and (\(any))"
  }

  private let started: (Int32) -> Start?
  private let verify: (Int32) -> Bool
  private let lock = NSLock()
  // Guarded by `lock`.
  private var verdicts: [Key: Bool] = [:]

  init(started: @escaping (Int32) -> Start?, verify: @escaping (Int32) -> Bool) {
    self.started = started
    self.verify = verify
  }

  /// How many verdicts are kept.
  var count: Int { lock.withLock { verdicts.count } }

  func isPlatform(_ pid: Int32) -> Bool {
    guard let start = started(pid) else { return false }
    let key = Key(pid: pid, start: start)
    if let known = lock.withLock({ verdicts[key] }) { return known }
    let verdict = verify(pid)
    // The pid went to another process while it was asked about: the answer may be that one's.
    guard started(pid) == start else { return false }
    lock.withLock {
      if verdicts.count >= Self.limit { verdicts.removeAll() }
      verdicts[key] = verdict
    }
    return verdict
  }

  /// When process `pid` started, from the kernel's process table. Nil when it cannot be read.
  ///
  /// Not `proc_pidinfo`'s `PROC_PIDTBSDINFO`, which refuses a process of another user: measured
  /// on 2026-10-28, it gave EPERM for the window server, which runs as `_windowserver` and draws
  /// the menu bar, and the same start time as this for every process of the person's own.
  static func started(_ pid: Int32) -> Start? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size
    var name = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    // A pid no process has is no error: it gives back nothing.
    guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size == MemoryLayout<kinfo_proc>.size,
      info.kp_proc.p_pid == pid
    else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    return Start(seconds: start.tv_sec, microseconds: Int(start.tv_usec))
  }

  /// Whether process `pid`'s running code is valid and meets `requirementText`. Any error is a
  /// no.
  static func isSystemUI(_ pid: Int32) -> Bool {
    guard let requirement = systemUIRequirement else { return false }
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
      let code
    else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
  }

  // Made once; nil if it cannot be, and then no process is trusted. Never changed once made.
  nonisolated(unsafe) private static let systemUIRequirement: SecRequirement? = {
    var requirement: SecRequirement?
    let made = SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
    guard made == errSecSuccess else { return nil }
    return requirement
  }()
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
