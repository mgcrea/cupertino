import Foundation

/// The arithmetic of the `simulator` surface, kept apart from AppKit and from
/// the Accessibility driver so `scripts/simulator-check.swift` can pin it with
/// no Simulator running and no grant.
///
/// ## What is being mapped
///
/// Simulator.app draws the simulated device inside an `AXGroup` whose size is
/// the device's point size TIMES the window scale. docs/simulator.md measured
/// the group at exactly 402x874 for an iPhone 17 Pro at point-accurate scale,
/// and the Simulator's own preferences held a `WindowScale` of 1 on one device
/// and 0.68 on another the same day. So the scale is any factor, and it is
/// DERIVED here from the measured group against the device type's point size
/// rather than assumed. A tolerance of 1% covers the rounding a fractional
/// scale produces on a 874-point edge.
///
/// AX frames are Mac-screen absolute with a top-left origin, which is also the
/// space `CGEvent` posts into. iOS points are top-left of the device screen.
/// Both directions are one affine step, and a caller that has to do it by hand
/// will get the origin wrong once and click the bezel.
enum SimulatorGeometry {

  /// Where the device screen is on the Mac, and how big a point is there.
  struct DeviceFrame: Equatable {
    /// Top-left of the device screen, in Mac screen points.
    let origin: CGPoint
    /// Mac screen points per iOS point.
    let scale: Double
    /// The device's point size AS ORIENTED — landscape swaps the profile's
    /// portrait width and height.
    let pointWidth: Double
    let pointHeight: Double
    let orientation: String

    func toDevice(_ screen: CGPoint) -> CGPoint {
      CGPoint(x: (screen.x - origin.x) / scale, y: (screen.y - origin.y) / scale)
    }

    func toScreen(_ device: CGPoint) -> CGPoint {
      CGPoint(x: origin.x + device.x * scale, y: origin.y + device.y * scale)
    }

    /// Whether an iOS point is on the device at all. Half-open, so the
    /// bottom-right corner (402, 874) is outside a 402x874 screen.
    func contains(_ device: CGPoint) -> Bool {
      device.x >= 0 && device.y >= 0 && device.x < pointWidth && device.y < pointHeight
    }

    /// An AX rect `[x, y, w, h]` in Mac screen points, as iOS points.
    func deviceRect(_ rect: [Double]) -> [Double] {
      guard rect.count == 4 else { return rect }
      let top = toDevice(CGPoint(x: rect[0], y: rect[1]))
      return [top.x, top.y, rect[2] / scale, rect[3] / scale].map { ($0 * 10).rounded() / 10 }
    }

    var json: [String: Any] {
      [
        "origin": [origin.x, origin.y],
        "scale": (scale * 10000).rounded() / 10000,
        "pointWidth": pointWidth,
        "pointHeight": pointHeight,
        "orientation": orientation,
      ]
    }
  }

  /// Does this group draw a device with this portrait point size, in either
  /// orientation? `nil` when neither fits, which is how a toolbar or a bezel
  /// group is told apart from the screen.
  static func resolve(
    groupOrigin: CGPoint, groupSize: CGSize, portraitPoints: CGSize, tolerance: Double = 0.01
  ) -> DeviceFrame? {
    guard groupSize.width > 0, groupSize.height > 0, portraitPoints.width > 0,
      portraitPoints.height > 0
    else { return nil }
    let candidates: [(CGSize, String)] = [
      (portraitPoints, "portrait"),
      (CGSize(width: portraitPoints.height, height: portraitPoints.width), "landscape"),
    ]
    for (points, orientation) in candidates {
      let byWidth = groupSize.width / points.width
      let byHeight = groupSize.height / points.height
      guard abs(byWidth - byHeight) / byWidth <= tolerance else { continue }
      return DeviceFrame(
        origin: groupOrigin, scale: (byWidth + byHeight) / 2,
        pointWidth: points.width, pointHeight: points.height, orientation: orientation)
    }
    return nil
  }
}

/// CoreSimulator's own records, read from the plists it keeps and never from
/// `simctl`. The surface needs two facts a Simulator window does not carry:
/// which device is behind a window, and how many points that device has.
///
/// `@mgcrea/mcp-ios-simulator` reads the same files (its `client/display.ts`)
/// through `plutil`; this reads them with `PropertyListSerialization`, which is
/// the only difference. Neither file is behind a TCC grant.
enum CoreSimulatorCatalog {

  struct Device: Equatable {
    let udid: String
    let name: String
    /// `com.apple.CoreSimulator.SimRuntime.iOS-26-5`, as CoreSimulator spells it.
    let runtime: String
    /// `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`.
    let deviceType: String
    /// CoreSimulator's state number. 3 is Booted; 1 is Shutdown.
    let state: Int

    var booted: Bool { state == 3 }
    /// `iOS 26.5` — the form the Simulator puts in its window title.
    var runtimeLabel: String { CoreSimulatorCatalog.runtimeLabel(runtime) }
  }

  struct Profile: Equatable {
    let pixelWidth: Double
    let pixelHeight: Double
    let scale: Double
    /// Portrait point size. 1206x2622 at 3x is 402x874.
    var points: CGSize {
      CGSize(width: (pixelWidth / scale).rounded(), height: (pixelHeight / scale).rounded())
    }
  }

  /// Absent and unreadable are different facts, and a caller has to be able
  /// to tell them apart: "no Xcode on this Mac" and "this directory refused"
  /// call for different advice. The same distinction docs/surfaces.md records
  /// getting wrong three times about the Maps store.
  enum Availability {
    case found([Device])
    case absent
    case unreadable(String)
  }

  static func devicesRoot(home: URL) -> URL {
    home.appendingPathComponent("Library/Developer/CoreSimulator/Devices")
  }

  static let deviceTypesRoot = URL(
    fileURLWithPath: "/Library/Developer/CoreSimulator/Profiles/DeviceTypes")

  static func devices(home: URL = FileManager.default.homeDirectoryForCurrentUser)
    -> Availability
  {
    let root = devicesRoot(home: home)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
      isDirectory.boolValue
    else { return .absent }
    let names: [String]
    do {
      names = try FileManager.default.contentsOfDirectory(atPath: root.path)
    } catch {
      return .unreadable(error.localizedDescription)
    }
    let devices = names.compactMap { name -> Device? in
      let plist = root.appendingPathComponent(name).appendingPathComponent("device.plist")
      guard let dict = read(plist),
        let udid = dict["UDID"] as? String,
        let deviceName = dict["name"] as? String,
        let runtime = dict["runtime"] as? String,
        let deviceType = dict["deviceType"] as? String,
        let state = dict["state"] as? Int
      else { return nil }
      return Device(
        udid: udid, name: deviceName, runtime: runtime, deviceType: deviceType, state: state)
    }
    return .found(devices.sorted { $0.name < $1.name })
  }

  /// The screen of one device type, from its `profile.plist`. The bundle is
  /// found by its `CFBundleIdentifier`, which equals the device's `deviceType`,
  /// rather than by guessing a directory name from it.
  static func profile(deviceType: String, root: URL = deviceTypesRoot) -> Profile? {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else {
      return nil
    }
    for name in names where name.hasSuffix(".simdevicetype") {
      let bundle = root.appendingPathComponent(name)
      guard let info = read(bundle.appendingPathComponent("Contents/Info.plist")),
        info["CFBundleIdentifier"] as? String == deviceType
      else { continue }
      guard let profile = read(bundle.appendingPathComponent("Contents/Resources/profile.plist")),
        let width = number(profile["mainScreenWidth"]),
        let height = number(profile["mainScreenHeight"]),
        let scale = number(profile["mainScreenScale"]), scale > 0
      else { return nil }
      return Profile(pixelWidth: width, pixelHeight: height, scale: scale)
    }
    return nil
  }

  /// What the Simulator's preferences say the window scale is, per display
  /// the window has been on. Reported beside the measured scale and never used
  /// in its place: the measured group is the truth, this is a cross-check.
  static func windowScalePreferences(
    udid: String, home: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> [Double] {
    let url = home.appendingPathComponent("Library/Preferences/com.apple.iphonesimulator.plist")
    guard let dict = read(url), let prefs = dict["DevicePreferences"] as? [String: Any],
      let device = prefs[udid] as? [String: Any],
      let geometry = device["SimulatorWindowGeometry"] as? [String: Any]
    else { return [] }
    return geometry.values.compactMap { number(($0 as? [String: Any])?["WindowScale"]) }.sorted()
  }

  /// `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `iOS 26.5`.
  static func runtimeLabel(_ runtime: String) -> String {
    let tail = runtime.components(separatedBy: ".").last ?? runtime
    var parts = tail.components(separatedBy: "-")
    guard parts.count >= 2 else { return tail }
    let os = parts.removeFirst()
    return "\(os) \(parts.joined(separator: "."))"
  }

  /// The Simulator titles a device window `<name> – <runtime label>`, with an
  /// EN DASH. A hyphen is accepted too, because a title is the one thing here
  /// that Apple can respell without notice, and a wrong separator would turn
  /// every window into "no device matches".
  static func parseWindowTitle(_ title: String) -> (name: String, runtime: String)? {
    for separator in [" \u{2013} ", " - ", " \u{2014} "] {
      guard let range = title.range(of: separator, options: .backwards) else { continue }
      let name = String(title[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
      let runtime = String(title[range.upperBound...]).trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty, !runtime.isEmpty else { continue }
      return (name, runtime)
    }
    return nil
  }

  // ─── plumbing ──────────────────────────────────────────────────────────────

  private static func read(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? PropertyListSerialization.propertyList(from: data, format: nil))
      as? [String: Any]
  }

  private static func number(_ value: Any?) -> Double? {
    switch value {
    case let d as Double: return d
    case let i as Int: return Double(i)
    case let n as NSNumber: return n.doubleValue
    default: return nil
    }
  }
}
