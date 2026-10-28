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
  /// Measured 2026-10-28 on macOS 27.0.1, in a scratch panel that compiled this file and logged
  /// both fields: clicks, drags, keys and trackpad scrolls from the person's hands read pid 0 and
  /// state 1. Clicks and keys posted by a separate process with Accessibility, and by the panel
  /// itself, read the poster's pid, even with pid 0 and the HID state written into the event
  /// before posting, through the HID tap, the session tap and `postToPid`. The window server
  /// stamps the pid; the state is the poster's to choose, so the pid carries the whole test.
  /// docs/shell.md has the table, and what was not measured (Screen Sharing, Sidecar).
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
/// Any error is a no, so a window whose owner cannot be checked still covers. Each definite
/// answer is kept for its process, a pid together with the time it started, so a pid the system
/// hands to a new process is asked about afresh. An error is not kept, so one that passes does
/// not keep Run off for as long as the process lives. A process whose start time cannot be read
/// is not trusted and is not kept, nor is one whose start time changed while it was asked
/// about. At most `limit` verdicts are kept; past that, all are let go.
///
/// Thread-safe: `CoverWatch` asks on the main thread every 0.1 s. `started` and `verify` are
/// given, so `make shell-check` pins the keeping without real processes.
nonisolated final class ShellPlatform: @unchecked Sendable {
  /// What Security says about a process. `no` is a refusal: valid code that does not meet the
  /// requirement. `unknown` is anything else that went wrong, which may pass.
  enum Answer {
    case yes, no, unknown
  }

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
  /// Nor every process of the system's interface. A trusted window that takes clicks but shows
  /// what a program chose can sit over the script with Run still on beneath it: a Spotlight
  /// panel listing files a program wrote, a Notification Center banner, Now Playing in Control
  /// Center, an input method's name in the input-source switcher. So only the processes measured
  /// above `.modalPanel`, over the middle of the screen, on a real Mac are listed: these three,
  /// on Olivier's Mac on 2026-10-28. Every other window still covers, which fails safe. A new
  /// entry needs that measurement and an argument that it draws no content a program chooses
  /// over the Shell window.
  static let systemUI = [
    "com.apple.WindowServer",
    "com.apple.dock",
    "com.apple.screencaptureui",
  ]

  /// The code requirement `isSystemUI` checks, in Security's requirement language.
  static let requirementText = requirement(for: systemUI)

  /// `anchor apple and (identifier "a" or identifier "b" …)`.
  static func requirement(for identifiers: [String]) -> String {
    let any = identifiers.map { "identifier \"\($0)\"" }.joined(separator: " or ")
    return "anchor apple and (\(any))"
  }

  private let started: (Int32) -> Start?
  private let verify: (Int32) -> Answer
  private let lock = NSLock()
  // Guarded by `lock`.
  private var verdicts: [Key: Bool] = [:]

  init(started: @escaping (Int32) -> Start?, verify: @escaping (Int32) -> Answer) {
    self.started = started
    self.verify = verify
  }

  /// How many verdicts are kept.
  var count: Int { lock.withLock { verdicts.count } }

  func isPlatform(_ pid: Int32) -> Bool {
    guard let start = started(pid) else { return false }
    let key = Key(pid: pid, start: start)
    if let known = lock.withLock({ verdicts[key] }) { return known }
    let answer = verify(pid)
    // The pid went to another process while it was asked about: the answer may be that one's.
    guard answer != .unknown, started(pid) == start else { return false }
    let verdict = answer == .yes
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

  /// Whether process `pid`'s running code is valid and meets `requirementText`. `no` only for
  /// `errSecCSReqFailed`, which is what valid code with another signer or another identifier
  /// gives (measured 2026-10-28 with a running `osascript` and Terminal); any other error is
  /// `unknown`, a process that has gone among them.
  static func isSystemUI(_ pid: Int32) -> Answer {
    guard let requirement = systemUIRequirement else { return .unknown }
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
      let code
    else { return .unknown }
    switch SecCodeCheckValidity(code, [], requirement) {
    case errSecSuccess: return .yes
    case errSecCSReqFailed: return .no
    default: return .unknown
    }
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
