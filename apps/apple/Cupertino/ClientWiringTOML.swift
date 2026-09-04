import Foundation

/// Reading and editing the `[mcp_servers]` blocks of a TOML client config,
/// without disturbing a byte of the rest of it.
///
/// Foundation only, for the same reason as `ClientWiringMerge`: `make
/// wiring-check` compiles this file beside `scripts/wiring-check.swift` and runs
/// the result. It does not depend on `ClientWiringMerge` either — that half
/// decides what an entry MEANS, this half decides where an entry IS.
///
/// Ported from Bastion, which needed it first and for a different transport: it
/// writes Codex a loopback `url`, Cupertino writes it a `command` and `args`.
/// Neither this file nor `ClientWiringMerge` can tell the difference, which is
/// the property that made the port a copy — `render` already listed `command`
/// and `args` among the keys it emits.
///
/// Why not a TOML library. The six JSON clients are serialised from a
/// dictionary, which is safe because their files hold nothing but data. Codex's
/// `config.toml` is hand-written prose and structure — on the machine this was
/// ported against, twenty-nine `[projects."…"]` tables, a `[features]` block
/// and a multi-line string full of markdown — and round-tripping it through any
/// serialiser would reformat and de-comment a file Cupertino does not own. That is
/// the same objection that keeps VS Code on `mcp.json` rather than
/// `settings.json`. So this never re-encodes the file: it locates the lines that
/// hold MCP servers, replaces those, and quotes every other byte verbatim.
///
/// **The invariant, and the reason for the shape below: the scanner may fail to
/// describe a server, but it must never fail to NAME one.** A server this can
/// see but not parse still appears in `servers`, which makes `isOurs` false,
/// which makes `collisions` refuse to write over it. Dropping it instead would
/// let a wire append a second `[mcp_servers.<name>]`, and a duplicate key does
/// not cost one entry — it makes the whole file fail to parse, and Codex loses
/// every server and every project trust level at once. That is a read bug with
/// a catastrophic write consequence, which is why extents and values are two
/// different jobs here:
///
/// - The **lexer** decides extents. It may throw, and a throw means the client
///   reads as `unreadable` and no write is possible, because every write path
///   begins with a read.
/// - The **value parser** is best effort and never throws. A value it cannot
///   type is omitted rather than guessed; `identity(of:)` returning nil is
///   already a case the pane knows how to render.
enum ClientWiringTOML {
  /// Where Codex keeps its servers. The TOML analogue of a client's `rootKey`.
  static let rootKey = "mcp_servers"

  // MARK: - What a scan produces

  /// One server as the file holds it: what it says, and which lines say it.
  struct Table {
    let name: String
    /// Line indices, half-open. Plural because TOML lets `[mcp_servers.a.env]`
    /// sit somewhere other than directly under `[mcp_servers.a]`, and both
    /// belong to `a`.
    var ranges: [Range<Int>]
    /// Best effort. Empty is a legitimate answer — see the invariant above.
    var value: [String: Any]

    /// `enabled = false`, which Codex honours and no JSON client has. Worth
    /// carrying separately because it is the one way a config can audit as
    /// configured while the client runs none of it.
    var isDisabled: Bool { (value["enabled"] as? Bool) == false }
  }

  struct Document {
    /// The file, verbatim. Every splice quotes out of this and never re-encodes
    /// it.
    let text: String
    /// One range per line, INCLUDING its own terminator — so an untouched CRLF
    /// line comes back with its CR, and a file with no final newline keeps not
    /// having one. Splitting on newlines and re-joining is exactly how a
    /// "byte-preserving" edit quietly rewrites line endings it never looked at.
    let lines: [Range<String.Index>]
    /// What a rendered block ends its lines with.
    let newline: String
    let tables: [String: Table]
    /// Where new blocks are emitted: just past the last `mcp_servers` span in
    /// the ORIGINAL file, counting the ones about to be deleted. Counting those
    /// too is what makes a second wire byte-identical to the first.
    let anchor: Int

    /// The shape every function in `ClientWiringMerge` already takes. The whole
    /// point of it: the policy layer never learns that one of these files is
    /// TOML.
    var servers: [String: Any] { tables.mapValues { $0.value } }

    var disabled: Set<String> {
      Set(tables.values.filter { $0.isDisabled }.map { $0.name })
    }
  }

  /// For a config that does not exist yet.
  static let empty = Document(
    text: "", lines: [], newline: "\n", tables: [:], anchor: 0)

  enum ScanError: LocalizedError {
    case notUTF8(URL)
    /// Legal TOML this cannot splice safely. Named, because the remedy is a
    /// person looking at that line.
    case unsupportedShape(line: Int, why: String)
    /// Not TOML, or not TOML in a way that leaves a span's end unknowable.
    case malformed(line: Int, why: String)

    var errorDescription: String? {
      switch self {
      case .notUTF8(let url):
        return "\(url.lastPathComponent) is not UTF-8; leaving it alone"
      case .unsupportedShape(let line, let why):
        return
          "line \(line + 1) uses a shape Cupertino cannot edit safely (\(why)). "
          + "Nothing was written."
      case .malformed(let line, let why):
        return "line \(line + 1) is not valid TOML (\(why)). Nothing was written."
      }
    }
  }

  // MARK: - Reading

  static func read(_ url: URL) throws -> Document {
    let data = try Data(contentsOf: url)
    guard let text = String(data: data, encoding: .utf8) else {
      throw ScanError.notUTF8(url)
    }
    return try scan(text)
  }

  static func scan(_ text: String) throws -> Document {
    let lines = lineRanges(text)
    var tables: [String: Table] = [:]

    // Which table the assignments on this line belong to.
    enum Context {
      /// Nothing we care about, or before the first header.
      case other
      /// A bare `[mcp_servers]`, under which every key IS a server.
      case parent
      /// `[mcp_servers.<name>]` and its subtables; `path` is what comes after
      /// the name.
      case server(name: String, path: [String])
    }
    var context = Context.other

    // The span being accumulated, if it belongs to a server.
    var openName: String?
    var openStart = 0
    // The last line that is not blank and not comment-only. A span ends here
    // rather than at the next header, so the blank line and the comment sitting
    // above the NEXT table stay with the next table.
    var lastContent = -1

    func closeSpan() {
      guard let name = openName else { return }
      let stop = max(openStart + 1, lastContent + 1)
      tables[name, default: Table(name: name, ranges: [], value: [:])]
        .ranges.append(openStart..<stop)
      openName = nil
    }

    func record(_ name: String, path: [String], key: [String], value: Any?) {
      var table = tables[name] ?? Table(name: name, ranges: [], value: [:])
      if let value { set(&table.value, path: path + key, to: value) }
      tables[name] = table
    }

    var state = LexState()
    for (index, span) in lines.enumerated() {
      let line = text[span]
      let fresh = state.isClean
      try advance(&state, over: line, at: index)

      guard fresh else {
        // A continuation line of a multi-line value. Content, but nothing to
        // classify — the assignment it belongs to was read on its first line.
        lastContent = index
        continue
      }

      switch try classify(line, at: index) {
      case .blank, .comment:
        continue

      case .header(let parts, let arrayOfTables):
        // Close before counting this line as content: a span ends at the last
        // line that says something, and the header below it is the next
        // table's first line, not this table's last.
        closeSpan()
        lastContent = index

        guard parts.first == rootKey else {
          context = .other
          continue
        }
        if arrayOfTables {
          throw ScanError.unsupportedShape(
            line: index, why: "an array of tables under [\(rootKey)]")
        }
        switch parts.count {
        case 1:
          context = .parent
        default:
          let name = parts[1]
          context = .server(name: name, path: Array(parts.dropFirst(2)))
          openName = name
          openStart = index
          // Named even if nothing below it parses. That is the invariant.
          if tables[name] == nil { tables[name] = Table(name: name, ranges: [], value: [:]) }
        }

      case .assignment(let key, let value):
        lastContent = index
        switch context {
        case .other:
          continue
        case .parent:
          // Every key here is a server, and its span is this one line.
          guard key.count == 1 else {
            throw ScanError.unsupportedShape(
              line: index, why: "a dotted key under [\(rootKey)]")
          }
          let name = key[0]
          var table = tables[name] ?? Table(name: name, ranges: [], value: [:])
          table.ranges.append(index..<(index + 1))
          if let value = value as? [String: Any] { table.value = value }
          tables[name] = table
        case .server(let name, let path):
          record(name, path: path, key: key, value: value)
        }
      }
    }
    closeSpan()

    if !state.isClean {
      throw ScanError.malformed(
        line: max(0, lines.count - 1), why: "a value that is never closed")
    }

    let anchor = tables.values.flatMap { $0.ranges }.map { $0.upperBound }.max() ?? lines.count
    return Document(
      text: text, lines: lines, newline: newline(of: text, lines: lines),
      tables: tables, anchor: anchor)
  }

  // MARK: - Writing

  /// One `[mcp_servers.<name>]` block.
  ///
  /// Only ever called on an entry Cupertino built. A hand-written entry is never
  /// re-rendered — read it, classify it, quote it back verbatim — and that
  /// asymmetry is the whole safety argument. Rendering is allowed to be
  /// opinionated about quoting and order precisely because the only thing it
  /// ever sees is a shape this app chose.
  static func render(name: String, entry: [String: Any], newline: String) -> String {
    var out = "[\(rootKey).\(key(name))]" + newline
    // What an entry points at first, because that is what somebody reading the
    // file wants to see; everything else in a stable order after it.
    let preferred = ["url", "command", "args", "env", "http_headers"]
    let rest = entry.keys.filter { !preferred.contains($0) }.sorted()
    for name in preferred + rest {
      guard let value = entry[name], let literal = literal(value) else { continue }
      out += "\(key(name)) = \(literal)" + newline
    }
    return out
  }

  /// Bare where TOML allows it, quoted otherwise.
  ///
  /// Cupertino's own keys are always bare in practice — `cupertino-<surface>`,
  /// where the surface id is `^[a-z0-9]+$` and generated from surfaces.json.
  /// Quoting is implemented and checked anyway: this renders whatever it is
  /// handed, and "always right in practice" is not a property the renderer can
  /// check for itself.
  private static func key(_ name: String) -> String {
    let bare =
      !name.isEmpty
      && name.allSatisfy {
        $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-")
      }
    return bare ? name : quoted(name)
  }

  private static func quoted(_ value: String) -> String {
    var out = "\""
    for character in value {
      switch character {
      case "\\": out += "\\\\"
      case "\"": out += "\\\""
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1,
          scalar.value < 0x20
        {
          out += String(format: "\\u%04X", scalar.value)
        } else {
          out.append(character)
        }
      }
    }
    return out + "\""
  }

  private static func literal(_ value: Any) -> String? {
    switch value {
    case let string as String: return quoted(string)
    case let bool as Bool: return bool ? "true" : "false"
    case let int as Int: return String(int)
    case let table as [String: Any]:
      let pairs = table.keys.sorted().compactMap { name -> String? in
        guard let value = table[name], let literal = literal(value) else { return nil }
        return "\(key(name)) = \(literal)"
      }
      return pairs.isEmpty ? "{}" : "{ " + pairs.joined(separator: ", ") + " }"
    case let array as [Any]:
      let elements = array.compactMap { literal($0) }
      guard elements.count == array.count else { return nil }
      return "[" + elements.joined(separator: ", ") + "]"
    default:
      return nil
    }
  }

  /// Delete the lines that hold `removing` and `upserting`, emit `upserting` at
  /// the anchor, and quote every other byte of the file verbatim.
  ///
  /// `upserting`'s keys are deleted as well as written: a key being rewritten
  /// has its old block taken out wherever it sat and a fresh one emitted at the
  /// anchor, which is what keeps a second wire byte-identical to the first
  /// rather than leaving the entry in two places.
  ///
  /// A deleted block also takes the blank line above it, and a written block
  /// puts one back. That pair is what makes wire → unwire return the original
  /// bytes, and what stops ten rounds of either from growing a column of blank
  /// lines.
  static func spliced(
    _ document: Document,
    removing: Set<String>,
    upserting: [String: [String: Any]]
  ) -> String {
    let doomed = removing.union(upserting.keys)
    var deleted = Set<Int>()
    for name in doomed {
      for range in document.tables[name]?.ranges ?? [] { deleted.formUnion(range) }
    }
    for name in doomed {
      for range in document.tables[name]?.ranges ?? [] {
        let above = range.lowerBound - 1
        guard above >= 0, !deleted.contains(above), isBlank(document, above) else { continue }
        deleted.insert(above)
      }
    }

    let blocks = upserting.keys.sorted().map {
      render(name: $0, entry: upserting[$0] ?? [:], newline: document.newline)
    }

    var out = ""
    var written = false
    func writeBlocks() {
      guard !written else { return }
      written = true
      for block in blocks {
        if !out.isEmpty {
          // Close an unterminated last line before adding to it, then put in
          // the blank line this block owns -- unconditionally, even if one is
          // already there. Insertion and deletion are then exact inverses: the
          // blank a wire adds is the blank an unwire takes back, so a blank
          // line the user wrote is never counted as ours and eaten.
          if let last = out.last, !breaks.contains(last) { out += document.newline }
          out += document.newline
        }
        out += block
      }
    }

    for index in document.lines.indices {
      if index == document.anchor { writeBlocks() }
      if deleted.contains(index) { continue }
      out += document.text[document.lines[index]]
    }
    if document.anchor >= document.lines.count { writeBlocks() }
    return out
  }

  private static func isBlank(_ document: Document, _ index: Int) -> Bool {
    document.text[document.lines[index]]
      .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  // MARK: - Lines

  /// What ends a line.
  ///
  /// Both, and named rather than written out at each site, because Swift makes
  /// CRLF easy to get wrong: `"\r\n"` is ONE `Character` — a grapheme cluster —
  /// so `c == "\n"` is false for a CRLF break and `hasSuffix("\n")` is false for
  /// a CRLF-terminated string. Comparing against the wrong one of these reads a
  /// whole CRLF file as a single line, finds no servers in it, and appends
  /// blocks to the end of what it thinks is line one.
  private static let breaks: Set<Character> = ["\n", "\r\n"]

  /// Every line, each carrying its own terminator.
  static func lineRanges(_ text: String) -> [Range<String.Index>] {
    var out: [Range<String.Index>] = []
    var start = text.startIndex
    var i = text.startIndex
    while i < text.endIndex {
      let isBreak = breaks.contains(text[i])
      i = text.index(after: i)
      if isBreak {
        out.append(start..<i)
        start = i
      }
    }
    if start < text.endIndex { out.append(start..<text.endIndex) }
    return out
  }

  private static func newline(of text: String, lines: [Range<String.Index>]) -> String {
    for line in lines {
      guard let last = text[line].last, breaks.contains(last) else { continue }
      return String(last)
    }
    return "\n"
  }

  // MARK: - The lexer

  /// What a line can leave open behind it.
  private struct LexState {
    /// `"` or `'` while inside a `"""` / `'''` block.
    var multiline: Character?
    /// Unclosed `[` or `{` in a value spanning lines.
    var depth = 0

    var isClean: Bool { multiline == nil && depth == 0 }
  }

  /// Walk one line for extents only: where strings start and stop, where a
  /// comment begins, whether a value is still open at the end of it.
  ///
  /// Not optional. The real `~/.codex/config.toml` keeps a `"""` block of
  /// markdown — headings that begin with `#`, prose, brackets — directly above
  /// `[mcp_servers.node_repl]`. A line scanner that does not know it is inside a
  /// string would mint servers out of somebody's prose and then delete the
  /// lines it invented.
  private static func advance(
    _ state: inout LexState, over line: Substring, at index: Int
  ) throws {
    let c = Array(line)
    var i = 0
    while i < c.count {
      if let delim = state.multiline {
        if c[i] == delim, i + 2 < c.count, c[i + 1] == delim, c[i + 2] == delim {
          state.multiline = nil
          i += 3
          continue
        }
        // Only a basic string has escapes; a literal one is bytes.
        if delim == "\"", c[i] == "\\", i + 1 < c.count {
          i += 2
          continue
        }
        i += 1
        continue
      }

      switch c[i] {
      case "#":
        return
      case "\"", "'":
        let quote = c[i]
        if i + 2 < c.count, c[i + 1] == quote, c[i + 2] == quote {
          state.multiline = quote
          i += 3
          continue
        }
        var j = i + 1
        var closed = false
        while j < c.count {
          if quote == "\"", c[j] == "\\" {
            j += 2
            continue
          }
          if c[j] == quote {
            j += 1
            closed = true
            break
          }
          j += 1
        }
        guard closed else {
          throw ScanError.malformed(line: index, why: "an unterminated string")
        }
        i = j
      case "[", "{":
        state.depth += 1
        i += 1
      case "]", "}":
        state.depth = max(0, state.depth - 1)
        i += 1
      default:
        i += 1
      }
    }
  }

  // MARK: - Classifying a line

  private enum Line {
    case blank
    case comment
    case header(parts: [String], arrayOfTables: Bool)
    case assignment(key: [String], value: Any?)
  }

  private static func classify(_ line: Substring, at index: Int) throws -> Line {
    var cursor = Cursor(Array(line))
    // A byte-order mark is not TOML, but editors write one and refusing the
    // whole client over it would be a poor trade. It is quoted back verbatim
    // like every other byte this does not own.
    if cursor.peek == "\u{FEFF}" { cursor.advance() }
    cursor.skipSpace()
    guard let first = cursor.peek else { return .blank }
    if breaks.contains(first) || first == "\r" { return .blank }
    if first == "#" { return .comment }

    if first == "[" {
      cursor.advance()
      var arrayOfTables = false
      if cursor.peek == "[" {
        arrayOfTables = true
        cursor.advance()
      }
      guard let parts = cursor.keyPath() else {
        throw ScanError.malformed(line: index, why: "a table header with no key")
      }
      cursor.skipSpace()
      guard cursor.peek == "]" else {
        throw ScanError.malformed(line: index, why: "an unclosed table header")
      }
      cursor.advance()
      if arrayOfTables {
        guard cursor.peek == "]" else {
          throw ScanError.malformed(line: index, why: "an unclosed table header")
        }
        cursor.advance()
      }
      guard cursor.atLineTail else {
        throw ScanError.malformed(line: index, why: "trailing text after a table header")
      }
      return .header(parts: parts, arrayOfTables: arrayOfTables)
    }

    guard let key = cursor.keyPath() else {
      throw ScanError.malformed(line: index, why: "neither a table header nor an assignment")
    }
    cursor.skipSpace()
    guard cursor.peek == "=" else {
      throw ScanError.malformed(line: index, why: "a key with no value")
    }
    cursor.advance()
    cursor.skipSpace()
    // Best effort from here down: an unparseable value is omitted, never
    // guessed, and never a reason to refuse the file.
    let value = cursor.value()
    return .assignment(key: key, value: cursor.atLineTail ? value : nil)
  }

  // MARK: - Values

  /// Nested assignment, for a dotted key or a subtable.
  private static func set(_ dict: inout [String: Any], path: [String], to value: Any) {
    guard let head = path.first else { return }
    if path.count == 1 {
      dict[head] = value
      return
    }
    var child = dict[head] as? [String: Any] ?? [:]
    set(&child, path: Array(path.dropFirst()), to: value)
    dict[head] = child
  }

  /// A hand-rolled reader over one line's characters.
  ///
  /// Everything it returns is optional rather than thrown, because a value it
  /// cannot type is not an error — see the invariant at the top of the file.
  private struct Cursor {
    private let c: [Character]
    private var i = 0

    init(_ characters: [Character]) { c = characters }

    var peek: Character? { i < c.count ? c[i] : nil }
    mutating func advance() { i += 1 }
    mutating func skipSpace() {
      while let ch = peek, ch == " " || ch == "\t" { advance() }
    }

    /// Whether nothing but whitespace, a comment and the line break remain.
    var atLineTail: Bool {
      var j = i
      while j < c.count, c[j] == " " || c[j] == "\t" { j += 1 }
      guard j < c.count else { return true }
      return c[j] == "#" || ClientWiringTOML.breaks.contains(c[j]) || c[j] == "\r"
    }

    private static func isBare(_ ch: Character) -> Bool {
      ch.isASCII && (ch.isLetter || ch.isNumber || ch == "_" || ch == "-")
    }

    /// One key, bare or quoted.
    mutating func key() -> String? {
      guard let ch = peek else { return nil }
      if ch == "\"" || ch == "'" { return string() }
      var out = ""
      while let d = peek, Cursor.isBare(d) {
        out.append(d)
        advance()
      }
      return out.isEmpty ? nil : out
    }

    /// A dotted key path. `[projects."/Users/olivier/…"]` is the shape that
    /// makes this more than a split on ".".
    mutating func keyPath() -> [String]? {
      var parts: [String] = []
      while true {
        skipSpace()
        guard let part = key() else { return nil }
        parts.append(part)
        skipSpace()
        guard peek == "." else { return parts }
        advance()
      }
    }

    /// A single-line quoted string. `nil` for a `"""` opener — that value spans
    /// lines, and the lexer has already taken care of the extents.
    mutating func string() -> String? {
      guard let quote = peek, quote == "\"" || quote == "'" else { return nil }
      if i + 2 < c.count, c[i + 1] == quote, c[i + 2] == quote { return nil }
      advance()
      var out = ""
      while let ch = peek {
        if ch == quote {
          advance()
          return out
        }
        if quote == "\"", ch == "\\" {
          advance()
          guard let escape = peek else { return nil }
          advance()
          switch escape {
          case "n": out.append("\n")
          case "t": out.append("\t")
          case "r": out.append("\r")
          case "b": out.append("\u{08}")
          case "f": out.append("\u{0C}")
          case "\"": out.append("\"")
          case "\\": out.append("\\")
          case "u", "U":
            let width = escape == "u" ? 4 : 8
            var hex = ""
            for _ in 0..<width {
              guard let d = peek, d.isHexDigit else { return nil }
              hex.append(d)
              advance()
            }
            guard let scalar = UInt32(hex, radix: 16),
              let unicode = Unicode.Scalar(scalar)
            else { return nil }
            out.append(Character(unicode))
          default:
            return nil
          }
          continue
        }
        if ClientWiringTOML.breaks.contains(ch) { return nil }
        out.append(ch)
        advance()
      }
      return nil
    }

    /// A value, as far as one line can tell. `nil` means "not something this
    /// can type", which is a legitimate and common answer.
    mutating func value() -> Any? {
      guard let ch = peek else { return nil }
      switch ch {
      case "\"", "'":
        return string()
      case "[":
        return array()
      case "{":
        return inlineTable()
      case "t", "f":
        return literal()
      default:
        return number()
      }
    }

    private mutating func array() -> [Any]? {
      advance()
      var out: [Any] = []
      while true {
        skipSpace()
        if peek == "]" {
          advance()
          return out
        }
        guard let element = value() else { return nil }
        out.append(element)
        skipSpace()
        if peek == "," {
          advance()
          continue
        }
        if peek == "]" {
          advance()
          return out
        }
        // End of line inside the brackets: a multi-line array. Untypeable here,
        // and the lexer already knows the value continues.
        return nil
      }
    }

    private mutating func inlineTable() -> [String: Any]? {
      advance()
      var out: [String: Any] = [:]
      skipSpace()
      if peek == "}" {
        advance()
        return out
      }
      while true {
        skipSpace()
        guard let path = keyPath() else { return nil }
        skipSpace()
        guard peek == "=" else { return nil }
        advance()
        skipSpace()
        guard let element = value() else { return nil }
        ClientWiringTOML.set(&out, path: path, to: element)
        skipSpace()
        if peek == "," {
          advance()
          continue
        }
        if peek == "}" {
          advance()
          return out
        }
        return nil
      }
    }

    private mutating func literal() -> Bool? {
      var word = ""
      while let ch = peek, ch.isLetter {
        word.append(ch)
        advance()
      }
      switch word {
      case "true": return true
      case "false": return false
      default: return nil
      }
    }

    /// Integers only, and only plain ones. A float, a datetime or an underscored
    /// integer comes back nil and its key is omitted — none of them can be a
    /// `command` or a `url`, so nothing downstream is poorer for it.
    private mutating func number() -> Int? {
      var word = ""
      if let ch = peek, ch == "-" || ch == "+" {
        word.append(ch)
        advance()
      }
      while let ch = peek, ch.isASCII, ch.isNumber {
        word.append(ch)
        advance()
      }
      return Int(word)
    }
  }
}
