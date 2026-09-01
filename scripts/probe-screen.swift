/*
 * Phase-0 probe: can Cupertino capture a surface's window, and at what cost?
 *
 * docs/surfaces.md: "Start with a probe, not a package." This is that probe for
 * the proposed `screen` surface. It is Swift rather than .mjs because
 * ScreenCaptureKit is unreachable from node — which is itself one of the
 * findings that decides the architecture.
 *
 * ## Read the two identities separately
 *
 * TCC attributes screen capture to the RESPONSIBLE PROCESS, so this binary
 * answers a different question depending on who runs it:
 *
 *   swift scripts/probe-screen.swift        responsible = your terminal
 *   scripts/spike-app-tcc/build.sh run      responsible = the signed .app
 *
 * The second is the one the design depends on. scripts/spike-app-tcc/README.md
 * measured exactly this inheritance for Full Disk Access and Apple Events, the
 * codebase generalised it to every TCC service, and it was WRONG for
 * Accessibility — a day was lost to it. So Screen Recording is measured here
 * rather than inherited from that verdict.
 *
 * ## Two answers that are allowed to disagree
 *
 * Same shape as `trusted` vs `uiRead` in the accessibility lane of
 * spike.sh.in. `CGPreflightScreenCaptureAccess()` is a CLAIM about an identity;
 * enumerating windows is the thing the feature actually does. A green flag over
 * a blind enumeration is a real state on a machine that has run the app from
 * two paths (README: "One identifier, four grants"), and reporting only the
 * flag would hide it.
 *
 * ## Titles are the data
 *
 * docs/surfaces.md: "A filename can be the data." Window titles are worse — a
 * mail subject, a chat participant, a document name. So the default output
 * reports STATISTICS about titles and never a title. `--unsafe-titles` prints
 * them, and exists so the leak can be inspected deliberately rather than by
 * accident.
 *
 * ## It refuses to report a negative it cannot stand behind
 *
 * scripts/probe-maps.mjs exits 3 rather than printing a result it cannot
 * support, after "no file lane" was declared three times about a store that was
 * there. Same rule: exit 3 for UNDETERMINED, 4 for a measured NO-GO, 0 for GO.
 *
 * Usage:
 *   swift scripts/probe-screen.swift [--surfaces=PATH] [--out=DIR] [--unsafe-titles] [--force]
 *
 * Without a grant it STOPS rather than prompt: the prompt would be attributed to
 * whatever launched it, and granting Screen Recording to a terminal is the
 * misattribution the whole project exists to avoid. --force overrides.
 */

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// ─── arguments ───────────────────────────────────────────────────────────────

let argv = CommandLine.arguments
func flag(_ name: String) -> Bool { argv.contains("--\(name)") }
func option(_ name: String) -> String? {
  argv.first { $0.hasPrefix("--\(name)=") }.map { String($0.dropFirst(name.count + 3)) }
}

let unsafeTitles = flag("unsafe-titles")
let force = flag("force")
let surfacesPath = option("surfaces") ?? FileManager.default.currentDirectoryPath + "/surfaces.json"
let outDir = URL(fileURLWithPath: option("out") ?? NSTemporaryDirectory() + "cupertino-probe-screen")

// Exit codes, mirroring scripts/probe-maps.mjs.
let GO: Int32 = 0
let UNDETERMINED: Int32 = 3
let NO_GO: Int32 = 4

func section(_ title: String) { print("\n── \(title) " + String(repeating: "─", count: max(0, 60 - title.count))) }
func row(_ key: String, _ value: String) { print("  \(key.padding(toLength: 26, withPad: " ", startingAt: 0)) \(value)") }

// ─── the surface allowlist ───────────────────────────────────────────────────

/// The closed table, read from the manifest rather than restated here.
/// docs/distribution.md: "a caller names a surface, never a path".
func loadSurfaces() -> [(id: String, bundleId: String)]? {
  guard let data = FileManager.default.contents(atPath: surfacesPath),
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let list = root["surfaces"] as? [[String: Any]]
  else { return nil }
  return list.compactMap { entry in
    guard let id = entry["id"] as? String, let bundleId = entry["bundleId"] as? String else { return nil }
    return (id, bundleId)
  }
}

// ─── image helpers ───────────────────────────────────────────────────────────

func writePNG(_ image: CGImage, to url: URL) -> Int? {
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { return nil }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int
}

/// A blank or solid-black capture is what a failed window grab looks like — it
/// does not throw, it returns pixels. Counting distinct colours in a downsample
/// separates "captured something" from "captured nothing" without a human.
/// It does NOT prove the pixels are the right window; question 4 needs eyes.
func distinctColours(_ image: CGImage, side: Int = 32) -> Int {
  // The context must outlive the closure that vends a pointer into an array,
  // so the buffer is allocated outright rather than borrowed from one.
  let count = side * side
  let buf = UnsafeMutablePointer<UInt32>.allocate(capacity: count)
  buf.initialize(repeating: 0, count: count)
  defer { buf.deinitialize(count: count); buf.deallocate() }

  guard let ctx = CGContext(data: buf, width: side, height: side, bitsPerComponent: 8,
                            bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return -1 }
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
  return Set(UnsafeBufferPointer(start: buf, count: count)).count
}


/// How much of a window was covered by other apps at capture time.
///
/// Q4 was going to be an eyeball check, which is both unreliable and a reason to
/// open the user's actual mail. It does not have to be: CGWindowListCopyWindowInfo
/// returns on-screen windows FRONT TO BACK, so everything listed before the
/// target is in front of it. Sampling a grid over the target's frame gives the
/// covered fraction, and a window that was 70% covered and still captured its own
/// content has answered the question without anyone looking at a screenshot.
func coveredFraction(of window: SCWindow, side: Int = 64) -> Double? {
  guard let infos = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }

  let target = window.frame
  guard target.width > 0, target.height > 0 else { return nil }

  var covering: [CGRect] = []
  var foundTarget = false
  for info in infos {
    guard let wid = info[kCGWindowNumber as String] as? CGWindowID else { continue }
    if wid == window.windowID { foundTarget = true; break }
    guard let owner = info[kCGWindowOwnerPID as String] as? pid_t,
          owner != window.owningApplication?.processID,
          let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: boundsDict) else { continue }
    let overlap = rect.intersection(target)
    if !overlap.isNull, overlap.width > 0, overlap.height > 0 { covering.append(overlap) }
  }
  // Not on the on-screen list at all: report nothing rather than a zero that
  // would read as "was fully visible".
  guard foundTarget else { return nil }
  if covering.isEmpty { return 0 }

  var hits = 0
  for i in 0..<side {
    for j in 0..<side {
      let pt = CGPoint(x: target.minX + (Double(i) + 0.5) / Double(side) * target.width,
                       y: target.minY + (Double(j) + 0.5) / Double(side) * target.height)
      if covering.contains(where: { $0.contains(pt) }) { hits += 1 }
    }
  }
  return Double(hits) / Double(side * side)
}

// ─── the probe ───────────────────────────────────────────────────────────────

@available(macOS 14.0, *)
func runProbe() async -> Int32 {
  var verdict: Int32 = GO
  var blockers: [String] = []
  var caveats: [String] = []

  // ── Identity: who is TCC actually going to attribute this to? ──────────────
  section("identity")
  let pid = ProcessInfo.processInfo.processIdentifier
  row("pid", "\(pid)")
  row("executable", ProcessInfo.processInfo.arguments.first ?? "?")
  row("bundle identifier", Bundle.main.bundleIdentifier ?? "(none — a bare executable)")
  print("""

    TCC keys on the RESPONSIBLE process, which is not necessarily this one.
    Confirm it before trusting anything below:
        sudo launchctl procinfo \(pid) | grep -i responsible
  """)

  // ── The flag, and then the thing itself ───────────────────────────────────
  section("permission")
  let claimed = CGPreflightScreenCaptureAccess()
  row("CGPreflightScreenCaptureAccess", claimed ? "granted" : "denied")

  // Stop here rather than provoke the prompt. Reaching SCShareableContent
  // without a grant makes macOS offer one — to the RESPONSIBLE process, which
  // from a terminal is the editor that launched it. Granting Screen Recording
  // to VS Code is the exact misattribution docs/alternatives.md names as the
  // one thing no competitor solves, and a probe must not cause it by accident.
  if !claimed && !force {
    print("""

      This identity has no Screen Recording grant, and continuing would ask for
      one. The prompt would name the RESPONSIBLE process — from a terminal that
      is your editor, not Cupertino, which is the misattribution this project
      exists to avoid.

      If you are reading this from INSIDE the spike bundle, the responsible
      process is the app and the prompt would name it — that is the measurement,
      not a hazard. Pass --force (spike.sh does).

      From a terminal, grant it to the app by hand instead, so nothing lands on
      the editor:
          open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture"

      Screen Recording takes effect on RELAUNCH, so quit and re-run afterwards.
    """)
    return UNDETERMINED
  }

  var content: SCShareableContent?
  var enumerationError: NSError?
  do {
    // onScreenWindowsOnly: false — an occluded or minimised window has to be
    // visible to the enumeration or question 4 cannot even be asked.
    content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
  } catch {
    enumerationError = error as NSError
  }

  if let err = enumerationError {
    let declined = err.code == -3801
    row("SCShareableContent", "DENIED — \(err.domain) \(err.code)\(declined ? " (userDeclined)" : "")")
    print("""

      The enumeration is the capability; the flag is a claim about it.
      \(claimed
        ? "The flag says granted and the enumeration is blind. That is the\n      \"One identifier, four grants\" state from scripts/spike-app-tcc/README.md —\n      the cure is `tccutil reset ScreenCapture <bundle id>`, never another grant."
        : "Both agree: this identity has no grant. Grant it and run again —\n      this run has measured nothing about ScreenCaptureKit.")
    """)
    return UNDETERMINED
  }

  guard let content else { return UNDETERMINED }
  row("SCShareableContent", "ok")
  if !claimed {
    caveats.append("flag said denied while enumeration succeeded — the two disagree, investigate before trusting either")
  }

  // ── Q6: what does enumeration leak? ───────────────────────────────────────
  section("Q6 — enumeration leak")
  let windows = content.windows
  let titled = windows.filter { !($0.title ?? "").isEmpty }
  let lengths = titled.compactMap { $0.title?.count }
  row("displays", "\(content.displays.count)")
  row("windows", "\(windows.count)")
  row("windows with a title", "\(titled.count)")
  row("title length max / mean", lengths.isEmpty
    ? "—"
    : "\(lengths.max() ?? 0) / \(lengths.reduce(0, +) / lengths.count)")
  row("applications", "\(content.applications.count)")
  if !titled.isEmpty {
    caveats.append("enumeration exposes \(titled.count) window titles — a mail subject, a chat name, a document. list_targets must not return them by default.")
  }
  if unsafeTitles {
    print("\n  --unsafe-titles: printing what the enumeration can see.\n")
    for w in titled.prefix(40) {
      print("    [\(w.owningApplication?.bundleIdentifier ?? "?")] \(w.title ?? "")")
    }
  } else {
    print("\n  Titles withheld. Re-run with --unsafe-titles to inspect the leak deliberately.")
  }

  // ── The closed table: which surfaces are actually capturable? ─────────────
  section("targets — the closed table")
  guard let surfaces = loadSurfaces() else {
    print("  could not read \(surfacesPath) — pass --surfaces=PATH")
    return UNDETERMINED
  }
  var capturable: [(surface: String, window: SCWindow)] = []
  for s in surfaces {
    let all = windows.filter { $0.owningApplication?.bundleIdentifier == s.bundleId }
    // A raw enumeration is not a target list. Mail reports 16 "windows" on this
    // machine and has one: the rest are shadows, toolbars and helper layers.
    // Real windows sit on layer 0 and have a usable size — a distinction
    // list_targets has to make too, or its count is nonsense to a model.
    // Layer and size are not enough. Three different apps reported an
    // identical 1000x1000 off-screen window that captured as one flat colour —
    // never-drawn helper windows, not hidden documents. A window the app has
    // actually rendered has a title or is on screen.
    let real = all.filter {
      $0.windowLayer == 0 && $0.frame.width >= 100 && $0.frame.height >= 100
        && ($0.isOnScreen || !($0.title ?? "").isEmpty)
    }
    let onScreen = real.filter { $0.isOnScreen }
    let offScreen = real.filter { !$0.isOnScreen }
    row(s.id, all.isEmpty
      ? "no windows (app not running, or windowless)"
      : "\(all.count) raw → \(real.count) real  (\(onScreen.count) on screen, \(offScreen.count) off)")

    let biggest = { (ws: [SCWindow]) in
      ws.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
    }
    // Both, when both exist: the off-screen one is the whole of Q4, and picking
    // purely by area answered it by accident on the first run — every target
    // came back on-screen and the question was silently skipped.
    if let w = biggest(onScreen) { capturable.append((s.id, w)) }
    if let w = biggest(offScreen) { capturable.append((s.id + " [off-screen]", w)) }
  }
  if capturable.isEmpty {
    print("\n  No surface app has a window open. Open Mail (or any surface app) and re-run —")
    print("  a capture probe with nothing to capture has measured nothing.")
    return UNDETERMINED
  }

  // ── Q4 + Q5: does an off-screen window render, and what does it cost? ─────
  section("Q4/Q5 — capture, occlusion and cost")
  try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
  var anyRendered = false
  var offScreenRendered: Bool?
  var occlusionEvidence: [(surface: String, covered: Double, colours: Int)] = []

  for target in capturable {
    let w = target.window
    let cfg = SCStreamConfiguration()
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    cfg.width = max(1, Int(w.frame.width * scale))
    cfg.height = max(1, Int(w.frame.height * scale))
    cfg.showsCursor = false

    // desktopIndependentWindow is the filter that decides the whole feature:
    // if it composites the window itself, capture is passive observation. If it
    // returns whatever is on top, capture would have to RAISE windows, which is
    // a much worse feature and probably a no.
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let started = DispatchTime.now()
    do {
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
      let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6
      let url = outDir.appendingPathComponent("\(target.surface)-\(w.windowID).png")
      let bytes = writePNG(image, to: url)
      let colours = distinctColours(image)
      let rendered = colours > 2
      anyRendered = anyRendered || rendered
      if !w.isOnScreen { offScreenRendered = (offScreenRendered ?? true) && rendered }
      let covered = coveredFraction(of: w)
      row(target.surface, String(format: "%.0f ms  %dx%d  %@  colours=%d  %@  %@",
                                 ms, image.width, image.height,
                                 bytes.map { "\($0 / 1024) KB" } ?? "unwritten",
                                 colours,
                                 w.isOnScreen ? "on screen" : "OFF SCREEN",
                                 covered.map { String(format: "covered=%.0f%%", $0 * 100) } ?? "covered=?"))
      if let c = covered, w.isOnScreen { occlusionEvidence.append((target.surface, c, colours)) }
      if !rendered {
        caveats.append("\(target.surface) captured as a near-solid image (\(colours) colours) — likely blank")
      }
    } catch {
      let err = error as NSError
      let named: String
      switch err.code {
      case -3801: named = " (userDeclined — no grant)"
      case -3802: named = " (failedToStart)"
      case -3803: named = " (missingEntitlements)"
      case -3811: named = " (invalid/unavailable window — it enumerated but will not composite)"
      default: named = ""
      }
      row(target.surface, "FAILED — \(err.domain) \(err.code)\(named)")
      caveats.append("\(target.surface) capture threw \(err.code)\(named) — enumerable is not capturable, so list_targets must not promise a window it cannot grab")
    }
  }

  if !anyRendered {
    blockers.append("no window produced a non-blank capture — SCScreenshotManager returns pixels but not content")
    verdict = NO_GO
  }
  // OFF-SCREEN IS NOT OCCLUDED, and treating them as one thing produced a
  // confident NO-GO on the first run of this probe. SCWindow.isOnScreen is
  // false for a MINIMISED or never-drawn window; a window sitting behind
  // another app is still isOnScreen == true. So a blank off-screen capture is a
  // documented LIMIT — capture cannot resurrect a window the app has not drawn
  // — and says nothing about the question the plan actually asked.
  if let off = offScreenRendered {
    row("off-screen window", off
      ? "rendered — off-screen does not mean blank"
      : "blank — this window was never drawn (off-screen alone does not predict this)")
    if !off {
      caveats.append("an off-screen window captured blank — check the RESULT, never predict it from isOnScreen: a drawn window composites off screen too")
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  section("verdict")
  print("""
    Written to: \(outDir.path)

    Q4 — occlusion — is decided by the covered= column above, not by eye.
    A window that was substantially covered and still returned its own content
    is passive observation, which is the design the plan assumes.
  """)

  let buried = occlusionEvidence.filter { $0.covered >= 0.5 }
  let buriedWithContent = buried.filter { $0.colours > 2 }
  section("Q4 — occlusion, decided")
  if buried.isEmpty {
    row("verdict", "UNANSWERED — no window was 50%+ covered at capture time")
    print("""

      Every target was substantially visible, so this run cannot distinguish
      compositing the window from photographing the screen. Cover a surface app
      with another window — covered, not minimised — and run again.
    """)
    caveats.append("Q4 unanswered: no target was 50%+ covered")
    if verdict == GO { verdict = UNDETERMINED }
  } else if buriedWithContent.count == buried.count {
    row("verdict", "GO — \(buried.count) window(s) 50%+ covered, all returned their own content")
    for b in buried { row("  " + b.surface, String(format: "covered %.0f%%, colours %d", b.covered * 100, b.colours)) }
    print("\n      SCContentFilter composites the window itself. Capture does not have\n      to raise anything, which is the passive-observation property the plan\n      depends on.")
  } else {
    row("verdict", "NO-GO — a covered window did not return its own content")
    for b in buried { row("  " + b.surface, String(format: "covered %.0f%%, colours %d", b.covered * 100, b.colours)) }
    blockers.append("a 50%+ covered window captured blank — capture would have to raise windows")
    verdict = NO_GO
  }
  if !caveats.isEmpty {
    print("\n  caveats:")
    for c in caveats { print("    - \(c)") }
  }
  if !blockers.isEmpty {
    print("\n  BLOCKERS:")
    for b in blockers { print("    - \(b)") }
  }
  print("\n  \(verdict == GO ? "GO — pending the eyeball check above" : "NO-GO")")
  return verdict
}

// ─── entry ───────────────────────────────────────────────────────────────────
// Task + RunLoop rather than a semaphore: blocking the main thread and then
// waiting on ScreenCaptureKit is a deadlock waiting to happen.

if #available(macOS 14.0, *) {
  Task {
    let code = await runProbe()
    exit(code)
  }
  RunLoop.main.run()
} else {
  print("needs macOS 14+ for SCScreenshotManager")
  exit(UNDETERMINED)
}
