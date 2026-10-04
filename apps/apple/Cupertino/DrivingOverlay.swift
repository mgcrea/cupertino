import Cocoa
import SwiftUI

/// The on-screen notice shown while Cupertino is driving an application.
///
/// ## Why this exists instead of the menu bar badge it replaces
///
/// The first version of this indicator put a 5pt orange dot on the menu bar
/// mark. It never appeared, and the reason is a property of `MenuBarExtra`
/// rather than a mistake in the drawing: **SwiftUI renders a `MenuBarExtra`
/// label as a template image.** Measured, macOS 26.6, three extras side by side
/// — a plain templated `sun.max`, the same with `.foregroundStyle(.orange)`, and
/// the same carrying that exact badge — came out PIXEL-IDENTICAL white, with the
/// badge not drawn at all. Colour is discarded and a small overlay is lost.
///
/// It is not a limitation of the menu bar. An `NSStatusItem` holding a
/// non-template `NSImage` renders orange perfectly, checked the same way. It is
/// the SwiftUI label path specifically, which is why the fix is not "mark the
/// asset differently".
///
/// So the indicator became a window we own, where colour is ours to choose, the
/// notice sits in the field of view rather than 16pt wide at the top of the
/// screen, and there is room to name the application being driven.
///
/// ## The focus rule, which is the whole point
///
/// This notice says *a synthetic keystroke may land at any moment*. A window
/// that took the keyboard focus would make that keystroke land in ITSELF, so an
/// overlay that steals focus is strictly worse than no overlay. Four things
/// prevent it and all four are load-bearing:
///
///   * `.nonactivatingPanel` in the style mask, and `orderFrontRegardless()`
///     rather than `makeKeyAndOrderFront` — the latter is exactly the mistake.
///   * `.screenSaver` level, so it sits above normal and full-screen windows.
///   * `ignoresMouseEvents` whenever a synthetic pointer event is going out, so
///     a click aimed at the corner of the screen goes to the window underneath.
///   * `.canJoinAllSpaces` / `.stationary` / `.fullScreenAuxiliary`, so it does
///     not disappear when the user changes Space.
///
/// Verified against a live frontmost application before this shipped:
///
///     frontmost before/after: Safari / Safari   unchanged: true
///     this process active: false   panel is key: false   panel visible: true
///
/// ## The three cards that take clicks, and why that is still safe
///
/// The countdown and the question have buttons, and so does the card shown
/// while a session holds the screen: a cross that stops it. For as long as one
/// of them is up the panel accepts mouse events, and two facts keep the rule
/// above intact.
///
/// No synthetic click can land on them. Nothing is posted while the countdown
/// or the question is up — every driving verb is waiting on the answer in
/// `DrivingSession.admit`. The session card is different, because a session is
/// exactly when clicks are posted, so it lets the mouse through for as long as
/// one is going out: `postingPointer` wraps every synthetic pointer event and
/// takes the card's clicks away first. A session is mostly the gaps between
/// calls while a model thinks, which is when the cross is there to be pressed.
/// And should one of ours land on the card anyway, `FirstClickHostingView`
/// drops it rather than let an agent press its own Stop.
///
/// And a click on a non-activating panel that never becomes key neither
/// activates Cupertino nor takes the keyboard, so the person can press Cancel
/// and keep typing into the window they were in. `FirstClickHostingView` exists
/// because a window that is not key otherwise spends that first click on
/// nothing.
///
/// ## What is settable about it, and what is not
///
/// `NoticeStyle` holds what somebody chose: which of six places along the top
/// or bottom edge the card sits in, how large it is drawn, and which of the
/// Mac's alert sounds it makes arriving and leaving, at what volume. All of it
/// is appearance. None of it can stop the card appearing, change what it says,
/// or move it off the display holding the application being driven — this is
/// the only warning the person at the keyboard gets, and a preference that
/// could silence it would be a preference that reintroduces the failure this
/// class was written for. The sound is the one addition that can only ADD a
/// signal: silence is where it starts, and the card is the same card either
/// way.
///
/// ## It is hidden from capture, deliberately
///
/// `sharingType = .none` keeps it out of `apple_screen_capture` and out of the
/// screenshot pipeline. The `screen` surface exists to show a model what the
/// user can see; handing back every frame with Cupertino's own banner painted
/// across it is noise at best, and at worst a model reasoning about a control
/// that belongs to us rather than to the application.
@MainActor
final class DrivingOverlay {
  static let shared = DrivingOverlay()

  /// What the card is saying.
  enum Phase: Equatable {
    /// The driving notice, or one of the quieter info notices.
    case notice(VisibleTools.Notice)
    /// The driving notice while a session holds the screen. The cross ends it.
    ///
    /// Apart from `.notice(.driving)` because a Node tool can light that one
    /// with no session behind it, and a cross there would have nothing to stop.
    case holding
    /// A session is about to open. Cancel stops it.
    case countdown(endsAt: Date)
    /// A session will open only if the person allows it.
    case asking
    /// A session just ended.
    case done(restoredName: String?)

    var takesClicks: Bool {
      switch self {
      case .countdown, .asking, .holding: true
      case .notice, .done: false
      }
    }

    /// Wider when there are buttons to fit beside the words, at the medium size
    /// `NoticeStyle.Size` scales from.
    var baseSize: NSSize {
      switch self {
      case .countdown: NSSize(width: 390, height: 60)
      case .asking: NSSize(width: 420, height: 60)
      case .holding: NSSize(width: 350, height: 60)
      case .notice, .done: NSSize(width: 320, height: 60)
      }
    }

    func size(_ size: NoticeStyle.Size) -> NSSize {
      NSSize(width: size.scaled(baseSize.width), height: size.scaled(baseSize.height))
    }
  }

  private var panel: NSPanel?
  /// What the visible panel currently says, so a burst of presses against one
  /// application does not rebuild and re-place it on every call. The phase is
  /// part of it: an info card becoming a driving one must redraw. So is the
  /// style: `DriveActivity` re-renders twice a second while a notice is up, so
  /// carrying it here is what makes a placement chosen in Settings move a card
  /// that is already on screen instead of waiting for the next one.
  private var showing: (bundleId: String, phase: Phase, style: NoticeStyle.Settings)?

  /// The style the sample card was drawn with, while one is up, and the timer
  /// that takes it down. Kept apart from `showing`, which means a notice about
  /// something real — see `preview()`.
  private var previewing: NoticeStyle.Settings?
  private var previewTimer: Timer?

  func show(bundleId: String, name: String, phase: Phase) {
    let style = NoticeStyle.current
    guard
      showing?.bundleId != bundleId || showing?.phase != phase || showing?.style != style
    else { return }
    // Nothing new arrives when the panel is already up, whether it was holding
    // a notice or the sample.
    let arriving = showing == nil && previewing == nil
    endPreview(silently: true)
    showing = (bundleId, phase, style)
    present(
      DrivingCard(name: name, phase: phase, size: style.size), phase: phase, style: style,
      on: screenShowing(bundleId))
    if arriving { play(.arriving, style) }
  }

  func hide() {
    endPreview(silently: false)
    guard let showing else { return }
    self.showing = nil
    panel?.orderOut(nil)
    play(.leaving, showing.style)
  }

  /// Put the card on screen for a couple of seconds, so somebody choosing a
  /// corner in Settings can see where it lands.
  ///
  /// It exists because the setting is otherwise unanswerable from the window it
  /// is set in: the card only appears while an agent is working, so picking a
  /// corner meant choosing one, waiting for a session, and finding out then.
  ///
  /// A real notice outranks it in both directions — this refuses to draw over
  /// one, and `show` takes the panel back from it without a sound — because the
  /// sample says "Cupertino is driving Safari" and nothing is being driven.
  func preview() {
    guard showing == nil else { return }
    let style = NoticeStyle.current
    // The session card, cross included, because that is the one somebody
    // choosing a corner will see. Its cross is drawn and not live: there is no
    // session for it to stop.
    let phase = Phase.holding
    let arriving = previewing == nil
    previewing = style
    present(
      DrivingCard(name: "Safari", phase: phase, size: style.size), phase: phase, style: style,
      on: NSScreen.main, clickable: false)
    if arriving { play(.arriving, style) }
    previewTimer?.invalidate()
    previewTimer = Timer.scheduledTimer(withTimeInterval: 2.2, repeats: false) { [weak self] _ in
      Task { @MainActor in self?.endPreview(silently: false) }
    }
  }

  /// Take the sample down, if one is up.
  ///
  /// `silently` when a real notice is about to take the panel: the sample
  /// leaving is not an event, and the panel must not be ordered out from under
  /// the card that is replacing it. This runs from `hide` as well as from the
  /// timer, because a `hide` that only cancelled the timer would leave the
  /// sample on screen for good.
  private func endPreview(silently: Bool) {
    previewTimer?.invalidate()
    previewTimer = nil
    guard let style = previewing else { return }
    previewing = nil
    guard !silently else { return }
    panel?.orderOut(nil)
    play(.leaving, style)
  }

  private func present(
    _ card: DrivingCard, phase: Phase, style: NoticeStyle.Settings, on screen: NSScreen?,
    clickable: Bool = true
  ) {
    let panel = panel ?? make()
    self.panel = panel
    panel.contentView = FirstClickHostingView(rootView: card)
    takesClicks = clickable && phase.takesClicks
    applyMouse()
    place(panel, on: screen, size: phase.size(style.size), placement: style.placement)
    // NEVER makeKeyAndOrderFront — see the focus rule above.
    panel.orderFrontRegardless()
  }

  // ─── letting synthetic pointer events through ──────────────────────────────

  /// Whether the card on screen has buttons to press. `applyMouse` is the only
  /// place that turns it into `ignoresMouseEvents`.
  private var takesClicks = false

  /// Synthetic pointer posts in flight, from any thread.
  private nonisolated(unsafe) static var pointerPosts = 0
  private nonisolated static let pointerLock = NSLock()

  /// How long the card stays click-through after the last event went out. The
  /// window server routes a posted event after `post` returns, so turning the
  /// card's clicks back on in the same instant could still catch it.
  private nonisolated static let pointerSettle: Duration = .milliseconds(250)

  /// Post synthetic pointer events with the card out of their way.
  ///
  /// Every `click`, `drag` and `hover` goes through here. The card's clicks are
  /// taken away on the main thread BEFORE the first event is posted — a hop
  /// that waits, which is safe because the main thread never waits on a
  /// driving thread (`DrivingSession`, "Blocking") — and given back a moment
  /// after the last, once no other post is in flight. Keystrokes and AX
  /// actions need none of this: they are not aimed at a point.
  nonisolated static func postingPointer<T>(_ body: () throws -> T) rethrows -> T {
    pointerLock.lock()
    pointerPosts += 1
    pointerLock.unlock()
    if Thread.isMainThread {
      MainActor.assumeIsolated { shared.applyMouse() }
    } else {
      DispatchQueue.main.sync { MainActor.assumeIsolated { shared.applyMouse() } }
    }
    defer {
      pointerLock.lock()
      pointerPosts -= 1
      pointerLock.unlock()
      Task { @MainActor in
        try? await Task.sleep(for: pointerSettle)
        shared.applyMouse()
      }
    }
    return try body()
  }

  private nonisolated static var postingNow: Bool {
    pointerLock.lock()
    defer { pointerLock.unlock() }
    return pointerPosts > 0
  }

  /// The one writer of `ignoresMouseEvents`. A card presented in the middle of
  /// a post — the session's card, lit by the very verb that is clicking — must
  /// not take its clicks back from under that post, so both facts are read
  /// here, every time.
  private func applyMouse() {
    panel?.ignoresMouseEvents = !takesClicks || Self.postingNow
  }

  private enum Cue { case arriving, leaving }

  /// The card arriving and leaving, for somebody who is not looking at it.
  ///
  /// Silent by default, and silent under a capture run whatever is chosen. A
  /// screenshot is taken on a developer's Mac with whatever defaults it happens
  /// to hold, and a run that beeps is a run somebody turns the volume down for
  /// — which is how the next one gets taken with the volume down as well.
  ///
  /// The style is the one the card was DRAWN with, not the one stored now, so a
  /// card that went up while a sound was chosen is still audible going away.
  private func play(_ cue: Cue, _ style: NoticeStyle.Settings) {
    guard !DemoSeed.isEnabled else { return }
    NoticeSounds.play(cue == .arriving ? style.arriving : style.leaving, volume: style.volume)
  }

  private func make() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: Phase.notice(.driving).baseSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    panel.level = .screenSaver
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [
      .canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle,
    ]
    panel.sharingType = .none
    return panel
  }

  /// The chosen corner of the display holding the application being driven.
  ///
  /// The DISPLAY is not a preference and the corner is. The driven window is
  /// what the user is about to watch move, and on a two-display Mac a notice
  /// pinned to the main screen can be on the other one entirely — which is the
  /// same failure as no notice. The corner within it is
  /// `NoticeStyle.frame`, which is where the arithmetic and its test live.
  private func place(
    _ panel: NSPanel, on screen: NSScreen?, size: NSSize, placement: NoticeStyle.Placement
  ) {
    guard let frame = (screen ?? NSScreen.main)?.visibleFrame else { return }
    panel.setFrame(
      NoticeStyle.frame(for: size, in: frame, placement: placement), display: false)
  }

  /// The screen holding that application's largest on-screen window.
  ///
  /// `CGWindowListCopyWindowInfo` rather than the Accessibility API: this runs
  /// on the path of a press and must not depend on a grant, on a handle, or on
  /// an application answering an AX query promptly. Its known weakness —
  /// `docs/screen.md`: it "hands back shadows, toolbars and helper layers" — is
  /// harmless when the question is only which display to use, and taking the
  /// LARGEST window makes a stray helper layer unable to win.
  private func screenShowing(_ bundleId: String) -> NSScreen? {
    guard
      let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first,
      let listed = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0)
        as? [[String: Any]]
    else { return nil }

    let pid = AccessibilityDriver.pid(of: app)
    var best: CGRect?
    for window in listed {
      guard
        (window[kCGWindowOwnerPID as String] as? pid_t) == pid,
        let raw = window[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: raw as CFDictionary)
      else { continue }
      if best == nil || rect.width * rect.height > best!.width * best!.height { best = rect }
    }
    guard let bounds = best else { return nil }

    // CGWindow bounds measure DOWN from the top of the primary display;
    // `NSScreen` measures up from its bottom. Comparing them unconverted puts
    // the notice on the wrong screen whenever the displays are stacked.
    guard let primary = NSScreen.screens.first else { return nil }
    let flipped = CGPoint(x: bounds.midX, y: primary.frame.maxY - bounds.midY)
    return NSScreen.screens.first { $0.frame.contains(flipped) }
  }
}

/// A hosting view that acts on the first click.
///
/// The panel never becomes key, by design, and a view in a window that is not
/// key normally treats the first click as "bring me forward" and does nothing
/// else. That would make Cancel need two clicks, the second of which may come
/// after the countdown has already ended.
///
/// It also drops any click Cupertino posted itself. `postingPointer` keeps the
/// card out of the way of those, and this is the net under it: a synthetic
/// click that reached the card anyway must not press its cross, which would be
/// an agent stopping its own session and being told the person did.
private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    guard !Self.isOurs(event) else { return }
    super.mouseDown(with: event)
  }

  override func mouseUp(with event: NSEvent) {
    guard !Self.isOurs(event) else { return }
    super.mouseUp(with: event)
  }

  private static func isOurs(_ event: NSEvent) -> Bool {
    event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid())
  }
}

extension DrivingSession.Prompt {
  var phase: DrivingOverlay.Phase {
    switch self {
    case .countdown(_, let endsAt): .countdown(endsAt: endsAt)
    case .asking: .asking
    }
  }
}

/// What an info notice says, shared by the card and the popover row.
///
/// Only the info tier lives here. The driving wording is written out in each
/// view as it always was, so the one notice that asks for hands off the
/// keyboard cannot change by way of a table edit.
extension VisibleTools.Notice {
  var infoSymbol: String {
    switch self {
    case .driving: "cursorarrow.rays"
    case .showing(.openingPage): "safari"
    case .showing(.clickingPage): "cursorarrow.click"
    case .showing(.fillingPage): "character.cursor.ibeam"
    case .showing(.scrollingPage): "arrow.up.and.down"
    case .showing(.openingPlace): "map"
    case .launching: "arrow.up.forward.app"
    }
  }

  func infoTitle(_ name: String) -> String {
    switch self {
    case .launching: "Cupertino opened \(name)"
    default: "Cupertino is using \(name)"
    }
  }

  var infoDetail: String {
    switch self {
    case .driving: "Please don't use the keyboard or mouse."
    case .showing(.openingPage): "Opening a page. You can keep working."
    case .showing(.clickingPage): "Clicking in a page. You can keep working."
    case .showing(.fillingPage): "Filling in a form. You can keep working."
    case .showing(.scrollingPage): "Scrolling a page. You can keep working."
    case .showing(.openingPlace): "Opening a place in the background. You can keep working."
    case .launching: "It was not running. You can keep working."
    }
  }
}

/// Whole seconds left on a countdown, never below zero.
func drivingSecondsLeft(until endsAt: Date, at now: Date) -> Int {
  max(0, Int(endsAt.timeIntervalSince(now).rounded(.up)))
}

/// The notice itself, saying the same thing the popover's `DrivingNotice` says.
///
/// Deliberately small and quiet: it has to be readable at a glance from across a
/// desk without covering what the user was reading.
private struct DrivingCard: View {
  let name: String
  let phase: DrivingOverlay.Phase
  /// Every length below comes from here rather than from a text style, so the
  /// panel and what is drawn in it grow together. See `NoticeStyle.Size`.
  let size: NoticeStyle.Size

  var body: some View {
    HStack(spacing: size.scaled(10)) {
      content
    }
    .padding(.horizontal, size.scaled(14))
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: size.scaled(14)))
    // The buttons are the one thing that cannot be given a point size, so they
    // take the nearest control size instead. `.small` under a 15.6pt title
    // looks like a mistake rather than a choice.
    .controlSize(size == .large ? .regular : .small)
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .notice(.driving):
      dot(.orange)
      lines("Cupertino is driving \(name)", "Please don't use the keyboard or mouse.")
      Spacer(minLength: 0)

    case .holding:
      dot(.orange)
      lines("Cupertino is driving \(name)", "Please don't use the keyboard or mouse.")
      Spacer(minLength: 0)
      Button {
        // Off the main actor: handing back waits up to a second for the
        // previous application to come forward.
        Task.detached { DrivingSession.release(.person) }
      } label: {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: size.titlePoints + size.scaled(4)))
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.borderless)
      .help("Stop driving")
      .accessibilityLabel("Stop driving \(name)")

    case .notice(let kind):
      // Same footprint as the driving card, so a tier change does not move
      // anything; the glyph and its colour are what say "no need to stop".
      glyph(kind.infoSymbol, .blue)
      lines(kind.infoTitle(name), kind.infoDetail)
      Spacer(minLength: 0)

    case .countdown(let endsAt):
      dot(.orange)
      TimelineView(.periodic(from: .now, by: 0.25)) { context in
        lines(
          "Cupertino will drive \(name) in \(drivingSecondsLeft(until: endsAt, at: context.date)) s",
          "Finish what you're typing, or cancel.")
      }
      Spacer(minLength: 0)
      Button("Cancel") { DrivingSession.respond(.stop) }

    case .asking:
      glyph("hand.raised.fill", .orange)
      lines("Cupertino wants to drive \(name)", "It will use the keyboard and mouse.")
      Spacer(minLength: 0)
      Button("Don't") { DrivingSession.respond(.stop) }
      Button("Allow") { DrivingSession.respond(.go) }

    case .done(let restoredName):
      glyph("checkmark.circle.fill", .green)
      lines(
        "Cupertino is done with \(name)",
        restoredName.map { "\($0) is back in front." } ?? "The keyboard and mouse are yours again.")
      Spacer(minLength: 0)
    }
  }

  private func dot(_ color: Color) -> some View {
    Circle()
      .fill(color)
      .frame(width: size.scaled(10), height: size.scaled(10))
  }

  private func glyph(_ symbol: String, _ color: Color) -> some View {
    Image(systemName: symbol)
      .foregroundStyle(color)
      .font(.system(size: size.titlePoints, weight: .semibold))
      .frame(width: size.scaled(16))
  }

  private func lines(_ title: String, _ detail: String) -> some View {
    VStack(alignment: .leading, spacing: size.scaled(2)) {
      Text(title)
        .font(.system(size: size.titlePoints, weight: .semibold))
      Text(detail)
        .font(.system(size: size.detailPoints))
        .foregroundStyle(.secondary)
    }
  }
}
