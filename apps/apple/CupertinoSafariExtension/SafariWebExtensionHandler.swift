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

  /// How long a command result survives uncollected.
  ///
  /// Much shorter than a capture's half hour. A result is correlated to one
  /// in-flight tool call; if the server has not collected it within a minute it
  /// has already timed out and reported, and keeping the answer longer would
  /// only leave a record of what was clicked lying on disk.
  private static let channelTTL: TimeInterval = 60

  func beginRequest(with context: NSExtensionContext) {
    let item = context.inputItems.first as? NSExtensionItem
    let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

    var payload: [String: Any] = ["stored": false]
    switch message?["kind"] as? String {
    case "capture":
      payload = ["stored": store(message ?? [:])]
    case "poll":
      // The command channel's only inbound step. Commands are claimed as they
      // are handed out — see `claimCommands` — so two tabs on the same URL
      // cannot both run one.
      payload = ["commands": claimCommands(for: message?["url"] as? String ?? "")]
    case "result":
      payload = ["stored": storeResult(message ?? [:])]
    default:
      break
    }

    let response = NSExtensionItem()
    response.userInfo = [SFExtensionMessageKey: payload]
    context.completeRequest(returningItems: [response], completionHandler: nil)
  }

  // MARK: - The command channel

  /// Where the server drops work and collects answers.
  ///
  /// Two directories rather than one, because the two have opposite writers and
  /// opposite readers: the server writes `commands` and reads `results`, this
  /// handler reads `commands` and writes `results`. A single directory would
  /// make "not yet picked up" and "picked up, no answer yet" the same state.
  ///
  /// Both sit beside `pages` in this appex's container, for the reason that
  /// store gives: an unsandboxed same-user process can read and write here with
  /// no Full Disk Access and no app group, so nothing in this lane needs a
  /// permission or a new entitlement. Measured in both directions.
  private func channelDirectory(_ name: String) -> URL? {
    let fm = FileManager.default
    guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    else { return nil }
    let dir = support.appendingPathComponent(name, isDirectory: true)
    if !fm.fileExists(atPath: dir.path) {
      try? fm.createDirectory(
        at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    return dir
  }

  /// Hand out the commands waiting for this page, and delete them as we do.
  ///
  /// CLAIMED BY DELETION, which is the whole concurrency design. Every allowed
  /// page polls on its own timer, so without this two tabs on the same URL
  /// would each run the same click. Deleting on hand-out makes a command
  /// at-most-once: if the page dies before reporting, the command is simply
  /// lost and the server times out — which is the honest outcome, because a
  /// click that MIGHT have happened must never be retried automatically.
  ///
  /// A command with no `url` is unscoped and goes to whoever polls first. That
  /// is deliberate for `elements`-style questions about "the page", and it is
  /// why the server names a URL for anything that acts.
  private func claimCommands(for url: String) -> [[String: Any]] {
    guard let dir = channelDirectory("commands") else { return [] }
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
    else { return [] }

    var claimed: [[String: Any]] = []
    for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
    where file.pathExtension == "json" {
      guard let data = try? Data(contentsOf: file),
        let object = try? JSONSerialization.jsonObject(with: data),
        let command = object as? [String: Any]
      else {
        // Unreadable or not ours. Remove it rather than reading it forever:
        // this directory is a queue, and a poison entry must not survive to be
        // re-examined on every poll by every page.
        try? fm.removeItem(at: file)
        continue
      }

      if let expiry = command["expiresAt"] as? Double,
        Date().timeIntervalSince1970 > expiry
      {
        try? fm.removeItem(at: file)
        continue
      }

      let wanted = command["url"] as? String
      guard wanted == nil || wanted == url else { continue }

      try? fm.removeItem(at: file)
      claimed.append(command)
      // One per poll. A page that has just been clicked is a page whose DOM has
      // moved, so element ids from before that click may no longer resolve —
      // running a batch would be running most of it against a page that no
      // longer matches what the caller was looking at.
      break
    }
    return claimed
  }

  /// Record what a page did, for the server to collect.
  private func storeResult(_ message: [String: Any]) -> Bool {
    guard let dir = channelDirectory("results"),
      let id = message["id"] as? String, !id.isEmpty,
      // The id names a file, so it must not be able to name a DIFFERENT file.
      // The server generates these, but this handler is reachable by anything
      // the extension runs, and a traversal here would write outside the
      // container.
      id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" })
    else { return false }

    var entry: [String: Any] = [
      "id": id,
      "completedAt": ISO8601DateFormatter().string(from: Date()),
      "ok": (message["ok"] as? Bool) ?? false,
    ]
    if let data = message["data"] { entry["data"] = data }
    if let error = message["error"] { entry["error"] = error }
    if let version = message["extensionVersion"] as? String { entry["extensionVersion"] = version }

    guard JSONSerialization.isValidJSONObject(entry),
      let data = try? JSONSerialization.data(withJSONObject: entry)
    else { return false }

    let file = dir.appendingPathComponent(id + ".json")
    do {
      try data.write(to: file, options: .atomic)
    } catch {
      os_log(.error, "cupertino: could not store a result: %{public}@", String(describing: error))
      return false
    }
    pruneChannel(dir)
    return true
  }

  /// Results are collected by a server that may have gone away. Age them out on
  /// the same reasoning as a capture: an answer nobody came back for is not
  /// worth keeping, and this one describes a page too.
  private func pruneChannel(_ dir: URL) {
    let fm = FileManager.default
    guard
      let files = try? fm.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [])
    else { return }
    let now = Date()
    for file in files where file.pathExtension == "json" {
      let modified =
        (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        ?? .distantPast
      if now.timeIntervalSince(modified) > Self.channelTTL { try? fm.removeItem(at: file) }
    }
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

    var entry: [String: Any] = [
      "url": url,
      "title": message["title"] as? String ?? "",
      "capturedAt": ISO8601DateFormatter().string(from: Date()),
      "text": text,
      "html": html,
      "textTruncated": textTruncated,
      "htmlTruncated": htmlTruncated,
    ]
    // The version of the code that actually ran in the page, as the content
    // script reported it — NOT this handler's. The two can differ: an update
    // replaces the appex immediately while an already-open tab keeps running
    // the previous content script, and it is that tab the server needs to
    // identify. Absent when the content script could not reach its own runtime,
    // which is itself the orphaned state.
    if let version = message["extensionVersion"] as? String { entry["extensionVersion"] = version }

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
