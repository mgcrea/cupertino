import SwiftUI

/// Whether a surface's file lane can actually be read.
///
/// Hoisted out of `SurfaceDetail` when the popover and the sidebar started
/// needing it too. The exists-vs-readable split is the whole shape of a TCC
/// failure — `stat` succeeds on a protected file and only `open`/`access` are
/// denied — so "present" is never on its own reassurance.
enum StoreStatus: Equatable {
  case checking
  /// No file lane at all, or nothing on this machine to read.
  case missing
  case found(path: String, readable: Bool)
}

/// One surface's verdict, in three colours.
///
/// Green when everything it needs is granted, orange when something is missing
/// and there is a step to take, red when something is broken in a way no switch
/// explains.
enum SurfaceHealth: Equatable {
  case ready
  case needsSetup
  case fault
}

/// Everything one surface needs, and whether it has it.
///
/// This exists because the three places that painted a status glyph — the
/// popover, the sidebar row and the Access card — all read **one** fact,
/// `AutomationStatus`, and a surface needs more than one. Screen has no Apple
/// Events lane at all, so the popover drew it grey and "not needed" while
/// `CGPreflightScreenCaptureAccess` was false and every capture refused. Mail
/// read green on Automation with its store unreadable. Contacts declared a TCC
/// service nothing ever probed.
///
/// Deliberately PURE. It is handed values somebody else gathered and computes
/// no permission of its own, for the reason `SurfaceDetail` gives for resolving
/// Screen Recording in a `.task`: a view body runs often, and these are facts
/// about the machine rather than about the render. `Permissions.automation` in
/// particular is a blocking IPC that has already frozen this app once — see
/// `StatusModel.refreshGrants`.
struct SurfaceStatus {
  let surface: Surface
  /// `nil` when this surface will send no Apple Event as configured — either it
  /// never scripts its app, or its events are the write lane and writes are
  /// off. Not the same as "not yet asked": there is nothing to ask for.
  let automation: AutomationStatus?
  /// Whether the TCC service gating this surface's store is held.
  ///
  /// **Not a health input when that service is Full Disk Access.** `Permissions`
  /// says so at the top of `DiskAccessStatus` and `SurfaceDetail` repeats it:
  /// one grant covers the whole app, so reporting it per surface "would imply a
  /// containment that does not exist" — *do not merge them*. Six surfaces sit
  /// behind that one grant, and keying their rows on it put the same sentence
  /// and the same `Grant…` button on all six plus the app-wide row above them,
  /// seven times in a 320pt panel.
  ///
  /// What IS per surface is whether that store opens, which is `store` below.
  /// Contacts and Screen Recording are different and stay here: each gates
  /// exactly one surface, so its row is the only place it is reported and there
  /// is nothing to duplicate.
  let grant: StoreGrant
  let store: StoreStatus

  /// Whether this surface's grant is its own to report, or the app's.
  private var grantIsPerSurface: Bool { surface.storePermission != .fullDiskAccess }

  /// What a gate is NOT: a health input.
  ///
  /// `allowCapture` off means every capture refuses, and that is a decision
  /// rather than a misconfiguration — the same for `allowWrites` and
  /// `allowCodes`. A surface with its gates off is correctly configured and
  /// reads green. Painting it orange would make the switch look broken and
  /// train people to turn on the one thing the manifest defaults off.
  var health: SurfaceHealth {
    // Red is narrow on purpose. A denial is not an error: it has a Settings…
    // button and is fixed by flipping a switch, which is the definition of the
    // orange case below.
    if case .failed = automation { return .fault }
    // The one state nothing can explain. `stat` succeeding while `access` is
    // denied is ordinary and means the grant is missing; the same thing while
    // the grant reads GRANTED is a contradiction, and it is the shape of the
    // several-TCC-rows-under-one-identifier bug that `Permissions.screenRecording`
    // documents. Sending someone to grant a permission they already hold is the
    // loop that cannot terminate.
    if grant == .granted, case .found(_, let readable) = store, !readable { return .fault }

    if let automation, automation != .granted { return .needsSetup }
    if grantIsPerSurface, grant == .missing { return .needsSetup }
    if case .found(_, let readable) = store, !readable { return .needsSetup }
    // A missing store is NOT a fault. `resolveStore` probes named candidates
    // with `fileExists`, which answers correctly without the grant, so a nil
    // resolve genuinely means absent — Notes with no store and Automation
    // granted works, slower, through Apple Events.
    return .ready
  }

  /// The first unmet requirement, named. One line, for a caption or a tooltip.
  ///
  /// First rather than all of them: the popover is 320pt wide and a row that
  /// lists three problems is a row nobody reads. The full breakdown is the
  /// Access card's job.
  var caption: String {
    if case .failed(let code) = automation { return "automation error \(code)" }
    if grant == .granted, case .found(_, let readable) = store, !readable {
      return "\(grantName) is granted but the store still will not open"
    }
    if let automation, automation != .granted { return StatusStyle.caption(automation) }
    if grantIsPerSurface, grant == .missing { return "\(grantName) needed" }
    // The per-surface half of a Full Disk Access failure, and the honest one:
    // the file is there and will not open. The row above says which grant turns
    // that around, once.
    if case .found(_, let readable) = store, !readable { return "store not readable" }
    return "ready"
  }

  /// What the grant gating this surface is called, in the words System Settings
  /// uses — this sentence sends someone to a specific pane and has to name it
  /// the way the pane does.
  var grantName: String {
    switch surface.storePermission {
    case .fullDiskAccess: "Full Disk Access"
    case .contacts: "Contacts access"
    case .screenRecording: "Screen Recording"
    case .microphone: "Microphone"
    case .accessibility: "Accessibility"
    }
  }

  /// The one button this row should offer, or none.
  ///
  /// One, not one per unmet requirement, and it addresses whatever `caption`
  /// named — so the sentence and the button always agree about which problem is
  /// being solved. Fixing it reveals the next.
  struct Action {
    let label: String
    let run: () -> Void
  }

  var action: Action? {
    // A fault has no button. Both fault states are already-granted-but-broken,
    // and the fix is `tccutil reset`, not another trip to the pane that says
    // yes. The Access card carries that advice in prose.
    if health == .fault { return nil }

    if let automation, automation != .granted {
      guard let label = StatusStyle.actionLabel(automation) else { return nil }
      return Action(label: label) {
        // A denial cannot be re-prompted; it has to change in Settings.
        if automation == .denied {
          Permissions.openAutomationSettings()
        } else {
          StatusModel.shared.requestAutomation(surface)
        }
      }
    }

    // Only `.missing` — an unreadable store while the grant reads granted is
    // the fault above, and it has already returned.
    //
    // And only when the grant is this surface's own to report. Full Disk Access
    // is granted once for the whole app, so six rows offering to open the same
    // pane is six buttons for one click; the app-wide row above owns it.
    if grantIsPerSurface, grant == .missing {
      // The pane, never the request call. `CGRequestScreenCaptureAccess`
      // prompts once and returns silently ever after — a button wired to it is
      // a button that stops working, the dead end `StatusStyle.actionLabel`
      // already fixed for Automation.
      switch surface.storePermission {
      case .contacts:
        return Action(label: "Allow…") { Permissions.openContactsSettings() }
      case .screenRecording:
        return Action(label: "Allow…") { Permissions.openScreenRecordingSettings() }
      case .microphone:
        // The one grant where the request call is NOT a dead end, and the only
        // reason `MicrophoneStatus` carries four states rather than two: TCC
        // does distinguish "never asked" from "refused" here. While it is
        // notDetermined the prompt still appears, so offer it; once denied,
        // only the pane will do and a button wired to the prompt would silently
        // do nothing — the dead end this switch's comment warns about.
        if Permissions.microphone() == .notDetermined {
          let surface = surface
          return Action(label: "Ask…") {
            Task { await StatusModel.shared.requestMicrophone(surface) }
          }
        }
        return Action(label: "Allow…") { Permissions.openMicrophoneSettings() }
      case .accessibility:
        // Both calls, in this order, and the request is not the dead end the
        // comment above warns about. `AXIsProcessTrustedWithOptions` does not
        // grant anything — it only makes the app APPEAR in the pane, which
        // Permissions.swift:615 records as the part people get stuck on: the
        // list has a `+` and a file picker, and an app that has never asked is
        // simply absent from it. So ask first, then open the pane it now
        // appears in.
        return Action(label: "Allow…") {
          Permissions.requestAccessibility()
          Permissions.openAccessibilitySettings()
        }
      case .fullDiskAccess:
        return nil  // unreachable: `grantIsPerSurface` excludes it.
      }
    }
    return nil
  }
}
