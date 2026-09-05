import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Capture of an application's window, bounded by the closed table unless the
/// scope gate is on.
///
/// The fifth lane, and the first that is not Apple Events, a file, or the
/// Safari extension. It exists in Swift because it cannot exist anywhere else:
/// ScreenCaptureKit is unreachable from node, and a server is handed
/// `PATH=/usr/bin:/bin`, so `screencapture` is not callable either.
///
/// ## What the allowlist buys, precisely
///
/// `kTCCServiceScreenCapture` is per-process and all-or-nothing. macOS has no
/// per-target scoping, so capturing Mail costs the identical grant as capturing
/// the display Passwords happens to be sitting on. **The scoping here buys
/// auditability, not a smaller grant** — the same trade `Surface.all` already
/// makes for Full Disk Access, and the copy must not drift from that.
///
/// The bound is real even so: a caller names a SURFACE, never a window id, so
/// no argument reaches `SCContentFilter` that did not come out of the table.
/// During the probe, Passwords.app and Keychain Access were both running with
/// open windows and neither was reachable.
///
/// Measurements behind the design are in docs/screen.md.
enum ScreenCapture {

  // ─── errors ────────────────────────────────────────────────────────────────

  enum Failure: LocalizedError {
    case notGranted
    case unknownSurface(String)
    case outOfScope(String)
    case notCapturable(String)
    case noWindow(String, appRunning: Bool)
    case captureFailed(String, code: Int)
    case blank(String)
    case destinationRefused(String)
    case writeFailed(String)

    var errorDescription: String? {
      switch self {
      case .notGranted:
        return
          "Screen Recording is not granted to Cupertino. Open System Settings › Privacy & "
          + "Security › Screen & System Audio Recording, switch Cupertino on, and relaunch it — "
          + "the grant only takes effect on relaunch."
      case .unknownSurface(let id):
        return "No surface named '\(id)'. Capture is limited to the surfaces Cupertino brokers."
      case .outOfScope(let id):
        return
          "'\(id)' is not one of the applications Cupertino brokers, and capture is scoped to "
          + "those. Switch on \"Capture any application\" for Screen in Cupertino to widen it."
      case .notCapturable(let id):
        return "The '\(id)' surface cannot be captured — it has no app behind it."
      case .noWindow(let name, let appRunning):
        return appRunning
          ? "\(name) is running but has no window Cupertino can capture. A minimised window that "
            + "has never been drawn does not composite."
          : "\(name) is not running, so it has no window to capture."
      case .captureFailed(let name, let code):
        // -3811 is the one seen in practice: a window that enumerates and then
        // will not composite. Reported rather than smoothed over, because
        // "enumerable" and "capturable" are different findings.
        return "Could not capture \(name) (ScreenCaptureKit \(code))."
          + (code == -3811 ? " The window enumerated but would not composite." : "")
      case .blank(let name):
        return "\(name)'s window captured as a blank image, so nothing was written. "
          + "This usually means the window has never been drawn."
      case .destinationRefused(let path):
        return "Refusing to write outside the capture directory: \(path)"
      case .writeFailed(let path):
        return "Could not write \(path)."
      }
    }
  }

  // ─── permission ────────────────────────────────────────────────────────────

  /// The flag, which is a CLAIM about this identity rather than the capability.
  ///
  /// `Permissions.swift` reports both this and whether enumeration actually
  /// works, because they disagree on a machine holding several TCC rows for one
  /// identifier — the "one identifier, four grants" state recorded in
  /// scripts/spike-app-tcc/README.md.
  static func isGranted() -> Bool { CGPreflightScreenCaptureAccess() }

  // ─── targets ───────────────────────────────────────────────────────────────

  struct Target {
    let surface: String
    let displayName: String
    /// Windows that could actually be captured, after filtering.
    let windows: Int
    let appRunning: Bool
  }

  /// A raw enumeration is NOT a target list.
  ///
  /// Mail reports 16 windows on a machine where it has one; the rest are
  /// shadows, toolbars and helper layers. A count that includes them is
  /// nonsense to a model, so the filter is part of the contract:
  ///
  /// - `windowLayer == 0` — ordinary app windows, not chrome
  /// - at least 100x100 — excludes the degenerate helpers
  /// - on screen OR titled — a window the app has actually drawn. Three
  ///   different apps reported an identical never-drawn 1000x1000 window that
  ///   captured as one flat colour.
  ///
  /// Note `isOnScreen` predicts nothing about whether a capture succeeds: a
  /// drawn window composites off screen too. Only the result is evidence.
  private static func realWindows(_ content: SCShareableContent, bundleID: String) -> [SCWindow] {
    content.windows.filter { w in
      w.owningApplication?.bundleIdentifier == bundleID
        && w.windowLayer == 0
        && w.frame.width >= 100 && w.frame.height >= 100
        && (w.isOnScreen || !(w.title ?? "").isEmpty)
    }
  }

  private static func shareableContent() async throws -> SCShareableContent {
    guard isGranted() else { throw Failure.notGranted }
    do {
      // onScreenWindowsOnly: false — a drawn window that is currently behind
      // another Space still captures, and excluding it here would hide a target
      // that works.
      return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
      let err = error as NSError
      // The flag said yes and the capability says no. That is the multi-row TCC
      // state, and the fix is `tccutil reset ScreenCapture`, never another grant.
      if err.code == -3801 { throw Failure.notGranted }
      throw Failure.captureFailed("the window list", code: err.code)
    }
  }

  /// Every capturable surface. Titles are deliberately absent — see `Target`.
  static func targets(anyApp: Bool = false) async throws -> [Target] {
    let content = try await shareableContent()
    let running = Set(content.applications.map(\.bundleIdentifier))
    var out = Surface.all.compactMap { surface -> Target? in
      guard let bundleID = surface.bundleID else { return nil }
      return Target(
        surface: surface.id,
        displayName: surface.displayName,
        windows: realWindows(content, bundleID: bundleID).count,
        appRunning: running.contains(bundleID))
    }
    guard anyApp else { return out }

    // Everything else that is RUNNING and has a window worth naming. Not every
    // installed application: a list of what someone has installed is a
    // different disclosure from a list of what is open, and only the second is
    // needed to pick a capture target.
    let brokered = Set(Surface.all.compactMap(\.bundleID))
    for app in NSWorkspace.shared.runningApplications
    where app.activationPolicy == .regular {
      guard let bundleID = app.bundleIdentifier, !brokered.contains(bundleID) else { continue }
      let windows = realWindows(content, bundleID: bundleID).count
      guard windows > 0 else { continue }
      out.append(
        Target(
          surface: bundleID,
          displayName: app.localizedName ?? bundleID,
          windows: windows,
          appRunning: true))
    }
    return out
  }

  // ─── capture ───────────────────────────────────────────────────────────────

  struct Shot {
    let path: String
    let bytes: Int
    let width: Int
    let height: Int
    let surface: String
  }

  static func capture(surface: Surface, into directory: URL?, overwrite: Bool) async throws -> Shot
  {
    guard let bundleID = surface.bundleID else { throw Failure.notCapturable(surface.id) }
    return try await capture(
      bundleID: bundleID, displayName: surface.displayName, label: surface.id,
      into: directory, overwrite: overwrite)
  }

  /// The core, addressed by bundle identifier.
  ///
  /// Split out so a scoped call and a widened one take the SAME path: the gate
  /// decides which identifiers may reach here, and nothing below this line
  /// knows or cares whether the caller named a surface or an application. A
  /// second capture implementation for arbitrary apps is exactly the duplication
  /// this avoids.
  static func capture(
    bundleID: String, displayName: String, label: String, into directory: URL?, overwrite: Bool
  ) async throws -> Shot {
    let content = try await shareableContent()
    let candidates = realWindows(content, bundleID: bundleID)
    guard
      let window = candidates.max(by: {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
      })
    else {
      let running = content.applications.contains { $0.bundleIdentifier == bundleID }
      throw Failure.noWindow(displayName, appRunning: running)
    }

    let config = SCStreamConfiguration()
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    config.width = max(1, Int(window.frame.width * scale))
    config.height = max(1, Int(window.frame.height * scale))
    config.showsCursor = false

    let image: CGImage
    do {
      // desktopIndependentWindow composites the window ITSELF. Measured: a
      // window 100% covered by another app returns its own content, so capture
      // never has to raise anything. That is the property the whole design
      // rests on — docs/screen.md.
      image = try await SCScreenshotManager.captureImage(
        contentFilter: SCContentFilter(desktopIndependentWindow: window),
        configuration: config)
    } catch {
      throw Failure.captureFailed(displayName, code: (error as NSError).code)
    }

    // A failed grab does not throw, it returns flat pixels. Without this the
    // tool reports success and hands back an empty image.
    guard distinctColours(image) > 2 else { throw Failure.blank(displayName) }

    let url = try destination(for: label, in: directory, overwrite: overwrite)
    guard let bytes = writePNG(image, to: url) else { throw Failure.writeFailed(url.path) }
    return Shot(
      path: url.path, bytes: bytes, width: image.width, height: image.height, surface: label)
  }

  // ─── destination ───────────────────────────────────────────────────────────

  /// Where captures may be written. The same confinement the three
  /// `save_attachment` tools use: a root, and a caller may only SELECT inside it.
  static var root: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
  }

  /// `label` is a surface id when one was named and a bundle identifier
  /// otherwise, so it can carry dots. Kept as-is rather than sanitised: a dot is
  /// legal in a filename and `com.apple.Maps` is more use in ~/Downloads than a
  /// flattened version of it.
  private static func destination(for label: String, in directory: URL?, overwrite: Bool) throws
    -> URL
  {
    let base = root.resolvingSymlinksInPath()
    var dir = base
    if let directory {
      let asked = directory.resolvingSymlinksInPath()
      // Lexical containment after resolving, exactly as packages/*/src/config.ts
      // does it. A trailing separator on the prefix so `/Downloads-evil` cannot
      // pass as being inside `/Downloads`.
      guard asked.path == base.path || asked.path.hasPrefix(base.path + "/") else {
        throw Failure.destinationRefused(directory.path)
      }
      dir = asked
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withYear, .withMonth, .withDay, .withTime]
    let leaf =
      "cupertino-\(label)-\(stamp.string(from: Date()).replacingOccurrences(of: ":", with: "")).png"
    let url = dir.appendingPathComponent(leaf)
    if FileManager.default.fileExists(atPath: url.path) && !overwrite {
      throw Failure.destinationRefused(url.path)
    }
    return url
  }

  // ─── pixels ────────────────────────────────────────────────────────────────

  private static func writePNG(_ image: CGImage, to url: URL) -> Int? {
    guard
      let dest = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { return nil }
    // 0600, as the attachment writers do: a capture can contain anything the
    // window did.
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int
  }

  /// Distinct colours in a downsample — "captured something" vs "captured
  /// nothing". It cannot tell the target window from an occluder; nothing in
  /// the enumeration can, which is why occlusion was settled by measurement
  /// once rather than being re-checked per call.
  private static func distinctColours(_ image: CGImage, side: Int = 32) -> Int {
    let count = side * side
    let buf = UnsafeMutablePointer<UInt32>.allocate(capacity: count)
    buf.initialize(repeating: 0, count: count)
    defer {
      buf.deinitialize(count: count)
      buf.deallocate()
    }
    guard
      let ctx = CGContext(
        data: buf, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return -1 }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    return Set(UnsafeBufferPointer(start: buf, count: count)).count
  }
}
