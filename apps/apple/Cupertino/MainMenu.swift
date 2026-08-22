import AppKit

/// The Settings item in the app menu, and the ⌘, that comes with it.
///
/// SwiftUI puts both there for free when an app has a `Settings` scene. This app
/// cannot have that scene — see `HostedWindow` — so the item is inserted by hand
/// into the menu SwiftUI has already built by the time the delegate runs.
///
/// The menu bar is only *drawn* while `DockPresence` holds the app at `.regular`,
/// which is to say while a window is open. The key equivalent does not wait for
/// that: `NSApplication.sendEvent` offers every key-down to the main menu before
/// anything else, menus displayed or not, so ⌘, answers from the menu bar
/// popover too — where an accessory app has no visible menus at all.
@MainActor
enum MainMenu {
  /// Held here because `NSMenuItem.target` is weak, and a target that has been
  /// deallocated turns the item grey rather than into an error anyone can read.
  private static let target = SettingsMenuTarget()

  /// Identifies our item so a second call is a no-op. `installSettingsItem` is
  /// cheap to call again and there is no guarantee it only ever happens once.
  private static let tag = 0x53_45_54  // "SET"

  static func installSettingsItem() {
    guard let appMenu = NSApp.mainMenu?.items.first?.submenu else {
      // Not fatal — every other way into Settings still works — but it is the
      // kind of silence that otherwise reads as "⌘, is broken on this Mac".
      hostLog("cupertino", .error, "no app menu found; ⌘, will not open Settings")
      return
    }
    guard appMenu.item(withTag: tag) == nil else { return }

    let item = NSMenuItem(
      title: "Settings…", action: #selector(SettingsMenuTarget.openSettings(_:)), keyEquivalent: ",")
    item.target = target
    item.tag = tag

    // Apple's order in every stock app menu is About, separator, Settings,
    // separator, Services. SwiftUI ships that menu one item short, so both
    // pieces go into the gap: immediately after the separator that follows
    // About. Found rather than hardcoded at index 2, because the titles around
    // it are localised and the shape of a menu we did not build is not ours to
    // assume.
    let insertion = appMenu.items.firstIndex(where: \.isSeparatorItem).map { $0 + 1 } ?? 0
    appMenu.insertItem(.separator(), at: insertion)
    appMenu.insertItem(item, at: insertion)
  }
}

/// A target for the menu item, rather than the responder chain.
///
/// A nil-targeted item is validated against whatever happens to be first
/// responder, and this app's two windows are `NSHostingController`s that know
/// nothing about Settings — the item would be permanently disabled. Naming the
/// receiver outright also means ⌘, works with no window open at all, which is
/// Cupertino's normal resting state.
@MainActor
private final class SettingsMenuTarget: NSObject {
  @objc func openSettings(_ sender: Any?) {
    SettingsWindowController.show()
  }
}
