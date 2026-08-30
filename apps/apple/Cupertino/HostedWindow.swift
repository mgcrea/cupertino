import AppKit
import SwiftUI

/// A SwiftUI view in a real `NSWindow`, openable from anywhere.
///
/// Both of this app's windows are held this way rather than declared as SwiftUI
/// `Window` scenes, and the reason is the same for each: they have to be
/// openable from `AppDelegate`, which has no view hierarchy and therefore no
/// `openWindow` to read out of the environment. The Settings window needs it for
/// the first-run licence prompt, and the main window for
/// `applicationShouldHandleReopen`, which is what a click on the Dock icon
/// becomes.
///
/// SwiftUI's `Settings` scene was tried first and does not work here at all: it
/// opens via `showSettingsWindow:`, routed through an app menu that an
/// `LSUIElement` app does not have.
@MainActor
final class HostedWindow {
  private let title: String
  private let autosaveName: String
  private let contentSize: NSSize?
  private let content: () -> AnyView

  /// Not released on close, so reopening restores the same window and AppKit
  /// keeps the frame it autosaved.
  private var window: NSWindow?

  /// Lives only long enough to see off SwiftUI's opening resize. See `show()`.
  private var resizeGuard: OpeningResizeGuard?

  /// `contentSize` is the size the window opens at the very first time, before
  /// there is an autosaved frame to restore. Worth stating for a window built
  /// out of a `NavigationSplitView` and a grouped `Form`: SwiftUI's fitting size
  /// for that is the width every footer sentence would need to avoid wrapping,
  /// which came out at 1120pt — a settings window half again as wide as it has
  /// any reason to be. `idealWidth` on the content does not reach the hosting
  /// controller; this does.
  init(
    title: String, autosaveName: String, contentSize: NSSize? = nil,
    content: @escaping () -> some View
  ) {
    self.title = title
    self.autosaveName = autosaveName
    self.contentSize = contentSize
    self.content = { AnyView(content()) }
  }

  /// The floor under which a restored frame is corrupt rather than merely
  /// small. `contentMinSize` is the real answer wherever AppKit has one — an
  /// `NSHostingController` propagates the content's `minWidth`/`minHeight` into
  /// it — but it is zero for content that declares no minimum, and zero accepts
  /// the 1x32 frame this exists to reject. Small enough that no window anyone
  /// dragged by hand lands under it.
  private static let degenerateContentSize = NSSize(width: 200, height: 150)

  /// Whether `window` is currently sized to hold its own content.
  ///
  /// The tolerance is for the equality case, which is the common one and must
  /// not trip: AppKit clamps a drag at `contentMinSize`, autosaves exactly that,
  /// and restores it back. Rejecting a frame the user themselves resized to the
  /// minimum would trade this crash for a window that forgets its size.
  fileprivate static func canHoldContent(_ window: NSWindow) -> Bool {
    let content = window.contentRect(forFrameRect: window.frame).size
    let minimum = window.contentMinSize
    let required = NSSize(
      width: max(minimum.width, degenerateContentSize.width),
      height: max(minimum.height, degenerateContentSize.height))
    return content.width >= required.width - 1 && content.height >= required.height - 1
  }

  func show() {
    if window == nil {
      let hosting = NSHostingController(rootView: content())
      // The minimum and nothing else. An `NSHostingController` will otherwise
      // push SwiftUI's preferred size onto the window as well, and for a window
      // that names its own size below there is nothing to prefer — while the
      // content's `minWidth`/`minHeight` still has to become the resize floor,
      // which is what `.minSize` carries across.
      if contentSize != nil {
        hosting.sizingOptions = [.minSize]
      }

      let created = NSWindow(contentViewController: hosting)
      created.title = title
      created.styleMask = [.titled, .closable, .miniaturizable, .resizable]
      created.isReleasedWhenClosed = false

      // Read before `setFrameAutosaveName`, which both restores a remembered
      // frame and writes one. This is the key AppKit stores it under, and the
      // question it answers is the only one that matters here: has anybody ever
      // sized this window themselves?
      let remembered =
        UserDefaults.standard.string(forKey: "NSWindow Frame \(autosaveName)") != nil
      // SwiftUI's own fitting size, read before the autosave overwrites it. It
      // is the fallback for a remembered frame that turns out to be unusable,
      // and for a window naming no `contentSize` it is the only one there is.
      let natural = created.frame
      created.setFrameAutosaveName(autosaveName)
      // A remembered frame wins — but only if the content can live in it.
      // AppKit restores whatever was last written under that key, including a
      // frame no layout can satisfy, and a SwiftUI `NavigationSplitView` handed
      // one of those does not merely look wrong: it fails to converge. The
      // split item's edge insets and the hosting view's safe-area insets
      // invalidate each other, and past 193 constraint passes in one display
      // cycle AppKit throws an exception nobody catches. Seen for real with a
      // saved frame of 1x32 — the app died 1.4s into launch, before a window
      // had ever been on screen.
      //
      // Self-perpetuating, which is what earns a guard here rather than another
      // one-time reset of the key: `OpeningResizeGuard` below pins the window at
      // whatever it opened with, and the autosave writes that straight back out.
      // One bad frame poisons every launch that follows it.
      let unusable = remembered && !Self.canHoldContent(created)
      if unusable {
        created.setFrame(natural, display: false)
      }
      // After the autosave name, never before. Naming it resizes the window —
      // to a remembered frame when there is one, and to SwiftUI's own idea of
      // the content's width when there is not, which for a grouped `Form` is
      // however wide the longest footer sentence would like to be. That came
      // out at 1120pt: a Settings window the exact size of the main window,
      // rather than the smaller thing that opens in front of it.
      // `|| DemoSeed.isEnabled`: a remembered frame is the developer's, and a
      // capture must not inherit whatever size they last dragged this window
      // to. Outside screenshot mode a remembered frame still wins, which is the
      // whole point of autosaving one.
      if !remembered || unusable || DemoSeed.isEnabled, let contentSize {
        created.setContentSize(contentSize)
      }
      created.center()
      // Overwrite the frame that was just rejected. Autosave writes on a user
      // resize, and nothing done here is one, so without this the bad value sits
      // in prefs forever — rediscovered and discarded on every single launch,
      // and taking the window's remembered position down with it.
      if unusable {
        created.saveFrame(usingName: autosaveName)
      }
      window = created

      // SwiftUI sizes a `NavigationSplitView` window to its own idea of the
      // content's width, on a layout pass that lands after `show()` has already
      // returned — 1120pt here, as wide as the longest footer sentence in the
      // form would like to be, and by coincidence the same size as the main
      // window. Nothing set beforehand survives it: not `setContentSize`, not
      // `sizingOptions`, not an `idealWidth` on the content, and not a frame
      // restored from the autosave, which is the part that matters — without
      // this, a window the user had resized came back the wrong size anyway.
      resizeGuard = OpeningResizeGuard(window: created, intended: created.frame)
    }
    // An accessory app does not come forward on its own, so the window would
    // otherwise open behind whatever the user was looking at.
    //
    // `activate()`, not `activate(ignoringOtherApps:)`, which is deprecated: the
    // modern call cooperates with the window server instead of demanding the
    // foreground, and is the one that still works when the request comes from a
    // menu bar extra whose own panel is key at that moment.
    //
    // Except under `appshot capture`, which launches with `open -g` on purpose
    // and activates for the moment of each shot. An app calling this at launch
    // is then fighting the driver for the foreground, and the symptom is one
    // shot in a run dying with "would not come to the front", on no particular
    // screen, passing on the next attempt. Ordering our *own* windows front is
    // still fine — that is order within the app, not which app is active.
    if !DemoSeed.isEnabled {
      NSApp.activate()
    }
    // `makeKeyAndOrderFront` does not restore a miniaturized window: it orders
    // the Dock tile front and leaves the window in the Dock, so "Open Cupertino"
    // on a window somebody had minimised looked like a button that did nothing.
    // The window is reused rather than rebuilt (`isReleasedWhenClosed = false`),
    // so this is the state it is genuinely most likely to be found in.
    if window?.isMiniaturized == true {
      window?.deminiaturize(nil)
    }
    window?.makeKeyAndOrderFront(nil)
    DockPresence.update()
  }
}


/// Holds a window at the size it was opened at, for as long as it takes SwiftUI
/// to stop arguing — and not one moment longer.
///
/// SwiftUI resizes a hosted `NavigationSplitView` window unprompted, a layout
/// pass or two after it is ordered front. Every resize after that is a person
/// dragging a corner, and undoing one of those is the bug this must not become,
/// so the whole thing expires on a deadline. Three quarters of a second is long
/// enough for a window that has only just appeared and far too short for anyone
/// to have grabbed its edge.
@MainActor
private final class OpeningResizeGuard {
  private var token: NSObjectProtocol?

  init?(window: NSWindow, intended: NSRect) {
    // Refusing here is what stops a bad frame becoming permanent: this observer
    // is what would hold the window at it long enough for the autosave to write
    // it back out. Nothing to see off is better than a size nothing can satisfy.
    guard HostedWindow.canHoldContent(window) else { return nil }
    token = NotificationCenter.default.addObserver(
      forName: NSWindow.didResizeNotification, object: window, queue: .main
    ) { _ in
      MainActor.assumeIsolated {
        window.setFrame(intended, display: false)
      }
    }
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(750))
      self?.stop()
    }
  }

  func stop() {
    guard let token else { return }
    NotificationCenter.default.removeObserver(token)
    self.token = nil
  }
}
