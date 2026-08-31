import CryptoKit
import Foundation
import SafariServices
import os.log

/// Where a captured page lands, and the only reason this extension has native
/// code at all.
///
/// ## Why a file, and why this file
///
/// The MCP server cannot be reached directly. It is a node process the app
/// spawns per connection, configured entirely through its environment at
/// `posix_spawn` time — there is no channel for the app, let alone an
/// extension, to push anything into a running one. See `ServerHost.run`.
///
/// So the hand-off is a store on disk, which is the idiom every other surface
/// here already uses. It lives in this extension's own container because an
/// appex is sandboxed and that is the one place it may write. Measured: the
/// container is `drwx------` owned by the user and is NOT TCC-protected, so the
/// unsandboxed node server reads it without a grant. The alternative, an app
/// group, would mean adding an entitlement to Cupertino.app — and
/// docs/distribution.md records that its identity is "the most expensive string
/// in the project: changing it is a new TCC identity, so every existing user
/// re-grants Full Disk Access".
///
/// ## Why it is bounded, and bounded tightly
///
/// This is page content at rest, in a directory any same-user process can read.
/// That is a materially larger footprint than the URLs and titles the rest of
/// this surface handles, so the store keeps as little as it can while still
/// being useful: a few recent pages, briefly.
@available(macOS 11.0, *)
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

  /// Entries older than this are deleted on the next write.
  ///
  /// Short on purpose. A capture is for answering "what is on the page I am
  /// looking at", which is a question about now; anything older is browsing
  /// history sitting on disk in cleartext, which is not what this is for.
  private static let ttl: TimeInterval = 30 * 60

  /// How many pages are kept at once. Eviction is oldest-first.
  private static let maxEntries = 20

  /// Per-capture caps. Truncation is recorded in the entry rather than hidden,
  /// so the server can say a page was cut rather than implying it ended.
  private static let maxTextBytes = 256 * 1024
  private static let maxHTMLBytes = 1024 * 1024

  func beginRequest(with context: NSExtensionContext) {
    let item = context.inputItems.first as? NSExtensionItem
    let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

    var stored = false
    if let message, (message["kind"] as? String) == "capture" {
      stored = store(message)
    }

    let response = NSExtensionItem()
    response.userInfo = [SFExtensionMessageKey: ["stored": stored]]
    context.completeRequest(returningItems: [response], completionHandler: nil)
  }

  /// The store's directory, created on first use.
  ///
  /// `.applicationSupportDirectory` inside a sandboxed extension resolves to
  /// this appex's container, never to the user's real Application Support.
  private var pagesDirectory: URL? {
    let fm = FileManager.default
    guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    else { return nil }
    let dir = support.appendingPathComponent("pages", isDirectory: true)
    if !fm.fileExists(atPath: dir.path) {
      try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [
        // The container is already 0700, but a store of page content should not
        // rely on the enclosing directory for that.
        .posixPermissions: 0o700
      ])
    }
    return dir
  }

  /// One file per URL, named by its digest.
  ///
  /// Keyed by URL rather than by time, so re-visiting a page overwrites its
  /// entry instead of accumulating one per visit — the freshest capture of a
  /// page is the only one worth keeping, and it makes "newest wins" free.
  private func filename(for url: String) -> String {
    let digest = SHA256.hash(data: Data(url.utf8))
    return digest.map { String(format: "%02x", $0) }.joined() + ".json"
  }

  private func store(_ message: [String: Any]) -> Bool {
    guard let dir = pagesDirectory,
      let url = message["url"] as? String, !url.isEmpty
    else { return false }

    let (text, textTruncated) = clamp(message["text"] as? String ?? "", to: Self.maxTextBytes)
    let (html, htmlTruncated) = clamp(message["html"] as? String ?? "", to: Self.maxHTMLBytes)

    let entry: [String: Any] = [
      "url": url,
      "title": message["title"] as? String ?? "",
      "capturedAt": ISO8601DateFormatter().string(from: Date()),
      "text": text,
      "html": html,
      "textTruncated": textTruncated,
      "htmlTruncated": htmlTruncated,
    ]

    guard let data = try? JSONSerialization.data(withJSONObject: entry) else { return false }
    let file = dir.appendingPathComponent(filename(for: url))
    do {
      try data.write(to: file, options: .atomic)
    } catch {
      os_log(.error, "cupertino: could not store a capture: %{public}@", String(describing: error))
      return false
    }

    prune(dir, keeping: file)
    return true
  }

  /// Truncate on a BYTE budget without splitting a character.
  ///
  /// The cap exists to bound what sits on disk, and a page is arbitrary UTF-8 —
  /// cutting a `String` by count would let a page of emoji or CJK blow past the
  /// budget by a factor of four.
  private func clamp(_ value: String, to limit: Int) -> (String, Bool) {
    let data = Data(value.utf8)
    guard data.count > limit else { return (value, false) }
    // Walk back to the last valid boundary: cutting mid-sequence yields nil,
    // and at most three bytes are ever discarded.
    var cut = data.prefix(limit)
    while !cut.isEmpty, String(data: cut, encoding: .utf8) == nil {
      cut = cut.dropLast()
    }
    return (String(data: cut, encoding: .utf8) ?? "", true)
  }

  /// Enforce the TTL and the entry cap. Runs on every write, so the store never
  /// grows between captures and a machine left alone sheds content on the next
  /// one rather than keeping it indefinitely.
  private func prune(_ dir: URL, keeping: URL) {
    let fm = FileManager.default
    guard
      let files = try? fm.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [])
    else { return }

    let now = Date()
    var dated: [(URL, Date)] = []
    for file in files where file.pathExtension == "json" {
      let modified =
        (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        ?? .distantPast
      if now.timeIntervalSince(modified) > Self.ttl, file != keeping {
        try? fm.removeItem(at: file)
      } else {
        dated.append((file, modified))
      }
    }

    guard dated.count > Self.maxEntries else { return }
    for (file, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(dated.count - Self.maxEntries)
    where file != keeping {
      try? fm.removeItem(at: file)
    }
  }
}
