import Foundation

/// Locating a find/replace edit in a draft's own text.
///
/// Pure text, so it can be checked without Mail. Whitespace is folded on both
/// sides because the composer's text and the caller's idea of it disagree about
/// line breaks: Mail's paragraphs read back with `\n` where a model, or a quote
/// copied from a message, has a space. A find that crosses a paragraph has to
/// match all the same.
nonisolated enum MailComposerText {

  struct Edit: Equatable {
    let find: String
    let replace: String
  }

  /// `matches` index the original `own`, in edit order, so the caller can select
  /// each one in the composer without redoing the search.
  enum Matched: Equatable {
    case ok(result: String, matches: [Range<String.Index>])
    case notFound(find: String)
    case ambiguous(find: String, count: Int)
    case overlapping
  }

  /// Every edit must match exactly once. Refusing a repeated find rather than
  /// taking the first keeps an edit from landing somewhere the caller did not
  /// mean, in a text they cannot see from here.
  static func apply(_ edits: [Edit], to own: String) -> Matched {
    let folded = fold(own)
    var matches: [Range<String.Index>] = []
    for edit in edits {
      let needle = fold(edit.find).chars
      let hits = occurrences(of: needle, in: folded.chars)
      if hits.isEmpty { return .notFound(find: edit.find) }
      if hits.count > 1 { return .ambiguous(find: edit.find, count: hits.count) }
      let first = hits[0]
      matches.append(folded.starts[first]..<folded.ends[first + needle.count - 1])
    }

    let ordered = matches.sorted { $0.lowerBound < $1.lowerBound }
    for (a, b) in zip(ordered, ordered.dropFirst()) where a.upperBound > b.lowerBound {
      return .overlapping
    }

    // Right to left, so a replacement never shifts a range still to be applied.
    var result = own
    for index in edits.indices.sorted(by: { matches[$0].lowerBound > matches[$1].lowerBound }) {
      result.replaceSubrange(matches[index], with: edits[index].replace)
    }
    return .ok(result: result, matches: matches)
  }

  static func sameQuote(_ a: String, _ b: String) -> Bool {
    fold(a).chars == fold(b).chars
  }

  /// The text with each whitespace run as one space, and where every folded
  /// character came from in the original (a run's space spans the whole run).
  private struct Folded {
    var chars: [Character] = []
    var starts: [String.Index] = []
    var ends: [String.Index] = []
  }

  private static func fold(_ text: String) -> Folded {
    var out = Folded()
    var index = text.startIndex
    while index < text.endIndex {
      let next = text.index(after: index)
      if text[index].isWhitespace {
        if out.chars.last == " ", out.ends[out.ends.count - 1] == index {
          out.ends[out.ends.count - 1] = next
        } else {
          out.chars.append(" ")
          out.starts.append(index)
          out.ends.append(next)
        }
      } else {
        out.chars.append(text[index])
        out.starts.append(index)
        out.ends.append(next)
      }
      index = next
    }
    return out
  }

  /// Overlapping hits are counted: "aa" in "aaa" is two places, not one.
  private static func occurrences(of needle: [Character], in haystack: [Character]) -> [Int] {
    guard !needle.isEmpty, needle.count <= haystack.count else { return [] }
    return (0...(haystack.count - needle.count)).filter {
      haystack[$0..<($0 + needle.count)].elementsEqual(needle)
    }
  }
}
