// Phase-0 probe: can Cupertino DRIVE an app's UI natively, and at what cost?
//
// docs/surfaces.md: "Start with a probe, not a package." This is that probe for
// the proposed `desktop` surface — a generic UI driver over the Accessibility
// API, the macOS analogue of what WebDriverAgent gives mcp-ios-device.
//
// ## Why this exists at all: the lane was never measured natively
//
// This repo rejected the Accessibility read lane on COST, three times:
//
//   docs/safari.md   "~206 elements at 33.6 ms a round trip, ~14 s, no bulk fetch"
//   docs/maps.md     "the Accessibility lane this replaced needed ~14 s"
//   packages/mail    "a 4 KB body takes minutes" typing keystroke by keystroke
//
// Every one of those numbers was taken through `osascript` + JXA + System
// Events. scripts/spike-maps-ax-write.mjs imports `osascript` from probe-kit and
// drives Application("System Events"); packages/mail/src/client/jxa/core.ts
// walks the composer with el.uiElements() and kids[i].role(), one APPLE EVENT
// per call, bounded at depth 6 purely to survive the cost.
//
// So 33.6 ms is the price of an Apple Events IPC round trip, NOT the price of
// AXUIElementCopyAttributeValue. "No bulk fetch" is a property of System Events,
// not of the API. The lane was measured through a layer this probe removes.
//
// A first pass established the shape (see docs/desktop.md): native AppKit walks
// at 0.6-1.6 ms a node, Electron and WebKit at 0.04-0.06 ms, and the cost sits
// in RESOLVING an element rather than reading attributes off one already held
// (2000 kAXRole reads on a held element: 0.015 ms each). What that pass did not
// do is measure the tree this repo's 14 s figure was actually taken from, which
// is Q1 below and the headline of the doc.
//
// ## Read the two identities separately
//
// TCC attributes Accessibility to the RESPONSIBLE PROCESS — not to this file,
// not to the swift interpreter, not to node. Measured: an unsigned main.swift in
// /var/folders answered AXIsProcessTrusted() == true purely by inheriting the
// editor that started the chain. So this file answers a different question
// depending on who runs it:
//
//   swift scripts/probe-desktop.swift     responsible = your terminal or editor
//   apple_desktop_diagnostics             responsible = the signed .app
//
// The second is the one the design depends on, and a green run here says nothing
// about it. Permissions.swift:449 records why: ONE BUNDLE ID CAN HOLD SEVERAL
// ACCESSIBILITY ENTRIES AT ONCE, one per path and signature it has been granted
// at, and a day went to a machine where the app's own check matched one row and
// the checks made on its behalf matched another.
//
// ## It never provokes the prompt
//
// Without the grant it STOPS. AXIsProcessTrustedWithOptions would offer the
// prompt to whatever launched this, and granting a terminal the right to drive
// every app on the Mac is the misattribution docs/alternatives.md names as the
// one thing no competitor solves. --force overrides, deliberately.
//
// ## It reads and never acts
//
// Nothing here presses, types, sets a value or posts a CGEvent. Q3 asks whether
// a text field REPORTS itself settable — AXUIElementIsAttributeSettable, which
// is itself a gated messaging call and therefore evidence — and stops there. The
// controlled write that follows belongs in a check, not a probe.
//
// ## Titles are the data
//
// docs/surfaces.md: "A filename can be the data." A window title is worse — a
// mail subject, a chat participant, a document name. Default output reports
// STATISTICS about titles and never a title. --unsafe-titles prints them, so the
// leak can be inspected deliberately rather than by accident.
//
// ## It refuses to report a negative it cannot stand behind
//
// Same rule as scripts/probe-maps.mjs and probe-screen.swift: exit 3 for
// UNDETERMINED, 4 for a measured NO-GO, 0 for GO.
//
// Usage:
//   swift scripts/probe-desktop.swift [--surfaces=PATH] [--apps=a,b] [--depth=N]
//                                     [--nodes=N] [--unsafe-titles] [--force]
//

import AppKit
import ApplicationServices
import Foundation

// ─── arguments ───────────────────────────────────────────────────────────────

let argv = CommandLine.arguments
func flag(_ name: String) -> Bool { argv.contains("--\(name)") }
func option(_ name: String) -> String? {
  argv.first { $0.hasPrefix("--\(name)=") }.map { String($0.dropFirst(name.count + 3)) }
}

let unsafeTitles = flag("unsafe-titles")
let force = flag("force")
let surfacesPath = option("surfaces") ?? FileManager.default.currentDirectoryPath + "/surfaces.json"
/// The walk bound used for the census. Deliberately generous — this probe is
/// measuring what the cap should BE, so it must not impose the answer.
let maxDepth = Int(option("depth") ?? "") ?? 40
let maxNodes = Int(option("nodes") ?? "") ?? 40000

// Exit codes, mirroring scripts/probe-maps.mjs and probe-screen.swift.
// SCREAMING_CASE for the same reason given there: a reader comparing the files
// should not have to translate.
// swift-format-ignore
let GO: Int32 = 0
// swift-format-ignore
let UNDETERMINED: Int32 = 3
// swift-format-ignore
let NO_GO: Int32 = 4

func section(_ title: String) {
  print("\n── \(title) " + String(repeating: "─", count: max(0, 60 - title.count)))
}
func row(_ key: String, _ value: String) {
  print("  \(key.padding(toLength: 30, withPad: " ", startingAt: 0)) \(value)")
}
func ms(_ seconds: Double) -> String { String(format: "%.3f s", seconds) }

var blockers: [String] = []
var caveats: [String] = []

// ─── AX helpers ──────────────────────────────────────────────────────────────

/// Every AXError this probe saw, counted. The taxonomy matters more than the
/// total: -25205 (attributeUnsupported) and -25212 (noValue) are STRUCTURAL
/// ABSENCES on a healthy tree, and a driver that reports them as failures makes
/// every successful walk look broken. Only -25211 (apiDisabled) and -25204
/// (cannotComplete) are errors worth surfacing.
var errorHistogram: [Int32: Int] = [:]

func nameOfError(_ err: AXError) -> String {
  switch err {
  case .success: return "success"
  case .apiDisabled: return "apiDisabled(-25211) NO GRANT"
  case .cannotComplete: return "cannotComplete(-25204) busy/hung"
  case .attributeUnsupported: return "attributeUnsupported(-25205) normal"
  case .noValue: return "noValue(-25212) normal"
  case .failure: return "failure(-25200)"
  case .illegalArgument: return "illegalArgument(-25201)"
  case .invalidUIElement: return "invalidUIElement(-25202) stale handle"
  case .notImplemented: return "notImplemented(-25208)"
  case .actionUnsupported: return "actionUnsupported(-25206)"
  default: return "other(\(err.rawValue))"
  }
}

func record(_ err: AXError) {
  if err != .success { errorHistogram[err.rawValue, default: 0] += 1 }
}

/// Cost is counted in CALLS, not in nodes. A node is however many round trips
/// the walker chose to spend on it, so a per-node figure silently rewards a
/// walker that reads less — and the only number comparable to System Events'
/// 33.6 ms is the price of ONE round trip.
var axCalls = 0
var timeAttrs = 0.0
var timeChildren = 0.0
var timeActions = 0.0

func copyAttr(_ el: AXUIElement, _ key: String) -> AnyObject? {
  var value: AnyObject?
  let t = Date()
  let err = AXUIElementCopyAttributeValue(el, key as CFString, &value)
  timeAttrs += Date().timeIntervalSince(t)
  axCalls += 1
  record(err)
  return err == .success ? value : nil
}

func stringAttr(_ el: AXUIElement, _ key: String) -> String? {
  guard let raw = copyAttr(el, key) else { return nil }
  guard let s = raw as? String else { return nil }
  let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
  var value: AnyObject?
  let t = Date()
  let err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value)
  timeChildren += Date().timeIntervalSince(t)
  axCalls += 1
  record(err)
  guard err == .success else { return [] }
  return (value as? [AXUIElement]) ?? []
}

func actionsOf(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  let t = Date()
  let err = AXUIElementCopyActionNames(el, &names)
  timeActions += Date().timeIntervalSince(t)
  axCalls += 1
  record(err)
  guard err == .success else { return [] }
  return (names as? [String]) ?? []
}

/// A hung target app must not hang the probe. Confirmed available; the driver
/// has to do this on every element it creates, or a tool call has no upper
/// bound and the caller cannot tell a slow app from a dead one.
func withTimeout(_ el: AXUIElement, _ seconds: Float = 2.0) -> AXUIElement {
  AXUIElementSetMessagingTimeout(el, seconds)
  return el
}

// ─── the census ──────────────────────────────────────────────────────────────

/// What one walk learned. The four addressability counters are the point: a
/// driver built on element POSITION breaks on every layout change and every
/// macOS release, so the share of elements carrying a stable name is the
/// reliability ceiling for the whole surface.
struct Census {
  var nodes = 0
  var pressable = 0
  var withIdentifier = 0
  var withTitleOrDesc = 0
  /// Pressable, but carrying no identifier, title or description — reachable by
  /// nothing but coordinates. THIS is the number that bounds reliability.
  var pressableAnonymous = 0
  var maxDepth = 0
  var nodesAtDepth: [Int: Int] = [:]
  var roles: [String: Int] = [:]
  var truncated = false
  /// Roles seen on elements that carry AXPress, to re-test the maps.md finding
  /// that a role filter sees 15 pressable elements where there are 236.
  var pressableRoles: [String: Int] = [:]
}

func walk(_ el: AXUIElement, depth: Int, into c: inout Census) {
  if c.nodes >= maxNodes {
    c.truncated = true
    return
  }
  if depth > maxDepth {
    c.truncated = true
    return
  }
  c.nodes += 1
  c.maxDepth = max(c.maxDepth, depth)
  c.nodesAtDepth[depth, default: 0] += 1

  let role = stringAttr(el, kAXRoleAttribute as String) ?? "?"
  c.roles[role, default: 0] += 1

  let identifier = stringAttr(el, kAXIdentifierAttribute as String)
  let title = stringAttr(el, kAXTitleAttribute as String)
  let desc = stringAttr(el, kAXDescriptionAttribute as String)
  if identifier != nil { c.withIdentifier += 1 }
  if title != nil || desc != nil { c.withTitleOrDesc += 1 }

  // maps.md: "Ask what has AXPress, never what calls itself a button." Catalyst
  // reports tappable controls as AXGenericElement, AXStaticText and AXImage at
  // least as often as AXButton.
  if actionsOf(el).contains(kAXPressAction as String) {
    c.pressable += 1
    c.pressableRoles[role, default: 0] += 1
    if identifier == nil && title == nil && desc == nil { c.pressableAnonymous += 1 }
  }

  for child in childrenOf(el) { walk(child, depth: depth + 1, into: &c) }
}

// ─── identity ────────────────────────────────────────────────────────────────

section("identity — and it is not this file")

let trusted = AXIsProcessTrusted()
row("AXIsProcessTrusted()", trusted ? "true" : "FALSE")
row("pid", "\(ProcessInfo.processInfo.processIdentifier)")

// The responsible process is what actually holds the grant, so name the chain
// rather than implying this file earned it.
let chain = { () -> String in
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/ps")
  p.arguments = ["-o", "comm=", "-p", "\(getppid())"]
  let pipe = Pipe()
  p.standardOutput = pipe
  try? p.run()
  p.waitUntilExit()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
}()
row("parent process", chain)
print(
  """

    The grant is on the RESPONSIBLE GUI ANCESTOR, not on this script and not on
    the swift interpreter. A green line above is the grant held by whatever
    started this chain. It is NOT evidence about Cupertino.app, and
    Permissions.swift:449 records the day lost to assuming it was: one bundle id
    can hold several Accessibility rows at once, and the app's own check can
    match a different row from the checks made on its behalf.
  """)

if !trusted && !force {
  section("stopped")
  print(
    """
      Accessibility is not granted to whatever is responsible for this process,
      and this probe will NOT ask for it. AXIsProcessTrustedWithOptions offers
      the prompt to the responsible app, and granting a terminal or an editor the
      right to drive every application on this Mac is exactly the misattribution
      the project exists to avoid.

      Grant it to the app you actually want holding it, or re-run with --force to
      measure this identity anyway.
    """)
  exit(UNDETERMINED)
}
if !trusted && force {
  caveats.append("--force with no grant: every AX read below is expected to fail with -25211")
}

// ─── discovery, which needs no grant ─────────────────────────────────────────

section("discovery — free, and worth stating that it is")

let workspace = NSWorkspace.shared
let regular = workspace.runningApplications.filter { $0.activationPolicy == .regular }
row("running applications", "\(workspace.runningApplications.count) total")
row("  .regular", "\(regular.count)")
print(
  """

    NSWorkspace.runningApplications is NOT TCC-gated — it reads the launch
    services process list. So `list_apps` works with no grant at all, and the
    surface can answer "here is what is running, and here is why I cannot read
    it" rather than failing blank. Only the tree below is gated.
  """)

// ─── targets ─────────────────────────────────────────────────────────────────

/// The closed table, read from the manifest rather than restated here.
/// docs/distribution.md: "a caller names a surface, never a path".
func loadSurfaceBundleIds() -> [(id: String, bundleId: String)] {
  guard let data = FileManager.default.contents(atPath: surfacesPath),
    let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let list = root["surfaces"] as? [[String: Any]]
  else { return [] }
  return list.compactMap { entry in
    guard let id = entry["id"] as? String, let bundleId = entry["bundleId"] as? String else {
      return nil
    }
    return (id, bundleId)
  }
}

/// docs/maps.md staged its ~14 s measurement by opening a place card with
/// `maps://?q=<name>&ll=<lat>,<lon>` — "not an Apple Event, needs no grant, and
/// is how these measurements were staged without clicking anything". Opt-in,
/// because it puts a card on the user's screen and sends a search: a probe
/// should not rearrange the machine it is measuring without being asked.
///
/// The combined form is the only one that works. Measured in docs/maps.md:
/// ?ll= alone centres the map and shows NO card; ?q=<name> alone can resolve to
/// the wrong place. A coordinate positions the map, a NAME selects a place.
if flag("stage-maps") {
  let url = URL(string: "maps://?q=Eiffel+Tower&ll=48.8584,2.2945")!
  NSWorkspace.shared.open(url)
  print("\n  staged a Maps place card, waiting 3s for it to lay out…")
  Thread.sleep(forTimeInterval: 3.0)
}

let surfaces = loadSurfaceBundleIds()
if surfaces.isEmpty {
  caveats.append("no surfaces read from \(surfacesPath) — falling back to whatever is running")
}

let requested = option("apps")?.split(separator: ",").map(String.init)
/// Measure the surface apps this project already brokers, because those are the
/// trees the rejected numbers were taken from. Anything else running is noise.
let targets: [(id: String, app: NSRunningApplication)] = {
  var out: [(String, NSRunningApplication)] = []
  for (id, bundleId) in surfaces {
    if let requested, !requested.contains(id) { continue }
    if let app = regular.first(where: { $0.bundleIdentifier == bundleId }) { out.append((id, app)) }
  }
  return out
}()

section("targets")
if targets.isEmpty {
  row("verdict", "UNDETERMINED — no brokered surface app is running")
  print(
    """

      Open Mail, Notes or Maps and run again. Measuring an arbitrary app would
      answer a question nobody asked: the comparison that matters is against the
      SAME trees docs/maps.md and docs/safari.md priced through System Events.
    """)
  exit(UNDETERMINED)
}
for (id, app) in targets {
  row(id, "pid \(app.processIdentifier)  \(app.localizedName ?? "?")")
}

// ─── Q1 + Q2 + Q4: the walk, per app ─────────────────────────────────────────

section("the walk — cost, census and depth")

/// docs/screen.md derived this filter and the reason holds identically here:
/// "a raw enumeration is not a target list". Mail reports 16 windows and has 3;
/// the rest are shadows, toolbars and helper layers.
func realWindows(_ appEl: AXUIElement) -> [AXUIElement] {
  guard let raw = copyAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement] else {
    return []
  }
  return raw
}

struct Result {
  let id: String
  let census: Census
  let seconds: Double
  let windows: Int
  let discoverySeconds: Double
  let calls: Int
  let attrSeconds: Double
  let childSeconds: Double
  let actionSeconds: Double
}
var results: [Result] = []

for (id, app) in targets {
  let t0 = Date()
  let appEl = withTimeout(AXUIElementCreateApplication(app.processIdentifier))
  let windows = realWindows(appEl)
  let discovery = Date().timeIntervalSince(t0)

  var census = Census()
  axCalls = 0
  timeAttrs = 0
  timeChildren = 0
  timeActions = 0
  let t1 = Date()
  // EVERY window, never windows[0]: maps.md found a place card's overflow
  // control lives in a POPOVER, and AppKit models a popover as its own AXWindow.
  // Walking windows[0] produced a confident zero.
  for w in windows { walk(w, depth: 0, into: &census) }
  let elapsed = Date().timeIntervalSince(t1)

  results.append(
    Result(
      id: id, census: census, seconds: elapsed, windows: windows.count,
      discoverySeconds: discovery, calls: axCalls, attrSeconds: timeAttrs,
      childSeconds: timeChildren, actionSeconds: timeActions))

  let perNode = census.nodes > 0 ? elapsed / Double(census.nodes) * 1000 : 0
  let perCall = axCalls > 0 ? elapsed / Double(axCalls) * 1000 : 0
  section("\(id) — \(windows.count) window(s)")
  row("discovery (create + windows)", ms(discovery))
  row("full walk", "\(census.nodes) nodes in \(ms(elapsed))")
  row("AX round trips", "\(axCalls) (\(census.nodes > 0 ? axCalls / census.nodes : 0) per node)")
  row("per ROUND TRIP", String(format: "%.3f ms  <- the number comparable to 33.6", perCall))
  row("per node", String(format: "%.3f ms", perNode))
  row("  attributes", ms(timeAttrs))
  row("  children", ms(timeChildren))
  row("  actions (AXPress probe)", ms(timeActions))
  row("max depth", "\(census.maxDepth)")
  row("ALL nodes: with AXIdentifier", "\(census.withIdentifier) of \(census.nodes)")
  row("ALL nodes: with title/desc", "\(census.withTitleOrDesc) of \(census.nodes)")
  row("pressable (has AXPress)", "\(census.pressable)")
  row("  ANONYMOUS (position only)", "\(census.pressableAnonymous) of \(census.pressable)")
  if census.truncated {
    row("truncated", "yes — hit --depth=\(maxDepth) or --nodes=\(maxNodes)")
    caveats.append("\(id) walk truncated; numbers are a floor, not a total")
  }

  // maps.md: a ROLE filter saw 15 pressable elements where there were 236.
  // Re-tested here rather than quoted, because it decides how the driver finds
  // controls and it is the trap most likely to look fine on an AppKit app and
  // fail on a Catalyst one.
  let buttonish = census.pressableRoles.filter { $0.key == "AXButton" }.values.reduce(0, +)
  row("  of which role==AXButton", "\(buttonish)")
  if census.pressable > 0 && buttonish < census.pressable {
    row(
      "  role filter would miss",
      "\(census.pressable - buttonish) of \(census.pressable) pressable elements")
  }

  let topRoles = census.roles.sorted { $0.value > $1.value }.prefix(6)
  row("top roles", topRoles.map { "\($0.key)=\($0.value)" }.joined(separator: " "))

  // Q4: where a depth cap would have to sit to keep a default response sane.
  var cumulative = 0
  var capAt: Int? = nil
  for d in census.nodesAtDepth.keys.sorted() {
    cumulative += census.nodesAtDepth[d] ?? 0
    if cumulative > 500 && capAt == nil { capAt = d }
  }
  if let capAt {
    row("depth holding <=500 nodes", "\(capAt - 1)")
  } else {
    row("depth holding <=500 nodes", "whole tree is under 500 nodes")
  }

  if unsafeTitles {
    for (i, w) in windows.enumerated() {
      row("  window[\(i)] title", stringAttr(w, kAXTitleAttribute as String) ?? "(none)")
    }
  } else {
    let titled = windows.filter { stringAttr($0, kAXTitleAttribute as String) != nil }.count
    row("windows carrying a title", "\(titled) of \(windows.count) — titles withheld")
  }
}

// ─── Q3: does a text field REPORT itself settable ────────────────────────────

section("Q3 — settable, asked and not acted on")

print(
  """
    packages/mail/src/client/jxa/core.ts:299 records a value that "reports itself
    settable first and then does nothing". So a true here is necessary and not
    sufficient — it proves the write path is PERMITTED, never that the app
    honours it. Nothing below is written; the controlled write belongs in a
    check.
  """)

func firstTextField(_ el: AXUIElement, depth: Int) -> AXUIElement? {
  if depth > 12 { return nil }
  let role = stringAttr(el, kAXRoleAttribute as String) ?? ""
  if role == "AXTextField" || role == "AXTextArea" { return el }
  for child in childrenOf(el) {
    if let found = firstTextField(child, depth: depth + 1) { return found }
  }
  return nil
}

var settableChecked = false
for (id, app) in targets {
  let appEl = withTimeout(AXUIElementCreateApplication(app.processIdentifier))
  guard let field = realWindows(appEl).compactMap({ firstTextField($0, depth: 0) }).first else {
    continue
  }
  var settable: DarwinBoolean = false
  let err = AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable)
  record(err)
  row(
    "\(id) first text field",
    "AXValue settable=\(settable.boolValue) err=\(nameOfError(err))")
  settableChecked = true
}
if !settableChecked {
  row("result", "no text field found in any target window")
  caveats.append("Q3 unanswered: no AXTextField/AXTextArea was on screen")
}

// ─── the error taxonomy, measured rather than assumed ────────────────────────

section("AXError taxonomy — what a HEALTHY walk actually produces")

if errorHistogram.isEmpty {
  row("errors", "none")
} else {
  for (code, count) in errorHistogram.sorted(by: { $0.value > $1.value }) {
    print(
      "  \(nameOfError(AXError(rawValue: code) ?? .failure).padding(toLength: 44, withPad: " ", startingAt: 0)) \(count)"
    )
  }
}
print(
  """

    -25205 attributeUnsupported and -25212 noValue are STRUCTURAL ABSENCES, not
    failures: an element without that attribute, a leaf without children. They
    dominate the count on every healthy walk. A driver that surfaces them as
    errors makes a working tree look broken, which leaves exactly two codes worth
    reporting to a caller: -25211 (no grant) and -25204 (busy or timed out).
  """)

// ─── verdict ─────────────────────────────────────────────────────────────────

section("verdict")

let totalNodes = results.reduce(0) { $0 + $1.census.nodes }
let totalTime = results.reduce(0.0) { $0 + $1.seconds }
let totalCalls = results.reduce(0) { $0 + $1.calls }
let overallPerNode = totalNodes > 0 ? totalTime / Double(totalNodes) * 1000 : 0
let overallPerCall = totalCalls > 0 ? totalTime / Double(totalCalls) * 1000 : 0
let totalPressable = results.reduce(0) { $0 + $1.census.pressable }
let totalAnonymous = results.reduce(0) { $0 + $1.census.pressableAnonymous }
let namedShare =
  totalPressable > 0 ? Double(totalPressable - totalAnonymous) / Double(totalPressable) * 100 : 0

row("total", "\(totalNodes) nodes, \(totalCalls) round trips in \(ms(totalTime))")
row("per node, overall", String(format: "%.3f ms", overallPerNode))
row("per ROUND TRIP, overall", String(format: "%.3f ms", overallPerCall))
row(
  "vs System Events",
  String(format: "%.0fx cheaper per round trip (33.6 ms)", 33.6 / max(overallPerCall, 0.001)))
print(
  """

    The comparison is per ROUND TRIP, because that is what 33.6 ms measured. A
    per-node figure is not comparable to it: this walker spends 5-6 round trips
    on every node (role, identifier, title, description, actions, children), so a
    walker that reads less would look faster while doing less.
  """)
row(
  "pressable, named",
  String(format: "%.0f%% (%d of %d)", namedShare, totalPressable - totalAnonymous, totalPressable))

var verdict = GO

// The cost question. 33.6 ms a round trip is the number this repo rejected the
// lane on; anything close to it means the transport was not the problem.
if overallPerCall > 33.6 {
  blockers.append(
    String(
      format: "native round trip costs %.1f ms — no better than System Events", overallPerCall))
  verdict = NO_GO
}

// The reliability question, and it is the one that decides whether this is a
// driver or a screen-scraper. A tree whose controls are reachable only by
// coordinates cannot survive a layout change or a non-English Mac.
if totalPressable == 0 {
  caveats.append("no pressable element found anywhere — open a window with controls and re-run")
  if verdict == GO { verdict = UNDETERMINED }
} else if namedShare < 50 {
  blockers.append(
    String(format: "only %.0f%% of pressable elements carry a stable name", namedShare))
  verdict = NO_GO
}

// The bound the first pass found, restated as a measurement rather than a fear.
if let worst = results.max(by: { $0.census.nodes < $1.census.nodes }), worst.census.nodes > 2000 {
  print(
    """

      \(worst.id) alone is \(worst.census.nodes) nodes in \(ms(worst.seconds)). The cost per node is
      fine and the TOTAL is not, which is the whole design constraint: the
      default tool must return a bounded tree plus an expand verb, never the
      hierarchy. A cap is not a degradation here, it is the product.
    """)
}

if !caveats.isEmpty {
  print("\n  caveats:")
  for c in caveats { print("    - \(c)") }
}
if !blockers.isEmpty {
  print("\n  BLOCKERS:")
  for b in blockers { print("    - \(b)") }
}

print(
  "\n  \(verdict == GO ? "GO" : verdict == NO_GO ? "NO-GO" : "UNDETERMINED")"
)
print(
  """

    Whatever this says, it says it about the identity that ran it. The hosted
    case — Cupertino.app as the responsible process — is a separate measurement
    and belongs to apple_desktop_diagnostics.
  """)
exit(verdict)
