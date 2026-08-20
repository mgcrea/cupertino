import AppKit
import Carbon
import Foundation

/// Full Disk Access, as one indivisible fact.
///
/// `docs/distribution.md`: "Full Disk Access is not divisible. A grant for mail
/// is already a grant for Messages, Safari history and SSH keys." So this is
/// deliberately one status for the whole app, not one per surface — reporting
/// it per surface would imply a containment that does not exist.
enum DiskAccessStatus: Equatable {
  case granted
  case denied
  /// The store is not on this machine at all, so readability says nothing.
  case storeMissing
}

/// Automation (Apple Events) status for one target app.
///
/// The raw codes are the same ones `mapOsaError` in
/// `packages/core/src/osascript.ts` translates, which is not a coincidence —
/// both are reading the same TCC decision, one through `osascript`'s exit and
/// one directly.
enum AutomationStatus: Equatable {
  case granted
  case denied           // -1743 errAEEventNotPermitted
  case notDetermined    // -1744 errAEEventWouldRequireUserConsent
  case appNotRunning    // -600  procNotFound
  case failed(OSStatus)
}

enum Permissions {
  /// The event the permission questions are asked about: `core`/`getd`, a
  /// property read — which is what the servers actually send, since every read
  /// in `packages/*/src/client` reaches Apple Events through `osascript` asking
  /// for a property.
  ///
  /// This was `typeWildCard` for both, which the header defines as asking
  /// whether *every* event may be sent — a strictly broader question than the
  /// one the app needs answered, and one that can disagree with what the
  /// servers can actually do. Naming the real event keeps the status row and
  /// the Allow… button answering the same question.
  ///
  /// It is **not** what made the button fail; that was the missing hardened
  /// runtime entitlement, recorded in `app/Cupertino.entitlements`. The
  /// wildcard was measured to behave identically, denying without a prompt,
  /// for the same reason.
  private static let eventClass = AEEventClass(kAECoreSuite)
  private static let eventID = AEEventID(kAEGetData)

  // MARK: Full Disk Access

  /// Probe with `access(2)`, never `stat(2)`.
  ///
  /// `stat` SUCCEEDS on a TCC-protected file — you get the real size and mtime
  /// — and only `open`/`access` are denied. A stat-based check would report
  /// success and prove nothing. Same distinction `packages/core/src/fs.ts`
  /// encodes as exists-vs-readable, and the one the TCC spike measured.
  static func diskAccess() -> DiskAccessStatus {
    var sawAStore = false
    for surface in Surface.all {
      guard let path = resolveStore(surface) else { continue }
      sawAStore = true
      if access(path, R_OK) == 0 { return .granted }
    }
    return sawAStore ? .denied : .storeMissing
  }

  /// Resolve a surface's store, expanding the one glob Mail needs.
  ///
  /// The ordering here is load-bearing, and it is the opposite of the obvious
  /// one. Directory **enumeration** of `~/Library/Mail` is denied without Full
  /// Disk Access:
  ///
  ///     ls ~/Library/Mail   -> Operation not permitted
  ///     test -e ~/Library/Mail/V10/MailData/Envelope\ Index   -> exists
  ///
  /// So a `contentsOfDirectory` glob fails in exactly the state this status row
  /// exists to describe — before the grant. Probing named candidates with
  /// `fileExists` works in both states, so that goes first, and enumeration is
  /// only the fallback for a V number outside the range once we *are* granted.
  ///
  /// This is a status row, not the real lane: the four-branch ladder in
  /// `packages/mail/src/client/locate.ts` asks Mail itself and is what the
  /// server actually uses.
  static func resolveStore(_ surface: Surface) -> String? {
    guard let relative = surface.storePath else { return nil }
    let home = FileManager.default.homeDirectoryForCurrentUser
    let exists = { (path: String) in FileManager.default.fileExists(atPath: path) }

    guard relative.contains("*") else {
      // `exists` is answerable without the grant; `readable` is not.
      let path = home.appendingPathComponent(relative).path
      return exists(path) ? path : nil
    }

    let parts = relative.split(separator: "/").map(String.init)
    guard let starIndex = parts.firstIndex(where: { $0.contains("*") }) else { return nil }
    let base = home.appendingPathComponent(parts[..<starIndex].joined(separator: "/"))
    let suffix = parts[(starIndex + 1)...].joined(separator: "/")
    let stem = parts[starIndex].replacingOccurrences(of: "*", with: "")

    let candidate = { (name: String) in
      base.appendingPathComponent(name).appendingPathComponent(suffix).path
    }

    // Newest first. V10 is current on macOS 26; the range is generous on both
    // sides so a bump does not need a release.
    for n in stride(from: 20, through: 2, by: -1) {
      let path = candidate("\(stem)\(n)")
      if exists(path) { return path }
    }

    // Only reachable once the grant is in place, which is the only state where
    // this can succeed at all.
    let children = (try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? []
    for child in children.sorted().reversed() where child.hasPrefix(stem) {
      let path = candidate(child)
      if exists(path) { return path }
    }
    return nil
  }

  /// Full Disk Access never prompts — it can only be granted by hand.
  static func openDiskAccessSettings() {
    let url = URL(
      string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")!
    NSWorkspace.shared.open(url)
  }

  // MARK: Automation

  /// Ask TCC whether we may drive `bundleID`, **without prompting**.
  ///
  /// `askUserIfNeeded: false` is what makes this safe to call on a timer to
  /// paint a status row: it reports `.notDetermined` rather than throwing a
  /// consent dialog at someone who only opened a menu.
  static func automation(for bundleID: String) -> AutomationStatus {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
    guard let desc = target.aeDesc else { return .failed(OSStatus(paramErr)) }

    let status = AEDeterminePermissionToAutomateTarget(
      desc, eventClass, eventID, false)

    switch status {
    case noErr: return .granted
    case OSStatus(errAEEventNotPermitted): return .denied
    case OSStatus(errAEEventWouldRequireUserConsent): return .notDetermined
    case OSStatus(procNotFound): return .appNotRunning
    default: return .failed(status)
    }
  }

  /// Ask for Automation consent **now**, from the app, with the prompt visible.
  ///
  /// The alternative is what happens by default: the first tool call triggers
  /// the prompt lazily inside `osascript`, which then blocks until someone
  /// notices the dialog. Measured — the call times out after 30s and the
  /// assistant is told Mail "may be mid-sync", which is not what happened.
  ///
  /// This needs `com.apple.security.automation.apple-events` in
  /// `app/Cupertino.entitlements`. Without it, under the hardened runtime, the
  /// call returns `errAEEventNotPermitted` instantly and no dialog is ever
  /// shown — see the entitlements file for the measurement. The servers were
  /// never affected, because they send their events from `osascript`.
  ///
  /// Blocks until the user answers, so never call it on the main thread.
  static func requestAutomation(for bundleID: String) -> AutomationStatus {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
    guard let desc = target.aeDesc else { return .failed(OSStatus(paramErr)) }
    let status = AEDeterminePermissionToAutomateTarget(desc, eventClass, eventID, true)
    switch status {
    case noErr: return .granted
    case OSStatus(errAEEventNotPermitted): return .denied
    case OSStatus(procNotFound): return .appNotRunning
    // Asked, and still undecided — the dialog was dismissed rather than
    // answered. Falling through to `.failed` here turned that into a dead grey
    // cross with no way back; `.notDetermined` leaves the button offering to
    // ask again.
    case OSStatus(errAEEventWouldRequireUserConsent): return .notDetermined
    default: return .failed(status)
    }
  }

  static func openAutomationSettings() {
    let url = URL(
      string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation")!
    NSWorkspace.shared.open(url)
  }

  static func isRunning(_ bundleID: String) -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
  }
}
