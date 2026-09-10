import Cocoa
import SwiftUI

/// The on-screen notice shown while Cupertino is driving an application.
///
/// ## Why this exists instead of the menu bar badge it replaces
///
/// The first version of this indicator put a 5pt orange dot on the menu bar
/// mark. It never appeared, and the reason is a property of `MenuBarExtra`
/// rather than a mistake in the drawing: **SwiftUI renders a `MenuBarExtra`
/// label as a template image.** Measured, macOS 26.6, three extras side by side
/// — a plain templated `sun.max`, the same with `.foregroundStyle(.orange)`, and
/// the same carrying that exact badge — came out PIXEL-IDENTICAL white, with the
/// badge not drawn at all. Colour is discarded and a small overlay is lost.
///
/// It is not a limitation of the menu bar. An `NSStatusItem` holding a
/// non-template `NSImage` renders orange perfectly, checked the same way. It is
/// the SwiftUI label path specifically, which is why the fix is not "mark the
/// asset differently".
///
/// So the indicator became a window we own, where colour is ours to choose, the
/// notice sits in the field of view rather than 16pt wide at the top of the
/// screen, and there is room to name the application being driven.
///
/// ## The focus rule, which is the whole point
///
/// This notice says *a synthetic keystroke may land at any moment*. A window
/// that took the keyboard focus would make that keystroke land in ITSELF, so an
/// overlay that steals focus is strictly worse than no overlay. Four things
/// prevent it and all four are load-bearing:
///
///   * `.nonactivatingPanel` in the style mask, and `orderFrontRegardless()`
///     rather than `makeKeyAndOrderFront` — the latter is exactly the mistake.
///   * `.screenSaver` level, so it sits above normal and full-screen windows.
///   * `ignoresMouseEvents`, so a click goes to whatever is underneath.
///   * `.canJoinAllSpaces` / `.stationary` / `.fullScreenAuxiliary`, so it does
///     not disappear when the user changes Space.
///
/// Verified against a live frontmost application before this shipped:
///
///     frontmost before/after: Safari / Safari   unchanged: true
///     this process active: false   panel is key: false   panel visible: true
///
/// ## It is hidden from capture, deliberately
///
/// `sharingType = .none` keeps it out of `apple_screen_capture` and out of the
/// screenshot pipeline. The `screen` surface exists to show a model what the
/// user can see; handing back every frame with Cupertino's own banner painted
/// across it is noise at best, and at worst a model reasoning about a control
/// that belongs to us rather than to the application.
@MainActor
final class DrivingOverlay {
  static let shared = DrivingOverlay()

  private var panel: NSPanel?
  /// What the visible panel currently says, so a burst of presses against one
  /// application does not rebuild and re-place it on every call. The kind is
  /// part of it: an info card becoming a driving one must redraw.
  private var showing: (bundleId: String, kind: VisibleTools.Notice)?

  private static let size = NSSize(width: 320, height: 60)
  private static let margin: CGFloat = 20

  func show(bundleId: String, name: String, kind: VisibleTools.Notice) {
    let panel = panel ?? make()
    self.panel = panel
    guard showing?.bundleId != bundleId || showing?.kind != kind else { return }
    showing = (bundleId, kind)
    panel.contentView = NSHostingView(rootView: DrivingCard(name: name, kind: kind))
    place(panel, near: bundleId)
    // NEVER makeKeyAndOrderFront — see the focus rule above.
    panel.orderFrontRegardless()
  }

  func hide() {
    showing = nil
    panel?.orderOut(nil)
  }

  private func make() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    panel.level = .screenSaver
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [
      .canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle,
    ]
    panel.sharingType = .none
    return panel
  }

  /// Top-right of the display holding the application being driven.
  ///
  /// The driven window is what the user is about to watch move, and on a
  /// two-display Mac a notice pinned to the main screen can be on the other one
  /// entirely — which is the same failure as no notice.
  private func place(_ panel: NSPanel, near bundleId: String) {
    let screen = screenShowing(bundleId) ?? NSScreen.main
    guard let frame = screen?.visibleFrame else { return }
    panel.setFrameOrigin(
      NSPoint(
        x: frame.maxX - Self.size.width - Self.margin,
        y: frame.maxY - Self.size.height - Self.margin))
  }

  /// The screen holding that application's largest on-screen window.
  ///
  /// `CGWindowListCopyWindowInfo` rather than the Accessibility API: this runs
  /// on the path of a press and must not depend on a grant, on a handle, or on
  /// an application answering an AX query promptly. Its known weakness —
  /// `docs/screen.md`: it "hands back shadows, toolbars and helper layers" — is
  /// harmless when the question is only which display to use, and taking the
  /// LARGEST window makes a stray helper layer unable to win.
  private func screenShowing(_ bundleId: String) -> NSScreen? {
    guard
      let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first,
      let listed = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0)
        as? [[String: Any]]
    else { return nil }

    let pid = app.processIdentifier
    var best: CGRect?
    for window in listed {
      guard
        (window[kCGWindowOwnerPID as String] as? pid_t) == pid,
        let raw = window[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: raw as CFDictionary)
      else { continue }
      if best == nil || rect.width * rect.height > best!.width * best!.height { best = rect }
    }
    guard let bounds = best else { return nil }

    // CGWindow bounds measure DOWN from the top of the primary display;
    // `NSScreen` measures up from its bottom. Comparing them unconverted puts
    // the notice on the wrong screen whenever the displays are stacked.
    guard let primary = NSScreen.screens.first else { return nil }
    let flipped = CGPoint(x: bounds.midX, y: primary.frame.maxY - bounds.midY)
    return NSScreen.screens.first { $0.frame.contains(flipped) }
  }
}

/// What an info notice says, shared by the card and the popover row.
///
/// Only the info tier lives here. The driving wording is written out in each
/// view as it always was, so the one notice that asks for hands off the
/// keyboard cannot change by way of a table edit.
extension VisibleTools.Notice {
  var infoSymbol: String {
    switch self {
    case .driving: "cursorarrow.rays"
    case .showing(.openingPage): "safari"
    case .showing(.clickingPage): "cursorarrow.click"
    case .showing(.fillingPage): "character.cursor.ibeam"
    case .showing(.scrollingPage): "arrow.up.and.down"
    case .showing(.openingPlace): "map"
    case .launching: "arrow.up.forward.app"
    }
  }

  func infoTitle(_ name: String) -> String {
    switch self {
    case .launching: "Cupertino opened \(name)"
    default: "Cupertino is using \(name)"
    }
  }

  var infoDetail: String {
    switch self {
    case .driving: "Please don't use the keyboard or mouse."
    case .showing(.openingPage): "Opening a page. You can keep working."
    case .showing(.clickingPage): "Clicking in a page. You can keep working."
    case .showing(.fillingPage): "Filling in a form. You can keep working."
    case .showing(.scrollingPage): "Scrolling a page. You can keep working."
    case .showing(.openingPlace): "Opening a place in the background. You can keep working."
    case .launching: "It was not running. You can keep working."
    }
  }
}

/// The notice itself, saying the same thing the popover's `DrivingNotice` says.
///
/// Deliberately small and quiet: it has to be readable at a glance from across a
/// desk without covering what the user was reading.
private struct DrivingCard: View {
  let name: String
  let kind: VisibleTools.Notice

  var body: some View {
    HStack(spacing: 10) {
      if kind == .driving {
        Circle()
          .fill(.orange)
          .frame(width: 10, height: 10)
        VStack(alignment: .leading, spacing: 2) {
          Text("Cupertino is driving \(name)")
            .font(.callout.weight(.semibold))
          Text("Please don't use the keyboard or mouse.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      } else {
        // Same footprint as the driving card, so a tier change does not move
        // anything; the glyph and its colour are what say "no need to stop".
        Image(systemName: kind.infoSymbol)
          .foregroundStyle(.blue)
          .font(.callout.weight(.semibold))
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 2) {
          Text(kind.infoTitle(name))
            .font(.callout.weight(.semibold))
          Text(kind.infoDetail)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
  }
}
