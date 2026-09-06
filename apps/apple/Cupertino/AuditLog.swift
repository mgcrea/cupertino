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
  /// Touched only on `writer`. See `SegmentSink`.
  private let sink = SegmentSink()

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
    let sink = self.sink
    writer.async { sink.append(bytes, to: url) }

    // Rotate AFTER the write is queued, so the record that crossed the line is
    // the last one in the segment it was sealed against rather than the first
    // of the next — which would break the link it already carries.
    if segmentSize >= Self.segmentBytes {
      segment += 1
      segmentSize = 0
      // Release the descriptor as soon as the last record has landed. The url
      // comparison in `append` would catch it lazily anyway; this is so a log
      // that goes quiet after a rotation does not hold the old file open.
      writer.async { sink.close() }
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
        at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]))
      ?? []
    return found.filter { $0.lastPathComponent.hasSuffix(".jsonl") }.sorted {
      $0.lastPathComponent < $1.lastPathComponent
    }
  }

  /// The open segment file, and the one place writes to it can fail.
  ///
  /// `@unchecked Sendable` on the same terms as `HandleStore`: the invariant is
  /// stated rather than shrugged at — every method here runs on `writer` and
  /// nowhere else, which is why it needs no lock.
  ///
  /// One handle per segment rather than one per record. `FileHandle` rather than
  /// the `.atomic` idiom the JSON stores use, and that is the point: `.atomic`
  /// replaces the file, which would rewrite history and silently reset the mode
  /// to 0644. An append-only log is appended to.
  ///
  /// A failed write used to be `try?`, so a full disk advanced `seq` and `head`
  /// in memory while nothing reached the file. The gap then surfaced later as
  /// "a record before N was removed" — the log accusing the disk of tampering
  /// when it had simply been unable to write. It is reported once per segment,
  /// because a disk that is full stays full and one row per call would be its
  /// own denial of service.
  final class SegmentSink: @unchecked Sendable {
    private var handle: FileHandle?
    private var url: URL?
    private var reported = false

    func append(_ bytes: Data, to target: URL) {
      if url != target { close() }
      if handle == nil {
        let path = target.path
        if !FileManager.default.fileExists(atPath: path) {
          FileManager.default.createFile(
            atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let opened = try? FileHandle(forWritingTo: target) else {
          report(target, "could not open it for writing")
          return
        }
        _ = try? opened.seekToEnd()
        handle = opened
        url = target
        reported = false
      }
      do {
        try handle?.write(contentsOf: bytes)
      } catch {
        report(target, error.localizedDescription)
        // Drop the handle so the next record retries the open rather than
        // writing into one the file system has already given up on.
        close()
      }
    }

    func close() {
      try? handle?.close()
      handle = nil
      url = nil
    }

    private func report(_ target: URL, _ reason: String) {
      guard !reported else { return }
      reported = true
      hostLog(
        "cupertino", .error,
        "audit: could not write \(target.lastPathComponent): \(reason)")
    }
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
    // Retention used to run only on rotation, so the age bound never bit on a
    // Mac that logs a few hundred calls a day: 4 MB is a long time at that rate,
    // and content sat on disk indefinitely while the setting said 30 days.
    // Once per launch, on the way in — `prune` never touches the segment being
    // written, which is the only file the writer queue appends to.
    defer { prune() }
    // The parent first, through the helper that also tightens an existing one.
    // withIntermediateDirectories sets the attributes on the leaf only, so
    // creating audit/ before its parent existed would leave the parent at the
    // default mode — and on a machine where the log is switched on before the
    // socket opens, this is what runs first.
    try? AppSupport.ensureDirectory()
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
    /// Where the chain's guarantee begins. 1 is a whole log; higher means
    /// retention dropped the segments before it, which is a declared truncation
    /// rather than a broken chain.
    var startsAtSegment = 1
  }

  /// Every segment on disk, oldest first, with its number and contents.
  nonisolated private static func load() -> [(url: URL, number: Int, text: String)] {
    segments().compactMap { url in
      guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
      return (url, number(of: url), text)
    }
  }

  nonisolated private static func chainSegments(
    _ loaded: [(url: URL, number: Int, text: String)]
  ) -> [AuditChain.Segment] {
    loaded.map {
      AuditChain.Segment(number: $0.number, lines: $0.text.split(separator: "\n").map(String.init))
    }
  }

  /// Verify every segment in order, carrying the head across.
  ///
  /// Off the main actor would be nicer, and it is deliberately not: this runs
  /// when somebody presses a button, and a verifier racing the writer would
  /// report a torn last line as tampering.
  static func verifyAll() -> Summary {
    let loaded = load()
    let verification = AuditChain.verify(segments: chainSegments(loaded))
    var summary = Summary()
    summary.segments = loaded.count
    summary.bytes = loaded.reduce(0) { $0 + size(of: $1.url) }
    summary.records = verification.records
    summary.report.failures = verification.failures
    summary.report.records = verification.records
    summary.report.head = verification.head
    summary.startsAtSegment = verification.startsAtSegment
    return summary
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

    let loaded = Self.load()
    let verification = AuditChain.verify(segments: Self.chainSegments(loaded))
    var described: [AuditChain.SegmentEntry] = []
    var summary = Summary()

    for (offset, segment) in loaded.enumerated() {
      let url = segment.url
      try? FileManager.default.removeItem(at: folder.appendingPathComponent(url.lastPathComponent))
      try FileManager.default.copyItem(
        at: url, to: folder.appendingPathComponent(url.lastPathComponent))
      described.append(
        AuditChain.SegmentEntry(
          name: url.lastPathComponent, records: verification.reports[offset].records,
          sha256: AuditChain.digest(segment.text)))
      summary.segments += 1
      summary.bytes += Self.size(of: url)
    }
    summary.records = verification.records
    summary.report.failures = verification.failures
    summary.report.records = verification.records
    summary.report.head = verification.head
    summary.startsAtSegment = verification.startsAtSegment

    let manifest = AuditChain.manifest(
      app: "Cupertino \(AppInfo.version)", exportedAt: Date(), records: summary.records,
      segments: described, head: verification.head, intact: summary.report.isIntact,
      startsAtSegment: verification.startsAtSegment)
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
    // Before the files go, and synchronously: a record already queued would
    // otherwise land after the deletion and recreate audit-0001.jsonl holding
    // one orphaned record from the log that was just cleared.
    writer.sync { [sink] in sink.close() }
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
