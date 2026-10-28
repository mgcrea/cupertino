import AppKit
import SwiftUI

/// The app's `ShellConsenting`: the window a person answers before a script runs, and the card
/// shown while one runs without it.
///
/// ## Why its defaults matter more than its looks
///
/// When an agent has been talked into running something, this window is the only thing left
/// between that and every grant Cupertino holds. So everything about it leans towards "nothing
/// runs":
///
/// - **Don't run** is the default button, and Return and Escape both mean it. Somebody typing
///   when the window arrives declines it rather than approving it.
/// - The two run buttons are `HandPressedButton`s. They have no key equivalent, never take
///   keyboard focus, and stay disabled for `armDelay` after the window shows, so a click already
///   on its way lands on nothing. They act only during a hardware click tracked on the button
///   itself; their cell refuses both Accessibility press entry points and `performClick`. A
///   program running with Cupertino's Accessibility grant could otherwise approve the window
///   without a click at all. The cost is that VoiceOver can read them but not press them.
/// - The window is a `ShellPanel`, which drops every click and keystroke that did not come
///   from hardware.
/// - No answer within `ShellPolicy.askTimeout` is a no, timed from when the window shows.
/// - The script is shown whole, wrapped rather than scrolled sideways, so nothing can be hidden
///   past the right edge, and a script holding invisible characters says so.
///
/// ## Focus
///
/// The window is a non-activating panel made key without activating Cupertino, so the
/// application somebody was in stays the active one while the window takes their keystrokes.
/// Taking focus from someone mid-sentence fails safe, because Return means Don't run.
///
/// ## Threads
///
/// `ask` and `cancel` go straight to `ShellPromptQueue`, which blocks the connection's worker
/// on its own lock, never on the main thread; the window is drawn from the main thread
/// whenever the request in front changes. `running` hops to the main thread with
/// `InProcessRPC.blocking` and returns once the card is on screen, so no run that skipped the
/// window starts before the card is up. The main thread never waits on a worker.
@MainActor
final class ShellConsent: ShellConsenting {
  static let shared = ShellConsent()

  /// What `ShellServer.clientName` falls back to when the client never named itself.
  nonisolated static let unnamedClient = "an unnamed client"

  /// How long the run buttons stay disabled once the window shows.
  static let armDelay: TimeInterval = 1

  nonisolated let queue: ShellPromptQueue

  /// The screen the window goes on: the one with the pointer, else the main one. Settable so
  /// `make shell-window-check` can have none.
  static var screenForPrompt: () -> NSScreen? = {
    let mouse = NSEvent.mouseLocation
    return NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
      ?? NSScreen.main
  }

  private init() {
    queue = ShellPromptQueue(
      timeout: ShellPolicy.askTimeout,
      changed: { Task { @MainActor in ShellConsent.shared.showFront() } })
  }

  // MARK: - ShellConsenting

  nonisolated func ask(_ prompt: ShellPrompt) -> ShellPromptAnswer {
    // The window is drawn on the main thread, so an ask from there could never be answered.
    // Nothing calls it there; should anything start to, it refuses rather than hangs.
    guard !Thread.isMainThread else { return .cancelled }
    return queue.ask(prompt)
  }

  nonisolated func cancel(connection: UUID, requestId: String) {
    queue.cancel(connection: connection, requestId: requestId)
  }

  nonisolated func running(_ prompt: ShellPrompt, stop: @escaping @Sendable () -> Void)
    -> any ShellNoticeToken
  {
    let id = UUID()
    let client = prompt.client
    let shown: Bool
    if Thread.isMainThread {
      shown = MainActor.assumeIsolated { self.addCard(id, client: client, stop: stop) }
    } else {
      shown =
        (try? InProcessRPC.blocking { await self.addCard(id, client: client, stop: stop) })
        ?? false
    }
    // A run nobody can see does not start.
    if !shown { stop() }
    return CardToken(id: id, owner: self)
  }

  // MARK: - The window

  private struct Showing {
    let id: Int
    let panel: ShellPanel
  }

  private var showing: Showing?

  /// Put the request in front on screen, or take the window down when there is none. Called
  /// whenever the front changes; does nothing when the window already shows it.
  private func showFront() {
    let front = queue.front
    guard showing?.id != front?.id else { return }
    if let showing {
      showing.panel.orderOut(nil)
      self.showing = nil
    }
    guard let front else { return }
    let id = front.id
    guard let screen = Self.screenForPrompt() else {
      // Unseen, it could never be answered or time out, and every request behind it would
      // wait for good. Answering it moves the queue on, as `drawCard` fails safe too.
      hostLog("shell", .error, "no screen to show the Shell window on; the request was cancelled")
      queue.answer(id, .cancelled)
      return
    }
    let window = PromptWindow(front.prompt, screen: screen) { [weak self] answer in
      self?.choose(id, answer)
    }
    showing = Showing(id: id, panel: window.panel)
    for button in window.runButtons { button.arm(after: Self.armDelay) }
    let visible = screen.visibleFrame
    let size = window.panel.frame.size
    window.panel.setFrameOrigin(
      NSPoint(
        x: (visible.midX - size.width / 2).rounded(),
        y: (visible.midY - size.height / 2).rounded()))
    window.panel.makeKeyAndOrderFront(nil)
    queue.shown(id)
  }

  private func choose(_ id: Int, _ answer: ShellPromptAnswer) {
    queue.answer(id, answer)
    showFront()
  }

  // MARK: - The card

  private struct Card {
    let id: UUID
    let client: String
    let stop: @Sendable () -> Void
  }

  private var cards: [Card] = []
  private var cardPanel: ShellPanel?

  /// True once the card is on screen.
  private func addCard(_ id: UUID, client: String, stop: @escaping @Sendable () -> Void) -> Bool {
    cards.append(Card(id: id, client: client, stop: stop))
    return drawCard()
  }

  fileprivate func removeCard(_ id: UUID) {
    cards.removeAll { $0.id == id }
    _ = drawCard()
  }

  /// One card for every run in flight without a window. No time limit: it stays as long as a
  /// run does.
  private func drawCard() -> Bool {
    guard !cards.isEmpty else {
      cardPanel?.orderOut(nil)
      return true
    }
    guard let screen = NSScreen.main else { return false }
    let panel = cardPanel ?? Self.makeCardPanel()
    cardPanel = panel
    let style = NoticeStyle.current
    var clients: [String] = []
    for card in cards where !clients.contains(card.client) { clients.append(card.client) }
    let title =
      cards.count == 1
      ? "Running a command for \(clients[0])" : "Running \(cards.count) commands"
    let detail =
      cards.count == 1
      ? "It has Cupertino's access. Stop ends it."
      : "For \(clients.joined(separator: ", ")). Stop ends them all."
    let stops = cards.map(\.stop)
    panel.contentView = CardHostingView(
      rootView: ShellCard(title: title, detail: detail, size: style.size) {
        // Off the main thread: stopping takes the run's own lock.
        for stop in stops { Task.detached { stop() } }
      })
    let size = NSSize(width: style.size.scaled(380), height: style.size.scaled(60))
    var frame = NoticeStyle.frame(for: size, in: screen.visibleFrame, placement: style.placement)
    // One card's height in from the corner, so it never sits on the driving card, which takes
    // the corner itself.
    let step = style.size.scaled(60) + 8
    frame.origin.y += style.placement.isTop ? -step : step
    panel.setFrame(frame, display: false)
    // Never key: the card must not take the keyboard from anybody.
    panel.orderFrontRegardless()
    return true
  }

  private static func makeCardPanel() -> ShellPanel {
    let panel = ShellPanel(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: false)
    panel.level = .screenSaver
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [
      .canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle,
    ]
    // Out of `apple_screen_capture`, as the driving card is.
    panel.sharingType = .none
    return panel
  }
}

/// A panel that takes input only from hardware.
///
/// Every click, keystroke, drag and scroll that `ShellInput.isHardware` says a program posted is
/// dropped before AppKit sees it, key equivalents included: those are offered to the window
/// before `sendEvent`, so `performKeyEquivalent` filters them too. Events that are not input
/// (window moves, AppKit's own) pass as usual. An event with no CGEvent behind it is dropped.
///
/// Nothing about Shell's prompt lives here, so the confirming sheets reuse it.
final class ShellPanel: NSPanel {
  /// Run for Escape, from hardware. Nil leaves Escape to AppKit.
  var onEscape: (() -> Void)?

  private static let input: Set<NSEvent.EventType> = [
    .keyDown, .keyUp, .flagsChanged,
    .leftMouseDown, .leftMouseUp, .leftMouseDragged,
    .rightMouseDown, .rightMouseUp, .rightMouseDragged,
    .otherMouseDown, .otherMouseUp, .otherMouseDragged,
    .mouseMoved, .scrollWheel,
  ]

  private static let escapeKeyCode: UInt16 = 53

  static func fromHardware(_ event: NSEvent) -> Bool {
    guard let cg = event.cgEvent else { return false }
    return ShellInput.isHardware(cg)
  }

  override func sendEvent(_ event: NSEvent) {
    if Self.input.contains(event.type), !Self.fromHardware(event) { return }
    super.sendEvent(event)
  }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    // Taken, so nothing else gets a posted key equivalent while this panel is key either.
    guard Self.fromHardware(event) else { return true }
    if event.keyCode == Self.escapeKeyCode, let onEscape {
      onEscape()
      return true
    }
    return super.performKeyEquivalent(with: event)
  }

  override func cancelOperation(_ sender: Any?) {
    if let onEscape { onEscape() } else { super.cancelOperation(sender) }
  }
}

/// A button with its action as a closure, for the safe answer: any press counts, Return,
/// VoiceOver and a program's included, because all it can do is decline.
private final class ShellButton: NSButton {
  var onPress: (() -> Void)?

  static func make(_ title: String, onPress: @escaping () -> Void) -> ShellButton {
    let button = ShellButton(title: title, target: nil, action: nil)
    button.target = button
    button.action = #selector(pressed)
    button.onPress = onPress
    button.bezelStyle = .push
    return button
  }

  @objc private func pressed() { onPress?() }
}

/// A button only a person's click can press: the run buttons, and the confirming buttons of the
/// sheets that lower the bar.
///
/// What a program could otherwise use to press it, and what stops each:
///
/// - **A posted click or key.** `ShellPanel` drops input that fails `ShellInput.isHardware`
///   before AppKit sees it.
/// - **An Accessibility press**, from any process with the grant, a script Cupertino started
///   included. AppKit hands the button's CELL to Accessibility, and a cell answers a press
///   through two entry points: `accessibilityPerformPress` and the older
///   `accessibilityPerformAction(.press)`, which goes straight to `performClick`. `Cell`
///   refuses both, performs no other Accessibility action, and ignores `performClick`. The
///   button refuses the same two entry points itself, in case AppKit ever reaches it directly.
/// - **Anything else that ends in the action** (`sendAction`, a cell pressed some way not
///   listed here). The action acts only during a click tracked on this button: `mouseDown`
///   with a hardware left mouse-down in this button's own window sets a flag for the length of
///   AppKit's tracking loop, which is when the cell sends the action. The action also needs the
///   event being handled to be a hardware left mouse-up in that window. `NSApp.currentEvent`
///   alone is not enough: an Accessibility request is not an event, so after the person clicks
///   anywhere in the panel, the last mouse-up stays current until the next event arrives.
///   Anything else is ignored and logged.
///
/// It also never takes keyboard focus, so Space never reaches it, has no key equivalent, and
/// `arm(after:)` keeps it disabled for a moment after its window shows, so a click already on
/// its way lands on nothing. The cost: VoiceOver can read it but not press it.
final class HandPressedButton: NSButton {
  /// The cell AppKit hands to Accessibility in the button's place. It refuses both
  /// Accessibility press entry points, performs no other Accessibility action, and ignores
  /// `performClick`; mouse tracking is left alone, so a real click still works. Not final only so
  /// `make shell-window-check` can count what reaches `performClick`.
  class Cell: NSButtonCell {
    override func accessibilityPerformPress() -> Bool { false }
    nonisolated override func accessibilityPerformAction(_ action: NSAccessibility.Action) {}
    override func performClick(_ sender: Any?) {}
  }

  override class var cellClass: AnyClass? {
    get { Cell.self }
    set {}
  }

  var onPress: (() -> Void)?

  /// True only while `mouseDown` runs AppKit's tracking loop for a hardware click on this
  /// button.
  private var trackingHandClick = false

  /// Presses that reached the action and were turned away there. For `make
  /// shell-window-check`, which tells the cell's refusal from the action's by it.
  private(set) static var refusedAtAction = 0

  static func make(_ title: String, onPress: @escaping () -> Void) -> HandPressedButton {
    let button = HandPressedButton(title: title, target: nil, action: nil)
    button.target = button
    button.action = #selector(pressed)
    button.onPress = onPress
    button.bezelStyle = .push
    button.keyEquivalent = ""
    button.refusesFirstResponder = true
    return button
  }

  /// Disabled now, enabled after `delay` if its window is still on screen. Call it before the
  /// window is ordered front.
  func arm(after delay: TimeInterval) {
    isEnabled = false
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.window?.isVisible == true else { return }
        self.isEnabled = true
      }
    }
  }

  /// Whether `event` is a hardware event of `type` delivered to `window`.
  static func isHand(_ event: NSEvent?, _ type: NSEvent.EventType, in window: NSWindow?) -> Bool {
    guard let event, let window, event.type == type, event.window === window else {
      return false
    }
    return ShellPanel.fromHardware(event)
  }

  /// Whether `event` is the mouse-up of a person's click in `window`.
  static func isPersonClick(_ event: NSEvent?, in window: NSWindow?) -> Bool {
    isHand(event, .leftMouseUp, in: window)
  }

  override func mouseDown(with event: NSEvent) {
    guard Self.isHand(event, .leftMouseDown, in: window) else {
      hostLog("shell", .info, "ignored a mouse-down on '\(title)' that was not from hardware")
      return
    }
    trackingHandClick = true
    defer { trackingHandClick = false }
    // The cell's tracking loop runs in here, and sends the action before it returns.
    super.mouseDown(with: event)
  }

  @objc private func pressed() { act(on: NSApp.currentEvent) }

  /// The action's own test, with the event it is judged against passed in, so the check can
  /// hand it one that looks like hardware.
  func act(on event: NSEvent?) {
    guard trackingHandClick, Self.isPersonClick(event, in: window) else {
      Self.refusedAtAction += 1
      hostLog("shell", .info, "ignored a press of '\(title)' that was not a click by hand")
      return
    }
    onPress?()
  }

  override func accessibilityPerformPress() -> Bool { false }
  nonisolated override func accessibilityPerformAction(_ action: NSAccessibility.Action) {}
}

/// A sheet that lowers the bar: turning Shell on, and "Don't ask".
///
/// A `ShellPanel`, so a posted click or key never reaches it, with the confirming button a
/// `HandPressedButton`, so neither Accessibility nor `performClick` presses it. A SwiftUI
/// `.sheet` with a `Button` would take all three. Cancel is an ordinary button and the default:
/// Return and Escape both mean Cancel, and pressing it any way at all can only leave the setting
/// where it was.
///
/// `onConfirm` and `onCancel` are called at most once between them, and the sheet does not take
/// itself down: the caller ends it in both.
@MainActor
struct ShellConfirmSheet {
  let panel: ShellPanel
  let confirm: HandPressedButton
  let cancel: NSButton

  static let width: CGFloat = 460
  static let inset: CGFloat = 20

  init(
    title: String, paragraphs: [String], confirmTitle: String,
    onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void
  ) {
    let content = Self.width - Self.inset * 2
    var answered = false
    let once: (@escaping () -> Void) -> () -> Void = { action in
      {
        guard !answered else { return }
        answered = true
        action()
      }
    }
    let confirmOnce = once(onConfirm)
    let cancelOnce = once(onCancel)

    var views: [NSView] = [PromptWindow.label(title, width: content, size: 15, bold: true)]
    for paragraph in paragraphs { views.append(PromptWindow.label(paragraph, width: content)) }

    let cancel = ShellButton.make(ShellPane.Copy.cancel) { cancelOnce() }
    cancel.keyEquivalent = "\r"
    let confirm = HandPressedButton.make(confirmTitle) { confirmOnce() }
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let row = NSStackView(views: [spacer, confirm, cancel])
    row.orientation = .horizontal
    row.spacing = 8
    row.translatesAutoresizingMaskIntoConstraints = false
    row.widthAnchor.constraint(equalToConstant: content).isActive = true
    views.append(row)

    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.setCustomSpacing(16, after: views[views.count - 2])
    stack.edgeInsets = NSEdgeInsets(
      top: Self.inset, left: Self.inset, bottom: Self.inset, right: Self.inset)
    stack.translatesAutoresizingMaskIntoConstraints = false

    let panel = ShellPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 200), styleMask: [.titled],
      backing: .buffered, defer: false)
    panel.title = title
    panel.isReleasedWhenClosed = false
    // Out of `apple_screen_capture`, as the window is: an agent has no business watching the
    // sheet it would like confirmed.
    panel.sharingType = .none
    panel.onEscape = { cancelOnce() }
    let container = NSView()
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      stack.topAnchor.constraint(equalTo: container.topAnchor),
      stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      stack.widthAnchor.constraint(equalToConstant: Self.width),
    ])
    panel.contentView = container
    panel.setContentSize(container.fittingSize)
    panel.defaultButtonCell = cancel.cell as? NSButtonCell
    panel.initialFirstResponder = cancel

    self.panel = panel
    self.confirm = confirm
    self.cancel = cancel
  }

  /// Attached to `window` as a sheet, or on its own in the middle of the screen when there is no
  /// window to attach it to. The confirming button is armed first, so a click already on its
  /// way lands on nothing.
  func present(on window: NSWindow?) {
    confirm.arm(after: ShellConsent.armDelay)
    if let window, window.isVisible {
      window.beginSheet(panel)
    } else {
      panel.center()
      panel.makeKeyAndOrderFront(nil)
    }
  }

  func dismiss() {
    if let parent = panel.sheetParent {
      parent.endSheet(panel)
    } else {
      panel.orderOut(nil)
    }
  }
}

/// The confirmation window for one request, in the spec's order: who is asking, what the agent
/// says, the script, how it would run, the risk, and the buttons.
@MainActor
private struct PromptWindow {
  let panel: ShellPanel
  let runButtons: [HandPressedButton]

  static let width: CGFloat = 600
  static let inset: CGFloat = 20

  init(_ prompt: ShellPrompt, screen: NSScreen, answer: @escaping (ShellPromptAnswer) -> Void) {
    let content = Self.width - Self.inset * 2
    let visible = screen.visibleFrame.height
    // The script's view is never taller than 60% of the screen; with stdin beside it, the two
    // share that.
    let scriptMax = visible * (prompt.stdin == nil ? 0.6 : 0.45)
    let stdinMax = visible * 0.15

    var views: [NSView] = []

    let client = prompt.client == ShellConsent.unnamedClient ? "An unnamed client" : prompt.client
    let title = NSMutableAttributedString(
      string: client, attributes: [.font: NSFont.boldSystemFont(ofSize: 15)])
    title.append(
      NSAttributedString(
        string: " wants to run a command with Cupertino's access",
        attributes: [.font: NSFont.systemFont(ofSize: 15)]))
    let heading = Self.label("", width: content)
    heading.attributedStringValue = title
    views.append(heading)
    views.append(
      Self.label(
        "The client names itself, and Cupertino cannot verify it.", width: content, size: 11,
        color: .secondaryLabelColor))

    views.append(Self.label("The agent says:", width: content, size: 11, bold: true))
    views.append(Self.label("\u{201C}\(prompt.purpose)\u{201D}", width: content))

    views.append(
      Self.label(Self.caption("Script", prompt.script), width: content, size: 11, bold: true))
    views.append(Self.textView(prompt.script, width: content, maxHeight: scriptMax))
    if let stdin = prompt.stdin {
      views.append(
        Self.label(Self.caption("Input (stdin)", stdin), width: content, size: 11, bold: true))
      views.append(Self.textView(stdin, width: content, maxHeight: stdinMax))
    }
    if Self.hidesCharacters(prompt.script) || prompt.stdin.map(Self.hidesCharacters) == true {
      views.append(
        Self.label(
          "This contains invisible characters, which can make it read differently from what "
            + "runs.", width: content, size: 11, color: .systemRed))
    }

    views.append(
      Self.label(
        "Interpreter: \(prompt.interpreter.rawValue)\nFolder: \(prompt.cwd)\n"
          + "Timeout: \(prompt.timeoutSeconds) s", width: content, size: 11,
        color: .secondaryLabelColor))

    views.append(
      Self.label(
        "This can read everything Cupertino can, including mail, messages and browsing "
          + "history, and can control apps Cupertino controls.", width: content, bold: true))

    let dontRun = ShellButton.make("Don't run") { answer(.dontRun) }
    dontRun.keyEquivalent = "\r"
    let runOnce = HandPressedButton.make("Run once") { answer(.runOnce) }
    var runs = [runOnce]
    if prompt.offerSession {
      runs.insert(
        HandPressedButton.make("Run, and stop asking this session") { answer(.runForSession) },
        at: 0)
    }
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let row = NSStackView(views: [spacer] + runs + [dontRun])
    row.orientation = .horizontal
    row.spacing = 8
    row.translatesAutoresizingMaskIntoConstraints = false
    row.widthAnchor.constraint(equalToConstant: content).isActive = true
    views.append(row)

    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.setCustomSpacing(14, after: views[1])
    stack.edgeInsets = NSEdgeInsets(
      top: Self.inset, left: Self.inset, bottom: Self.inset, right: Self.inset)
    stack.translatesAutoresizingMaskIntoConstraints = false

    let panel = ShellPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 400),
      styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.title = "Cupertino Shell"
    // In this order: `isFloatingPanel` sets the level to `.floating` itself.
    panel.isFloatingPanel = true
    panel.level = .modalPanel
    panel.becomesKeyOnlyIfNeeded = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.sharingType = .none
    panel.onEscape = { answer(.dontRun) }
    let container = NSView()
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      stack.topAnchor.constraint(equalTo: container.topAnchor),
      stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      stack.widthAnchor.constraint(equalToConstant: Self.width),
    ])
    panel.contentView = container
    panel.setContentSize(container.fittingSize)
    panel.defaultButtonCell = dontRun.cell as? NSButtonCell
    panel.initialFirstResponder = dontRun

    self.panel = panel
    self.runButtons = runs
  }

  /// "Script, 3 lines, 120 bytes": a long script says so before anyone scrolls.
  static func caption(_ name: String, _ text: String) -> String {
    let lines =
      text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count
    return "\(name), \(lines) \(lines == 1 ? "line" : "lines"), \(text.utf8.count) bytes"
  }

  /// Format and control characters other than tab and newline: bidirectional overrides,
  /// zero-width spaces and the like, which change how a script reads without changing how it
  /// runs.
  static func hidesCharacters(_ text: String) -> Bool {
    text.unicodeScalars.contains { scalar in
      switch scalar.properties.generalCategory {
      case .format: true
      case .control: scalar != "\n" && scalar != "\t" && scalar != "\r"
      default: false
      }
    }
  }

  static func label(
    _ text: String, width: CGFloat, size: CGFloat = 13, bold: Bool = false,
    color: NSColor = .labelColor
  ) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: text)
    label.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
    label.textColor = color
    label.preferredMaxLayoutWidth = width
    label.isSelectable = true
    label.translatesAutoresizingMaskIntoConstraints = false
    label.widthAnchor.constraint(equalToConstant: width).isActive = true
    return label
  }

  /// Monospaced, selectable, not editable, wrapped, and scrolled once it is taller than
  /// `maxHeight`. Never elided.
  static func textView(_ text: String, width: CGFloat, maxHeight: CGFloat) -> NSScrollView {
    let scroll = NSTextView.scrollableTextView()
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = false
    scroll.borderType = .bezelBorder
    scroll.autohidesScrollers = false
    let view = scroll.documentView as! NSTextView
    view.isEditable = false
    view.isSelectable = true
    view.isRichText = false
    view.usesFontPanel = false
    view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    view.textContainerInset = NSSize(width: 4, height: 6)
    view.string = text
    let inner = width - NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) - 4
    view.frame = NSRect(x: 0, y: 0, width: inner, height: 0)
    view.textContainer?.containerSize = NSSize(width: inner, height: .greatestFiniteMagnitude)
    view.textContainer?.widthTracksTextView = true
    var height: CGFloat = 40
    if let layout = view.layoutManager, let container = view.textContainer {
      layout.ensureLayout(for: container)
      height = layout.usedRect(for: container).height + view.textContainerInset.height * 2 + 4
    }
    scroll.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      scroll.widthAnchor.constraint(equalToConstant: width),
      scroll.heightAnchor.constraint(equalToConstant: min(max(height, 40), maxHeight)),
    ])
    return scroll
  }
}

/// The card's token. `ended()` takes this run off the card, and the card down with the last.
private nonisolated struct CardToken: ShellNoticeToken {
  let id: UUID
  let owner: ShellConsent
  func ended() { Task { @MainActor in owner.removeCard(id) } }
}

/// A hosting view that acts on the first click: the card is never key, and a view in a window
/// that is not key otherwise spends that click on bringing it forward.
private final class CardHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The card, drawn as the driving card is, at the size `NoticeStyle` sets.
private struct ShellCard: View {
  let title: String
  let detail: String
  let size: NoticeStyle.Size
  let stop: () -> Void

  var body: some View {
    HStack(spacing: size.scaled(10)) {
      Image(systemName: "terminal")
        .foregroundStyle(.orange)
        .font(.system(size: size.titlePoints, weight: .semibold))
        .frame(width: size.scaled(16))
      VStack(alignment: .leading, spacing: size.scaled(2)) {
        Text(title)
          .font(.system(size: size.titlePoints, weight: .semibold))
          .lineLimit(1)
        Text(detail)
          .font(.system(size: size.detailPoints))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      Button("Stop", action: stop)
        .accessibilityLabel("Stop the running command")
    }
    .padding(.horizontal, size.scaled(14))
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: size.scaled(14)))
    .controlSize(size == .large ? .regular : .small)
  }
}
