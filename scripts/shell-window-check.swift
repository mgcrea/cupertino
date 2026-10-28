import AppKit

/// Asserts that nothing a program can reach without a click presses the Shell window's run
/// buttons, and that a window with no screen to go on is answered rather than left waiting.
///
/// Apart from `shell-check` because it needs AppKit, which that check must not. It posts no
/// event, shows no window and launches nothing: the buttons sit in windows never ordered on
/// screen, and every press is made by calling what an Accessibility client, `performClick` or
/// `sendAction` reaches. The "hardware-looking" events are built in memory and never posted.
///
/// Each layer is checked on its own as well as together: the cell's refusal on a plain button
/// with no gate behind it, and the action's gate behind a plain cell that refuses nothing.
///
/// What it cannot check, because that needs a real click: that a person's click still passes,
/// that is, that AppKit sends the action from inside `mouseDown`'s tracking loop with the
/// mouse-up current. Driving the tracking loop needs events in the queue, which means posting.
///
/// Run with `make shell-window-check`.
@main
struct ShellWindowCheck {
  nonisolated(unsafe) static var failures = 0
  nonisolated(unsafe) static var checks = 0

  static func check(_ label: String, _ condition: Bool) {
    checks += 1
    if condition {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  /// Everything Accessibility can reach under `element`, depth first.
  @MainActor static func accessible(under element: Any) -> [Any] {
    let children = (element as AnyObject).accessibilityChildren?() ?? []
    return children + children.flatMap { accessible(under: $0) }
  }

  /// Press each element through the current Accessibility entry point.
  @MainActor static func pressNew(_ elements: [Any]) {
    for element in elements { _ = (element as AnyObject).accessibilityPerformPress?() }
  }

  /// Press each element through the older one, which a button cell answers by `performClick`
  /// without going through `accessibilityPerformPress`. Called by selector, as the
  /// Accessibility bridge calls it, so the deprecation does not reach the build output.
  @MainActor static func pressLegacy(_ elements: [Any]) {
    let selector = NSSelectorFromString("accessibilityPerformAction:")
    for element in elements {
      guard let object = element as? NSObject, object.responds(to: selector) else { continue }
      _ = object.perform(selector, with: NSAccessibility.Action.press.rawValue as NSString)
    }
  }

  @MainActor static func main() {
    _ = NSApplication.shared
    buttonChecks()
    sheetChecks()
    noScreenChecks()
    scriptHeightChecks()
    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }

  @MainActor static func buttonChecks() {
    print("Control: a plain button")
    let plainTarget = Target()
    let plain = NSButton(title: "Plain", target: plainTarget, action: #selector(Target.fire))
    let plainView = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
    plainView.addSubview(plain)
    let plainElements = accessible(under: plainView)
    pressNew(plainElements)
    check("accessibilityPerformPress on its elements presses it", plainTarget.fired == 1)
    pressLegacy(plainElements)
    check("accessibilityPerformAction(.press) on its elements presses it", plainTarget.fired == 2)

    print("\nHandPressedButton, both layers")
    var fired = 0
    let window = panel()
    let button = HandPressedButton.make("Run once") { fired += 1 }
    window.contentView?.addSubview(button)
    check("its cell is the refusing one", button.cell is HandPressedButton.Cell)
    check("it has no key equivalent", button.keyEquivalent.isEmpty)
    check("it never takes keyboard focus", button.refusesFirstResponder)
    let elements = accessible(under: window.contentView!) + [button, button.cell!]
    check("Accessibility sees an element under it", elements.count > 2)
    var refused = HandPressedButton.refusedAtAction
    pressNew(elements)
    check("accessibilityPerformPress on every element, button and cell does nothing", fired == 0)
    pressLegacy(elements)
    check(
      "accessibilityPerformAction(.press) on every element, button and cell does nothing",
      fired == 0)
    check(
      "none of those reached the action: the cell and the button refused them",
      HandPressedButton.refusedAtAction == refused)
    check("there is no event being handled", NSApp.currentEvent == nil)
    button.performClick(nil)
    check("performClick does nothing", fired == 0)
    check(
      "and never reached the action: the cell ignores performClick",
      HandPressedButton.refusedAtAction == refused)
    _ = button.sendAction(button.action, to: button.target)
    check("sending its action does nothing", fired == 0)
    check(
      "it reached the action, which turned it away",
      HandPressedButton.refusedAtAction == refused + 1)

    print("\nThe cell alone, on a plain button with no gate behind it")
    let bareTarget = Target()
    let bare = NSButton(title: "Run once", target: nil, action: nil)
    let refusing = HandPressedButton.Cell(textCell: "Run once")
    refusing.target = bareTarget
    refusing.action = #selector(Target.fire)
    bare.cell = refusing
    let bareView = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
    bareView.addSubview(bare)
    let bareElements = accessible(under: bareView) + [refusing]
    pressNew(bareElements)
    check("accessibilityPerformPress does nothing", bareTarget.fired == 0)
    pressLegacy(bareElements)
    check("accessibilityPerformAction(.press) does nothing", bareTarget.fired == 0)
    bare.performClick(nil)
    check("performClick does nothing", bareTarget.fired == 0)
    // Each refusal on its own: the two Accessibility entry points stop before `performClick`,
    // which is ignored as well.
    let counting = CountingCell(textCell: "Run once")
    counting.target = bareTarget
    counting.action = #selector(Target.fire)
    // On a button, as a cell with no control behind it answers no press at all.
    let countingButton = NSButton(title: "Run once", target: nil, action: nil)
    countingButton.cell = counting
    bareView.addSubview(countingButton)
    _ = counting.accessibilityPerformPress()
    pressLegacy([counting])
    check(
      "neither Accessibility entry point gets as far as performClick",
      counting.clicks == 0 && bareTarget.fired == 0)
    countingButton.performClick(nil)
    check(
      "control: performClick on that button does reach the cell's performClick",
      counting.clicks == 1 && bareTarget.fired == 0)

    print("\nThe gate alone, behind a plain cell that refuses nothing")
    var gateFired = 0
    let gateWindow = panel()
    let gated = HandPressedButton.make("Run once") { gateFired += 1 }
    let plainCell = NSButtonCell(textCell: "Run once")
    plainCell.target = gated
    plainCell.action = gated.action
    gated.cell = plainCell
    gateWindow.contentView?.addSubview(gated)
    let gatedElements = accessible(under: gateWindow.contentView!) + [plainCell]
    refused = HandPressedButton.refusedAtAction
    pressNew(gatedElements)
    let afterNew = HandPressedButton.refusedAtAction
    check("accessibilityPerformPress does nothing", gateFired == 0)
    check("it reached the action, which turned it away", afterNew > refused)
    pressLegacy(gatedElements)
    check("accessibilityPerformAction(.press) does nothing", gateFired == 0)
    check(
      "it reached the action, which turned it away",
      HandPressedButton.refusedAtAction > afterNew)
    gated.performClick(nil)
    check("performClick does nothing", gateFired == 0)

    print("\nA stale event: a hardware-looking mouse-up current, no click tracked")
    // `NSApp.currentEvent` cannot be set without posting, so this hands the action's test the
    // event directly, as `pressed()` hands it the current one. It proves that a mouse-up that
    // passes the hardware test is not enough without a tracked mouse-down on the button; it does
    // not prove which event AppKit has current when a real Accessibility request arrives.
    let up = handLike(.leftMouseUp, in: window)
    check(
      "the built mouse-up passes the hardware test, so the next line tests the flag",
      HandPressedButton.isPersonClick(up, in: window))
    refused = HandPressedButton.refusedAtAction
    button.act(on: up)
    check("with no tracked click, the action does nothing", fired == 0)
    check("and says it turned it away", HandPressedButton.refusedAtAction == refused + 1)
    // A mouse-down that is not hardware starts no tracking; were it to, `super.mouseDown` would
    // wait in AppKit's tracking loop for a mouse-up that never comes, and this check would hang.
    let madeDown = NSEvent.mouseEvent(
      with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
      pressure: 0)
    if let madeDown { button.mouseDown(with: madeDown) }
    button.act(on: up)
    check("a program's mouse-down does not start a tracked click", fired == 0)

    print("\nWhat counts as a person's click")
    let made = NSEvent.mouseEvent(
      with: .leftMouseUp, location: .zero, modifierFlags: [], timestamp: 0,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
      pressure: 0)
    check(
      "a mouse-up a program builds is not: it carries the program's pid",
      !HandPressedButton.isPersonClick(made, in: window))
    check("no event is not", !HandPressedButton.isPersonClick(nil, in: window))
    check(
      "a hardware-looking mouse-up in another window is not",
      !HandPressedButton.isPersonClick(up, in: gateWindow))
    check(
      "a hardware-looking mouse-down is not a mouse-up",
      !HandPressedButton.isPersonClick(handLike(.leftMouseDown, in: window), in: window))

    print("\nArming")
    button.arm(after: 0.05)
    check("arming disables it at once", !button.isEnabled)
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    check("and leaves it disabled when its window is not on screen", !button.isEnabled)

    print("\nCoverWatch: the run buttons and another program's window")
    let watched = HandPressedButton.make("Run once") {}
    watched.isEnabled = true
    let watchedPanel = ShellPanel(
      contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled],
      backing: .buffered, defer: false)
    let notice = NSTextField(labelWithString: CoverWatch.notice(nil))
    notice.alphaValue = 0
    let watch = CoverWatch(panel: watchedPanel, buttons: [watched], notice: notice)
    check("a watched button starts off", !watched.isEnabled)
    check("and is given a test to pass at the moment of a click", watched.clear != nil)
    watch.start()
    RunLoop.main.run(until: Date().addingTimeInterval(ShellConsent.armDelay + 0.3))
    check("it stays off while its window is not on screen", !watched.isEnabled)
    watch.stop()
    check("stopping leaves it off", !watched.isEnabled)
    check(
      "the notice names no one when the window over it has no owner to give",
      CoverWatch.notice(nil) == "Another window is over this one, so Run is off until it moves."
        && CoverWatch.notice("\u{202E}") == CoverWatch.notice(nil))
    check(
      "and names the program whose window it is, made safe to show",
      CoverWatch.notice("No\u{202E}tes")
        == "A window of Notes is over this one, so Run is off until it moves.")
    let longest = CoverWatch.notice(String(repeating: "W", count: 60))
    check(
      "a long name is capped",
      longest == CoverWatch.notice(String(repeating: "W", count: ShellText.ownerLimit)))
    check("none of it has an em dash", !longest.contains("\u{2014}"))
  }

  /// The sheets that turn Shell on and choose "Don't ask": only the confirming button lowers
  /// the bar, nothing a program reaches presses it, and every key means Cancel.
  @MainActor static func sheetChecks() {
    print("\nShellConfirmSheet: the sheets that lower the bar")
    var confirmed = 0
    var cancelled = 0
    let sheet = ShellConfirmSheet(
      title: ShellPane.Copy.enableTitle,
      paragraphs: [ShellPane.Copy.enableBody, ShellPane.Copy.enableSafeguard],
      confirmTitle: ShellPane.Copy.enableConfirm, onConfirm: { confirmed += 1 },
      onCancel: { cancelled += 1 })
    check(
      "the confirming button's cell is the refusing one",
      sheet.confirm.cell is HandPressedButton.Cell)
    check(
      "it has no key equivalent and never takes focus",
      sheet.confirm.keyEquivalent.isEmpty && sheet.confirm.refusesFirstResponder)
    check(
      "Cancel is the default button, so Return cancels",
      sheet.panel.defaultButtonCell === sheet.cancel.cell && sheet.cancel.keyEquivalent == "\r")
    check("and Cancel has the focus", sheet.panel.initialFirstResponder === sheet.cancel)

    let elements =
      accessible(under: sheet.panel.contentView!) + [sheet.confirm, sheet.confirm.cell!]
    pressNew(
      elements.filter {
        ($0 as AnyObject) !== sheet.cancel && ($0 as AnyObject) !== sheet.cancel.cell
      })
    pressLegacy(
      elements.filter {
        ($0 as AnyObject) !== sheet.cancel && ($0 as AnyObject) !== sheet.cancel.cell
      })
    sheet.confirm.performClick(nil)
    _ = sheet.confirm.sendAction(sheet.confirm.action, to: sheet.confirm.target)
    check("no Accessibility press, performClick or sent action confirms it", confirmed == 0)

    sheet.panel.cancelOperation(nil)
    check("Escape cancels", cancelled == 1 && confirmed == 0)
    sheet.cancel.performClick(nil)
    check("and the sheet answers once only", cancelled == 1)

    var dontAskConfirmed = 0
    var dontAskCancelled = 0
    let dontAsk = ShellConfirmSheet(
      title: ShellPane.Copy.dontAskTitle,
      paragraphs: [ShellPane.Copy.dontAskBody, ShellPane.Copy.dontAskCard],
      confirmTitle: ShellPane.Copy.dontAskConfirm, onConfirm: { dontAskConfirmed += 1 },
      onCancel: { dontAskCancelled += 1 })
    pressNew(accessible(under: dontAsk.confirm) + [dontAsk.confirm, dontAsk.confirm.cell!])
    dontAsk.confirm.performClick(nil)
    check("the Don't ask sheet's confirm refuses the same", dontAskConfirmed == 0)
    dontAsk.cancel.performClick(nil)
    check(
      "and its Cancel is an ordinary button: any press can only leave things as they were",
      dontAskCancelled == 1 && dontAskConfirmed == 0)
  }

  /// A panel with a window number, never ordered on screen.
  @MainActor static func panel() -> ShellPanel {
    ShellPanel(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled],
      backing: .buffered, defer: false)
  }

  /// A mouse event in `window` carrying the source fields hardware is expected to carry. Built
  /// in memory and never posted.
  @MainActor static func handLike(_ type: NSEvent.EventType, in window: NSWindow) -> NSEvent? {
    guard
      let made = NSEvent.mouseEvent(
        with: type, location: .zero, modifierFlags: [], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
        pressure: 0),
      let cg = made.cgEvent
    else { return nil }
    cg.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    cg.setIntegerValueField(
      .eventSourceStateID, value: Int64(CGEventSourceStateID.hidSystemState.rawValue))
    return NSEvent(cgEvent: cg)
  }

  /// The height a `PromptWindow.textView` was given.
  @MainActor static func height(_ view: NSScrollView) -> CGFloat? {
    view.constraints.first {
      $0.firstItem === view && $0.firstAttribute == .height && $0.secondItem == nil
    }?.constant
  }

  @MainActor static func scriptHeightChecks() {
    print("\nPromptWindow: the script's view is as tall as the script, up to its cap")
    let one = height(PromptWindow.textView("echo", width: 560, maxHeight: 600))
    let five = height(
      PromptWindow.textView(
        (1...5).map { "echo \($0)" }.joined(separator: "\n"), width: 560,
        maxHeight: 600))
    let long = height(
      PromptWindow.textView(
        (1...200).map { "echo \($0)" }.joined(separator: "\n"), width: 560,
        maxHeight: 300))
    check("one line takes the least height", one == PromptWindow.scriptLeast)
    check("five lines take more than that", (five ?? 0) > (one ?? 0) + 40)
    check("two hundred lines stop at the cap", long == 300)
  }

  @MainActor static func noScreenChecks() {
    print("\nShellConsent: with no screen, a request is answered, not left waiting")
    ShellConsent.screenForPrompt = { nil }
    let consent = ShellConsent.shared
    let answers = Answers()
    let connection = UUID()
    for requestId in ["i1", "i2", "i3"] {
      let prompt = ShellPrompt(
        client: "c", purpose: "p", script: "echo", stdin: nil, interpreter: .zsh, cwd: "/",
        timeoutSeconds: 60, offerSession: false, connection: connection, requestId: requestId)
      Thread.detachNewThread { answers.add(consent.ask(prompt)) }
    }
    let deadline = Date().addingTimeInterval(5)
    while answers.all.count < 3, Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    check("every request is answered", answers.all.count == 3)
    check("each as cancelled", answers.all.allSatisfy { $0 == .cancelled })
    check("and nothing is left in the queue", consent.queue.waiting == 0)
  }
}

/// The refusing cell, counting what reaches `performClick`.
final class CountingCell: HandPressedButton.Cell {
  var clicks = 0
  override func performClick(_ sender: Any?) {
    clicks += 1
    super.performClick(sender)
  }
}

final class Target: NSObject {
  var fired = 0
  @objc func fire() { fired += 1 }
}

final class Answers: @unchecked Sendable {
  private let lock = NSLock()
  private var answers: [ShellPromptAnswer] = []
  func add(_ answer: ShellPromptAnswer) { lock.withLock { answers.append(answer) } }
  var all: [ShellPromptAnswer] { lock.withLock { answers } }
}

/// `AppInfo` reaches for screenshot-mode state, as in `shell-check`.
enum DemoSeed {
  static let isEnabled = false
  static let version = "0.0.0"
}
