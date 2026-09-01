import AppKit
import SwiftUI

/// Each surface's real app icon, asked of the system at runtime.
///
/// **Nothing here is bundled.** LaunchServices is asked where the app with this
/// bundle id lives and IconServices is asked what it looks like, so Cupertino
/// ships no Apple artwork and none can go stale: an icon that changes in a
/// macOS update, or with the user's appearance, changes here too. Extracting
/// the `.icns` files out of `/System/Applications` into an asset catalogue
/// would be redistributing Apple's artwork, and is also why the website draws
/// its own glyphs instead — see `apps/website/src/components/SurfaceGlyph.astro`.
///
/// The lookup is by `Surface.bundleID`, which is the same closed table the
/// launcher matches on. Calendar is the one that makes this worth stating:
/// its bundle id is `com.apple.iCal`, so anything deriving an id from the
/// display name finds nothing.
///
/// Used in the main window's sidebar and surface pane, and in Settings'
/// automation table — everywhere a surface is a row a person picks. **Not in
/// the menu-bar popover**, which is 320pt wide and exists to answer one
/// question at a glance; four colour icons there compete with the status glyph
/// that is the whole reason it opens.
@MainActor
enum SurfaceIcon {
  /// `icon(forFile:)` reaches IconServices, and a SwiftUI list redraws far more
  /// often than an installed app changes. Keyed by surface id, for the life of
  /// the process.
  private static var cache: [String: NSImage] = [:]

  /// `nil` when the app is not installed — a real state on a Mac where someone
  /// has removed one of the four, and the caller shows that rather than
  /// substituting something that implies it is there.
  static func image(for surface: Surface) -> NSImage? {
    if let hit = cache[surface.id] { return hit }

    // A capability has no app to ask LaunchServices about, so it names a file
    // whose icon stands for it — Apple's own Settings extension. That keeps a
    // capability looking like the colour icons beside it instead of announcing
    // itself as a different kind of row.
    //
    // The path is checked rather than trusted: it points into /System, and
    // those names move. A miss returns nil and `SurfaceIconView` draws the
    // declared SF Symbol, which is why one is mandatory in the manifest.
    if let iconPath = surface.iconPath {
      guard FileManager.default.fileExists(atPath: iconPath) else { return nil }
      let icon = NSWorkspace.shared.icon(forFile: iconPath)
      cache[surface.id] = icon
      return icon
    }

    guard let bundleID = surface.bundleID,
      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
    else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: url.path)
    cache[surface.id] = icon
    return icon
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
