import CoreGraphics
import Foundation

/// Where the on-screen notice sits, how big it is, and whether it is audible.
///
/// ## Why this is its own file, and why it holds arithmetic
///
/// The same argument `DrivingPolicy` makes. `DrivingOverlay` has to link AppKit
/// and SwiftUI, and the part that decides WHERE a card lands is arithmetic over
/// a visible frame, a size and a corner — the kind that is silent when wrong,
/// because a card placed off the bottom of the display looks exactly like a card
/// that never appeared. So the placement lives here with no dependency beyond
/// `CGRect`, and `make unit` pins it.
///
/// ## Why any of this is a preference at all
///
/// The notice is the one thing Cupertino puts over somebody else's work, and
/// the top-right corner it shipped in is not free for everyone: it is where
/// menu bar apps drop their panels, where Xcode parks its inspector, and on a
/// laptop with a notch it is the narrowest part of the visible frame. The size
/// is the same argument from the other end — read at a glance from across a
/// desk on a 27", or kept out of the way on a 13". The sound is for the case
/// the other two cannot reach at all: eyes somewhere other than the screen the
/// card is on. None of them changes what the notice SAYS, which is why they
/// are appearance and not policy.
///
/// The names and the playing live in `NoticeSounds`, which needs AppKit. This
/// type holds only what a person chose, so it stays at Foundation and
/// `CGRect` — which is what lets `make unit` compile it.
///
/// ## App-wide, not per surface
///
/// There is one person watching one screen. Nine surfaces can light this card —
/// Desktop and Simulator drive, Safari, Maps, Mail, Notes, Reminders, Calendar
/// and Contacts show or launch — and a placement set per surface would mean the
/// notice moved depending on which one happened to be talking.
nonisolated enum NoticeStyle {

  /// One of six places along the top or bottom edge of the display.
  ///
  /// Six rather than eight: the vertical middle is where the person is looking,
  /// which is the one place a notice must not cover.
  enum Placement: String, CaseIterable, Sendable {
    case topLeft
    case top
    case topRight
    case bottomLeft
    case bottom
    case bottomRight

    var label: String {
      switch self {
      case .topLeft: "Top left"
      case .top: "Top"
      case .topRight: "Top right"
      case .bottomLeft: "Bottom left"
      case .bottom: "Bottom"
      case .bottomRight: "Bottom right"
      }
    }

    var isTop: Bool {
      switch self {
      case .topLeft, .top, .topRight: true
      case .bottomLeft, .bottom, .bottomRight: false
      }
    }
  }

  /// How large the card is drawn.
  ///
  /// A single scale rather than a set of sizes, applied to every length in the
  /// card — the panel, the padding, the dot, and the two type sizes. Scaling
  /// only the window would give a large card with small print, and scaling only
  /// the print would give large print in a box it does not fit.
  ///
  /// It is NOT `scaleEffect` on the hosting view, which is the shortcut that
  /// looks the same in a screenshot and wrong on the screen: that transforms a
  /// rasterised layer, so the text of a 1.3× card is a blown-up 1× bitmap.
  /// Every length below is a real point size and the text is laid out at it.
  enum Size: String, CaseIterable, Sendable {
    case small
    case medium
    case large

    var label: String {
      switch self {
      case .small: "Small"
      case .medium: "Medium"
      case .large: "Large"
      }
    }

    /// Medium is 1 exactly, so the card it shipped with is unchanged for
    /// everyone who never opens this setting.
    var scale: CGFloat {
      switch self {
      case .small: 0.85
      case .medium: 1
      case .large: 1.3
      }
    }

    /// The title line. 12 is what macOS's `.callout` measures, which is what the
    /// card used before this was a preference.
    var titlePoints: CGFloat { (12 * scale).rounded() }

    /// The second line. 10 is macOS's `.caption`.
    var detailPoints: CGFloat { (10 * scale).rounded() }

    /// A length from the medium card, at this size.
    func scaled(_ length: CGFloat) -> CGFloat { (length * scale).rounded() }
  }

  struct Settings: Equatable, Sendable {
    var placement: Placement
    var size: Size
    /// The sound as the card arrives, by the name `NSSound(named:)` resolves
    /// against `/System/Library/Sounds`. EMPTY MEANS SILENT, which is what "no
    /// sound" is here — there is no separate switch, because a switch plus two
    /// menus has a fourth state ("on, but both set to None") that says nothing
    /// the menus do not already say.
    var arriving: String
    /// The sound as it goes, which is the one meaning the Mac is yours again.
    var leaving: String
    /// 0…1, relative to the Mac's own output volume.
    var volume: Double

    var isSilent: Bool { arriving.isEmpty && leaving.isEmpty }
  }

  /// Top right, medium and silent — which is exactly how the card behaved
  /// before any of this was settable.
  ///
  /// Silent by default and not "Tink, quietly". This fires whenever an agent
  /// touches the screen, which on a working session is many times an hour, and
  /// a sound nobody asked for is the fastest way to make a background feature
  /// feel intrusive. The volume it would play at if chosen is a third, where an
  /// alert sound reads as a cue under what you are doing rather than as an
  /// alert.
  static let defaults = Settings(
    placement: .topRight, size: .medium, arriving: "", leaving: "", volume: 0.35)

  enum Keys {
    static let placement = "notice.placement"
    static let size = "notice.size"
    static let arriving = "notice.soundArriving"
    static let leaving = "notice.soundLeaving"
    static let volume = "notice.soundVolume"
  }

  static var current: Settings { read(UserDefaults.standard) }

  /// Read as strings, the way `DrivingPolicy.read` does and for the same
  /// reason: `NSArgumentDomain` stores launch arguments as strings, so a card
  /// pinned with `-notice.placement bottom` by a capture run has to read back
  /// as `.bottom` here — and a volume pinned with `-notice.soundVolume 0` has
  /// to read as 0 rather than falling through `as? Double` to the default,
  /// which is a THIRD OF FULL and the opposite of what was asked for.
  ///
  /// The sound names are not checked against what this Mac has. A name that
  /// resolves to nothing is silence, which is the same thing an empty name
  /// means, so there is nothing for a validation to save anybody from.
  static func read(_ store: UserDefaults) -> Settings {
    Settings(
      placement: store.string(forKey: Keys.placement).flatMap(Placement.init(rawValue:))
        ?? defaults.placement,
      size: store.string(forKey: Keys.size).flatMap(Size.init(rawValue:)) ?? defaults.size,
      arriving: store.string(forKey: Keys.arriving) ?? defaults.arriving,
      leaving: store.string(forKey: Keys.leaving) ?? defaults.leaving,
      volume: fraction(store.object(forKey: Keys.volume), fallback: defaults.volume))
  }

  /// A stored 0…1 clamped into it, or the fallback when there is none.
  ///
  /// The `String` case is the launch-argument one above. The clamp is not
  /// theoretical: a slider cannot produce 1.4, and `defaults write` can.
  static func fraction(_ raw: Any?, fallback: Double) -> Double {
    let value: Double? =
      switch raw {
      case let number as NSNumber: number.doubleValue
      case let text as String: Double(text)
      default: nil
      }
    guard let value, value.isFinite else { return fallback }
    return min(1, max(0, value))
  }

  /// The gap between the card and the edges it is pinned to.
  static let margin: CGFloat = 20

  /// Where a card of this size goes on this display.
  ///
  /// `visible` is an `NSScreen.visibleFrame`, so the menu bar and the Dock are
  /// already out of it, and AppKit's y grows UPWARD from the bottom of the
  /// primary display — which is why "top" is `maxY` and not `minY`. Getting
  /// that backwards puts the card under the Dock, where it is not obviously
  /// absent, only unread.
  ///
  /// Clamped into `visible` at the end. A card cannot currently be wider than a
  /// display, but the widest one is 546pt at `.large` and the narrowest useful
  /// display is not much more than twice that — and a notice hanging off the
  /// side of the screen is the failure this whole type exists to avoid.
  static func frame(
    for size: CGSize, in visible: CGRect, placement: Placement, margin: CGFloat = margin
  ) -> CGRect {
    let x: CGFloat =
      switch placement {
      case .topLeft, .bottomLeft: visible.minX + margin
      case .top, .bottom: visible.midX - size.width / 2
      case .topRight, .bottomRight: visible.maxX - size.width - margin
      }
    let y: CGFloat =
      placement.isTop ? visible.maxY - size.height - margin : visible.minY + margin
    return CGRect(
      x: clamp(x, visible.minX, visible.maxX - size.width),
      y: clamp(y, visible.minY, visible.maxY - size.height),
      width: size.width, height: size.height)
  }

  /// `low` wins a range that has collapsed, which is a display smaller than the
  /// card rather than a mistake worth trapping.
  private static func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
    high <= low ? low : min(max(value, low), high)
  }

}
