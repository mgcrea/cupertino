import AppKit
import SwiftUI

/// Real app icons, asked of the system at runtime — a surface's Apple app, a
/// client's editor.
///
/// **Nothing here is bundled.** LaunchServices is asked where the app with this
/// bundle id lives and IconServices is asked what it looks like, so Cupertino
/// ships no Apple artwork and none can go stale: an icon that changes in a
/// macOS update, or with the user's appearance, changes here too. Extracting
/// the `.icns` files out of `/System/Applications` into an asset catalogue
/// would be redistributing Apple's artwork, and is also why the website draws
/// its own glyphs instead — see `apps/website/src/components/SurfaceGlyph.astro`.
/// The same holds for the third-party editors the client rows name.
///
/// The lookup is by bundle id, which for a surface is the same closed table the
/// launcher matches on. Calendar is the one that makes this worth stating: its
/// bundle id is `com.apple.iCal`, so anything deriving an id from the display
/// name finds nothing.
///
/// Used in the main window's sidebar and surface pane, and in Settings'
/// automation table — everywhere a surface or a client is a row a person picks.
/// **Not in the menu-bar popover**, which is 320pt wide and exists to answer
/// one question at a glance; four colour icons there compete with the status
/// glyph that is the whole reason it opens.
///
/// `ClientIconView` below, and the capture rule it carries, are the same ones
/// in Bastion's `apps/apple/Bastion/AppIcon.swift`. The two apps draw the same
/// clients in the same kind of sidebar, and a person running both should not
/// see one of them name Cursor with a generic glyph.
@MainActor
enum AppIcon {
  /// `icon(forFile:)` reaches IconServices, and a SwiftUI list redraws far more
  /// often than an installed app changes. Keyed by whatever was looked up — a
  /// bundle id or an absolute path, which cannot collide — for the life of the
  /// process.
  ///
  /// Hits only. A miss costs one lookup per redraw and buys the property that
  /// matters more: a client installed while Cupertino is running picks up its
  /// icon at the next redraw, instead of staying a glyph until somebody
  /// relaunches the app.
  private static var cache: [String: NSImage] = [:]

  /// The icon of the app with this bundle id, or `nil` when it is not on this
  /// Mac.
  ///
  /// LaunchServices rather than a path under /Applications: it finds the app in
  /// `~/Applications`, on a second volume, anywhere. Editors are exactly what
  /// people keep somewhere else.
  static func image(bundleID: String) -> NSImage? {
    if let hit = cache[bundleID] { return hit }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
    else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: url.path)
    cache[bundleID] = icon
    return icon
  }

  /// The icon of the file at this path, or `nil` when the path has moved.
  ///
  /// The path is checked rather than trusted: the callers point into /System,
  /// and those names move. A miss degrades to a declared symbol rather than
  /// breaking.
  static func image(path: String) -> NSImage? {
    if let hit = cache[path] { return hit }
    guard FileManager.default.fileExists(atPath: path) else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: path)
    cache[path] = icon
    return icon
  }
}

/// Which icon stands for a surface.
@MainActor
enum SurfaceIcon {
  /// `nil` when the app is not installed — a real state on a Mac where someone
  /// has removed one of the four, and the caller shows that rather than
  /// substituting something that implies it is there.
  static func image(for surface: Surface) -> NSImage? {
    // A capability has no app to ask LaunchServices about, so it names a file
    // whose icon stands for it — Apple's own Settings extension. That keeps a
    // capability looking like the colour icons beside it instead of announcing
    // itself as a different kind of row.
    //
    // A miss returns nil and `SurfaceIconView` draws the declared SF Symbol,
    // which is why one is mandatory in the manifest.
    if let iconPath = surface.iconPath { return AppIcon.image(path: iconPath) }
    guard let bundleID = surface.bundleID else { return nil }
    return AppIcon.image(bundleID: bundleID)
  }
}

/// The icon, or a dashed placeholder if that app is not on this Mac.
struct SurfaceIconView: View {
  let surface: Surface
  var size: CGFloat = 16

  var body: some View {
    if let icon = SurfaceIcon.image(for: surface) {
      Image(nsImage: icon)
        .resizable()
        .interpolation(.high)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    } else if let symbol = surface.symbol {
      // A capability whose icon file has moved. NOT `app.dashed`: that says
      // "this app is not installed", and nothing was ever installed here.
      Image(systemName: symbol)
        .font(.system(size: size * 0.85))
        .foregroundStyle(.secondary)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    } else {
      // Not a generic app glyph standing in for the real one: `app.dashed` is
      // the "nothing is installed here" symbol, which is exactly the fact.
      Image(systemName: "app.dashed")
        .font(.system(size: size * 0.85))
        .foregroundStyle(.tertiary)
        .frame(width: size, height: size)
        .help("\(surface.displayName) is not installed on this Mac")
    }
  }
}

/// One client's icon: the real one where its app is installed, the SF Symbol it
/// declares otherwise.
///
/// Never `app.dashed`, unlike the surface above. Two of these clients are CLIs
/// with no app bundle at all, so it would be a lie about them, and the row
/// already carries a dot for how the client stands. The icon answers WHICH
/// client; the dot answers what state it is in.
struct ClientIconView: View {
  let client: ClientWiring.Client
  var size: CGFloat = 16

  /// Nil under a capture, deliberately. A surface is an Apple app that every
  /// Mac has, so its icon is the same everywhere; a client is not. Which
  /// editors the capturing Mac happens to have would otherwise decide which
  /// rows get a colour icon and which get a glyph — a run on another machine
  /// would fail `make screenshots-check` with no code change behind it, and the
  /// plate would show a half-and-half sidebar that looks like a bug rather than
  /// a fixture.
  private var icon: NSImage? {
    if DemoSeed.isEnabled { return nil }
    guard let bundleID = client.bundleID else { return nil }
    return AppIcon.image(bundleID: bundleID)
  }

  var body: some View {
    if let icon {
      Image(nsImage: icon)
        .resizable()
        .interpolation(.high)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    } else {
      Image(systemName: client.symbol)
        .font(.system(size: size * 0.85))
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
  }
}
