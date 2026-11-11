import AppKit
import ApplicationServices
import SwiftUI

/// Spike: can an app be driven while it stays in the background, the way WDA drives an iOS
/// Simulator without taking the Mac's focus?
///
/// Two lanes, measured against the same throwaway target app (an AppKit field, text view and
/// button, a SwiftUI field and button), each case reading what landed and whether the target
/// ever became the active app:
///
///   - **O (out of process)**: what Cupertino can do to any app. `CGEvent.postToPid` keys and
///     clicks, focus set through Accessibility or by the target itself.
///   - **I (in process)**: what a driver linked into our own apps could do (a swift-support-kit
///     product). The target synthesises `NSEvent`s and hands them to its own window with
///     `NSWindow.sendEvent`, or queues them with `NSApp.postEvent`, without activating.
///
/// Each lane runs twice: with the target's window in front of other apps' windows but the app
/// inactive, and with it ordered behind them (occluded), since a driven window usually is.
///
/// ## What makes this safe to run while someone works
///
/// Nothing is posted to the HID or session tap: every out-of-process event goes to the target's
/// pid, and every in-process event stays in the target. If a case does activate the target, it
/// counts the activation and yields straight back to the app that was in front.
///
/// Usage (compiled, so the Accessibility grant is the terminal's):
///   swiftc -O -o apps/apple/.build/background-input-spike scripts/spike-background-input.swift
///   apps/apple/.build/background-input-spike
///
/// ## RUN 2026-11-11, macOS 27.2, Olivier working in VS Code throughout
///
/// 16 cases × 2 window orders = 32. **The target never became active in any of them**
/// (`activations=0`, `isActive` false), and its window was never key, not even after
/// `makeKey()`: an inactive app cannot have a key window, and none of this needs one.
/// Front and behind gave identical results, so occlusion does not matter to either lane.
///
/// - **Keys by `postToPid` land in a background app.** O1–O4, all `LANDED`: NSTextField
///   and NSTextView focused by the app itself, and a SwiftUI `TextField` focused from
///   outside by `AXFocused = true` (its responder became `_SystemTextFieldFieldEditor`).
///   AppKit dispatches the key to the first responder of a window that is not key.
/// - **Clicks by `postToPid` arrive and do nothing.** O5–O7: the local monitor saw
///   `leftMouseDown`/`leftMouseUp` (types 1, 2), and no button fired, AppKit or SwiftUI,
///   with or without the two window-under-pointer fields set to the target's window.
///   `AXPress` (O8) is the out-of-process way to press, as the product already does.
/// - **In process, everything landed.** I1–I8: `NSWindow.sendEvent` keys into AppKit and
///   SwiftUI fields, clicks on an AppKit and a SwiftUI button (the up queued with
///   `NSApp.postEvent` first so NSButton's tracking loop finds it), a click into a
///   SwiftUI field or NSTextField that focused it and the keys after it, and
///   `NSApp.postEvent` keys, which AppKit dispatched although the app has no key window.
///
/// Then a third-party check, `textedit-probe` (scratch, not kept): TextEdit launched
/// behind with `activates = false`, an untitled document, its `AXTextArea` focused through
/// AX, `abc` posted to its pid. **AXValue read `"abc"`, TextEdit stayed inactive.**
/// **Cmd-A posted the same way selected nothing**: a key equivalent goes through the menu
/// bar, which an inactive app does not own. That is the same wall the Mail spike hit with
/// Cmd-V (`spike-mail-composer.swift`, finding 2), which was a key equivalent, not a
/// web-view limit.
///
/// Not measured: Return, Tab, arrows and Escape by `postToPid` (plain keyDowns, so
/// probably like letters, but a field's action on Return may differ), Electron and
/// Chromium fields, WKWebView content, input methods, hover and drag in process.

// MARK: - Shared

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

let role = CommandLine.arguments.dropFirst().first ?? "driver"

// MARK: - Target

final class Model: ObservableObject {
  @Published var swiftText = ""
  @Published var swiftTaps = 0
}

struct Panel: View {
  @ObservedObject var model: Model
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      TextField("SwiftUI field", text: $model.swiftText)
        .accessibilityIdentifier("swiftField")
      Button("SwiftUI button") { model.swiftTaps += 1 }
        .accessibilityIdentifier("swiftButton")
    }
    .padding(8)
  }
}

final class Target: NSObject, NSApplicationDelegate {
  let model = Model()
  var window: NSWindow!
  let nsField = NSTextField(frame: NSRect(x: 10, y: 262, width: 340, height: 24))
  let nsButton = NSButton(frame: NSRect(x: 10, y: 224, width: 180, height: 30))
  var textView: NSTextView!
  var nsTaps = 0
  var activations = 0
  var lastOther: NSRunningApplication?
  var arrived: [String] = []

  func applicationDidFinishLaunching(_ note: Notification) {
    lastOther = NSWorkspace.shared.frontmostApplication
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] note in
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      if let app, app.processIdentifier != getpid() { self?.lastOther = app }
    }
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.activations += 1
      emit("activated")
      if let prev = self.lastOther {
        NSApp.yieldActivation(to: prev)
        prev.activate(from: .current, options: [])
      }
    }
    // Every event the app's queue dispatches, tagged by the poster through
    // eventSourceUserData, so a case can tell "arrived" from "arrived and did nothing".
    NSEvent.addLocalMonitorForEvents(matching: .any) { [weak self] event in
      if let tag = event.cgEvent?.getIntegerValueField(.eventSourceUserData), tag != 0 {
        self?.arrived.append("\(event.type.rawValue)")
      }
      return event
    }

    let screen = NSScreen.main!.visibleFrame
    let size = NSSize(width: 360, height: 300)
    window = NSWindow(
      contentRect: NSRect(
        x: screen.maxX - size.width - 20, y: screen.minY + 20, width: size.width,
        height: size.height),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "background-input spike"
    window.isReleasedWhenClosed = false
    let content = window.contentView!

    nsField.identifier = NSUserInterfaceItemIdentifier("nsField")
    content.addSubview(nsField)

    nsButton.title = "AppKit button"
    nsButton.bezelStyle = .push
    nsButton.target = self
    nsButton.action = #selector(tapped)
    nsButton.identifier = NSUserInterfaceItemIdentifier("nsButton")
    content.addSubview(nsButton)

    let scroll = NSScrollView(frame: NSRect(x: 10, y: 130, width: 340, height: 86))
    textView = NSTextView(frame: scroll.bounds)
    textView.identifier = NSUserInterfaceItemIdentifier("textView")
    scroll.documentView = textView
    scroll.borderType = .bezelBorder
    content.addSubview(scroll)

    let hosting = NSHostingView(rootView: Panel(model: model))
    hosting.frame = NSRect(x: 10, y: 10, width: 340, height: 110)
    content.addSubview(hosting)

    window.orderFrontRegardless()
    Thread.detachNewThread { [weak self] in
      while let line = readLine() {
        DispatchQueue.main.async { self?.handle(line) }
      }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
    emit("ready \(getpid()) \(window.windowNumber)")
  }

  @objc func tapped() { nsTaps += 1 }

  func handle(_ line: String) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    let arg = parts.count > 1 ? parts[1] : ""
    switch parts.first ?? "" {
    case "reset":
      window.makeFirstResponder(nil)
      nsField.stringValue = ""
      textView.string = ""
      model.swiftText = ""
      model.swiftTaps = 0
      nsTaps = 0
      activations = 0
      arrived = []
    case "front":
      window.orderFrontRegardless()
    case "back":
      window.orderBack(nil)
    case "focus":
      let view: NSView = arg == "textView" ? textView : nsField
      emit("focus \(window.makeFirstResponder(view))")
      return
    case "makeKey":
      window.makeKey()
    case "keys":
      for c in arg.map(String.init) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
          window.sendEvent(keyEvent(type, c))
        }
      }
    case "postKeys":
      for c in arg.map(String.init) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
          NSApp.postEvent(keyEvent(type, c), atStart: false)
        }
      }
    case "click":
      // A Cocoa screen point. The up is queued first because NSButton's mouseDown runs a
      // tracking loop that pulls the next mouse event off the queue and would otherwise wait
      // for a real one.
      let xy = arg.split(separator: " ").compactMap { Double($0) }
      let point = window.convertPoint(fromScreen: NSPoint(x: xy[0], y: xy[1]))
      NSApp.postEvent(mouseEvent(.leftMouseUp, point), atStart: false)
      window.sendEvent(mouseEvent(.leftMouseDown, point))
    case "state":
      break
    default:
      emit("unknown \(line)")
      return
    }
    // Let SwiftUI and the queued events settle before reporting.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in
      let responder = window.firstResponder.map { String(describing: type(of: $0)) } ?? "nil"
      let fields: [String] = [
        "nsField=\(nsField.stringValue)", "textView=\(textView.string)",
        "swiftText=\(model.swiftText)", "nsTaps=\(nsTaps)", "swiftTaps=\(model.swiftTaps)",
        "active=\(NSApp.isActive)", "key=\(window.isKeyWindow)",
        "activations=\(activations)", "arrived=\(arrived.joined(separator: ","))",
        "responder=\(responder)",
      ]
      emit("state " + fields.joined(separator: "|"))
    }
  }

  func keyEvent(_ type: NSEvent.EventType, _ c: String) -> NSEvent {
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, characters: c, charactersIgnoringModifiers: c, isARepeat: false,
      keyCode: 0)!
  }

  func mouseEvent(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: point, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
  }
}

// MARK: - Driver

final class Lines: @unchecked Sendable {
  private var buffer: [String] = []
  private let lock = NSLock()
  func push(_ s: String) { lock.lock(); buffer.append(s); lock.unlock() }
  func next(prefix: String, timeout: TimeInterval = 5) -> String? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      lock.lock()
      if let i = buffer.firstIndex(where: { $0.hasPrefix(prefix) }) {
        let s = buffer.remove(at: i)
        buffer.removeAll { $0 == "activated" }
        lock.unlock()
        return s
      }
      lock.unlock()
      Thread.sleep(forTimeInterval: 0.02)
    }
    return nil
  }
}

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
  var raw: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, name as CFString, &raw) == .success ? raw : nil
}

func find(_ root: AXUIElement, _ id: String, depth: Int = 0) -> AXUIElement? {
  if (attr(root, "AXIdentifier") as? String) == id { return root }
  guard depth < 12, let kids = attr(root, kAXChildrenAttribute) as? [AXUIElement] else {
    return nil
  }
  for kid in kids { if let hit = find(kid, id, depth: depth + 1) { return hit } }
  return nil
}

/// The element's centre in global display coordinates (top-left origin), which is what a
/// CGEvent takes; `cocoa` flips it for the target's `convertPoint(fromScreen:)`.
func centre(_ e: AXUIElement) -> CGPoint? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else {
    return nil
  }
  var origin = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &origin)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
}

func cocoa(_ p: CGPoint) -> CGPoint {
  CGPoint(x: p.x, y: NSScreen.screens[0].frame.height - p.y)
}

func frontPid() -> pid_t {
  guard let raw = attr(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute) else {
    return 0
  }
  var pid: pid_t = 0
  AXUIElementGetPid(raw as! AXUIElement, &pid)
  return pid
}

func runDriver() {
  guard AXIsProcessTrusted() else {
    print("This process has no Accessibility grant.")
    exit(1)
  }
  let me = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
  let target = Process()
  target.executableURL = me
  target.arguments = ["target"]
  let input = Pipe()
  let output = Pipe()
  target.standardInput = input
  target.standardOutput = output
  let lines = Lines()
  var partial = ""
  output.fileHandleForReading.readabilityHandler = { handle in
    let chunk = String(decoding: handle.availableData, as: UTF8.self)
    partial += chunk
    while let nl = partial.firstIndex(of: "\n") {
      lines.push(String(partial[..<nl]))
      partial = String(partial[partial.index(after: nl)...])
    }
  }
  try! target.run()
  defer { target.terminate() }

  func send(_ s: String) { input.fileHandleForWriting.write((s + "\n").data(using: .utf8)!) }
  func state(after command: String) -> [String: String] {
    send(command)
    guard let line = lines.next(prefix: "state ") else { return ["error": "no state"] }
    var out: [String: String] = [:]
    for pair in line.dropFirst(6).split(separator: "|", omittingEmptySubsequences: false) {
      let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
      out[kv[0]] = kv.count > 1 ? kv[1] : ""
    }
    return out
  }

  guard let ready = lines.next(prefix: "ready "), case let bits = ready.split(separator: " "),
    let pid = pid_t(bits[1]), let windowNumber = Int64(bits[2])
  else {
    print("target never said ready")
    return
  }
  Thread.sleep(forTimeInterval: 0.8)
  let app = AXUIElementCreateApplication(pid)
  guard let win = (attr(app, kAXWindowsAttribute) as? [AXUIElement])?.first else {
    print("target window not readable")
    return
  }
  var el: [String: AXUIElement] = [:]
  for id in ["nsField", "nsButton", "textView", "swiftField", "swiftButton"] {
    el[id] = find(win, id)
    if el[id] == nil { print("missing \(id)") }
  }
  print("target pid \(pid), window \(windowNumber); front app pid \(frontPid())\n")

  let tag: Int64 = 0x5050
  func postKeys(_ s: String) {
    for c in s.utf16 {
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
        var u = c
        e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        e.setIntegerValueField(.eventSourceUserData, value: tag)
        e.postToPid(pid)
      }
    }
  }
  func postClick(_ id: String, windowFields: Bool) {
    guard let e = el[id], let p = centre(e) else { return }
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
      let ev = CGEvent(
        mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
      ev.setIntegerValueField(.eventSourceUserData, value: tag)
      if windowFields {
        // The two window fields the window server fills for a real click; set by hand so
        // AppKit routes the event to the target's window and not to whatever is under the
        // pointer.
        ev.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: windowNumber)
        ev.setIntegerValueField(
          .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: windowNumber)
      }
      ev.postToPid(pid)
    }
  }
  func axFocus(_ id: String) -> String {
    guard let e = el[id] else { return "missing" }
    let err = AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return err == .success ? "ok" : "AXError \(err.rawValue)"
  }
  func inClick(_ id: String) {
    guard let e = el[id], let p = centre(e) else { return }
    let c = cocoa(p)
    send("click \(c.x) \(c.y)")
    _ = lines.next(prefix: "state ")
  }
  func setup(_ s: String) {
    if s.hasPrefix("focus ") {
      send(s)
      _ = lines.next(prefix: "focus ")
    } else {
      _ = state(after: s)
    }
  }

  struct Case {
    let name: String
    let act: () -> Void
    let check: ([String: String]) -> String
  }
  let typed: (String) -> ([String: String]) -> String = { key in
    { s in s[key] == "abc" ? "LANDED" : "no (\(key)=\"\(s[key] ?? "?")\")" }
  }
  let tapped: (String) -> ([String: String]) -> String = { key in
    { s in s[key] == "1" ? "LANDED" : "no (\(key)=\(s[key] ?? "?"))" }
  }

  let cases: [Case] = [
    Case(name: "O1 postToPid keys, NSTextField focused by the app",
         act: { setup("focus nsField"); postKeys("abc") }, check: typed("nsField")),
    Case(name: "O2 postToPid keys, NSTextView focused by the app",
         act: { setup("focus textView"); postKeys("abc") }, check: typed("textView")),
    Case(name: "O3 postToPid keys, NSTextField focused + window made key",
         act: { setup("focus nsField"); setup("makeKey"); postKeys("abc") },
         check: typed("nsField")),
    Case(name: "O4 postToPid keys, SwiftUI field focused through AX",
         act: { print("      AX focus: \(axFocus("swiftField"))"); postKeys("abc") },
         check: typed("swiftText")),
    Case(name: "O5 postToPid click, AppKit button",
         act: { postClick("nsButton", windowFields: false) }, check: tapped("nsTaps")),
    Case(name: "O6 postToPid click + window fields, AppKit button",
         act: { postClick("nsButton", windowFields: true) }, check: tapped("nsTaps")),
    Case(name: "O7 postToPid click + window fields, SwiftUI button",
         act: { postClick("swiftButton", windowFields: true) }, check: tapped("swiftTaps")),
    Case(name: "O8 AXPress, SwiftUI button (baseline)",
         act: { _ = AXUIElementPerformAction(el["swiftButton"]!, kAXPressAction as CFString) },
         check: tapped("swiftTaps")),
    Case(name: "I1 sendEvent keys, NSTextField focused",
         act: { setup("focus nsField"); send("keys abc"); _ = lines.next(prefix: "state ") },
         check: typed("nsField")),
    Case(name: "I2 sendEvent keys, NSTextView focused",
         act: { setup("focus textView"); send("keys abc"); _ = lines.next(prefix: "state ") },
         check: typed("textView")),
    Case(name: "I3 sendEvent keys, SwiftUI field focused through AX",
         act: { _ = axFocus("swiftField"); send("keys abc"); _ = lines.next(prefix: "state ") },
         check: typed("swiftText")),
    Case(name: "I4 sendEvent click, AppKit button",
         act: { inClick("nsButton") }, check: tapped("nsTaps")),
    Case(name: "I5 sendEvent click, SwiftUI button",
         act: { inClick("swiftButton") }, check: tapped("swiftTaps")),
    Case(name: "I6 sendEvent click into SwiftUI field, then keys",
         act: { inClick("swiftField"); send("keys abc"); _ = lines.next(prefix: "state ") },
         check: typed("swiftText")),
    Case(name: "I7 sendEvent click into NSTextField, then keys",
         act: { inClick("nsField"); send("keys abc"); _ = lines.next(prefix: "state ") },
         check: typed("nsField")),
    Case(name: "I8 NSApp.postEvent keys, NSTextField focused",
         act: { setup("focus nsField"); send("postKeys abc"); _ = lines.next(prefix: "state ") },
         check: typed("nsField")),
  ]

  for order in ["front", "back"] {
    print("== window \(order == "front" ? "in front, app inactive" : "behind other apps' windows") ==")
    for c in cases {
      _ = state(after: "reset")
      _ = state(after: order)
      let before = frontPid()
      c.act()
      Thread.sleep(forTimeInterval: 0.3)
      let s = state(after: "state")
      let after = frontPid()
      let stole = (s["activations"] ?? "0") != "0" || after == pid
      print("  \(c.name)")
      print(
        "      \(c.check(s))  activated=\(s["activations"] ?? "?")  key=\(s["key"] ?? "?")"
          + "  arrived=[\(s["arrived"] ?? "")]  responder=\(s["responder"] ?? "?")"
          + (stole ? "  ** TOOK THE FRONT **" : "")
          + (before != after && after != pid ? "  (front moved \(before)->\(after))" : ""))
    }
    print("")
  }
}

// MARK: - Main

if role == "target" {
  let delegate = Target()
  NSApplication.shared.setActivationPolicy(.regular)
  NSApplication.shared.delegate = delegate
  NSApplication.shared.run()
} else {
  runDriver()
}
