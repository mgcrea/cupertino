import AppKit
import ApplicationServices

/// The Accessibility layer for the `desktop` surface: read a window's element
/// tree, address a control, press it.
///
/// Knows nothing about MCP, exactly as `ScreenCapture` knows nothing about
/// `ScreenServer`. Everything here is measured in
/// [docs/desktop.md](../../../docs/desktop.md) rather than assumed, because this
/// repo closed this lane three times on numbers that were measuring something
/// else.
///
/// ## Why this is not osascript
///
/// Every Accessibility measurement this project took before 2026-09-05 went
/// through `osascript` + JXA + System Events — one APPLE EVENT per attribute.
/// That is where "33.6 ms a round trip" and "~14 s" came from. Natively the same
/// walks cost **1.24 ms a round trip**, and the Maps place card that priced at
/// ~14 s walks in **0.177 s**. The transport was the cost, not the API.
///
/// ## The three bounds, and why a node cap is not enough
///
/// Per-round-trip cost varies **206x between applications** on one machine:
/// Safari answers at 0.022 ms, Contacts at 4.537 ms. So node count does not
/// predict time — Contacts' 2401 nodes cost 65 s while Notes' 9770 cost 37 s.
/// Every walk therefore carries THREE bounds and reports which one stopped it:
/// depth, node count, and a wall-clock budget. The budget is the only one that
/// actually protects a caller.
///
/// ## Handles are the performance design
///
/// Resolving an element is what costs; reading an attribute off one already held
/// does not — 2000 `kAXRole` reads on a held element ran at 0.015 ms each. So a
/// walk hands back opaque handles into `HandleStore` and every follow-up press,
/// read or set is nearly free. A fork-per-call CLI cannot do this, which is half
/// the reason this surface is served in-process.
enum AccessibilityDriver {

  // ─── errors: only two of them are worth a caller's attention ───────────────

  /// docs/desktop.md: a healthy 13,960-node walk produced 19,903
  /// `attributeUnsupported` and 12,893 `noValue`. Those are an element without
  /// that attribute and a leaf without children — structural absences that
  /// outnumber the nodes. Surfacing them as failures makes every working tree
  /// look broken, so they never reach this type.
  enum Failure: LocalizedError {
    case notTrusted
    case outOfScope(String)
    case appNotRunning(String)
    case noWindows(String)
    case staleHandle(String)
    case busy(String)
    case refused(String)

    var errorDescription: String? {
      switch self {
      case .notTrusted:
        return
          "Accessibility is not granted to Cupertino. System Settings › Privacy & Security › "
          + "Accessibility. If Cupertino is already listed and switched on, the grant is a stale "
          + "duplicate: run `tccutil reset Accessibility io.mgcrea.cupertino` and grant it once "
          + "from the running copy."
      case .outOfScope(let bundleId):
        return
          "'\(bundleId)' is not one of the applications Cupertino brokers, and this surface is "
          + "scoped to those. Switch on \"Reach any application\" for Desktop in Cupertino to "
          + "address it."
      case .appNotRunning(let name):
        return "\(name) is not running."
      case .noWindows(let name):
        return "\(name) is running but has no window this surface can address."
      case .staleHandle(let handle):
        return
          "Element '\(handle)' no longer exists — the window changed since it was read. Take a "
          + "fresh ui_tree."
      case .busy(let what):
        return "\(what) did not answer in time. The app may be busy; retry."
      case .refused(let what):
        return what
      }
    }
  }

  /// The only two AX codes worth turning into an error. Everything else is
  /// either success or an absence the walker skips.
  private static func failure(for err: AXError, doing what: String) -> Failure? {
    switch err {
    case .success, .attributeUnsupported, .noValue, .actionUnsupported: return nil
    case .apiDisabled: return .notTrusted
    case .invalidUIElement: return .staleHandle(what)
    case .cannotComplete: return .busy(what)
    default: return .refused("\(what) failed (AXError \(err.rawValue)).")
    }
  }

  // ─── permission ────────────────────────────────────────────────────────────

  /// Cheap and local — a lookup, not an IPC. Never prompts: asking would attach
  /// the prompt to whatever is responsible for this process, and
  /// `Permissions.requestAccessibility()` is the one place allowed to do that.
  static func isTrusted() -> Bool { AXIsProcessTrusted() }

  // ─── handles ───────────────────────────────────────────────────────────────

  /// Opaque handles onto resolved elements.
  ///
  /// `@unchecked Sendable` for the same reason `InProcessRPC.ResultBox` is: the
  /// lock is the invariant, stated rather than shrugged at. `AXUIElement` is a
  /// CFType and safe to hold across threads; what is not safe is the dictionary.
  final class HandleStore: @unchecked Sendable {
    /// The element AND which application it came from.
    ///
    /// The bundle id is not bookkeeping: a handle minted while the scope gate
    /// was ON must not keep working after it is switched off, or the gate is a
    /// suggestion. Every read of a handle re-checks scope against this, so
    /// turning the switch off takes effect on the next call rather than at the
    /// next restart — the same guarantee `ServerHost` gives by re-reading
    /// `isEnabled` per request.
    private var elements: [String: (element: AXUIElement, bundleId: String)] = [:]
    private var next = 0
    private let lock = NSLock()

    /// Bounded so a long session cannot grow without limit. Handles are cheap to
    /// re-mint — a stale one is an error a caller recovers from with a fresh
    /// tree, which is the same contract a WebDriver element id has.
    private let capacity = 20000

    func put(_ element: AXUIElement, bundleId: String) -> String {
      lock.lock()
      defer { lock.unlock() }
      if elements.count >= capacity { elements.removeAll() }
      next += 1
      let handle = "e\(next)"
      elements[handle] = (element, bundleId)
      return handle
    }

    func get(_ handle: String) -> (element: AXUIElement, bundleId: String)? {
      lock.lock()
      defer { lock.unlock() }
      return elements[handle]
    }

    func clear() {
      lock.lock()
      defer { lock.unlock() }
      elements.removeAll()
    }
  }

  static let handles = HandleStore()

  /// Resolve a handle, refusing one whose application is now out of scope.
  /// Every verb that takes a handle goes through here rather than touching the
  /// store, so a new verb cannot forget the check.
  private static func resolve(_ handle: String, anyApp: Bool) throws -> AXUIElement {
    guard let entry = handles.get(handle) else { throw Failure.staleHandle(handle) }
    guard inScope(entry.bundleId, anyApp: anyApp) else {
      throw Failure.outOfScope(entry.bundleId)
    }
    return entry.element
  }

  // ─── raw reads ─────────────────────────────────────────────────────────────

  /// A hung app must not hang a tool call. Measured as available; without it
  /// there is no upper bound on a read and a caller cannot tell a slow app from
  /// a dead one. Two seconds is well past the slowest thing measured (Contacts
  /// at 4.5 ms a round trip) and far short of a client timeout.
  private static let messagingTimeout: Float = 2.0

  private static func element(for pid: pid_t) -> AXUIElement {
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, messagingTimeout)
    return el
  }

  private static func copy(_ el: AXUIElement, _ key: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, key as CFString, &value) == .success else { return nil }
    return value
  }

  private static func string(_ el: AXUIElement, _ key: String) -> String? {
    guard let text = copy(el, key) as? String else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func children(_ el: AXUIElement) -> [AXUIElement] {
    (copy(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
  }

  private static func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
  }

  /// AX reports position and size as `AXValue` boxes, and both use the SAME
  /// top-left global origin `CGEvent` posts into. That is worth stating: the
  /// AppKit habit is a bottom-left origin, and flipping these — as code ported
  /// from `NSScreen` arithmetic does — puts every synthetic click on the wrong
  /// half of the screen while every number still looks plausible.
  private static func frame(_ el: AXUIElement) -> [Double]? {
    guard let posValue = copy(el, kAXPositionAttribute as String),
      let sizeValue = copy(el, kAXSizeAttribute as String)
    else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
      AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else { return nil }
    return [point.x, point.y, size.width, size.height]
  }

  // ─── discovery, which needs no grant ───────────────────────────────────────

  struct RunningApp {
    let name: String
    let bundleId: String
    let pid: pid_t
    let active: Bool
  }

  /// `NSWorkspace.runningApplications` is not TCC-gated — it reads the launch
  /// services list. So this answers even with no Accessibility grant at all,
  /// which is what lets the surface say "here is what is running, and here is
  /// why I cannot read it" instead of failing blank.
  /// The brokered set, when the scope gate is off.
  ///
  /// Read from `Surface.all` rather than restated, for the reason
  /// docs/distribution.md gives about every other closed table: "a caller names
  /// a surface, never a path". `desktop` itself has no bundleId — it is a
  /// capability — so it cannot address itself, which is correct.
  static let brokeredBundleIds: Set<String> = Set(Surface.all.compactMap(\.bundleID))

  static func inScope(_ bundleId: String, anyApp: Bool) -> Bool {
    anyApp || brokeredBundleIds.contains(bundleId)
  }

  static func runningApps(anyApp: Bool) -> [RunningApp] {
    NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .filter { anyApp || brokeredBundleIds.contains($0.bundleIdentifier ?? "") }
      .compactMap { app in
        guard let bundleId = app.bundleIdentifier else { return nil }
        return RunningApp(
          name: app.localizedName ?? bundleId, bundleId: bundleId,
          pid: app.processIdentifier, active: app.isActive)
      }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  private static func app(forBundleId bundleId: String) throws -> NSRunningApplication {
    guard
      let app = NSWorkspace.shared.runningApplications
        .first(where: { $0.bundleIdentifier == bundleId })
    else { throw Failure.appNotRunning(bundleId) }
    return app
  }

  // ─── windows ───────────────────────────────────────────────────────────────

  struct WindowRef {
    let handle: String
    let index: Int
    let title: String?
    let role: String
    let rect: [Double]?
    let main: Bool
  }

  /// EVERY window, never `windows[0]`.
  ///
  /// docs/maps.md: a place card's overflow control opens a POPOVER, and AppKit
  /// models a popover as its own `AXWindow`. A spike that walked `windows[0]`
  /// reported a confident zero pressable controls where there were 236.
  ///
  /// **And no filter, deliberately.** docs/screen.md had to derive one —
  /// `windowLayer == 0`, at least 100x100, `isOnScreen || title != nil` —
  /// because "a raw enumeration is not a target list": `CGWindowListCopyWindowInfo`
  /// hands back shadows, toolbars and helper layers, and Mail enumerated 16
  /// windows while having 3. Carrying that filter over here looked obviously
  /// right and is not: `kAXWindowsAttribute` is already curated by the
  /// application. Measured across six surface apps, the AX count and the
  /// FILTERED CGWindowList count agree on every one. A filter here would only be
  /// able to drop real windows.
  static func windows(bundleId: String, anyApp: Bool) throws -> [WindowRef] {
    guard isTrusted() else { throw Failure.notTrusted }
    guard inScope(bundleId, anyApp: anyApp) else { throw Failure.outOfScope(bundleId) }
    let running = try app(forBundleId: bundleId)
    let appElement = element(for: running.processIdentifier)

    var raw: AnyObject?
    let err = AXUIElementCopyAttributeValue(
      appElement, kAXWindowsAttribute as CFString, &raw)
    if let problem = failure(for: err, doing: "Reading \(bundleId) windows") { throw problem }
    guard let list = raw as? [AXUIElement], !list.isEmpty else {
      throw Failure.noWindows(running.localizedName ?? bundleId)
    }

    return list.enumerated().map { index, window in
      WindowRef(
        handle: handles.put(window, bundleId: bundleId),
        index: index,
        title: string(window, kAXTitleAttribute as String),
        role: string(window, kAXRoleAttribute as String) ?? "AXWindow",
        rect: frame(window),
        main: (copy(window, kAXMainAttribute as String) as? Bool) ?? false)
    }
  }

  // ─── the tree ──────────────────────────────────────────────────────────────

  /// What a caller can ask to see. Ported from the reasoning in
  /// `mcp-ios-core/src/ui-tree.ts`: a raw hierarchy is not merely expensive, it
  /// makes the model walk a tree to find a clickable point, which is a join it
  /// can silently get wrong.
  enum Detail: String {
    /// Anything a press can land on. The default.
    case interactive
    /// Anything carrying an identifier, title or description — the readable
    /// surface of the window, for "what does this say".
    case labelled
    case all
  }

  struct Element {
    let handle: String
    let role: String
    let subrole: String?
    let identifier: String?
    let name: String?
    let value: String?
    let rect: [Double]?
    /// The point to click, precomputed. Without it every caller re-derives
    /// `x + width / 2` and the one that gets it wrong clicks a neighbour with
    /// nothing looking wrong.
    let point: [Double]?
    let pressable: Bool
    let depth: Int

    var json: [String: Any] {
      var out: [String: Any] = ["handle": handle, "role": role, "depth": depth]
      if let subrole { out["subrole"] = subrole }
      if let identifier { out["id"] = identifier }
      if let name { out["name"] = name }
      if let value { out["value"] = value }
      if let rect { out["rect"] = rect }
      if let point { out["point"] = point }
      if pressable { out["pressable"] = true }
      return out
    }
  }

  /// Which bound stopped the walk, named rather than implied. A truncated answer
  /// that does not say so is worse than a slow one.
  struct Tree {
    let elements: [Element]
    let visited: Int
    let seconds: Double
    let stoppedBy: String?
  }

  struct Bounds {
    var depth = 12
    var nodes = 4000
    /// The bound that actually protects a caller — see the 206x spread in
    /// docs/desktop.md. Node count does not predict time.
    var seconds = 5.0
  }

  static func tree(
    bundleId: String, windowIndex: Int?, detail: Detail, bounds: Bounds, anyApp: Bool
  ) throws -> Tree {
    let all = try windows(bundleId: bundleId, anyApp: anyApp)
    let chosen: [WindowRef]
    if let windowIndex {
      guard windowIndex >= 0, windowIndex < all.count else {
        throw Failure.refused(
          "Window \(windowIndex) does not exist; \(bundleId) has \(all.count).")
      }
      chosen = [all[windowIndex]]
    } else {
      chosen = all
    }
    let roots = chosen.compactMap { handles.get($0.handle)?.element }
    return walk(roots: roots, detail: detail, bounds: bounds, bundleId: bundleId)
  }

  /// Children of one already-resolved element — the lazy half.
  ///
  /// This is what makes a 9770-node window usable: docs/desktop.md measured
  /// Notes at 37 s for a full walk, and depth 3 for its first 500 nodes. A
  /// default tree plus this verb is not a degraded whole tree; it is the product.
  static func expand(handle: String, detail: Detail, bounds: Bounds, anyApp: Bool) throws -> Tree {
    guard isTrusted() else { throw Failure.notTrusted }
    let owner = handles.get(handle)?.bundleId ?? ""
    let element = try resolve(handle, anyApp: anyApp)
    return walk(roots: children(element), detail: detail, bounds: bounds, bundleId: owner)
  }

  private static func walk(
    roots: [AXUIElement], detail: Detail, bounds: Bounds, bundleId: String
  ) -> Tree {
    var out: [Element] = []
    var visited = 0
    var stoppedBy: String?
    let started = Date()

    func visit(_ el: AXUIElement, depth: Int) {
      if stoppedBy != nil { return }
      if visited >= bounds.nodes {
        stoppedBy = "nodes(\(bounds.nodes))"
        return
      }
      // Checked per node rather than per level: the whole point of a wall-clock
      // bound is that node count does not predict how long a level costs.
      if Date().timeIntervalSince(started) > bounds.seconds {
        stoppedBy = "seconds(\(bounds.seconds))"
        return
      }
      visited += 1

      let role = string(el, kAXRoleAttribute as String) ?? "AXUnknown"
      let identifier = string(el, kAXIdentifierAttribute as String)
      let title = string(el, kAXTitleAttribute as String)
      let description = string(el, kAXDescriptionAttribute as String)

      // docs/maps.md, re-measured across seven apps in docs/desktop.md: ASK WHAT
      // HAS AXPress, NEVER WHAT CALLS ITSELF A BUTTON. A `role == AXButton`
      // filter misses 86% of Maps' pressable elements and 80% of Calendar's,
      // because Catalyst and SwiftUI report controls as AXGenericElement,
      // AXStaticText and AXImage at least as often as AXButton.
      let pressable = actions(el).contains(kAXPressAction as String)

      let keep: Bool
      switch detail {
      case .interactive: keep = pressable
      case .labelled: keep = identifier != nil || title != nil || description != nil
      case .all: keep = true
      }

      if keep {
        let rect = frame(el)
        out.append(
          Element(
            handle: handles.put(el, bundleId: bundleId),
            role: role,
            subrole: string(el, kAXSubroleAttribute as String),
            identifier: identifier,
            name: title ?? description,
            value: string(el, kAXValueAttribute as String),
            rect: rect,
            point: rect.map { [$0[0] + $0[2] / 2, $0[1] + $0[3] / 2] },
            pressable: pressable,
            depth: depth))
      }

      if depth >= bounds.depth {
        // Not a stop condition for the whole walk — one deep branch must not
        // truncate its siblings — but the caller still has to know it happened.
        if stoppedBy == nil { stoppedBy = "depth(\(bounds.depth))" }
        return
      }
      for child in children(el) { visit(child, depth: depth + 1) }
    }

    for root in roots { visit(root, depth: 0) }
    return Tree(
      elements: out, visited: visited, seconds: Date().timeIntervalSince(started),
      stoppedBy: stoppedBy)
  }

  // ─── driving ───────────────────────────────────────────────────────────────

  /// Press by ELEMENT, never by coordinate, whenever the element offers it.
  ///
  /// docs/desktop.md: 86% of pressable elements across seven apps carry an
  /// identifier, title or description, and Maps' controls carry unlocalised
  /// developer-set identifiers (`FavoriteButton`, `AddButton`). A verb built on
  /// position breaks on every layout change and every non-English Mac; this one
  /// does not.
  static func press(handle: String, anyApp: Bool) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, anyApp: anyApp)
    let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if err == .actionUnsupported {
      throw Failure.refused("That element has no AXPress. Use click with its point instead.")
    }
    if let problem = failure(for: err, doing: "Pressing '\(handle)'") { throw problem }
  }

  /// Set a value, and report the trap rather than hiding it.
  ///
  /// `packages/mail/src/client/jxa/core.ts:299` records a value that "reports
  /// itself settable first and then does nothing". `AXUIElementIsAttributeSettable`
  /// returned true on the first text field of all seven apps probed, which proves
  /// the write path is PERMITTED and not that any given app honours it. So this
  /// reads the value back and tells the caller when it did not take.
  static func setValue(handle: String, value: String, anyApp: Bool) throws -> Bool {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, anyApp: anyApp)

    var settable: DarwinBoolean = false
    let check = AXUIElementIsAttributeSettable(
      element, kAXValueAttribute as CFString, &settable)
    if let problem = failure(for: check, doing: "Checking '\(handle)'") { throw problem }
    guard settable.boolValue else {
      throw Failure.refused("That element's value is not settable.")
    }

    let err = AXUIElementSetAttributeValue(
      element, kAXValueAttribute as CFString, value as CFTypeRef)
    if let problem = failure(for: err, doing: "Setting '\(handle)'") { throw problem }

    return string(element, kAXValueAttribute as String) == value
  }

  static func raise(handle: String, anyApp: Bool) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, anyApp: anyApp)
    let err = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    if let problem = failure(for: err, doing: "Raising '\(handle)'") { throw problem }
  }

  // ─── synthetic input, for what AX cannot express ───────────────────────────

  /// `CGEvent` posting rides the SAME Accessibility grant as everything above —
  /// there is no separate TCC service for it, and constructing an event needs no
  /// permission at all. Only posting does.
  ///
  /// This is the fallback, not the default. A click at a point is what a driver
  /// does when an element offers no action; it is not how a driver should
  /// normally reach a control.
  static func click(x: Double, y: Double) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let point = CGPoint(x: x, y: y)
    let source = CGEventSource(stateID: .hidSystemState)
    guard
      let down = CGEvent(
        mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point,
        mouseButton: .left),
      let up = CGEvent(
        mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point,
        mouseButton: .left)
    else { throw Failure.refused("Could not synthesise a click.") }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }

  /// Type text as unicode rather than as key codes.
  ///
  /// `jxa/core.ts:301` measured keystroke-by-keystroke typing at "minutes" for a
  /// 4 KB body and noted it "mangles accented characters" — both are properties
  /// of driving System Events with a per-character Apple Event. Setting the
  /// unicode string on one event carries any character correctly and costs one
  /// round trip, so neither the pasteboard borrow nor a key-code table is needed.
  static func type(text: String) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let source = CGEventSource(stateID: .hidSystemState)
    // Chunked: the unicode string on a single event is not meant for unbounded
    // input, and a long paste-like burst is better delivered as several events.
    for chunk in text.chunked(into: 20) {
      guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
      else { throw Failure.refused("Could not synthesise typing.") }
      var utf16 = Array(chunk.utf16)
      down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
  }

  /// A named key with modifiers — what `type` cannot express.
  static func key(_ name: String, modifiers: [String]) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    guard let code = keyCodes[name.lowercased()] else {
      throw Failure.refused(
        "Unknown key '\(name)'. Known: \(keyCodes.keys.sorted().joined(separator: ", ")).")
    }
    var flags: CGEventFlags = []
    for modifier in modifiers.map({ $0.lowercased() }) {
      switch modifier {
      case "command", "cmd": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "option", "alt": flags.insert(.maskAlternate)
      case "control", "ctrl": flags.insert(.maskControl)
      case "function", "fn": flags.insert(.maskSecondaryFn)
      default: throw Failure.refused("Unknown modifier '\(modifier)'.")
      }
    }
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    else { throw Failure.refused("Could not synthesise a key press.") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }

  /// Deliberately small. These are the keys a driver needs to get unstuck —
  /// dismiss a sheet, commit a field, move a selection. Anything typeable goes
  /// through `type` instead, which needs no table and gets accents right.
  private static let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  ]
}

extension String {
  fileprivate func chunked(into size: Int) -> [String] {
    guard size > 0, count > size else { return isEmpty ? [] : [self] }
    var out: [String] = []
    var index = startIndex
    while index < endIndex {
      let next = self.index(index, offsetBy: size, limitedBy: endIndex) ?? endIndex
      out.append(String(self[index..<next]))
      index = next
    }
    return out
  }
}
