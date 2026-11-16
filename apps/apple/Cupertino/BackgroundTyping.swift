import Foundation

/// Whether text typed into a field in the BACKGROUND landed, as a pure function.
///
/// `apple_desktop_type` with a handle first posts the text to the field's
/// application by pid, which measured as landing without the application coming
/// forward (`scripts/spike-background-input.swift`: AppKit, SwiftUI and
/// TextEdit). Not every field takes it, so the field's value is read back, and
/// only a field that did not change is typed again in front.
///
/// That fallback is the risk. A wrong "nothing landed" types the text twice,
/// which is why a field that changed at all counts as landed, even when it did
/// not take the whole text, and why a field whose value cannot be read back is
/// never typed in the background in the first place.
///
/// No dependency, so `make unit` pins it.
nonisolated enum BackgroundTyping {

  enum Verdict: Equatable {
    /// The field changed. `verified` when it now holds one more copy of the
    /// typed text than it did before.
    case landed(verified: Bool)
    /// The field did not change: nothing was taken, so typing again in front
    /// cannot double it.
    case nothingLanded
  }

  /// `after` is nil when the value could not be read: unknown is not
  /// "nothing", so it is never a reason to type again. `selectionMoved` is
  /// whether the field's selected range changed: focusing an NSTextField
  /// through AX selects all of it, so typing the text it already holds
  /// replaces it with itself and only the selection shows it.
  static func verdict(before: String, after: String?, typed: String, selectionMoved: Bool = false)
    -> Verdict
  {
    guard let after else { return .landed(verified: false) }
    guard after != before else {
      return selectionMoved ? .landed(verified: after.contains(typed)) : .nothingLanded
    }
    let verified =
      !typed.isEmpty && occurrences(of: typed, in: after) > occurrences(of: typed, in: before)
    return .landed(verified: verified)
  }

  /// Whether a field can be typed into in the background at all.
  ///
  /// It needs a string value to read back. A secure field reads empty or as
  /// bullets whatever it holds, so it would always look as if nothing landed
  /// and be typed a second time in front.
  static func eligible(role: String?, subrole: String?, value: Any?) -> Bool {
    guard value is String else { return false }
    return subrole != "AXSecureTextField"
  }

  /// What a field holds once `text` is typed into `value` with `range`
  /// selected: the selection replaced, or the text at the caret when the
  /// selection is empty. For a field no key reaches, which is written by value
  /// instead (`AccessibilityDriver.typeByValue`).
  ///
  /// `range` is in UTF-16 units, as Accessibility's `AXSelectedTextRange` is.
  /// Nil, unreadable, is the end of the field. A range past the end is clamped
  /// to it, and an end that falls inside a character moves past it, so a
  /// stale range never traps or splits an emoji.
  static func inserting(
    _ text: String, into value: String, at range: (location: Int, length: Int)?
  ) -> String {
    guard let range else { return value + text }
    let units = value.utf16
    func index(_ offset: Int) -> String.Index {
      let clamped = min(max(0, offset), units.count)
      // Rounded up to the next character boundary; the end is always one.
      var at = units.index(units.startIndex, offsetBy: clamped)
      while String.Index(at, within: value) == nil { at = units.index(after: at) }
      return at
    }
    let start = index(range.location)
    let end = max(start, index(range.location + max(0, range.length)))
    return String(value[..<start]) + text + String(value[end...])
  }

  /// Non-overlapping, so "abcabc" holds "abc" twice and "aaa" holds "aa" once.
  private static func occurrences(of needle: String, in haystack: String) -> Int {
    var count = 0
    var rest = haystack[...]
    while let found = rest.range(of: needle) {
      count += 1
      rest = rest[found.upperBound...]
    }
    return count
  }
}
