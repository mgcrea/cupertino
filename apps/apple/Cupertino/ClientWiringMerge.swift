import Foundation

/// The part of client wiring that touches somebody else's file, with the app
/// taken out of it: no AppKit, no `Surface`, no `Bundle`, no logging.
///
/// That subtraction is the point. `make wiring-check` compiles this one file
/// beside `scripts/wiring-check.swift` and runs the result, which is the whole
/// test story for a project with no test target. Everything policy-shaped —
/// which clients exist, which key they use, where the bridge lives — stays in
/// `ClientWiring`, which can keep importing AppKit.
enum ClientWiringMerge {
  /// The tail of every `command` this app has ever written into a config.
  static let bridgeSuffix = "/Contents/Helpers/cupertino-bridge"

  // MARK: - Reading

  enum ReadError: LocalizedError {
    case notJSONObject(URL)

    var errorDescription: String? {
      switch self {
      case .notJSONObject(let url):
        return "\(url.lastPathComponent) is not a JSON object; leaving it alone"
      }
    }
  }

  static func readJSON(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    if data.isEmpty { return [:] }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ReadError.notJSONObject(url)
    }
    return object
  }

  /// Whether an entry is one this app wrote, wherever the bundle was at the
  /// time. Deliberately not compared against the current bridge path: an entry
  /// left by a copy that has since moved is exactly the one worth cleaning up.
  static func isOurs(_ entry: Any?) -> Bool {
    guard let entry = entry as? [String: Any],
      let command = entry["command"] as? String
    else { return false }
    return command.hasSuffix(bridgeSuffix)
  }

  // MARK: - Merging

  /// Merge our servers in, leaving everything else untouched.
  ///
  /// `entries` maps server key to the entry to write. `legacy` maps a current
  /// key to the key it replaced, which is removed only when `isOurs` says we
  /// were the ones who wrote it — a third-party server that happens to be
  /// called `apple-mail` is someone else's entry and this has no business
  /// removing it. Migrate rather than duplicate.
  static func merged(
    into root: [String: Any],
    rootKey: String,
    entries: [String: [String: Any]],
    legacy: [String: String],
    remove: Set<String>
  ) -> [String: Any] {
    var root = root
    var servers = root[rootKey] as? [String: Any] ?? [:]
    for (key, entry) in entries {
      servers[key] = entry
      if let previous = legacy[key], isOurs(servers[previous]) {
        servers.removeValue(forKey: previous)
      }
    }
    // Removal is gated twice: never a key we have just written, and never one
    // that is not ours. The second is the same rule the legacy migration above
    // follows, for the same reason — a third-party server that happens to be
    // called `cupertino-safari` is somebody else's entry and this has no
    // business deleting it.
    //
    // Note what `isOurs` does NOT check: the current bundle path. An entry left
    // by a copy of the app that has since moved is still ours to clean up, and
    // that is deliberate — it is also the entry most worth cleaning up.
    for key in remove where entries[key] == nil && isOurs(servers[key]) {
      servers.removeValue(forKey: key)
    }
    root[rootKey] = servers
    return root
  }

  // MARK: - Auditing

  /// What a status check concludes from a servers object alone.
  ///
  /// Deliberately not `ClientWiring.Status`: the cases missing here —
  /// `notInstalled`, `unreadable`, `unknown` — are all facts about I/O, and
  /// this file does none it was not handed a URL for.
  enum Audit: Equatable {
    case configured
    case notConfigured
    /// Present, but pointing somewhere else — usually a previous build.
    case stale(String)
    /// Wired for some surfaces and not others — what an existing config looks
    /// like the day a new surface ships.
    case incomplete([String])
    /// Wired for a surface that has since been switched off. Ours, still in the
    /// file, and still costing tool definitions in every session that reads it —
    /// which is the exact cost switching a surface off is meant to remove.
    case extra([String])
  }

  /// `expected` is the server key paired with the human label to name in
  /// `.incomplete`, in the order the labels should read.
  static func audit(
    servers: [String: Any],
    expectedCommand: String,
    expected: [(key: String, label: String)],
    unexpected: [(key: String, label: String)]
  ) -> Audit {
    var missing: [String] = []
    for (key, label) in expected {
      guard let entry = servers[key] as? [String: Any] else {
        missing.append(label)
        continue
      }
      if (entry["command"] as? String) != expectedCommand {
        return .stale((entry["command"] as? String) ?? "unknown")
      }
    }
    // Handed in rather than derived by scanning for `isOurs` keys absent from
    // `expected`. That scan would flag `cupertino-<a surface this build has
    // never heard of>` — written by a NEWER copy of the app — as junk, which is
    // reporting an entry as stale because the reader is out of date.
    //
    // Only `isOurs` entries count, so a third-party squatter never puts a client
    // into a state whose Update button would have nothing to do.
    let stale = unexpected.filter { isOurs(servers[$0.key]) }.map(\.label)
    // A partially wired config used to report `.configured`, because any one
    // matching entry was enough. That made every new surface invisible to
    // everyone who had already configured the client — a green check beside a
    // config that would never gain the new server.
    if missing.count == expected.count && stale.isEmpty { return .notConfigured }
    // Missing wins over extra when both are true. A missing server breaks a tool
    // call; an extra one only costs an assistant definitions it will never use.
    // The same Update button fixes both in one write, so the row loses nothing
    // by naming the worse fault.
    if !missing.isEmpty { return .incomplete(missing) }
    return stale.isEmpty ? .configured : .extra(stale)
  }

  // MARK: - Writing

  enum WriteError: LocalizedError {
    /// The file moved on between the read and the swap, so the merge in hand
    /// was computed from bytes that are no longer there.
    case changedUnderneath(URL)

    var errorDescription: String? {
      switch self {
      case .changedUnderneath(let url):
        return "\(url.lastPathComponent) changed while it was being read; nothing was written"
      }
    }
  }

  /// What a config looked like when the caller read it, so the write can refuse
  /// to land a merge computed from bytes somebody has since replaced.
  ///
  /// Size and modification date rather than a hash of the contents: the largest
  /// of these files is 130 KB and this runs on every Configure, while the only
  /// question being asked is "did anything touch it", which two `stat` fields
  /// answer for free.
  ///
  /// `absent` is a state and not an error. A file that does not exist yet is
  /// exactly as legitimate a precondition as one that does — and a config
  /// created in the window between the two is precisely what this is for.
  enum Stamp: Equatable {
    case absent
    case present(size: Int, modified: Date)
  }

  /// `FileManager`, deliberately, and not `URL.resourceValues`: an `NSURL`
  /// caches the values it has already been asked for, so two stamps taken from
  /// the same `URL` around a write come back identical and the precondition
  /// this exists for silently passes. Measured — the first version of this
  /// function did exactly that.
  static func stamp(of url: URL) -> Stamp {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      let size = attributes[.size] as? Int, let modified = attributes[.modificationDate] as? Date
    else { return .absent }
    return .present(size: size, modified: modified)
  }

  /// Backup, atomic temp, swap. Returns the backup URL if one was made.
  ///
  /// Three properties this has to hold, because the file belongs to someone
  /// else: every unrelated key survives, the previous contents are recoverable,
  /// and a crash mid-write cannot leave a truncated config.
  ///
  /// `expecting` narrows a fourth risk without pretending to eliminate it. A
  /// mismatch means the file changed since the caller read it, and the merge in
  /// hand would silently drop that change; the caller re-reads and tries again.
  /// What it CANNOT do is win against a process holding its own snapshot of the
  /// whole file — Claude Code keeps one for the length of a session and writes
  /// it back on its own schedule. Nothing short of a lock neither side takes
  /// would fix that, and `claude mcp add` does not take one either. It is a
  /// narrower window, not a closed one, which is why the audit that notices a
  /// clobbered write matters more than this does.
  ///
  /// `newFileMode` applies only when this call is the one creating the file.
  /// Replacing an existing one already preserves its mode — `replaceItemAt`
  /// keeps the original's metadata unless asked not to, measured at 0600 in and
  /// 0600 out — so the only way to loosen a config is to be the one that made
  /// it, and the per-user client configs are all files that should be 0600
  /// whether or not they hold credentials today.
  @discardableResult
  static func write(
    _ root: [String: Any],
    to url: URL,
    backupSuffix: String,
    expecting: Stamp? = nil,
    newFileMode: Int? = nil
  ) throws -> URL? {
    let fm = FileManager.default
    var backup: URL?

    if let expecting, stamp(of: url) != expecting { throw WriteError.changedUnderneath(url) }

    let existed = fm.fileExists(atPath: url.path)
    if existed {
      backup = url.appendingPathExtension(backupSuffix)
      try? fm.removeItem(at: backup!)
      try fm.copyItem(at: url, to: backup!)
    } else {
      try fm.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    let data = try JSONSerialization.data(
      withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])

    // Write beside the target, then swap: a config half-written because the
    // machine slept is worse than one not written at all.
    let temp = url.deletingLastPathComponent()
      .appendingPathComponent(".cupertino-\(UUID().uuidString).tmp")
    try data.write(to: temp, options: .atomic)
    do {
      _ = try fm.replaceItemAt(url, withItemAt: temp)
    } catch {
      // `replaceItemAt` consumes the temp on success only. A failure here would
      // otherwise leave a dotfile in someone's config directory forever.
      try? fm.removeItem(at: temp)
      throw error
    }
    if !existed, let newFileMode {
      try? fm.setAttributes([.posixPermissions: newFileMode], ofItemAtPath: url.path)
    }
    return backup
  }

  /// The servers a Claude Code **local**-scope entry holds for one folder.
  ///
  /// Lives here rather than next to the policy that calls it because it is the
  /// only genuinely new reading this feature added, and `make wiring-check` can
  /// only reach what compiles against Foundation alone.
  ///
  /// Two shapes mean two different things and must not collapse into one:
  /// `nil` is "this folder has no entry at all", while an empty dictionary is
  /// "Claude Code knows this folder and no Cupertino server is in it". The
  /// first is a folder nobody has wired; the second is one that was wired and
  /// then emptied, or wired for a different tool entirely. `audit` gives a
  /// useful answer for the second and a misleading one for the first.
  static func localScopeServers(in root: [String: Any], folder: String) -> [String: Any]? {
    guard let projects = root["projects"] as? [String: Any] else { return nil }
    guard let entry = projects[folder] as? [String: Any] else { return nil }
    return entry["mcpServers"] as? [String: Any] ?? [:]
  }

  /// Merge into one folder's local scope, leaving the other ninety-eight
  /// project blocks and the seventy-six top-level keys beside them alone.
  ///
  /// Written as an explicit read-modify-write of two nested dictionaries rather
  /// than the obvious `root["projects"]![folder]!["mcpServers"]` chain, because
  /// Swift dictionaries are value types and that chain operates on copies. The
  /// bug it produces is a write that reports success and changes nothing.
  ///
  /// A folder Claude Code has never heard of gets a block holding nothing but
  /// `mcpServers`. That is the same shape `claude mcp add --scope local` leaves
  /// behind, and Claude Code fills in the rest of its own keys when it next
  /// opens the folder.
  static func mergedIntoLocalScope(
    into root: [String: Any],
    folder: String,
    entries: [String: [String: Any]],
    legacy: [String: String],
    remove: Set<String>
  ) -> [String: Any] {
    var root = root
    var projects = root["projects"] as? [String: Any] ?? [:]
    let project = projects[folder] as? [String: Any] ?? [:]
    projects[folder] = merged(
      into: project, rootKey: "mcpServers", entries: entries, legacy: legacy, remove: remove)
    root["projects"] = projects
    return root
  }
}
