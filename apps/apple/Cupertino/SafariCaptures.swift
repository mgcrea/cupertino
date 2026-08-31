import Foundation

/// What the Safari extension has written, as a fact about this Mac.
///
/// Foundation only, and no reference to the rest of the app — the same
/// constraint `CallCapture` is written under and for the same reason. The Xcode
/// project has synchronized-group targets and no shared schemes, so a test
/// target means hand-editing `project.pbxproj`; a file that compiles on its own
/// can be asserted by `scripts/unit-check.swift` through `make unit` instead.
///
/// It is worth that constraint here because the edge cases are the interesting
/// part: an empty directory, a directory that does not exist at all, a file
/// written by an older extension with a different shape, and a capture old
/// enough that reporting it without comment would be a lie.
///
/// ## Why this is measured at all
///
/// `Permissions.safariExtension()` reports a SWITCH, and a switch that is on
/// proves nothing on its own — Safari grants the extension one website at a
/// time, so "enabled" and "never allowed anywhere" are the same picture. This
/// is what separates them, and it is the difference between the Safari pane and
/// the Settings row it would otherwise duplicate.
struct SafariCaptures: Equatable {
  let count: Int
  /// Age of the freshest capture. `nil` when there are none.
  let newestAge: TimeInterval?

  static let none = SafariCaptures(count: 0, newestAge: nil)

  /// How long the extension keeps a capture before pruning it.
  ///
  /// The THIRD copy of this number, and the two others cannot be imported:
  /// `SafariWebExtensionHandler.ttl` is private to the appex target, and
  /// `QUIET_AFTER_SECONDS` in `packages/safari/src/client/pages.ts` is in
  /// another language. That file already explains what drift costs — report
  /// quiet while entries are still being kept, or stay silent about a store
  /// that has stopped being written. Change one, change all three.
  static let ttl: TimeInterval = 30 * 60

  /// Nothing recent.
  ///
  /// Says the captures are old and deliberately does not say why. Switched off,
  /// or allowed on no site visited since, cannot be told apart from a directory
  /// listing — the same restraint `apple_safari_diagnostics` applies to the
  /// same measurement.
  var isQuiet: Bool {
    guard let newestAge else { return false }
    return newestAge > Self.ttl
  }

  /// Blocking: it enumerates a directory and reads one file. Never call it on
  /// the main actor — the rule `StatusModel.refreshAutomation` documents with a
  /// measured run-loop freeze.
  ///
  /// A missing directory and an empty one both yield zero, and the caller wants
  /// that: the extension creates it on its first write, so "not there" and
  /// "there and empty" are the same answer — nothing has been captured.
  static func read(directory: URL, now: Date = Date()) -> SafariCaptures {
    guard
      let entries = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles])
    else { return .none }

    let files = entries.filter { $0.pathExtension == "json" }
    guard let newest = files.max(by: { modified($0) < modified($1) })
    else { return SafariCaptures(count: files.count, newestAge: nil) }

    // ONE file is read, not all of them: a capture can be a megabyte and there
    // can be twenty, and the only thing wanted here is the freshest timestamp.
    //
    // `capturedAt` rather than the mtime it was picked by, because that is the
    // value `apple_safari_diagnostics` reports off the same directory. A pane
    // and a tool disagreeing about how old the same capture is would be a bug
    // with no symptom other than mistrust. mtime is the fallback, not the
    // answer — it moves for reasons that have nothing to do with when a page
    // was read, which is the note `pages.ts` carries over its own sort.
    let at = capturedAt(newest) ?? modified(newest)
    return SafariCaptures(
      count: files.count, newestAge: max(0, now.timeIntervalSince(at)))
  }

  /// The extension's own timestamp, or nil if this file is not one of ours.
  ///
  /// Tolerant by construction, for the reason `readPages` gives on the other
  /// side of this hand-off: the store is written by a component that updates on
  /// its own schedule, so one unreadable entry must never take down the row.
  private static func capturedAt(_ url: URL) -> Date? {
    guard let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data),
      let entry = object as? [String: Any],
      let stamp = entry["capturedAt"] as? String
    else { return nil }
    return ISO8601DateFormatter().date(from: stamp)
  }

  private static func modified(_ url: URL) -> Date {
    (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
      ?? .distantPast
  }
}
