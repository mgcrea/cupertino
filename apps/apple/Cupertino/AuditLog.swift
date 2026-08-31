import Foundation
import Observation

/// The durable half of the activity log.
///
/// `LogStore` is a ring in memory, cleared on quit — a debugger. This is the
/// thing you can look at on Tuesday about Monday, and hand to somebody else.
/// It is **off by default**: with the Activity pane untouched, nothing here
/// ever opens a file and Cupertino behaves exactly as it did before.
///
/// The same file as Bastion's, with one thing added. There, an argument is
/// mostly an identifier. Here it is the message — `send_message` takes "exactly
/// what to send, sent verbatim" — so putting arguments on disk and putting
/// PROSE on disk are two different decisions and get two different switches.
///
/// ## Events, not calls
///
/// One tool call writes a `call` record and, once answered, a `result` record
/// carrying the call's `seq` in `ref`. `LogStore.attachResult` fills a result
/// in after its row exists, so a record hashed at append time cannot hold one,
/// and hashing after the reply would mean rewriting a record — the one thing an
/// append-only chain must never do. The split also keeps a fact worth keeping:
/// a call that was never answered stays on file as a call with no result.
///
/// ## Segments
///
/// Append-only and retention are in direct conflict — deleting the oldest
/// record breaks the root every later record hangs from. So the log is segment
/// files, each its own chain, each linked to the previous segment's head.
/// Dropping an old segment is then a *declared* truncation: the verifier says
/// "intact from segment 4" rather than "corrupt".
///
/// ## Where the ordering comes from
///
/// Sequencing and sealing happen here, on the main actor, because that is where
/// `LogStore` already serialises every row — and a chain built out of order is
/// a chain that fails verification for no reason anyone can reproduce. Only the
/// finished bytes go to a background queue, which is serial, so they land in
/// the order they were sealed.
@MainActor
@Observable
final class AuditLog {
  static let shared = AuditLog()

  // MARK: - Settings

  static let enabledKey = "auditEnabled"
  static let payloadsKey = "auditPayloads"
  /// The third act. Content reaches a file only when the surface records it
  /// live, the audit log is on, AND this is set — three deliberate switches,
  /// because the thing on the other side of them is the text of somebody's mail.
  static let contentKey = "auditContent"
  static let maxDaysKey = "auditMaxDays"
  static let maxMegabytesKey = "auditMaxMegabytes"

  /// Absence means off, for both. An audit log that switched itself on would
  /// be writing a file nobody asked for out of what is otherwise memory.
  nonisolated static var isEnabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }
  nonisolated static var recordsPayloads: Bool { UserDefaults.standard.bool(forKey: payloadsKey) }
  nonisolated static var recordsContent: Bool { UserDefaults.standard.bool(forKey: contentKey) }

  static let defaultMaxDays = 30
  static let defaultMaxMegabytes = 100

  nonisolated static var maxDays: Int {
    let set = UserDefaults.standard.integer(forKey: maxDaysKey)
    return set > 0 ? set : defaultMaxDays
  }
  nonisolated static var maxMegabytes: Int {
    let set = UserDefaults.standard.integer(forKey: maxMegabytesKey)
    return set > 0 ? set : defaultMaxMegabytes
  }

  /// Rotate at four megabytes. Small enough that retention can drop a segment
  /// without throwing away a month, large enough that a busy day is not a
  /// thousand files.
  static let segmentBytes = 4 * 1024 * 1024

  // MARK: - State

  /// The directory, and the fact that it is 0700 like everything else Bastion
  /// keeps beside it.
  nonisolated static var directory: URL {
    AppSupport.directory.appendingPathComponent("audit", isDirectory: true)
  }

  private var seq = 0
  private var head = AuditChain.genesis
  private var segment = 1
  private var segmentSize = 0
  private var opened = false

  /// Writes only. Serial, so bytes land in the order the main actor sealed
  /// them; `.utility` because a log line is never what a user is waiting for.
  private let writer = DispatchQueue(label: "io.mgcrea.cupertino.audit", qos: .utility)

  /// Call ids that have a `seq` on file, so a result can name the call it
  /// answers. Bounded: a reply that never comes would otherwise keep its entry
  /// for the life of the process.
  private var pending: [UUID: Int] = [:]
  private var pendingOrder: [UUID] = []
  private static let pendingLimit = 512

  // MARK: - Recording

  /// Start listening to `LogStore`.
  ///
  /// Called once at launch. Listening is not the same as writing: `record`
  /// returns immediately unless the log is switched on, so the default costs
  /// one branch per row and touches no file.
  static func install() {
    LogStore.onCall = { shared.record($0) }
    LogStore.onResult = { shared.result($0) }
  }

  /// Record a call, if the log is on. Returns nothing: the caller already has
  /// the row id, and `result` finds the sequence number from it.
  func record(_ entry: LogStore.Entry) {
    guard Self.isEnabled, entry.level == .call else { return }
    open()
    let number = append(
      kind: .call, surface: entry.surface, text: entry.text,
      args: Self.recordsPayloads ? Self.forDisk(entry.arguments) : nil)
    remember(entry.id, number)
  }

  /// Record the reply to a call already on file.
  ///
  /// Silent when the call was not recorded — the log may have been switched on
  /// between the request and its answer, and half a pair is worse than none.
  func result(_ entry: LogStore.Entry) {
    guard Self.isEnabled, let reference = pending.removeValue(forKey: entry.id) else { return }
    pendingOrder.removeAll { $0 == entry.id }
    open()
    append(
      kind: entry.failed ? .error : .result, surface: entry.surface, text: entry.text,
      args: nil, result: Self.recordsPayloads ? Self.forDisk(entry.result) : nil,
      failed: entry.failed ? true : nil, ref: reference)
  }

  @discardableResult
  private func append(
    kind: AuditChain.Kind, surface: String, text: String, args: String? = nil,
    result: String? = nil, failed: Bool? = nil, ref: Int? = nil
  ) -> Int {
    seq += 1
    let sealed = AuditChain.seal(
      AuditChain.Record(
        seq: seq, at: Date(), surface: surface, kind: kind, text: text, args: args,
        result: result, failed: failed, ref: ref, prev: head))
    head = sealed.hash

    let line = AuditChain.line(sealed) + "\n"
    let bytes = Data(line.utf8)
    segmentSize += bytes.count
    let url = Self.url(for: segment)
    writer.async { Self.write(bytes, to: url) }

    // Rotate AFTER the write is queued, so the record that crossed the line is
    // the last one in the segment it was sealed against rather than the first
    // of the next — which would break the link it already carries.
    if segmentSize >= Self.segmentBytes {
      segment += 1
      segmentSize = 0
      prune()
    }
    return seq
  }

  /// Blank the prose again on the way to disk, unless it was asked for.
  ///
  /// The rule itself lives in `CallCapture.reredact`, which `make unit`
  /// compiles; this is only the setting lookup.
  nonisolated static func forDisk(_ payload: String?) -> String? {
    CallCapture.reredact(payload, content: recordsContent)
  }

  private func remember(_ id: UUID, _ number: Int) {
    pending[id] = number
    pendingOrder.append(id)
    while pendingOrder.count > Self.pendingLimit {
      pending.removeValue(forKey: pendingOrder.removeFirst())
    }
  }

  // MARK: - Files

  nonisolated static func url(for segment: Int) -> URL {
    directory.appendingPathComponent(String(format: "audit-%04d.jsonl", segment))
  }

  /// Every segment on disk, oldest first.
  nonisolated static func segments() -> [URL] {
    let found =
      (try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? []
    return found.filter { $0.lastPathComponent.hasSuffix(".jsonl") }.sorted {
      $0.lastPathComponent < $1.lastPathComponent
    }
  }

  /// Append, creating the file 0600 if it is not there.
  ///
  /// `FileHandle` rather than the `.atomic` idiom the JSON stores use, and that
  /// is the point: `.atomic` replaces the file, which would rewrite history and
  /// silently reset the mode to 0644. An append-only log is appended to.
  nonisolated private static func write(_ bytes: Data, to url: URL) {
    let path = url.path
    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(
        atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    guard let handle = try? FileHandle(forWritingTo: url) else { return }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: bytes)
  }

  /// Pick up where the last run left off.
  ///
  /// The files are the state — there is no sidecar recording the sequence
  /// number and the head, because a sidecar can disagree with the log it
  /// describes and then the disagreement looks like tampering. The last line of
  /// the last segment already says both.
  private func open() {
    guard !opened else { return }
    opened = true
    try? FileManager.default.createDirectory(
      at: Self.directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])

    guard let last = Self.segments().last,
      let text = try? String(contentsOf: last, encoding: .utf8)
    else { return }

    segment = Self.number(of: last)
    segmentSize = text.utf8.count
    let lines = text.split(separator: "\n").map(String.init)
    guard let tail = lines.last,
      let object = try? JSONSerialization.jsonObject(with: Data(tail.utf8)) as? [String: Any],
      let lastSeq = object["seq"] as? Int, let lastHash = object["hash"] as? String
    else {
      // A truncated final line — a crash mid-write, most likely. Start a new
      // segment rather than appending to a record that is half there: the
      // damaged segment stays on disk and the verifier will name it.
      segment += 1
      segmentSize = 0
      return
    }
    seq = lastSeq
    head = lastHash
    if segmentSize >= Self.segmentBytes {
      segment += 1
      segmentSize = 0
    }
  }

  nonisolated static func number(of url: URL) -> Int {
    Int(url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "audit-", with: ""))
      ?? 1
  }

  // MARK: - Retention

  /// Drop whole segments, oldest first, never the one being written.
  ///
  /// Whole segments because a chain cannot lose a record from the middle and
  /// still verify — the point of segmenting at all. Age and size are both
  /// bounds, and whichever bites first wins.
  func prune() {
    let all = Self.segments().filter { Self.number(of: $0) != segment }
    guard !all.isEmpty else { return }

    let cutoff = Date().addingTimeInterval(-Double(Self.maxDays) * 86_400)
    var keep: [URL] = []
    for url in all {
      let modified =
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        ?? Date()
      if modified < cutoff {
        try? FileManager.default.removeItem(at: url)
      } else {
        keep.append(url)
      }
    }

    var total = keep.reduce(0) { $0 + Self.size(of: $1) }
    let budget = Self.maxMegabytes * 1024 * 1024
    for url in keep where total > budget {
      total -= Self.size(of: url)
      try? FileManager.default.removeItem(at: url)
    }
  }

  nonisolated static func size(of url: URL) -> Int {
    (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
  }

  // MARK: - Reading back

  struct Summary {
    var segments = 0
    var records = 0
    var bytes = 0
    var report = AuditChain.Report()
  }

  /// Verify every segment in order, carrying the head across.
  ///
  /// Off the main actor would be nicer, and it is deliberately not: this runs
  /// when somebody presses a button, and a verifier racing the writer would
  /// report a torn last line as tampering.
  static func verifyAll() -> Summary {
    var summary = Summary()
    var head = AuditChain.genesis
    for url in segments() {
      guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
      let report = verify(text: text, from: head)
      summary.segments += 1
      summary.records += report.records
      summary.bytes += size(of: url)
      summary.report.failures += report.failures
      head = report.head
    }
    summary.report.records = summary.records
    summary.report.head = head
    return summary
  }

  static func verify(text: String, from: String) -> AuditChain.Report {
    AuditChain.verify(lines: text.split(separator: "\n").map(String.init), from: from)
  }

  // MARK: - Export

  /// Copy the log somewhere the user chose, with a manifest describing it.
  ///
  /// The manifest is the thing worth signing: it names every segment, its
  /// record count and its digest, plus the chain head and whether verification
  /// passed. A recipient can check the segments against it without trusting the
  /// copy, and check the chain without trusting the manifest.
  ///
  /// **The signature lives in its own file.** Writing it into the manifest
  /// would change the bytes it was computed over — the self-referential trap
  /// that makes half the signed-JSON formats in the world ambiguous about what
  /// exactly was signed. `manifest.json` is signed verbatim; `signature.json`
  /// says so beside it.
  ///
  /// The count in the manifest is load-bearing in a way that is easy to miss: a
  /// chain cannot detect its own truncation, because lopping off the tail
  /// leaves a shorter valid chain. The count is what makes a short export
  /// visible.
  @discardableResult
  func export(to folder: URL, sign: Bool) throws -> Summary {
    try FileManager.default.createDirectory(
      at: folder, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])

    var head = AuditChain.genesis
    var described: [AuditChain.SegmentEntry] = []
    var summary = Summary()

    for url in Self.segments() {
      guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
      let report = Self.verify(text: text, from: head)
      try? FileManager.default.removeItem(at: folder.appendingPathComponent(url.lastPathComponent))
      try FileManager.default.copyItem(at: url, to: folder.appendingPathComponent(url.lastPathComponent))
      described.append(
        AuditChain.SegmentEntry(
          name: url.lastPathComponent, records: report.records,
          sha256: AuditChain.digest(text)))
      head = report.head
      summary.segments += 1
      summary.records += report.records
      summary.bytes += Self.size(of: url)
      summary.report.failures += report.failures
    }
    summary.report.records = summary.records
    summary.report.head = head

    let manifest = AuditChain.manifest(
      app: "Cupertino \(AppInfo.version)", exportedAt: Date(), records: summary.records,
      segments: described, head: head, intact: summary.report.isIntact)
    let bytes = Data(manifest.utf8)
    try bytes.write(to: folder.appendingPathComponent("manifest.json"))

    if sign {
      let signature = try AuditSigning.sign(bytes)
      let sidecar = """
        {"algorithm":"ed25519","publicKey":\(AuditChain.quote(try AuditSigning.publicKey())),        "signature":\(AuditChain.quote(signature)),"signs":"manifest.json"}
        """
      try Data(sidecar.utf8).write(to: folder.appendingPathComponent("signature.json"))
    }
    return summary
  }

  func clear() {
    for url in Self.segments() { try? FileManager.default.removeItem(at: url) }
    seq = 0
    head = AuditChain.genesis
    segment = 1
    segmentSize = 0
    opened = false
    pending.removeAll()
    pendingOrder.removeAll()
  }
}
