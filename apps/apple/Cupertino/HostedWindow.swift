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
  private let content: () -> AnyView

  /// Not released on close, so reopening restores the same window and AppKit
  /// keeps the frame it autosaved.
  private var window: NSWindow?

  init(title: String, autosaveName: String, content: @escaping () -> some View) {
    self.title = title
    self.autosaveName = autosaveName
    self.content = { AnyView(content()) }
  }

  func show() {
    if window == nil {
      let created = NSWindow(contentViewController: NSHostingController(rootView: content()))
      created.title = title
      created.styleMask = [.titled, .closable, .miniaturizable, .resizable]
      created.isReleasedWhenClosed = false
      created.setFrameAutosaveName(autosaveName)
      created.center()
      window = created
    }
    // An accessory app does not come forward on its own, so the window would
    // otherwise open behind whatever the user was looking at.
    //
    // Except under `appshot capture`, which launches with `open -g` on purpose
    // and activates for the moment of each shot. An app calling this at launch
    // is then fighting the driver for the foreground, and the symptom is one
    // shot in a run dying with "would not come to the front", on no particular
    // screen, passing on the next attempt. Ordering our *own* windows front is
    // still fine — that is order within the app, not which app is active.
    if !DemoSeed.isEnabled {
      NSApp.activate(ignoringOtherApps: true)
    }
    window?.makeKeyAndOrderFront(nil)
    DockPresence.update()
  }
}
