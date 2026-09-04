import AVFoundation
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import SafariServices

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
  case denied  // -1743 errAEEventNotPermitted
  case notDetermined  // -1744 errAEEventWouldRequireUserConsent
  case appNotRunning  // -600  procNotFound
  case failed(OSStatus)
}

/// Accessibility (UI scripting) status.
///
/// Two cases, not three, and that is a fact about TCC rather than a
/// simplification: `AXIsProcessTrusted` answers false both for a refusal and
/// for a question nobody has been asked yet, and no API separates them. So
/// `AutomationStatus.notDetermined` has no counterpart here — the button offers
/// to ask either way, which is the correct action in both states.
/// Screen Recording, as two states.
///
/// Two rather than three for the same reason `AccessibilityStatus` has two: TCC
/// cannot distinguish "denied" from "never asked" for this service either.
enum ScreenRecordingStatus: Hashable {
  case granted
  case denied
}

/// The microphone, as FOUR states — and it is the first grant here that can
/// afford four.
///
/// `AccessibilityStatus` and `ScreenRecordingStatus` have two because TCC
/// answers them with a boolean and cannot separate a refusal from a question
/// nobody has asked. `AVCaptureDevice.authorizationStatus(for:)` does separate
/// them, and the difference is worth surfacing: `notDetermined` means the app
/// can still raise the prompt itself, while `denied` means only System Settings
/// will do. Collapsing them would send someone to the wrong place.
enum MicrophoneStatus: Hashable {
  case granted
  case denied
  /// Nobody has been asked yet. The prompt is still available.
  case notDetermined
  /// Policy forbids it — a managed Mac or Screen Time. Asking will not help.
  case restricted

  /// The spelling that goes on the wire, in diagnostics.
  var wireName: String {
    switch self {
    case .granted: "granted"
    case .denied: "denied"
    case .notDetermined: "notDetermined"
    case .restricted: "restricted"
    }
  }
}

enum AccessibilityStatus: Equatable {
  case granted
  case denied
}

/// The one grant a surface's store sits behind, normalised across the three TCC
/// services that gate one.
///
/// `Surface.storePermission` names which service; this says whether it is held.
/// Two states, not three, for the reason `ScreenRecordingStatus` has two: TCC
/// answers Screen Recording and Contacts with a boolean and cannot separate a
/// refusal from a question never asked. Full Disk Access has a third case of its
/// own — `storeMissing`, a fact about the machine rather than about permission —
/// which `storeGrant(for:diskAccess:)` folds in deliberately.
enum StoreGrant: Equatable {
  case granted
  case missing
}

/// Whether Safari is running our web extension.
///
/// Four states, and the fourth is the one that matters. `notInstalled` is not a
/// failure: a Debug build ships no extension at all (see the `app` target in the
/// Makefile), so on a locally built copy this is the correct and expected
/// answer. Reporting it as "disabled" would send someone to Safari to enable
/// something that is not there.
enum SafariExtensionStatus: Equatable {
  case enabled
  case disabled
  /// Safari does not know this extension. A Debug build, or an app that has
  /// never been launched from its installed location.
  case notInstalled
  /// The query itself failed. Distinct from `notInstalled`, because "we could
  /// not ask" and "the answer is no" are different facts.
  case unknown
}

enum Permissions {
  /// The app whose UI the composer is read out of.
  ///
  /// Automation to System Events is a SEPARATE grant from Automation to Mail,
  /// which is why `apple_mail_reply_to_message` can fail on a Mac where every
  /// other Mail tool works. It is not a Surface — nothing registers it, it has
  /// no store and no tools — so it is named here rather than in `surfaces.json`.
  static let systemEventsBundleID = "com.apple.systemevents"

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
  /// TCC's own database: present on every Mac, and readable under exactly one
  /// condition.
  ///
  /// `access(2)` only asks whether it *could* be opened. Nothing here reads a
  /// byte of it, and nothing needs to — the question is the permission, not the
  /// contents.
  private static let fullDiskAccessOracle = "Library/Application Support/com.apple.TCC/TCC.db"

  /// Is Full Disk Access granted?
  ///
  /// **Not "can any surface store be read".** That was the previous test and it
  /// failed in the one direction that matters: it reported `.granted` while
  /// every protected store on the Mac was unreadable.
  ///
  /// The loop returned on the first store that opened, and
  /// `Library/Application Support/AddressBook` opens without this grant — it is
  /// gated by the Contacts TCC service, which is a different permission. So
  /// Contacts alone answered the question on behalf of Mail, Messages, Safari,
  /// Notes, Reminders and Calendar, and answered it wrongly.
  ///
  /// MEASURED, with the grant absent: Mail, Notes, Reminders, Calendar,
  /// Messages and Safari all denied, AddressBook readable. The Settings row
  /// showed a green tick in the same second that `apple_mail_diagnostics`
  /// reported `fullDiskAccess: denied` and every mail lane fell back to Apple
  /// Events. A permission row that lies is worse than no row: it sends someone
  /// looking for the fault everywhere except where it is.
  ///
  /// `storeMissing` still means what it did — there is nothing on this Mac worth
  /// reading, so readability would say nothing either way — and it is decided
  /// before the grant is consulted, because that question is about the machine
  /// rather than about permission.
  static func diskAccess() -> DiskAccessStatus {
    let sawAStore = Surface.all.contains { resolveStore($0) != nil }
    guard sawAStore else { return .storeMissing }

    let oracle = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(fullDiskAccessOracle).path
    return access(oracle, R_OK) == 0 ? .granted : .denied
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
      string:
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")!
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
      string:
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation")!
    NSWorkspace.shared.open(url)
  }

  // MARK: Safari extension

  /// Which surface the extension belongs to.
  ///
  /// Named here rather than in `surfaces.json` for the reason
  /// `systemEventsBundleID` gives above: the extension is not a Surface. It
  /// registers no tools, has no store and no env prefix, and exactly one
  /// surface will ever have one. A flag in the manifest would mean touching
  /// the schema, `generate-surfaces.mjs` and the Swift template to carry a
  /// boolean that is true once.
  static let safariSurfaceID = "safari"

  static var safariExtensionID: String {
    (Bundle.main.bundleIdentifier ?? BridgeProtocol.appIdentifier) + ".SafariExtension"
  }

  /// Ask Safari whether the extension is enabled.
  ///
  /// Asynchronous, and unavoidably so — the API is completion-handler based and
  /// talks to Safari, so it must never be called while painting a row. That is
  /// the same rule the Automation probes carry, for the same reason.
  ///
  /// Only the containing app may ask. A separate process gets `SFErrorDomain
  /// error 1`, which is measured: a standalone probe binary built from the same
  /// call site was refused, and this succeeds only because it runs inside the
  /// bundle that ships the extension.
  static func safariExtension() async -> SafariExtensionStatus {
    await withCheckedContinuation { continuation in
      SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: safariExtensionID) {
        state, error in
        if let state {
          continuation.resume(returning: state.isEnabled ? .enabled : .disabled)
        } else if let error = error as NSError?, error.domain == SFErrorDomain,
          error.code == SFErrorCode.noExtensionFound.rawValue
        {
          // Safari has no record of it. On a Debug build that is correct: the
          // Makefile strips the appex, because Safari will not list an
          // extension whose container is not notarized and stapled.
          //
          // The CODE is checked, not just the domain. `SFErrorCode` has three
          // values and only this one means "no such extension" — 2 is
          // `noAttachmentFound` and 3 is `loadingInterrupted`, which are both
          // "we could not ask" and belong in `.unknown`. Matching the domain
          // alone reported them as an extension that is not installed, which
          // is the one answer that sends someone to reinstall the app.
          continuation.resume(returning: .notInstalled)
        } else {
          continuation.resume(returning: .unknown)
        }
      }
    }
  }

  /// Safari's own Extensions settings, which is where this switch lives.
  ///
  /// There is no `x-apple.systempreferences:` pane for it — it is Safari's
  /// preferences, not the system's. What there IS is
  /// `showPreferencesForExtension`, which opens that pane with our row already
  /// selected; the SDK header says so in as many words ("Opens Safari
  /// Extensions preferences and selects extension with the identifier"). This
  /// used to launch Safari and stop there, which left someone who had just
  /// been told to enable an extension in a browser window, hunting a
  /// three-level menu for it.
  ///
  /// The launch is kept as the fallback rather than dropped, because that call
  /// reports failure asynchronously and its failure modes are not enumerated
  /// anywhere. Landing in Safari is worse than landing on the pane and better
  /// than a button that does nothing.
  static func openSafariExtensionSettings() {
    SFSafariApplication.showPreferencesForExtension(withIdentifier: safariExtensionID) { error in
      guard error != nil else { return }
      DispatchQueue.main.async { launchSafari() }
    }
  }

  private static func launchSafari() {
    guard
      let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari")
    else { return }
    NSWorkspace.shared.openApplication(at: safari, configuration: NSWorkspace.OpenConfiguration())
  }

  /// Where the extension writes. Mirrors `defaultPagesDirectory` in
  /// `packages/safari/src/client/pages.ts`.
  ///
  /// The identifier is DERIVED, like `safariExtensionID` and for the same
  /// reason — a Debug build must ask about its own extension.
  /// `packages/safari/src/client/pages.ts` hardcodes the release one, which is
  /// a latent bug there rather than a licence to repeat it here.
  ///
  /// Needs no grant of any kind. The extension writes into its own appex
  /// container, which is `drwx------` owned by the user and is not
  /// TCC-protected; docs/safari.md records the negative control — a shell
  /// denied on `History.db`, `~/Library/Mail` and `chat.db` reading three appex
  /// containers, two of them belonging to other vendors' apps.
  static var safariPagesDirectory: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Containers/\(safariExtensionID)")
      .appendingPathComponent("Data/Library/Application Support/pages")
  }

  /// Blocking. The logic lives in `SafariCaptures` so `make unit` can assert
  /// it; this only supplies the path.
  static func safariCaptures() -> SafariCaptures {
    SafariCaptures.read(directory: safariPagesDirectory)
  }

  // MARK: Accessibility

  /// Is this process trusted to read another app's UI?
  ///
  /// What `apple_mail_reply_to_message` needs, and the one permission the whole
  /// app was previously blind to. A reply's body cannot go through the
  /// scripting interface at all — `content` on a reply reports itself settable
  /// and then swallows the write — so the composer is filled through the
  /// accessibility interface, and without this grant that fails while
  /// Automation and Full Disk Access both read as granted.
  ///
  /// Cheap and local: unlike `automation(for:)` this is a lookup, not a
  /// synchronous IPC, so it is safe to call while painting a row. The freeze
  /// documented over `StatusModel.refreshAutomation` does not apply.
  ///
  /// The identity being asked about is **this app**, and the servers do inherit
  /// it: `scripts/spike-app-tcc` measured that for Full Disk Access and Apple
  /// Events, and `launchctl procinfo` confirms it for the servers directly —
  /// the responsible pid of a `node` server is this process.
  ///
  /// What that does NOT buy is certainty, because the identity itself can be
  /// ambiguous. MEASURED, macOS 26.6: with this row green, an `osascript`
  /// grandchild answered `AXIsProcessTrusted` false and could not name a single
  /// Mail window, so `apple_mail_reply_to_message` failed on a Mac whose
  /// Accessibility row said everything was fine. The cause was that
  /// **one bundle identifier can hold several Accessibility entries at once**,
  /// one per path and signature it has been granted at — an installed copy, a
  /// debug build, each earlier reinstall. `tccutil reset Accessibility
  /// io.mgcrea.cupertino` reported clearing FOUR. This check matched one of
  /// them; the servers' checks matched another.
  ///
  /// So a green row is necessary and not sufficient, and the thing to fix is
  /// never "grant it again" — it is to clear the identifier and grant once from
  /// the bundle that is running. `apple_mail_diagnostics` reports
  /// `composerUiRead`, which measures the composer instead of asking about it.

  static func accessibility() -> AccessibilityStatus {
    AXIsProcessTrusted() ? .granted : .denied
  }

  /// Screen Recording — the third TCC service this app models, and the first
  /// added since `Surface.storePermission` started recording which grant gates
  /// which surface.
  ///
  /// TWO answers, because they disagree and the disagreement is the diagnosis.
  /// `CGPreflightScreenCaptureAccess` is a claim about this identity;
  /// enumerating windows is the capability. A Mac that has run Cupertino from
  /// more than one path holds several TCC rows under one identifier — the
  /// "one identifier, four grants" state in scripts/spike-app-tcc/README.md —
  /// and there the flag says yes while every capture is blind. The cure is
  /// `tccutil reset ScreenCapture`, never another grant, so advice built on the
  /// flag alone sends people round a loop that cannot terminate.
  ///
  /// Cheap enough to call from a settings pane: the flag is a lookup and the
  /// enumeration is the same call the server makes.
  ///
  /// MEASURED, macOS 26.6: this grant is held by the app bundle, inherited by
  /// processes it spawns, and survives both re-signing and the bundle moving —
  /// see docs/screen.md. It is NOT inherited from whatever launched the app.
  static func screenRecording() -> ScreenRecordingStatus {
    CGPreflightScreenCaptureAccess() ? .granted : .denied
  }

  /// Unlike Full Disk Access, this one CAN be requested — and unlike Contacts,
  /// the grant only takes effect on relaunch, which the UI has to say.
  static func requestScreenRecording() {
    CGRequestScreenCaptureAccess()
  }

  /// The microphone, for THIS process's responsible identity.
  ///
  /// MEASURED, macOS 26.6 through scripts/spike-app-tcc lane 2d: the grant lands
  /// on the app bundle, is inherited by a grandchild, and survives a rebuild and
  /// re-sign — see docs/sound.md. Measured rather than inherited from the Full
  /// Disk Access verdict, because that generalisation was already wrong once,
  /// for Accessibility.
  ///
  /// A TRAP THAT LOOKS LIKE A CRASH: macOS TERMINATES a process that touches the
  /// microphone with no `NSMicrophoneUsageDescription` in its Info.plist. Every
  /// other grant here denies and lets the app carry on. If this ever appears to
  /// take the app down rather than return `.denied`, that string is missing.
  static func microphone() -> MicrophoneStatus {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: .granted
    case .denied: .denied
    case .notDetermined: .notDetermined
    case .restricted: .restricted
    @unknown default: .denied
    }
  }

  /// Raise the system prompt, which only works while the status is
  /// `notDetermined`. Once denied, System Settings is the only route — which is
  /// exactly why `MicrophoneStatus` keeps the two apart.
  static func requestMicrophone() async -> Bool {
    await AVCaptureDevice.requestAccess(for: .audio)
  }

  static func openMicrophoneSettings() {
    let url = URL(
      string:
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone"
    )!
    NSWorkspace.shared.open(url)
  }

  /// The pane, because the prompt only ever appears once.
  ///
  /// `CGRequestScreenCaptureAccess` shows the system dialog on the first call
  /// and returns silently on every one after it, so a button wired to it alone
  /// is a button that stops working — the same dead-end shape `.denied`
  /// Automation had before `StatusStyle.actionLabel` existed.
  static func openScreenRecordingSettings() {
    NSWorkspace.shared.open(
      URL(
        string:
          "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture"
      )!)
  }

  // MARK: Contacts

  /// Is the Contacts store readable?
  ///
  /// `access(2)` on the store, and deliberately NOT `CNContactStore`. Linking
  /// Contacts.framework means shipping `NSContactsUsageDescription`, which makes
  /// the app claim the grant in its metadata for every user — including everyone
  /// who never turns this surface on. The file test is also the more honest
  /// question: what the server does is open that directory, and this asks
  /// exactly that.
  ///
  /// It is a SEPARATE grant from Full Disk Access, which is the whole reason
  /// this function exists. The comment on `diskAccess()` records the measurement:
  /// `Library/Application Support/AddressBook` opens without the whole-disk
  /// grant because kTCCServiceAddressBook gates it, and reading that as an
  /// answer about Full Disk Access is what made the old status row lie.
  ///
  /// Unlike Full Disk Access, macOS PROMPTS for this one — so the advice a
  /// failing Contacts surface should give is different in kind.
  static func contacts() -> StoreGrant {
    guard let surface = Surface.named("contacts"), let path = resolveStore(surface) else {
      // No store on this Mac. Nothing to read, so nothing is being refused.
      return .granted
    }
    return access(path, R_OK) == 0 ? .granted : .missing
  }

  /// The Contacts privacy pane.
  ///
  /// Its own opener rather than a shared one: the three services live behind
  /// three different anchors, and a button that opens the wrong pane is worse
  /// than no button — it reads as "this is where you fix it" and is not.
  static func openContactsSettings() {
    NSWorkspace.shared.open(
      URL(
        string:
          "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Contacts"
      )!)
  }

  // MARK: The grant, per surface

  /// Whether the grant that gates this surface's store is held.
  ///
  /// One call for the three TCC services `Surface.StorePermission` names, so a
  /// status row can ask "is this surface's permission in place" without knowing
  /// which permission that is — which is what let the popover report Screen as
  /// "not needed" while every capture on the Mac was refusing.
  ///
  /// Takes `diskAccess` rather than probing it, because that answer is app-wide:
  /// `diskAccess()` walks every surface's store looking for one that exists, and
  /// nine surfaces asking it nine times would pay for one fact nine times.
  ///
  /// `.storeMissing` counts as missing here. It means there is nothing on this
  /// Mac to read, which for a status row is not a state to paint green.
  static func storeGrant(for surface: Surface, diskAccess: DiskAccessStatus) -> StoreGrant {
    switch surface.storePermission {
    case .fullDiskAccess: diskAccess == .granted ? .granted : .missing
    case .contacts: contacts()
    case .screenRecording: screenRecording() == .granted ? .granted : .missing
    case .microphone: microphone() == .granted ? .granted : .missing
    }
  }

  /// Ask for Accessibility, with the system's prompt visible.
  ///
  /// Unlike Automation there is no consent dialog that grants it in place — the
  /// prompt offers to open System Settings, and the switch has to be flipped by
  /// hand. What this does buy is the app appearing in that list already, which
  /// is the part people get stuck on: the pane has a `+` and a file picker, and
  /// an app that has never asked is simply absent from it.
  ///
  /// Returns immediately; the prompt is not modal to us.
  static func requestAccessibility() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  }

  static func openAccessibilitySettings() {
    let url = URL(
      string:
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"
    )!
    NSWorkspace.shared.open(url)
  }

  static func isRunning(_ bundleID: String) -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
  }

  /// Launch `bundleID`, wait for it to register, then ask for consent.
  ///
  /// MEASURED, macOS 26.6, Contacts quit:
  ///
  ///     com.apple.AddressBook  askUserIfNeeded:false = -600  askUserIfNeeded:true = -600
  ///
  /// So `askUserIfNeeded: true` does **not** launch the target — it returns
  /// `procNotFound` exactly as the silent check does. An Allow… button wired
  /// straight to `requestAutomation` therefore cannot work while the app is
  /// closed: it re-runs the same call and writes back the same `.appNotRunning`,
  /// which is a button that looks live and provably does nothing.
  ///
  /// That state used to be unreachable in practice because Mail, Notes,
  /// Reminders and Calendar are all apps people leave open. Contacts is not —
  /// it sits closed on most Macs, so for that surface `.appNotRunning` is the
  /// *normal* state rather than an edge case, and the dead button is what
  /// somebody actually meets.
  ///
  /// `.appNotRunning` is a precondition, not a verdict: the only way to answer
  /// the question is to open the app. Blocks — the consent dialog does too, so
  /// the caller is already off the main thread.
  static func launchAndRequestAutomation(for bundleID: String) -> AutomationStatus {
    guard
      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
    else { return .appNotRunning }

    if !isRunning(bundleID) {
      let config = NSWorkspace.OpenConfiguration()
      // Behind Cupertino's own window. Somebody clicking a permission row in
      // Settings asked to answer a question, not to be dropped into Contacts.
      config.activates = false
      config.addsToRecentItems = false

      let done = DispatchSemaphore(value: 0)
      NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in done.signal() }
      _ = done.wait(timeout: .now() + 10)

      // Registering as running and being ready to answer an Apple Event are
      // different moments, and the callback above only reports the first. Poll
      // rather than sleeping a guessed interval: a cold launch off a slow disk
      // is much slower than a warm one, and a fixed wait has to be wrong in one
      // direction or the other.
      let deadline = Date().addingTimeInterval(10)
      while Date() < deadline {
        if case .appNotRunning = automation(for: bundleID) {
          Thread.sleep(forTimeInterval: 0.1)
          continue
        }
        break
      }
    }

    return requestAutomation(for: bundleID)
  }
}
