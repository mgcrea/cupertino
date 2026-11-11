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

  static func verdict(before: String, after: String, typed: String) -> Verdict {
    guard after != before else { return .nothingLanded }
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
