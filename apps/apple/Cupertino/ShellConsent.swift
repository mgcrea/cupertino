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
/// - The two run buttons have no key equivalent, never take keyboard focus (so Space cannot
///   press them either), stay disabled for `armDelay` after the window shows (so a click
///   already on its way lands on nothing), and refuse an Accessibility press: a program running
///   with Cupertino's Accessibility grant could otherwise press them without a click at all.
///   The cost is that VoiceOver can read them but not press them.
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
    let runButtons: [ShellButton]
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
    let mouse = NSEvent.mouseLocation
    guard
      let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
        ?? NSScreen.main
    else { return }
    let id = front.id
    let window = PromptWindow(front.prompt, screen: screen) { [weak self] answer in
      self?.choose(id, answer)
    }
    showing = Showing(id: id, panel: window.panel, runButtons: window.runButtons)
    let visible = screen.visibleFrame
    let size = window.panel.frame.size
    window.panel.setFrameOrigin(
      NSPoint(
        x: (visible.midX - size.width / 2).rounded(),
        y: (visible.midY - size.height / 2).rounded()))
    window.panel.makeKeyAndOrderFront(nil)
    queue.shown(id)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.armDelay) { [weak self] in
      MainActor.assumeIsolated {
        guard let showing = self?.showing, showing.id == id else { return }
        for button in showing.runButtons { button.isEnabled = true }
      }
    }
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
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
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

/// A button with its action as a closure, which can refuse an Accessibility press.
private final class ShellButton: NSButton {
  var onPress: (() -> Void)?
  /// False for the run buttons: a press must be a click.
  var allowsAccessibilityPress = true

  static func make(_ title: String, onPress: @escaping () -> Void) -> ShellButton {
    let button = ShellButton(title: title, target: nil, action: nil)
    button.target = button
    button.action = #selector(pressed)
    button.onPress = onPress
    button.bezelStyle = .push
    return button
  }

  @objc private func pressed() { onPress?() }

  override func accessibilityPerformPress() -> Bool {
    allowsAccessibilityPress ? super.accessibilityPerformPress() : false
  }
}

/// The confirmation window for one request, in the spec's order: who is asking, what the agent
/// says, the script, how it would run, the risk, and the buttons.
@MainActor
private struct PromptWindow {
  let panel: ShellPanel
  let runButtons: [ShellButton]

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

    views.append(Self.label(Self.caption("Script", prompt.script), width: content, size: 11, bold: true))
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
    let runOnce = ShellButton.make("Run once") { answer(.runOnce) }
    var runs = [runOnce]
    if prompt.offerSession {
      runs.insert(ShellButton.make("Run, and stop asking this session") { answer(.runForSession) }, at: 0)
    }
    for button in runs {
      button.isEnabled = false
      button.refusesFirstResponder = true
      button.allowsAccessibilityPress = false
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
    let lines = text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count
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
