import AppKit

/// Asserts that nothing but a person's click can press the Shell window's run buttons, and that
/// a window with no screen to go on is answered rather than left waiting.
///
/// Apart from `shell-check` because it needs AppKit, which that check must not. It posts no
/// event, shows no window and launches nothing: every button lives in a view that is never put
/// on screen, and every press is made by calling the method a program would reach, the way an
/// Accessibility client or `performClick` reaches it.
///
/// The reason it exists: an override of `accessibilityPerformPress` on the button did nothing,
/// because AppKit hands the button's CELL to Accessibility and ignores the button. A check that
/// presses what Accessibility actually sees is the only way to know the refusal holds.
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

  /// Press each element as an Accessibility client would.
  @MainActor static func pressAll(_ elements: [Any]) {
    for element in elements { _ = (element as AnyObject).accessibilityPerformPress?() }
  }

  @MainActor static func main() {
    _ = NSApplication.shared
    buttonChecks()
    noScreenChecks()
    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }

  @MainActor static func buttonChecks() {
    print("HandPressedButton: only a person's click presses it")

    // The control: a plain button, pressed the same way, fires. Without it the checks below
    // could pass because the method of pressing reached nothing.
    let plainTarget = Target()
    let plain = NSButton(title: "Plain", target: plainTarget, action: #selector(Target.fire))
    let plainView = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
    plainView.addSubview(plain)
    let plainElements = accessible(under: plainView)
    pressAll(plainElements)
    check(
      "control: an Accessibility press of a plain button's elements fires it",
      plainTarget.fired == 1)

    var fired = 0
    let window = ShellPanel(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled],
      backing: .buffered, defer: true)
    let button = HandPressedButton.make("Run once") { fired += 1 }
    window.contentView?.addSubview(button)
    check("its cell is the refusing one", button.cell is HandPressedButton.Cell)
    check("it has no key equivalent", button.keyEquivalent.isEmpty)
    check("it never takes keyboard focus", button.refusesFirstResponder)

    let elements = accessible(under: window.contentView!)
    check("Accessibility sees an element for it", !elements.isEmpty)
    pressAll(elements)
    check("an Accessibility press of every element under it does nothing", fired == 0)
    _ = button.accessibilityPerformPress()
    _ = button.cell?.accessibilityPerformPress()
    check("nor of the button or its cell directly", fired == 0)
    check(
      "the cell refuses those itself: none reached the action's own test",
      HandPressedButton.refusedAtAction == 0)

    check("there is no event being handled", NSApp.currentEvent == nil)
    button.performClick(nil)
    check("performClick with no event does nothing", fired == 0)
    _ = button.sendAction(button.action, to: button.target)
    check("sending its action does nothing", fired == 0)
    check(
      "those two were turned away by the action's own test",
      HandPressedButton.refusedAtAction == 2)

    // Built, never posted: a mouse-up this process made carries its own pid.
    let made = NSEvent.mouseEvent(
      with: .leftMouseUp, location: .zero, modifierFlags: [], timestamp: 0,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
      pressure: 0)
    check(
      "a mouse-up a program builds is not a person's click",
      !HandPressedButton.isPersonClick(made, in: window))
    check("no event is not a person's click", !HandPressedButton.isPersonClick(nil, in: window))
    check("nor is any event with no window", !HandPressedButton.isPersonClick(made, in: nil))

    button.arm(after: 0.05)
    check("arming disables it at once", !button.isEnabled)
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    check("and leaves it disabled when its window is not on screen", !button.isEnabled)
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
