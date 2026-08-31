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

  /// Dropped when the window closes, rather than kept for the life of the
  /// process, which is what makes closing and reopening a genuine repair. See
  /// `discard(_:)` for what that is a repair *for*. The frame is not lost with
  /// it: `setFrameAutosaveName` has already persisted it and the rebuilt window
  /// restores it.
  private var window: NSWindow?

  /// Removed with the window it watches. One per window, added when the window
  /// is built.
  private var closeObserver: NSObjectProtocol?

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
    // Asking for a window that is already in front of you is only ever a request
    // for a working one, so this is where a wedged window gets replaced. Nothing
    // else arrives here in that state: the menu bar's "Open Cupertino" is the
    // only route that can be taken while the window is key and the app is
    // active, and a person takes it because what they are looking at is not
    // doing its job. A Dock click never gets this far — the delegate's
    // `applicationShouldHandleReopen` returns early while a window is visible.
    //
    // MEASURED, on the wedge this was written for: an installed 1.4.0 sat for
    // forty minutes showing a main window that drew nothing and hit-tested
    // nothing. The main thread was idle in `-[NSApplication run]`, the servers
    // kept answering calls throughout, and `heap` on the live pid found the
    // `NavigationSplitView`'s two split items present but the sidebar `List`'s
    // backing table never built. No exception was thrown, so the `unusable`
    // guard below never had anything to catch.
    //
    // A structural test cannot tell that window from a healthy one — half the
    // tree is there, at sane frames, and the sidebar carries a 15s
    // `TimelineView` that a live window redraws on. Rebuilding on the gesture is
    // honest about that: it costs one hosting controller in the case where
    // nothing was wrong, and it is the only thing that helps in the case where
    // something was.
    if let existing = window, existing.isVisible, existing.isKeyWindow, NSApp.isActive {
      discard(existing, because: "asked to open a window that was already in front")
    } else if let existing = window, existing.contentView?.subviews.isEmpty == true {
      // The one shape that IS decidable without guessing: a hosting root that
      // built nothing at all.
      discard(existing, because: "its content view was empty")
    }
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
      // Neither of this app's two windows is a document, and macOS tabs any two
      // same-class titled, resizable windows when the user has set Desktop &
      // Dock → "Prefer tabs when opening documents" to Always. `.automatic` is
      // the NSWindow default, so without this the Settings window is absorbed as
      // a TAB of the main window on those Macs — with one titlebar, one tab
      // strip, and ⌘, appearing to do nothing because the pane it opened is
      // behind the tab you were already looking at.
      //
      // Set here rather than per window because it is true of both: this app has
      // exactly one main window and one Settings window, and neither has a
      // second instance to be tabbed WITH in the first place.
      created.tabbingMode = .disallowed

      // Read before `setFrameAutosaveName`, which both restores a remembered
      // frame and writes one. This is the key AppKit stores it under, and the
      // question it answers is the only one that matters here: has anybody ever
      // sized this window themselves?
      let remembered = !DemoSeed.isEnabled
        && UserDefaults.standard.string(forKey: "NSWindow Frame \(autosaveName)") != nil
      // SwiftUI's own fitting size, read before the autosave overwrites it. It
      // is the fallback for a remembered frame that turns out to be unusable,
      // and for a window naming no `contentSize` it is the only one there is.
      let natural = created.frame
      // Never named under screenshot mode, and this is a one-way street that the
      // `|| DemoSeed.isEnabled` below only half paved. That branch stops a
      // capture INHERITING the developer's window size; naming the autosave here
      // let the capture WRITE ITS OWN back out, under the very same key the real
      // window reads — so every `make screenshots` quietly resized the
      // developer's Settings window to the capture's pinned size and left it
      // that way.
      //
      // MEASURED on the machine this was found on: `NSWindow Frame
      // settings-panes` held 1000x772 and `NSWindow Frame main` 1120x572 —
      // `DemoSeed.settingsContentSize` and `DemoSeed.contentSize` plus a
      // titlebar, exactly. The visible symptom is a Settings window 200pt TALLER
      // than the main window it opens in front of, which is the opposite of what
      // `contentSize` is for.
      //
      // A capture has nothing to remember anyway: it opens one window, shoots it
      // and exits.
      if !DemoSeed.isEnabled { created.setFrameAutosaveName(autosaveName) }
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
      // Dropping the reference on close is the whole repair. Before it, a window
      // that had stopped drawing lasted as long as the process:
      // `isReleasedWhenClosed = false` kept it alive, this method rebuilt only
      // `if window == nil`, and nothing ever set it back — so ⌘W and every
      // reopen after it
      // handed the same dead window back, and quitting the app was the only way
      // out.
      closeObserver = NotificationCenter.default.addObserver(
        forName: NSWindow.willCloseNotification, object: created, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.window === created else { return }
          self.forget()
        }
      }
      // Not under `appshot capture`: a capture photographs the log, and a line
      // about the window it is being photographed in is not part of the product.
      if !DemoSeed.isEnabled {
        hostLog("cupertino", .info, "built the \(autosaveName) window")
      }

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
    // `makeKeyAndOrderFront` does not restore a miniaturized window: it orders
    // the Dock tile front and leaves the window in the Dock, so "Open Cupertino"
    // on a window somebody had minimised looked like a button that did nothing.
    // The window is reused rather than rebuilt (`isReleasedWhenClosed = false`),
    // so this is the state it is genuinely most likely to be found in.
    if window?.isMiniaturized == true {
      window?.deminiaturize(nil)
    }
    window?.makeKeyAndOrderFront(nil)
    // Then the app itself, every time and not only on the first open. An
    // accessory app does not come forward on its own, and ordering a window
    // front is order *within* an app — it says nothing about which app the user
    // is looking at, so without this the window stays behind whatever was there.
    //
    // `activate(ignoringOtherApps:)`, not the cooperative `activate()`. The
    // cooperative call asks the frontmost app to yield the foreground and is
    // refused when nobody yields, which is every time the request arrives from
    // a menu bar extra: the user is in some other app, and that app was never
    // asked. It is why "Open Cupertino" on a window that was already open
    // looked like it did nothing — the first open only appeared to work because
    // `DockPresence.update()` fires the forceful call on the .accessory →
    // .regular transition, and every open after that early-returns straight
    // past it with the policy already .regular.
    //
    // Except under `appshot capture`, which launches with `open -g` on purpose
    // and activates for the moment of each shot. An app calling this at launch
    // is then fighting the driver for the foreground, and the symptom is one
    // shot in a run dying with "would not come to the front", on no particular
    // screen, passing on the next attempt. Ordering our *own* windows front,
    // above, is still fine — that is order within the app, not which app is
    // active.
    if !DemoSeed.isEnabled {
      NSApp.activate(ignoringOtherApps: true)
    }
    DockPresence.update()
  }

  /// Take a window down for good, so the next `show()` builds a fresh hosting
  /// controller and with it a fresh SwiftUI tree.
  private func discard(_ existing: NSWindow, because reason: String) {
    hostLog("cupertino", .info, "rebuilding the \(autosaveName) window — \(reason)")
    forget()
    // Ordered out first: `close()` on a visible window animates, and this one is
    // about to be replaced by another at the same frame.
    existing.orderOut(nil)
    existing.close()
  }

  /// Let go of the current window and everything hung off it, without touching
  /// the window itself — the close path is already closing it.
  private func forget() {
    resizeGuard?.stop()
    resizeGuard = nil
    if let closeObserver {
      NotificationCenter.default.removeObserver(closeObserver)
      self.closeObserver = nil
    }
    window = nil
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
