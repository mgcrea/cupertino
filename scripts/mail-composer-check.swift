import Foundation

/// Asserts the pure text core of the native Mail composer: how a find/replace
/// edit is located in a draft's own text, and when it is refused.
///
/// Nothing here touches Mail or Accessibility; it is text in, text out.
///
/// Run with `make mail-composer-check`.
@main
struct MailComposerCheck {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  typealias Edit = MailComposerText.Edit

  /// The result of an `.ok` outcome, nil for any refusal.
  static func result(_ edits: [Edit], _ own: String) -> String? {
    if case .ok(let result, _) = MailComposerText.apply(edits, to: own) { return result }
    return nil
  }

  static func main() {
    print("mail-composer-check")

    check(
      "a single edit replaces its match in place",
      result([Edit(find: "two", replace: "2")], "one\ntwo") == "one\n2")
    check(
      "a find spanning a line break matches across paragraphs",
      result([Edit(find: "one two", replace: "x")], "one\ntwo") == "x")
    check(
      "a find matches through a run of blank lines",
      result([Edit(find: "one two", replace: "x")], "one\n\n  \ntwo") == "x")
    check(
      "a repeated find is ambiguous, with its count",
      MailComposerText.apply([Edit(find: "a", replace: "b")], to: "a a")
        == .ambiguous(find: "a", count: 2))
    check(
      "a missing find is not found",
      MailComposerText.apply([Edit(find: "z", replace: "b")], to: "a") == .notFound(find: "z"))
    check(
      "an empty find is not found",
      MailComposerText.apply([Edit(find: "", replace: "b")], to: "a b") == .notFound(find: ""))
    check(
      "edits whose matches intersect are overlapping",
      MailComposerText.apply(
        [Edit(find: "a b", replace: "x"), Edit(find: "b c", replace: "y")], to: "a b c")
        == .overlapping)
    check(
      "edits that only touch are not overlapping",
      result([Edit(find: "a ", replace: "x"), Edit(find: "b", replace: "y")], "a b") == "xy")
    check(
      "several edits apply right to left against the original text",
      result(
        [Edit(find: "one", replace: "1111"), Edit(find: "three", replace: "3")],
        "one two\nthree") == "1111 two\n3")
    check(
      "matches index the original text, in edit order",
      {
        let own = "x\ny z"
        guard
          case .ok(_, let matches) = MailComposerText.apply(
            [Edit(find: "z", replace: "Z"), Edit(find: "x y", replace: "Q")], to: own)
        else { return false }
        return matches.map { String(own[$0]) } == ["z", "x\ny"]
      }())
    check(
      "non-ASCII text matches and keeps its surroundings",
      result([Edit(find: "ça", replace: "ok")], "Désolé — ça marche") == "Désolé — ok marche")
    check(
      "a quote header is the same quote across a line break",
      MailComposerText.sameQuote("On 22 Oct, X wrote:\nHi", "On 22 Oct, X wrote: Hi"))
    check(
      "different quotes are not the same",
      !MailComposerText.sameQuote("On 22 Oct, X wrote:\nHi", "On 23 Oct, X wrote: Hi"))

    print("\(checks) checks, \(failures) failures")
    if failures > 0 { exit(1) }
  }
}
