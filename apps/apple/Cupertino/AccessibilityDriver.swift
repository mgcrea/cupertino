import AppKit
import ApplicationServices
import Carbon.HIToolbox

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
    /// Keyed by the number in the handle rather than by its spelling, so that
    /// age is an ordering rather than a lookup: eviction is "everything below
    /// this number", which a dictionary of strings cannot answer.
    private var elements: [Int: (element: AXUIElement, bundleId: String)] = [:]
    private var next = 0
    private let lock = NSLock()

    /// Bounded so a long session cannot grow without limit. Handles are cheap to
    /// re-mint — a stale one is an error a caller recovers from with a fresh
    /// tree, which is the same contract a WebDriver element id has.
    static let capacity = 20000

    /// Evicting the oldest half rather than everything, because the walk that
    /// trips the bound is minting handles INTO it: a full wipe would strand
    /// handles minted earlier in the very answer being composed, and the caller
    /// would be told to take a fresh tree for the tree it just took.
    /// apple_desktop_find_elements reaches the cap fastest, since it walks with
    /// detail `all`.
    func put(_ element: AXUIElement, bundleId: String) -> String {
      lock.lock()
      defer { lock.unlock() }
      next += 1
      elements[next] = (element, bundleId)
      if elements.count > Self.capacity {
        let floor = next - Self.capacity / 2
        elements = elements.filter { $0.key >= floor }
      }
      return "e\(next)"
    }

    func get(_ handle: String) -> (element: AXUIElement, bundleId: String)? {
      lock.lock()
      defer { lock.unlock() }
      guard handle.hasPrefix("e"), let number = Int(handle.dropFirst()) else { return nil }
      return elements[number]
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
  private static func resolve(_ handle: String, scope: Scope) throws -> AXUIElement {
    try resolveEntry(handle, scope: scope).element
  }

  /// The same check, keeping the bundle id. `focus` needs it to ask the
  /// APPLICATION which element holds the keyboard, which is the only honest
  /// answer available — see the note there.
  private static func resolveEntry(
    _ handle: String, scope: Scope
  ) throws -> (element: AXUIElement, bundleId: String) {
    guard let entry = handles.get(handle) else { throw Failure.staleHandle(handle) }
    guard inScope(entry.bundleId, scope: scope) else {
      throw Failure.outOfScope(entry.bundleId)
    }
    return entry
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

  // ─── orphans: children the parent will not name ────────────────────────────

  /// The Simulator's tab bar, measured 2026-09-07 (docs/simulator.md): an
  /// `AXGroup` whose `AXChildren`, `AXVisibleChildren`, `AXContents`, `AXTabs`,
  /// `AXSelectedChildren` and `AXChildrenInNavigationOrder` all answer 0 — and
  /// whose frame, hit-tested, returns four `AXRadioButton`s that each name that
  /// very group as their `AXParent`, and that take `AXPress`. The edge is
  /// one-way: the children know their parent, the parent does not list them.
  /// A walk that descends only `AXChildren` stops there and reports the walk
  /// complete, which is worse than a truncated one because nothing says so.
  ///
  /// So when a container's children link is empty, its frame is swept with
  /// `AXUIElementCopyElementAtPosition` and every distinct hit whose ancestor
  /// chain leads back to the container is walked as one of its children. The
  /// hit is the DEEPEST element at the point, so the chain is climbed to the
  /// element directly under the container, and that is what is kept — the tree
  /// stays a tree.
  ///
  /// Cost, measured across seven Mac apps and the Simulator: one hit-test is
  /// 0.3–3 ms, and a whole tree holds between zero and five childless
  /// containers that pass the gate below. Probe points inside a child already
  /// found are skipped, so the tab bar's four tabs cost about ten round trips
  /// rather than the grid's full count. That is why this runs on every walk
  /// rather than behind a switch: the price is a few milliseconds where it does
  /// nothing, and where it does something there was no answer before.
  ///
  /// What it does not recover: children of a container that is scrolled or
  /// covered — a hit-test sees what is on screen. That is the same limit a
  /// finger has, and `recovered` in the answer says how many came this way.
  private static let sweepRoles: Set<String> = [
    "AXGroup", "AXToolbar", "AXTabGroup", "AXRadioGroup", "AXList", "AXScrollArea",
    "AXSplitGroup", "AXLayoutArea", "AXGenericElement",
  ]
  /// Coarser than the smallest control that matters (a tab item is 95x54) and
  /// fine enough that nothing a finger can hit falls between two probes.
  private static let sweepStep = 24.0
  private static let sweepMaxProbes = 48

  /// Whether an element with no `AXChildren` is worth sweeping: a container by
  /// role, drawn at a size a child could hide in, and not itself a control — a
  /// childless button is a leaf, and there are hundreds per window.
  private static func sweepWorthy(role: String, rect: [Double]?, pressable: Bool) -> Bool {
    guard sweepRoles.contains(role), !pressable, let rect else { return false }
    return rect[2] >= sweepStep && rect[3] >= sweepStep
  }

  /// `AXUIElement` compares by identity through `CFEqual`, not by Swift `==`;
  /// this is the wrapper that lets a `Set` do the de-duplication.
  private struct ElementKey: Hashable {
    let element: AXUIElement
    static func == (a: ElementKey, b: ElementKey) -> Bool { CFEqual(a.element, b.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
  }

  /// The hit-test sweep. Returns the recovered children in reading order
  /// (top-to-bottom, then left-to-right, by their own frames rather than by
  /// which probe found them), each one a direct child of `el` by its own
  /// `AXParent` chain. `deadline` is the walk's wall-clock bound; a sweep that
  /// would cross it stops and returns what it has.
  private static func orphans(of el: AXUIElement, rect: [Double], deadline: Date)
    -> [AXUIElement]
  {
    var pid: pid_t = 0
    guard AXUIElementGetPid(el, &pid) == .success else { return [] }
    // Scoped to the application rather than system-wide, so a window of another
    // app lying over this one cannot answer for it.
    let app = element(for: pid)

    let columns = max(1, min(Int(rect[2] / sweepStep), sweepMaxProbes))
    let rows = max(1, min(Int(rect[3] / sweepStep), sweepMaxProbes / columns))
    var found: [(element: AXUIElement, origin: CGPoint)] = []
    var seen = Set<ElementKey>()
    var covered: [CGRect] = []
    func ordered() -> [AXUIElement] {
      found.sorted {
        $0.origin.y != $1.origin.y ? $0.origin.y < $1.origin.y : $0.origin.x < $1.origin.x
      }.map(\.element)
    }

    for row in 0..<rows {
      let y = rect[1] + rect[3] * (Double(row) + 0.5) / Double(rows)
      for column in 0..<columns {
        if Date() > deadline { return ordered() }
        let x = rect[0] + rect[2] * (Double(column) + 0.5) / Double(columns)
        let point = CGPoint(x: x, y: y)
        if covered.contains(where: { $0.contains(point) }) { continue }

        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(x), Float(y), &hit) == .success,
          let deepest = hit, !CFEqual(deepest, el)
        else { continue }

        // Climb to the element directly under `el`. A chain that never reaches
        // `el` is something else drawn at that point — a sibling, a sheet —
        // and is not a child, however well it overlaps.
        var child = deepest
        var reached = false
        for _ in 0..<12 {
          guard let parent = copy(child, kAXParentAttribute as String) else { break }
          let parentElement = parent as! AXUIElement
          if CFEqual(parentElement, el) {
            reached = true
            break
          }
          child = parentElement
        }
        guard reached else { continue }

        let key = ElementKey(element: child)
        var origin = point
        if let childRect = frame(child) {
          origin = CGPoint(x: childRect[0], y: childRect[1])
          covered.append(
            CGRect(x: childRect[0], y: childRect[1], width: childRect[2], height: childRect[3]))
        }
        if seen.insert(key).inserted { found.append((child, origin)) }
      }
    }
    return ordered()
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

  /// How far a caller may reach.
  ///
  /// A value rather than the `anyApp` boolean this started as, because a third
  /// reach appeared that is neither of the two the gate expresses. The internal
  /// channel (`ServerHost`, `for=<surface>`) lends this driver to a node surface
  /// that needs Accessibility for its own app — Mail's composer — and what that
  /// caller may touch is ONE bundle id, narrower than either user-facing
  /// setting and unaffected by them. A boolean could only have widened.
  ///
  /// Kept as a closed enum rather than a set with a `nil` meaning "all", so the
  /// widest reach has to be written down at the call site. `.any` is greppable;
  /// an empty optional is not.
  enum Scope: Hashable {
    /// The applications Cupertino brokers. What the surface reaches with its
    /// scope gate off.
    case brokered
    /// Every running application. What `allowAnyApp` widens to.
    case any
    /// Exactly these, and nothing else. Never widened by a gate.
    case only(Set<String>)

    func admits(_ bundleId: String) -> Bool {
      switch self {
      case .brokered: return AccessibilityDriver.brokeredBundleIds.contains(bundleId)
      case .any: return true
      case .only(let ids): return ids.contains(bundleId)
      }
    }

    /// The phrase a refusal and the guide both use, so they cannot drift.
    var described: String {
      switch self {
      case .brokered:
        return
          "the \(AccessibilityDriver.brokeredBundleIds.count) applications Cupertino brokers"
      case .any: return "any running application"
      case .only(let ids): return ids.sorted().joined(separator: ", ")
      }
    }
  }

  static func inScope(_ bundleId: String, scope: Scope) -> Bool { scope.admits(bundleId) }

  static func runningApps(scope: Scope) -> [RunningApp] {
    NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .filter { scope.admits($0.bundleIdentifier ?? "") }
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
  static func windows(bundleId: String, scope: Scope) throws -> [WindowRef] {
    guard isTrusted() else { throw Failure.notTrusted }
    guard inScope(bundleId, scope: scope) else { throw Failure.outOfScope(bundleId) }
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
    /// Reached by hit-testing a container that did not list it — see
    /// `orphans(of:)`. Emitted as `via: "hit-test"` only when true, the way
    /// `pressable` is, so a tree that told the truth looks as it always did.
    var recovered = false

    var json: [String: Any] {
      var out: [String: Any] = ["handle": handle, "role": role, "depth": depth]
      if let subrole { out["subrole"] = subrole }
      if let identifier { out["id"] = identifier }
      if let name { out["name"] = name }
      if let value { out["value"] = value }
      if let rect { out["rect"] = rect }
      if let point { out["point"] = point }
      if pressable { out["pressable"] = true }
      if recovered { out["via"] = "hit-test" }
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
    /// How many nodes arrived by hit-testing a container whose children link
    /// was empty — see `orphans(of:)`. Zero on a tree that told the truth.
    let recovered: Int
  }

  struct Bounds {
    var depth = 12
    var nodes = 4000
    /// The bound that actually protects a caller — see the 206x spread in
    /// docs/desktop.md. Node count does not predict time.
    var seconds = 5.0
  }

  /// What a search tests a node against, before the node earns a handle.
  ///
  /// A search visits everything and returns almost nothing, so minting a handle
  /// per visited node spends the store's whole capacity on elements the caller
  /// will never be given. This is the same four fields the search filters on.
  struct Candidate {
    let role: String
    let identifier: String?
    let name: String?
    let pressable: Bool
  }

  static func tree(
    bundleId: String, windowIndex: Int?, detail: Detail, bounds: Bounds, scope: Scope,
    match: ((Candidate) -> Bool)? = nil
  ) throws -> Tree {
    let all = try windows(bundleId: bundleId, scope: scope)
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
    return walk(roots: roots, detail: detail, bounds: bounds, bundleId: bundleId, match: match)
  }

  /// Children of one already-resolved element — the lazy half.
  ///
  /// This is what makes a 9770-node window usable: docs/desktop.md measured
  /// Notes at 37 s for a full walk, and depth 3 for its first 500 nodes. A
  /// default tree plus this verb is not a degraded whole tree; it is the product.
  static func expand(
    handle: String, detail: Detail, bounds: Bounds, scope: Scope,
    match: ((Candidate) -> Bool)? = nil
  ) throws -> Tree {
    guard isTrusted() else { throw Failure.notTrusted }
    let owner = handles.get(handle)?.bundleId ?? ""
    let element = try resolve(handle, scope: scope)
    // The same recovery the walk applies below: expanding the Simulator's tab
    // bar by handle used to answer nothing for the same reason walking into it
    // did.
    var roots = children(element)
    var recovered = 0
    if roots.isEmpty {
      let role = string(element, kAXRoleAttribute as String) ?? "AXUnknown"
      let rect = frame(element)
      let pressable = actions(element).contains(kAXPressAction as String)
      if sweepWorthy(role: role, rect: rect, pressable: pressable), let rect {
        roots = orphans(
          of: element, rect: rect, deadline: Date().addingTimeInterval(bounds.seconds))
        recovered = roots.count
      }
    }
    let tree = walk(
      roots: roots, detail: detail, bounds: bounds, bundleId: owner, match: match,
      rootsRecovered: recovered > 0)
    return Tree(
      elements: tree.elements, visited: tree.visited, seconds: tree.seconds,
      stoppedBy: tree.stoppedBy, recovered: tree.recovered + recovered)
  }

  private static func walk(
    roots: [AXUIElement], detail: Detail, bounds: Bounds, bundleId: String,
    match: ((Candidate) -> Bool)? = nil, rootsRecovered: Bool = false
  ) -> Tree {
    var out: [Element] = []
    var visited = 0
    var stoppedBy: String?
    // Kept apart from `stoppedBy` on purpose. The depth cap is reported like
    // the other two bounds, but it must not STOP the walk: the first branch to
    // reach the cap used to set `stoppedBy`, and the guard below then skipped
    // every sibling after it — a depth-1 listing of a window with twenty
    // children answered one child and named `depth(1)` as the reason, which is
    // true and useless. Measured on the Simulator's window, 2026-09-07.
    var depthCapped = false
    var recovered = 0
    let started = Date()
    let deadline = started.addingTimeInterval(bounds.seconds)

    func visit(_ el: AXUIElement, depth: Int, recovered viaHitTest: Bool = false) {
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

      var keep: Bool
      switch detail {
      case .interactive: keep = pressable
      case .labelled: keep = identifier != nil || title != nil || description != nil
      case .all: keep = true
      }
      // `visited` still counts every node, so the walk's own bounds and the
      // `stoppedBy` it reports mean what they did before.
      if keep, let match {
        keep = match(
          Candidate(
            role: role, identifier: identifier, name: title ?? description, pressable: pressable))
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
            depth: depth,
            recovered: viaHitTest))
      }

      if depth >= bounds.depth {
        // Not a stop condition for the whole walk — one deep branch must not
        // truncate its siblings — but the caller still has to know it happened.
        depthCapped = true
        return
      }
      let next = children(el)
      if !next.isEmpty {
        for child in next { visit(child, depth: depth + 1) }
        return
      }
      // Role and action are already in hand; the frame is read only for the few
      // childless containers that get this far, since a node the caller did
      // not keep has not paid for one yet.
      if sweepRoles.contains(role), !pressable,
        let rect = keep ? out.last?.rect : frame(el),
        sweepWorthy(role: role, rect: rect, pressable: pressable)
      {
        let found = orphans(of: el, rect: rect, deadline: deadline)
        recovered += found.count
        for child in found { visit(child, depth: depth + 1, recovered: true) }
      }
    }

    for root in roots { visit(root, depth: 0, recovered: rootsRecovered) }
    if stoppedBy == nil, depthCapped { stoppedBy = "depth(\(bounds.depth))" }
    return Tree(
      elements: out, visited: visited, seconds: Date().timeIntervalSince(started),
      stoppedBy: stoppedBy, recovered: recovered)
  }

  // ─── driving ───────────────────────────────────────────────────────────────

  /// Press by ELEMENT, never by coordinate, whenever the element offers it.
  ///
  /// docs/desktop.md: 86% of pressable elements across seven apps carry an
  /// identifier, title or description, and Maps' controls carry unlocalised
  /// developer-set identifiers (`FavoriteButton`, `AddButton`). A verb built on
  /// position breaks on every layout change and every non-English Mac; this one
  /// does not.
  static func press(handle: String, scope: Scope) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, scope: scope)
    announce(handle)
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
  static func setValue(handle: String, value: String, scope: Scope) throws -> Bool {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, scope: scope)
    announce(handle)

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

  static func raise(handle: String, scope: Scope) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, scope: scope)
    announce(handle)
    let err = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    if let problem = failure(for: err, doing: "Raising '\(handle)'") { throw problem }
  }

  /// Give an element the keyboard focus, and read it back.
  ///
  /// Raising a window is NOT this, and the difference is what makes a paste land
  /// somewhere else. `kAXRaiseAction` orders a window forward inside its
  /// application; the keystroke that follows goes wherever the focus actually
  /// is. `packages/mail` sets `focused` on the composer's web area for exactly
  /// this reason before pressing command-V.
  ///
  /// Read back for the same reason `setValue` is: settable is a claim about the
  /// API, not about the app. Returns whether the focus took, and never reports
  /// success on the strength of the write having been accepted.
  ///
  /// ## Which read back, though — and the bug that answered it
  ///
  /// Asking the element `AXFocused` is the obvious check and it is WRONG on the
  /// one control this verb was written for. MEASURED on Mail's composer web
  /// area, macOS 26.6, French layout: after a set that returns `.success`, the
  /// element's own `AXFocused` reads **false** for as long as it is polled — 24
  /// samples over 1.2 s, never flipping — while the application's
  /// `AXFocusedUIElement` is **that very element from the first read, +0 ms**.
  /// A command-V posted in that state lands in the composer.
  ///
  /// So the element's own flag is not slow, it is untrue, in the same family as
  /// the trap this file already records: reports itself settable and then does
  /// nothing. Here it accepts the focus, holds it, takes the keystrokes, and
  /// still answers no.
  ///
  /// The cost of believing it was not theoretical. `MailAxLane.paste` refuses to
  /// press command-V unless this returns true, so every native reply and forward
  /// came back `bodyVerified: false` — "Nothing landed in it" — while refusing
  /// to paste a body that would have gone in. The tool was wrong in the safe
  /// direction, which is why it survived a release: it under-reported a success
  /// rather than inventing one.
  ///
  /// The application's answer is authoritative because it is the same one the
  /// window server routes keystrokes by, so it cannot disagree with where a
  /// keystroke will land. The element's flag is still consulted as a fallback,
  /// for the case where the app element cannot be reached at all.
  static func focus(handle: String, scope: Scope) throws -> Bool {
    guard isTrusted() else { throw Failure.notTrusted }
    let entry = try resolveEntry(handle, scope: scope)
    let target = entry.element
    announce(handle)

    var settable: DarwinBoolean = false
    let check = AXUIElementIsAttributeSettable(
      target, kAXFocusedAttribute as CFString, &settable)
    if let problem = failure(for: check, doing: "Checking focus on '\(handle)'") { throw problem }
    guard settable.boolValue else {
      throw Failure.refused("That element cannot take the keyboard focus.")
    }

    let err = AXUIElementSetAttributeValue(
      target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if let problem = failure(for: err, doing: "Focusing '\(handle)'") { throw problem }

    if holdsFocus(target, in: entry.bundleId) { return true }

    var raw: AnyObject?
    let read = AXUIElementCopyAttributeValue(target, kAXFocusedAttribute as CFString, &raw)
    if read != .success { return false }
    return (raw as? Bool) ?? false
  }

  /// Does the application say this element is the one holding the keyboard?
  ///
  /// `CFEqual` rather than `==`: two `AXUIElement`s naming the same control are
  /// distinct objects, and reference equality answers no for a match.
  ///
  /// False when the application cannot be reached, which sends `focus` to the
  /// element's own flag rather than reporting a failure it did not establish.
  private static func holdsFocus(_ target: AXUIElement, in bundleId: String) -> Bool {
    guard let running = try? app(forBundleId: bundleId) else { return false }
    var raw: AnyObject?
    let read = AXUIElementCopyAttributeValue(
      element(for: running.processIdentifier), kAXFocusedUIElementAttribute as CFString, &raw)
    guard read == .success, let focused = raw else { return false }
    return CFEqual(focused, target)
  }

  /// Make an application frontmost.
  ///
  /// Synthetic keyboard events are posted to the session and land in whatever is
  /// frontmost, so every `type` and `key` against a specific app has to be
  /// preceded by this or it types into someone else's window. It is a write in
  /// the sense that matters — it rearranges the user's screen — which is why it
  /// sits behind `allowWrites` with the rest of the driving verbs.
  ///
  /// `NSRunningApplication.activate()` rather than an AX action: there is no
  /// `AXRaise` on an application element, and the window-level raise above
  /// deliberately does something narrower. There is, however, a settable
  /// `AXFrontmost` on it, and this needs both.
  ///
  /// LaunchServices arbitrates `activate()`, and since macOS 14 it refuses a
  /// caller the user has not interacted with. This app is an `LSUIElement`
  /// broker that nobody ever clicks, so it is refused for EVERY target — not
  /// for want of a permission, and not because of anything about the target.
  /// MEASURED on macOS 26.6.2: `apple_desktop_activate` was refused for
  /// com.apple.mail and com.apple.finder alike, from Cupertino, while the same
  /// `activate()` on Mail from a command-line process launched seconds earlier
  /// returned true and moved the foreground. The difference is the caller.
  ///
  /// `.activateIgnoringOtherApps` is not the way out: it is deprecated since
  /// macOS 14 and the compiler is explicit that it "will have no effect".
  ///
  /// So when LaunchServices says no, ask Accessibility — a different subsystem,
  /// arbitrated differently, and the one this driver is built on top of anyway.
  /// MEASURED, same session: setting `AXFrontmost` raised Mail from behind
  /// VS Code with `err=0` in the moment after `activate()` had been refused.
  ///
  /// The answer is then read back off the window server rather than taken from
  /// either call's return value, because activation is asynchronous and a
  /// `true` that did not actually move the foreground is precisely how a
  /// synthetic keystroke ends up in somebody else's window.
  static func activate(bundleId: String, scope: Scope) throws {
    guard inScope(bundleId, scope: scope) else { throw Failure.outOfScope(bundleId) }
    let running = try app(forBundleId: bundleId)
    // Not gated on `isTrusted`: activation is LaunchServices, not Accessibility,
    // and refusing it for want of a grant it does not use would be a confusing
    // lie. Scope still applies — it is this surface's bound, not the system's.
    let asked = running.activate()

    // Without the grant there is no second route to try and nothing to read the
    // truth back with, so the boolean is all there is. Unchanged behaviour for
    // a caller that never had Accessibility in the first place.
    guard isTrusted() else {
      guard asked else { throw Failure.refused("\(bundleId) refused to come to the front.") }
      DriveActivity.record(bundleId)
      return
    }

    if !asked {
      AXUIElementSetAttributeValue(
        element(for: running.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }
    guard frontmostSettled(on: bundleId) else {
      throw Failure.refused("\(bundleId) refused to come to the front.")
    }
    // Recorded only once the screen has actually changed. Announcing first put
    // "Cupertino is driving X" on screen for four seconds after a refusal that
    // told the caller X was not even running.
    DriveActivity.record(bundleId)
  }

  /// Wait for the window server to agree that `bundleId` is frontmost.
  ///
  /// Both routes above are asynchronous — about 105 ms, measured on the
  /// Simulator and recorded on `activateAndWait` below — so the call that asked
  /// for the foreground returns before the screen has it. This is the only
  /// place that decides whether activation happened.
  private static func frontmostSettled(on bundleId: String, timeout: TimeInterval = 2) -> Bool {
    let started = Date()
    repeat {
      if frontmostBundleId() == bundleId { return true }
      usleep(20_000)
    } while Date().timeIntervalSince(started) < timeout
    return frontmostBundleId() == bundleId
  }

  /// The application that holds the focus RIGHT NOW, asked of the window
  /// server through Accessibility rather than of `NSWorkspace`.
  ///
  /// `NSWorkspace.frontmostApplication` is fed by KVO and refreshes with the
  /// run loop, so a thread that has just called `activate()` reads the answer
  /// from before it — and a process with no run loop reads the answer from
  /// when it started. MEASURED, docs/simulator.md: six activation trials all
  /// reported "frontmost after 0.0 ms" because the value never moved. The
  /// system-wide element's focused application is the window server's own
  /// answer, and it is where a synthetic keystroke is about to land.
  ///
  /// Nil without a grant, which is an answer: the caller cannot post anyway.
  static func frontmostBundleId() -> String? {
    var raw: AnyObject?
    let systemWide = AXUIElementCreateSystemWide()
    guard
      AXUIElementCopyAttributeValue(
        systemWide, kAXFocusedApplicationAttribute as CFString, &raw) == .success,
      let focused = raw
    else { return nil }
    var pid: pid_t = 0
    guard AXUIElementGetPid(focused as! AXUIElement, &pid) == .success else { return nil }
    return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
  }

  /// `activate`, then WAIT until the window server agrees.
  ///
  /// Activation is asynchronous, and a click posted in the same millisecond
  /// lands in whatever was in front before — measured on the Simulator, where
  /// a click before activation reached nothing and a click after it opened
  /// the row it was aimed at. About 105 ms on every trial. Returns whether the
  /// application became frontmost within `timeout`; a caller that posts
  /// anyway on `false` is typing into somebody else's window.
  static func activateAndWait(bundleId: String, scope: Scope, timeout: TimeInterval = 2)
    throws -> Bool
  {
    if frontmostBundleId() == bundleId { return true }
    try activate(bundleId: bundleId, scope: scope)
    let started = Date()
    while Date().timeIntervalSince(started) < timeout {
      if frontmostBundleId() == bundleId { return true }
      usleep(20_000)
    }
    return frontmostBundleId() == bundleId
  }

  /// Type by KEY CODE, one character at a time, resolved against the layout
  /// the Mac is actually using.
  ///
  /// `type(text:)` puts the unicode string on one event, which every Mac
  /// application reads. The Simulator does not: it forwards the HID key code
  /// to the device and ignores the string — MEASURED, docs/simulator.md: the
  /// string "acc" on virtual key 0 arrived in Settings' search field as a
  /// single "Q", which is key 0 on the AZERTY layout it was typed from. So a
  /// simulated device is typed into the way a person types, one key at a
  /// time, with shift for an uppercase letter.
  ///
  /// Returns the characters this layout has no key for, so the caller can say
  /// which part of the text did not arrive rather than reporting a success it
  /// did not have. Nothing is posted for those characters.
  static func typeByKeyCodes(_ text: String, announcing target: String? = nil) throws
    -> [Character]
  {
    guard isTrusted() else { throw Failure.notTrusted }
    let source = CGEventSource(stateID: .hidSystemState)
    var unmapped: [Character] = []
    var events: [(CGEvent, CGEvent)] = []
    for character in text {
      let lower = String(character).lowercased()
      let name: String
      switch lower {
      case " ": name = "space"
      case "\n": name = "return"
      case "\t": name = "tab"
      default: name = lower
      }
      guard let code = keyCode(for: name) else {
        unmapped.append(character)
        continue
      }
      guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
      else { throw Failure.refused("Could not synthesise typing.") }
      if String(character) != lower {
        down.flags = .maskShift
        up.flags = .maskShift
      }
      events.append((down, up))
    }
    guard !events.isEmpty else { return unmapped }
    announceSessionInput(target)
    for (down, up) in events {
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      // A device keyboard drops keys that arrive faster than a person could
      // press them; 20 ms a key is well inside what a typist manages.
      usleep(20_000)
    }
    return unmapped
  }

  /// Read ONE named attribute off an element.
  ///
  /// The tree carries a fixed field set, chosen because it is what a driver
  /// needs to address a control. Verifying a write often needs one more:
  /// `packages/mail` confirms its quote strip by reading `AXBlockQuoteLevel`,
  /// which is meaningless to every other caller and would be dead weight on
  /// every node of every walk.
  ///
  /// **`attributeUnsupported` and `noValue` return nil rather than throwing**,
  /// which is the rule the census in docs/desktop.md established: a healthy
  /// 13,960-node walk produced 19,903 of the first and 12,893 of the second, so
  /// they outnumber the nodes and are structural rather than failures. An
  /// element that does not carry the attribute is an answer.
  static func attribute(handle: String, name: String, scope: Scope) throws -> Any? {
    guard isTrusted() else { throw Failure.notTrusted }
    let element = try resolve(handle, scope: scope)

    var raw: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, name as CFString, &raw)
    if err == .attributeUnsupported || err == .noValue { return nil }
    if let problem = failure(for: err, doing: "Reading \(name) of '\(handle)'") { throw problem }

    // Only the scalars a caller can act on. An `AXUIElement` answer would need a
    // handle minted for it, and returning one from here would make this a second
    // and undocumented way to walk the tree — `expand` is that, and it carries
    // the bounds this does not.
    switch raw {
    case let value as String: return value
    case let value as NSNumber: return value
    case let value as [Any]: return "<\(value.count) values>"
    case .some(let other): return "<\(Swift.type(of: other))>"
    case nil: return nil
    }
  }

  /// Tell the app that something on somebody's screen is being driven.
  ///
  /// Here rather than in `DesktopServer` so a driving verb added later cannot
  /// forget to do it, and keyed off the HANDLE because that is what every verb
  /// already has — the handle store knows which application it came from, so
  /// nothing has to be threaded through.
  ///
  /// Fire-and-forget onto the main actor: this sits on the path of a press, and
  /// a press that waited for a menu bar icon to redraw would be a worse trade
  /// than no icon at all.
  private static func announce(_ handle: String) {
    guard let bundleId = handles.get(handle)?.bundleId else { return }
    DriveActivity.record(bundleId)
  }

  /// The same notice, for the verbs that address the SESSION rather than an
  /// element: `click`, `type` and `key`.
  ///
  /// These three lit nothing at all, which was exactly backwards. They are the
  /// most invasive things here — a click lands at a screen point and a keystroke
  /// goes to whatever is frontmost, so they are the verbs that actually collide
  /// with the person at the keyboard, and they were the only ones that did it
  /// silently. They were skipped because they take no bundle id to report.
  ///
  /// The frontmost application IS the honest answer: it is where the event is
  /// about to land. Read on this thread rather than hopped to the main actor,
  /// because `NSWorkspace.frontmostApplication` is safe to read from anywhere
  /// and a press that waited on the UI would be the worse trade this file
  /// already refuses elsewhere.
  ///
  /// `target` is for a caller that knows better than the frontmost read: the
  /// simulator surface posts into a window it has just activated, and the
  /// notice should name the Simulator rather than whatever `NSWorkspace` still
  /// reports as frontmost in the same millisecond.
  private static func announceSessionInput(_ target: String? = nil) {
    let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    DriveActivity.record(target ?? frontmost ?? "the frontmost application")
  }

  // ─── the other direction: what the PERSON is doing ─────────────────────────

  /// Seconds since a human last touched this machine.
  ///
  /// The counterpart to the synthetic input below: that is what this app posts,
  /// this is what somebody else did. Needed because driving an interface is the
  /// one thing here that COMPETES with the user — a keystroke goes to whatever
  /// is frontmost and a click goes to a screen point, so a person typing during
  /// a sequence does not slow it down, it corrupts it.
  ///
  /// The value is a duration rather than a flag so a caller can compare it
  /// against how long its own sequence took: a sequence that ran for five
  /// seconds and finds two seconds since the last input knows the input landed
  /// INSIDE it. That comparison is the whole point — an absolute "is the user
  /// active" reading cannot distinguish before from during.
  ///
  /// `combinedSessionState` rather than `hidSystemState`, so events synthesised
  /// by other software count too: something else driving the machine disturbs a
  /// sequence exactly as a person does.
  ///
  /// **Needs no permission.** It reports WHEN, never what — no key, no
  /// position, no content — which is why it can be read on a machine that has
  /// granted nothing, and why it is registered as a read rather than gated.
  static func secondsSinceUserInput() -> Double {
    // `~0` is the documented "any event type" wildcard for this call.
    guard let any = CGEventType(rawValue: ~0) else { return .infinity }
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
  }

  // ─── synthetic input, for what AX cannot express ───────────────────────────

  /// `CGEvent` posting rides the SAME Accessibility grant as everything above —
  /// there is no separate TCC service for it, and constructing an event needs no
  /// permission at all. Only posting does.
  ///
  /// This is the fallback, not the default. A click at a point is what a driver
  /// does when an element offers no action; it is not how a driver should
  /// normally reach a control.
  /// One constructor for every synthetic mouse event below.
  ///
  /// `click`, `drag` and `hover` agree on the two things that are easy to get
  /// wrong separately: the `.hidSystemState` source, and a point in the SAME
  /// top-left global space `frame` reports — see the origin note there. The
  /// source is passed in rather than made here so one sequence's events all
  /// come from one source, as `drag` has always built them.
  private static func mouseEvent(
    _ type: CGEventType, at point: CGPoint, from source: CGEventSource?, doing what: String
  ) throws -> CGEvent {
    guard
      let made = CGEvent(
        mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    else { throw Failure.refused("Could not synthesise \(what).") }
    return made
  }

  static func click(x: Double, y: Double, announcing target: String? = nil) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let point = CGPoint(x: x, y: y)
    let source = CGEventSource(stateID: .hidSystemState)
    // Both built before either is posted, so a failure to synthesise the second
    // cannot leave the button held down — the property `drag` states below.
    let down = try mouseEvent(.leftMouseDown, at: point, from: source, doing: "a click")
    let up = try mouseEvent(.leftMouseUp, at: point, from: source, doing: "a click")
    announceSessionInput(target)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }

  /// Press, move along the segment, release.
  ///
  /// Interpolated `leftMouseDragged` events at ~60 Hz, so whatever is under
  /// the pointer sees a pan with a velocity rather than a jump. Written for the
  /// simulator surface, where the Simulator turns a mouse drag into a touch
  /// pan — MEASURED, docs/simulator.md: a 400-point drag over 400 ms scrolled
  /// Settings' root list a full screen, and the same drag over 120 ms did too.
  /// The duration is honoured as wall-clock, so a caller asking for a fling
  /// gets fewer, faster steps rather than the same steps spaced closer.
  static func drag(
    from: CGPoint, to: CGPoint, durationMs: Int, announcing target: String? = nil
  ) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let source = CGEventSource(stateID: .hidSystemState)
    func event(_ type: CGEventType, at point: CGPoint) throws -> CGEvent {
      try mouseEvent(type, at: point, from: source, doing: "a drag")
    }
    let steps = max(2, durationMs / 16)
    let moved = try event(.mouseMoved, at: from)
    let down = try event(.leftMouseDown, at: from)
    var drags: [CGEvent] = []
    for step in 1...steps {
      let t = Double(step) / Double(steps)
      drags.append(
        try event(
          .leftMouseDragged,
          at: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)))
    }
    let up = try event(.leftMouseUp, at: to)
    // Every event is built before the first is posted, so a failure to
    // synthesise one cannot leave the button held down.
    announceSessionInput(target)
    moved.post(tap: .cghidEventTap)
    down.post(tap: .cghidEventTap)
    let pause = UInt32(max(1, durationMs * 1000 / steps))
    for drag in drags {
      drag.post(tap: .cghidEventTap)
      usleep(pause)
    }
    up.post(tap: .cghidEventTap)
  }

  // ─── hover, which is not a click without the button ────────────────────────

  /// Where the pointer is now, in the same top-left global space `frame`
  /// reports and `click` posts into.
  ///
  /// `CGEvent(source: nil)?.location` answers there already.
  /// `NSEvent.mouseLocation` does NOT — it is bottom-left, and mixing the two is
  /// the origin flip this file warns about above: it puts a sweep on the wrong
  /// half of the screen while every number still looks plausible.
  static func cursorLocation() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
  }

  /// How long the Mac must have been left alone before `hover` will take the
  /// pointer away from whoever is holding it. Under `DriveActivity.linger` on
  /// purpose — see `someoneIsUsingTheMac`.
  static let hoverIdleFloor: TimeInterval = 2

  /// Whether a PERSON — rather than this app — touched the Mac just now.
  ///
  /// `secondsSinceUserInput` reads `.combinedSessionState` deliberately, so it
  /// counts synthetic events too, including the ones `hover` posts below. A bare
  /// `secondsSinceUserInput() < floor` check would therefore refuse every hover
  /// after the first in a sequence, reset by the previous one: the guard would
  /// bite hardest exactly when the agent is working alone, which is the case it
  /// exists to permit.
  ///
  /// `DriveActivity.current()` is the discriminator, and it already has the
  /// right shape — it names what Cupertino is driving for `linger` seconds after
  /// any driving verb. Recent input while that is lit is most likely ours, so
  /// the floor sits UNDER the linger and a sequence composes.
  ///
  /// What this cannot see: a person typing INSIDE a Cupertino sequence, masked
  /// by the lit indicator. That is the same before/after ambiguity
  /// `apple_desktop_user_activity` already tells callers to settle by comparing
  /// the seconds against how long their own sequence took — which is why `hover`
  /// reports the reading back rather than only acting on it.
  static func someoneIsUsingTheMac() -> Bool {
    secondsSinceUserInput() < hoverIdleFloor && DriveActivity.current() == nil
  }

  /// The live centre of a handle's element, re-read at call time.
  ///
  /// The point in a `ui_tree` answer was true when the walk ran. A window that
  /// has moved since — and one being driven moves often — leaves every one of
  /// those points aimed at bare desktop, where a hover MISSES IN SILENCE: there
  /// is no control to fail to press and nothing to report, just a readout that
  /// never appears. Re-reading the frame is what makes the handle form worth
  /// preferring over two numbers, and it is the failure that motivated this verb.
  static func hoverPoint(handle: String, scope: Scope) throws -> (
    point: CGPoint, bundleId: String
  ) {
    guard isTrusted() else { throw Failure.notTrusted }
    let entry = try resolveEntry(handle, scope: scope)
    guard let rect = frame(entry.element) else {
      throw Failure.refused(
        "That element reports no position, so there is no point to move the pointer to.")
    }
    return (CGPoint(x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2), entry.bundleId)
  }

  /// Walk the pointer to a point, posting real `mouseMoved` events along the way.
  ///
  /// The verb for everything that only exists under the cursor — a tooltip, a
  /// hover readout, SwiftUI's `onContinuousHover`. None of them answer to
  /// `click`, and the reason is visible in `click` above: it posts a press and a
  /// release and NOTHING ELSE, so a tracking area sees a button go down inside
  /// it having never seen the pointer arrive.
  ///
  /// Walked rather than teleported because that is the shape proven by hand
  /// against a SwiftUI chart: 24 steps, 25 ms apart. Whether a single move would
  /// have done is NOT known — it was never tried — so the default reproduces
  /// what worked and `durationMs` is how a caller buys it back. Measuring that
  /// is open, docs/desktop.md.
  ///
  /// Steps are derived as `drag` derives them, at ~60 Hz, so a duration means
  /// wall-clock in both and the two read the same.
  static func hover(
    to point: CGPoint, durationMs: Int = 600, settleMs: Int = 0, announcing target: String? = nil
  ) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    guard !someoneIsUsingTheMac() else {
      throw Failure.refused(
        "Somebody is using this Mac — the last input was "
          + String(format: "%.1f", secondsSinceUserInput())
          + " s ago. Hovering takes the physical pointer away from them, so nothing was posted. "
          + "Retry once the Mac has been left alone for \(Int(hoverIdleFloor)) s.")
    }
    let source = CGEventSource(stateID: .hidSystemState)
    let from = cursorLocation()
    let steps = max(2, durationMs / 16)
    var moves: [CGEvent] = []
    for step in 1...steps {
      let t = Double(step) / Double(steps)
      moves.append(
        try mouseEvent(
          .mouseMoved,
          at: CGPoint(x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t),
          from: source, doing: "a pointer move"))
    }
    // Every event built before the first is posted, for `drag`'s reason: a sweep
    // that threw half way would leave the pointer stranded mid-path.
    announceSessionInput(target)
    let pause = UInt32(max(1, durationMs * 1000 / steps))
    for move in moves {
      move.post(tap: .cghidEventTap)
      usleep(pause)
    }
    // The hover state is drawn by the OTHER application, so a caller that reads
    // the tree in the same breath reads it from before the redraw.
    // `Thread.sleep` rather than `usleep`, which is only specified below a
    // second and can decline a longer settle by returning EINVAL — a silent
    // no-wait, which here reads as an application that did not redraw.
    if settleMs > 0 { Thread.sleep(forTimeInterval: Double(settleMs) / 1000) }
  }

  /// Type text as unicode rather than as key codes.
  ///
  /// `jxa/core.ts:301` measured keystroke-by-keystroke typing at "minutes" for a
  /// 4 KB body and noted it "mangles accented characters" — both are properties
  /// of driving System Events with a per-character Apple Event. Setting the
  /// unicode string on one event carries any character correctly and costs one
  /// round trip, so neither the pasteboard borrow nor a key-code table is needed.
  static func type(text: String, announcing target: String? = nil) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    let source = CGEventSource(stateID: .hidSystemState)
    announceSessionInput(target)
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
  static func key(_ name: String, modifiers: [String], announcing target: String? = nil) throws {
    guard isTrusted() else { throw Failure.notTrusted }
    guard let code = keyCode(for: name) else {
      throw Failure.refused(
        "Unknown key '\(name)'. Known: \(knownKeys().joined(separator: ", ")).")
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
    announceSessionInput(target)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
  }

  /// Deliberately small. These are the keys a driver needs to get unstuck —
  /// dismiss a sheet, commit a field, move a selection. Anything typeable goes
  /// through `type` instead, which needs no table and gets accents right.
  /// Keys whose code is a position rather than a character, so a layout cannot
  /// move them. Return is 36 on every Mac ever sold.
  private static let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  ]

  /// Which key produces this character on the layout the user is ACTUALLY typing
  /// on, asked of the system rather than assumed.
  ///
  /// **This is a correctness fix, not a completeness one, and the failure it
  /// prevents is destructive.** A `CGKeyCode` names a physical position, not a
  /// letter. The table above was letter-free, so a caller could not express
  /// command-V at all; the obvious repair — pasting in the US table, where `a`
  /// is 0 and `v` is 9 — is wrong on any layout that moves them. On a French
  /// AZERTY Mac the key at US-`a` is **Q**, so "select all before pasting a
  /// reply" would have sent **command-Q** and quit Mail with an unsaved
  /// composer open. Silently, and only for people not typing on a US layout.
  ///
  /// So the map is built by asking `UCKeyTranslate` what each of the 128 codes
  /// produces on the current input source, and inverting that. Cached, because
  /// it costs 128 translations and the layout rarely changes — and keyed on the
  /// input source id so switching layouts rebuilds it rather than serving a map
  /// for the previous one.
  /// `NSLock` rather than `OSAllocatedUnfairLock`, matching `HandleStore` above:
  /// this file guards its own state and does not import `os` for it.
  ///
  /// **The Text Input Services half runs on the main thread and nowhere else,
  /// and that is a crash fix rather than a convention.** MEASURED: four
  /// `EXC_BREAKPOINT` reports between 1.18.0 and 1.20.0, every one on a
  /// `cupertino.session` thread inside `TSMCurrentKeyboardInputSourceRefCreate`
  /// or `TSMGetInputSourceProperty`. HIToolbox enumerates the input source list
  /// under a `dispatch_assert_queue`, so a lookup answered on the thread the
  /// RPC arrived on takes the whole app down — every surface's connection at
  /// once, not just the one that asked. It was intermittent because the
  /// assertion sits in the branch that REBUILDS the current source ref rather
  /// than the one serving a cached one, which is how it survived three releases
  /// of constant driving. `command-V` into the Mail composer is the call that
  /// found it, being the first single-character key anything sends.
  ///
  /// Hence the split: `refreshLayout` touches TIS and is main-thread-only,
  /// `layoutKeyCodes` reads the cache and never touches TIS at all.
  private nonisolated(unsafe) static var layoutCache: (id: String, map: [String: CGKeyCode])?
  private static let layoutLock = NSLock()

  /// Ask TIS which layout is current, and rebuild the map if it moved.
  ///
  /// MAIN THREAD ONLY — see above. The precondition is the point: a later
  /// caller on the wrong thread fails here, loudly and in its own stack frame,
  /// rather than inside HIToolbox on a machine that is only sometimes unlucky.
  ///
  /// Cheap on the common path — the id compare is one TIS call, and the 128
  /// `UCKeyTranslate` calls run only when the layout actually changed.
  static func refreshLayout() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return }
    let idPointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
    let id =
      idPointer.map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""

    layoutLock.lock()
    let cached = layoutCache
    layoutLock.unlock()
    if let cached, cached.id == id { return }

    var map: [String: CGKeyCode] = [:]
    if let layoutPointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) {
      let data = Unmanaged<CFData>.fromOpaque(layoutPointer).takeUnretainedValue() as Data
      data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
        for code in 0..<128 as Range<UInt16> {
          // Reset per key. `UCKeyTranslate` carries dead-key state forward in
          // this variable, and sharing it across the scan means a dead key
          // swallows whatever is translated next: on the AZERTY layout this was
          // written against, the circumflex key ate `i`, which then had no code
          // and could not be typed. Each key is asked in isolation.
          var deadKeys: UInt32 = 0
          var chars = [UniChar](repeating: 0, count: 4)
          var length = 0
          let err = UCKeyTranslate(
            layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
            OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, 4, &length, &chars)
          guard err == noErr, length > 0 else { continue }
          let produced = String(utf16CodeUnits: chars, count: length).lowercased()
          // First code wins. A character reachable from two keys — the numeric
          // keypad — should resolve to the main one, which comes first.
          if produced.count == 1, map[produced] == nil { map[produced] = CGKeyCode(code) }
        }
      }
    }
    layoutLock.lock()
    layoutCache = (id: id, map: map)
    layoutLock.unlock()
  }

  /// Warm the map and keep it current, so no lookup ever has to reach for TIS.
  ///
  /// MAIN THREAD ONLY, and called once at launch BEFORE the host opens its
  /// socket: after that a client can arrive at any moment, and arriving ahead of
  /// the first warm is exactly what leaves a session thread with nothing to
  /// read.
  ///
  /// The notification is what keeps a switched layout from being served stale,
  /// which matters more than it sounds. A map for the previous layout does not
  /// fail — it presses a DIFFERENT PHYSICAL KEY, which is the destructive
  /// failure this whole lookup exists to prevent.
  static func watchLayout() {
    dispatchPrecondition(condition: .onQueue(.main))
    refreshLayout()
    DistributedNotificationCenter.default.addObserver(
      forName: Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
      object: nil, queue: .main
    ) { _ in refreshLayout() }
  }

  /// The map, read from the cache. Touches nothing that asserts a queue.
  private static func layoutKeyCodes() -> [String: CGKeyCode] {
    layoutLock.lock()
    let cached = layoutCache
    layoutLock.unlock()

    if let cached {
      // Belt to the notification's braces, and off this thread. If the
      // notification is ever missed, a stale map survives ONE lookup rather
      // than until the next time the layout changes.
      DispatchQueue.main.async { refreshLayout() }
      return cached.map
    }

    // Cold, which in the app means something asked before `watchLayout` ran.
    // Inline when this already IS the main thread, because the standalone check
    // binaries have no run loop to service a hop. Otherwise a BOUNDED wait: the
    // alternative to waiting is refusing a key the caller can name, and the
    // alternative to bounding it is parking a session thread on a main thread
    // that may be busy.
    if Thread.isMainThread {
      refreshLayout()
    } else {
      let ready = DispatchSemaphore(value: 0)
      DispatchQueue.main.async {
        refreshLayout()
        ready.signal()
      }
      _ = ready.wait(timeout: .now() + 0.25)
    }

    layoutLock.lock()
    let filled = layoutCache
    layoutLock.unlock()
    // Empty rather than fatal: `key` turns this into its "Unknown key" refusal,
    // which is a bad answer where the trap was a dead app.
    return filled?.map ?? [:]
  }

  /// The code for a named key, position-keyed first and layout-resolved second.
  static func keyCode(for name: String) -> CGKeyCode? {
    let wanted = name.lowercased()
    if let fixed = keyCodes[wanted] { return fixed }
    guard wanted.count == 1 else { return nil }
    return layoutKeyCodes()[wanted]
  }

  /// Every key this driver can name right now, for a refusal that is worth
  /// reading. Layout-dependent, which is the point.
  static func knownKeys() -> [String] {
    (Set(keyCodes.keys).union(layoutKeyCodes().keys)).sorted()
  }
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
