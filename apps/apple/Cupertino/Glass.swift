import AppKit
import SwiftUI

/// Liquid Glass, reached from SwiftUI.
///
/// The obvious approach does not exist here. `glassEffect(_:in:)` and
/// `GlassEffectContainer` are iOS-side: neither appears anywhere in the macOS
/// SwiftUI interface, and the whole SwiftUI glass surface on this platform is
/// `.buttonStyle(.glass)` and `.glassProminent`. The material itself is AppKit's
/// `NSGlassEffectView`, new in macOS 26, so that is what this wraps.
///
/// Used as a background rather than as a container. `NSGlassEffectView` places
/// its `contentView` inside the effect, which would mean hosting SwiftUI inside
/// AppKit inside SwiftUI and re-solving the layout by hand; with no content it
/// is simply a pane of glass, and SwiftUI's own `.background` already gives it
/// exactly the frame of the thing it sits behind.
///
/// Where it goes is a design constraint, not a preference. Glass belongs to the
/// control and navigation layer — bars, banners, floating chrome — with content
/// legible underneath it. Stacking glass on glass muddies both, so the menu bar
/// popover, which the system already draws as a material, does not get any.
struct GlassPanel: NSViewRepresentable {
  var cornerRadius: CGFloat = 12
  var style: NSGlassEffectView.Style = .regular
  var tint: NSColor?

  func makeNSView(context: Context) -> NSGlassEffectView {
    let view = NSGlassEffectView()
    apply(to: view)
    return view
  }

  func updateNSView(_ view: NSGlassEffectView, context: Context) {
    apply(to: view)
  }

  private func apply(to view: NSGlassEffectView) {
    view.cornerRadius = cornerRadius
    view.style = style
    view.tintColor = tint
  }
}

extension View {
  /// A pane of glass behind this view, clipped to the same corner radius.
  func glassBackground(
    cornerRadius: CGFloat = 12,
    style: NSGlassEffectView.Style = .regular,
    tint: NSColor? = nil
  ) -> some View {
    background(GlassPanel(cornerRadius: cornerRadius, style: style, tint: tint))
  }
}
