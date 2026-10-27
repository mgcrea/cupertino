import Foundation

/// The run record: one chained line per Shell request, whatever the activity and audit settings
/// say.
///
/// The audit file is off by default, the Activity window keeps no result in its default mode,
/// and each argument there is cut at 4 KB, so a script hiding its payload past 4 KB of harmless
/// text would be logged without it. This record is the one that cannot be switched off. It holds
/// the script's length and a SHA-256 over its full text, never the text or the output.
///
/// Every request is a line, a refusal as much as a run: declined, no answer, cooldown and busy
/// say as much about what an agent tried as a run does.
///
/// ## The file
///
/// Monthly segments, `runs-YYYY-MM.jsonl`, months in UTC as the chain's clock is. Each line is an
/// `AuditChain.Record`, sealed by `AuditChain` exactly as the audit log's are: `surface` is
/// `shell`, `kind` is `info`, `text` is the decision, `at` is the entry's own time, and `args` is
/// the entry's other fields as sorted-key JSON. A segment opens from the head of the newest one
/// before it, as `AuditLog`'s do, so dropping an old month is a declared truncation and not a
/// broken chain.
///
/// The chain is tamper evidence, not prevention: a same-user process can still delete the file.
/// See `AuditChain` for what it is and is not worth.
///
/// ## Writing
///
/// `append` hands the entry to one serial queue and returns. It runs on server threads, and it
/// never throws: a failure goes to the host log. The link is read from the file on that queue,
/// never from memory, so a write that failed cannot be followed by a record pointing at a hash
/// the file never received.
nonisolated enum ShellRecord {
  enum Decision: String, Sendable {
    case approved, approvedForSession, notAsked, declined, noAnswer, cooldown, busy, cancelled,
      invalid
  }

  struct Entry: Sendable, Equatable {
    var at: Date
    var client: String
    var connection: UUID
    var purpose: String
    var interpreter: String
    var cwd: String
    var scriptBytes: Int
    var scriptSHA256: String
    var decision: Decision
    var exitCode: Int32?
    var signal: String?
    var timedOut: Bool
    var durationMs: Int?
  }

  /// `<Application Support>/<app id>/shell-runs`. Settable so a check can point it at a scratch
  /// directory; the app never changes it.
  nonisolated(unsafe) static var directory: URL = AppSupport.directory.appendingPathComponent(
    "shell-runs", isDirectory: true)

  static let retentionDays = 90

  static let surface = "shell"

  /// Every read and write of the directory, in order. `.utility`: a record line is never what
  /// the person is waiting for.
  private static let queue = DispatchQueue(label: "io.mgcrea.cupertino.shell-runs", qos: .utility)

  /// The last record of each segment as this process left it, so an append does not reread the
  /// month. Valid only while the file is still the size it was then; anything else rereads.
  /// Touched only on `queue`.
  private struct Tail {
    var size: Int
    var seq: Int
    var head: String
  }
  nonisolated(unsafe) private static var tails: [String: Tail] = [:]

  // MARK: - Writing

  /// Record one request. Returns at once; the line lands on `queue`.
  ///
  /// `now` picks the month the line goes in and the age retention measures from. It is the
  /// time of writing rather than `entry.at`, so lines land in segments in the order they were
  /// chained.
  static func append(_ entry: Entry, in dir: URL = directory, now: Date = Date()) {
    queue.async { write(entry, in: dir, now: now) }
  }

  /// Wait for every queued line to land. For `make shell-check`, which reads the directory
  /// straight after an append; the app never needs it, since `recent` and `verify` read on the
  /// writer's own queue.
  static func flushForCheck() { queue.sync {} }

  /// On `queue`.
  private static func write(_ entry: Entry, in dir: URL, now: Date) {
    if let reason = ensure(dir) {
      hostLog(surface, .error, "shell run record: could not create its folder: \(reason)")
      return
    }
    let target = dir.appendingPathComponent(name(of: month(of: now)))

    // The link first, then retention: a segment that opens a new month links to the month
    // before it even when that month is about to be dropped, so the chain carries on rather
    // than restarting from genesis with nothing to say why.
    let (tail, torn) = link(for: target, in: dir)
    prune(dir, now: now, keeping: target.lastPathComponent)

    let sealed = AuditChain.seal(
      AuditChain.Record(
        seq: tail.seq + 1, at: entry.at, surface: surface, kind: .info,
        text: entry.decision.rawValue, args: arguments(of: entry), prev: tail.head))
    // A torn last line (a crash mid-write) stays a line of its own, where the verifier will
    // name it, rather than having this record glued onto it.
    let bytes = Data(((torn ? "\n" : "") + AuditChain.line(sealed) + "\n").utf8)

    if let reason = append(bytes, to: target) {
      tails[target.path] = nil
      hostLog(surface, .error, "shell run record: could not append: \(reason)")
      return
    }
    tails[target.path] = Tail(size: size(of: target), seq: sealed.seq, head: sealed.hash)
  }

  /// The folder, at 0700 whether or not it is new. Nil on success, else the reason.
  private static func ensure(_ dir: URL) -> String? {
    // The app's own parent through the helper that also tightens an existing one, as
    // `AuditLog` does. Only for the real folder: a check's scratch folder has its own parent.
    if dir.standardizedFileURL == directory.standardizedFileURL {
      _ = try? AppSupport.ensureDirectory()
    }
    do {
      try FileManager.default.createDirectory(
        at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
      return error.localizedDescription
    }
    chmod(dir.path, 0o700)
    return nil
  }

  /// What the next record in `target` follows: the last record in it, else the last record of
  /// the newest segment before it, else genesis. `torn` when `target` does not end on a line
  /// break.
  private static func link(for target: URL, in dir: URL) -> (tail: Tail, torn: Bool) {
    let current = size(of: target)
    if current > 0, let known = tails[target.path], known.size == current {
      return (known, false)
    }
    if current > 0, let text = try? String(contentsOf: target, encoding: .utf8) {
      let torn = !text.hasSuffix("\n")
      if let last = lastRecord(in: text) { return (last, torn) }
      // Nothing readable in it: carry on from the month before, as an empty file would.
      return (previousTail(before: target, in: dir), torn)
    }
    return (previousTail(before: target, in: dir), false)
  }

  private static func previousTail(before target: URL, in dir: URL) -> Tail {
    let earlier = segments(in: dir).filter { $0.url.lastPathComponent < target.lastPathComponent }
    for segment in earlier.reversed() {
      if let text = try? String(contentsOf: segment.url, encoding: .utf8),
        let last = lastRecord(in: text)
      {
        return last
      }
    }
    return Tail(size: 0, seq: 0, head: AuditChain.genesis)
  }

  /// The last line that parses as a record, with its `seq` and `hash`.
  private static func lastRecord(in text: String) -> Tail? {
    for line in text.split(separator: "\n").reversed() {
      guard
        let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        let seq = row["seq"] as? Int, let hash = row["hash"] as? String
      else { continue }
      return Tail(size: 0, seq: seq, head: hash)
    }
    return nil
  }

  /// Append-only, through a handle: never `.atomic`, which would replace the file and reset its
  /// mode. Nil on success, else the reason.
  private static func append(_ bytes: Data, to target: URL) -> String? {
    let path = target.path
    if !FileManager.default.fileExists(atPath: path),
      !FileManager.default.createFile(
        atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    {
      return "could not create \(target.lastPathComponent)"
    }
    do {
      let handle = try FileHandle(forWritingTo: target)
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: bytes)
      return nil
    } catch {
      return "\(target.lastPathComponent): \(error.localizedDescription)"
    }
  }

  /// The entry's fields other than its time and decision, which the record carries itself.
  /// Optional fields are left out rather than written null, as the chain's own are.
  private struct Arguments: Codable {
    var client: String
    var connection: UUID
    var purpose: String
    var interpreter: String
    var cwd: String
    var scriptBytes: Int
    var scriptSHA256: String
    var exitCode: Int32?
    var signal: String?
    var timedOut: Bool
    var durationMs: Int?
  }

  private static func arguments(of entry: Entry) -> String {
    let fields = Arguments(
      client: entry.client, connection: entry.connection, purpose: entry.purpose,
      interpreter: entry.interpreter, cwd: entry.cwd, scriptBytes: entry.scriptBytes,
      scriptSHA256: entry.scriptSHA256, exitCode: entry.exitCode, signal: entry.signal,
      timedOut: entry.timedOut, durationMs: entry.durationMs)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // Encoding strings, numbers and a UUID cannot fail; the fallback is never written.
    return (try? encoder.encode(fields)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }

  // MARK: - Segments

  /// Months in UTC, as the chain's clock is, so a line lands in the same file whichever zone
  /// the Mac is in.
  private static let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
  }()

  private struct Month: Comparable {
    var year: Int
    var month: Int

    /// Months since year zero: the segment's number for `AuditChain.verify(segments:)`. Always
    /// above 1, so the oldest month on file opens from its own first link. That is the
    /// declared truncation retention makes, and a file holding the very first record opens
    /// from genesis anyway.
    var ordinal: Int { year * 12 + month - 1 }

    static func < (a: Month, b: Month) -> Bool { a.ordinal < b.ordinal }
  }

  private static func month(of date: Date) -> Month {
    let parts = calendar.dateComponents([.year, .month], from: date)
    return Month(year: parts.year ?? 1970, month: parts.month ?? 1)
  }

  private static func name(of month: Month) -> String {
    String(format: "runs-%04d-%02d.jsonl", month.year, month.month)
  }

  /// `runs-YYYY-MM.jsonl` back to its month. Nil for any other file.
  private static func month(named name: String) -> Month? {
    guard name.hasPrefix("runs-"), name.hasSuffix(".jsonl") else { return nil }
    let parts = name.dropFirst("runs-".count).dropLast(".jsonl".count).split(separator: "-")
    guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
      let year = Int(parts[0]), let month = Int(parts[1]), (1...12).contains(month)
    else { return nil }
    return Month(year: year, month: month)
  }

  /// Every segment in `dir`, oldest first.
  private static func segments(in dir: URL) -> [(url: URL, month: Month)] {
    let found =
      (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
      ?? []
    return found.compactMap { url in month(named: url.lastPathComponent).map { (url, $0) } }
      .sorted { $0.month < $1.month }
  }

  /// Drop every segment whose month ended more than `retentionDays` before `now`. Never
  /// `keeping`, the one about to be written.
  private static func prune(_ dir: URL, now: Date, keeping: String) {
    let cutoff = now.addingTimeInterval(-Double(retentionDays) * 86_400)
    for segment in segments(in: dir) where segment.url.lastPathComponent != keeping {
      let start = calendar.date(
        from: DateComponents(year: segment.month.year, month: segment.month.month, day: 1))
      guard let start, let end = calendar.date(byAdding: .month, value: 1, to: start),
        end < cutoff
      else { continue }
      try? FileManager.default.removeItem(at: segment.url)
      tails[dir.appendingPathComponent(segment.url.lastPathComponent).path] = nil
    }
  }

  private static func size(of url: URL) -> Int {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
  }

  // MARK: - Reading back

  /// The `limit` most recent requests, newest first. Lines that do not read back as an entry
  /// are skipped; `verify` is what names them.
  static func recent(_ limit: Int = 20, in dir: URL = directory) -> [Entry] {
    guard limit > 0 else { return [] }
    return queue.sync {
      var out: [Entry] = []
      for segment in segments(in: dir).reversed() {
        guard let text = try? String(contentsOf: segment.url, encoding: .utf8) else { continue }
        for line in text.split(separator: "\n").reversed() {
          guard let found = entry(from: line) else { continue }
          out.append(found)
          if out.count == limit { return out }
        }
      }
      return out
    }
  }

  private static func entry(from line: Substring) -> Entry? {
    guard
      let row = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
      row["surface"] as? String == surface,
      let at = (row["at"] as? String).flatMap({ AuditChain.clock.date(from: $0) }),
      let decision = (row["text"] as? String).flatMap(Decision.init(rawValue:)),
      let args = row["args"] as? String,
      let fields = try? JSONDecoder().decode(Arguments.self, from: Data(args.utf8))
    else { return nil }
    return Entry(
      at: at, client: fields.client, connection: fields.connection, purpose: fields.purpose,
      interpreter: fields.interpreter, cwd: fields.cwd, scriptBytes: fields.scriptBytes,
      scriptSHA256: fields.scriptSHA256, decision: decision, exitCode: fields.exitCode,
      signal: fields.signal, timedOut: fields.timedOut, durationMs: fields.durationMs)
  }

  /// The whole record's chain, every surviving month in order. On the writer's queue, so a line
  /// being written is never read half there and reported as damage.
  static func verify(in dir: URL = directory) -> AuditChain.Verification {
    queue.sync {
      AuditChain.verify(
        segments: segments(in: dir).map { segment in
          let text = (try? String(contentsOf: segment.url, encoding: .utf8)) ?? ""
          return AuditChain.Segment(
            number: segment.month.ordinal, lines: text.split(separator: "\n").map(String.init))
        })
    }
  }
}
