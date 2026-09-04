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

  /// Where an entry points, whichever shape it is.
  ///
  /// `command` first, then `url`. Cupertino only ever writes a `command`, so the
  /// `url` half exists purely to *describe* entries it did not write: a Claude
  /// Code config legitimately holds `{"type": "http", "url": ...}` blocks, and a
  /// list of other people's servers that rendered one of those as "no command"
  /// would be describing the file wrongly. `isOurs` stays command-only — reading
  /// a url here never widens what this app claims as its own.
  static func identity(of entry: Any?) -> String? {
    guard let entry = entry as? [String: Any] else { return nil }
    if let command = entry["command"] as? String { return command }
    if let url = entry["url"] as? String { return url }
    return nil
  }

  /// An entry in a client's config that this app did not write.
  ///
  /// `identity` is nil for a shape carrying neither `command` nor `url` — hand
  /// written and malformed, or a key holding a bare string. Listed anyway, on
  /// purpose: it is in the file, it is not ours, and a view that silently skipped
  /// it would be lying about what the file holds.
  struct ForeignEntry: Equatable {
    let key: String
    let identity: String?
  }

  /// Everything under a servers object that `isOurs` does not claim, by key.
  ///
  /// Deliberately the same predicate the removal gate uses, so a Remove button
  /// fed from this list can never appear beside an entry `removing` would refuse.
  /// An `apple-mail` written by an older Cupertino is ours and does not appear
  /// here; a third-party server that happens to be called `apple-mail` does.
  static func foreignEntries(in servers: [String: Any]) -> [ForeignEntry] {
    servers.keys.sorted()
      .filter { !isOurs(servers[$0]) }
      .map { ForeignEntry(key: $0, identity: identity(of: servers[$0])) }
  }

  /// The same question asked of every `projects[<dir>].mcpServers` block.
  ///
  /// Named for LOCAL SCOPE rather than for projects, because both words are
  /// already taken here and mean different files: `project` scope is
  /// `<dir>/.mcp.json`, and `local` scope is the block inside Claude Code's own
  /// config. See `ClientWiring.ProjectScope`.
  ///
  /// Folders sorted, and a folder with nothing foreign in it dropped rather than
  /// listed empty — the config this was written against holds ninety-eight of
  /// them, and twelve have ever called a tool.
  static func foreignLocalScopeEntries(
    in root: [String: Any]
  ) -> [(folder: String, entries: [ForeignEntry])] {
    guard let projects = root["projects"] as? [String: Any] else { return [] }
    return projects.keys.sorted().compactMap { folder in
      guard let servers = localScopeServers(in: root, folder: folder) else { return nil }
      let foreign = foreignEntries(in: servers)
      return foreign.isEmpty ? nil : (folder: folder, entries: foreign)
    }
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

  /// Remove every entry this app wrote under `rootKey`, and nothing else.
  ///
  /// The counterpart to `merged`, and the reason `isOurs` is narrow: unwiring
  /// must never be a way to delete somebody's config. It reaches an entry left by
  /// a copy of the app that has since moved, and an `apple-<surface>` key from
  /// before the rename, for the same reason `merged`'s removal gate does — both
  /// are ours, and both are exactly what is worth cleaning up.
  ///
  /// User scope only. The `projects` blocks are a different scope with a
  /// different button, and a Remove on a client row that silently emptied
  /// ninety-eight folders would be doing far more than it says.
  static func unmerged(from root: [String: Any], rootKey: String) -> [String: Any] {
    var root = root
    guard var servers = root[rootKey] as? [String: Any] else { return root }
    // Keys collected before anything is removed. Mutating a dictionary while
    // iterating it is legal here — the loop holds its own copy — and it is the
    // kind of legal that stops being obvious the moment somebody edits it.
    for key in servers.keys.filter({ isOurs(servers[$0]) }) {
      servers.removeValue(forKey: key)
    }
    // Assigned back even when the removal emptied it: absent and empty are
    // different statements about a config — see `localScopeServers` — and this
    // has no business inventing the difference in either direction.
    root[rootKey] = servers
    return root
  }

  /// Remove one named entry, and nothing else.
  ///
  /// Deliberately REFUSES a key `isOurs` claims. Taking Cupertino's own entries
  /// out is `unmerged`, which knows about the whole set; this is the path for a
  /// server somebody configured by hand and has since replaced with one of ours,
  /// and the two must not be reachable from each other.
  ///
  /// A key that is absent — or that turns out to be ours because the file moved
  /// on under the caller — is a no-op rather than an error. There is nothing to
  /// undo, and nothing to say about it that the caller did not already know.
  static func removing(key: String, from root: [String: Any], rootKey: String) -> [String: Any] {
    var root = root
    guard var servers = root[rootKey] as? [String: Any] else { return root }
    guard servers[key] != nil, !isOurs(servers[key]) else { return root }
    servers.removeValue(forKey: key)
    root[rootKey] = servers
    return root
  }

  /// The same, inside one `projects[<dir>]` block, leaving the other
  /// ninety-seven alone.
  ///
  /// Explicit read-modify-write for the reason `mergedIntoLocalScope` spells out:
  /// Swift dictionaries are value types, and the obvious
  /// `root["projects"]![folder]!["mcpServers"]` chain edits copies and reports
  /// success having changed nothing.
  static func removing(
    key: String, inLocalScope folder: String, from root: [String: Any]
  ) -> [String: Any] {
    var root = root
    guard var projects = root["projects"] as? [String: Any],
      let project = projects[folder] as? [String: Any]
    else { return root }
    projects[folder] = removing(key: key, from: project, rootKey: "mcpServers")
    root["projects"] = projects
    return root
  }

  /// Every entry of ours out of one folder's local scope.
  ///
  /// The unwire the folder list never had: `ClientWiring.forget` drops a folder
  /// from `UserDefaults` and leaves its entries sitting in Claude Code's config,
  /// where they go on costing every session opened there a tool list it cannot
  /// use.
  static func unmergedFromLocalScope(from root: [String: Any], folder: String) -> [String: Any] {
    var root = root
    guard var projects = root["projects"] as? [String: Any],
      let project = projects[folder] as? [String: Any]
    else { return root }
    projects[folder] = unmerged(from: project, rootKey: "mcpServers")
    root["projects"] = projects
    return root
  }

  /// The keys among `keys` that somebody else's entry already occupies.
  ///
  /// The predicate behind Configure's refusal, here rather than beside the
  /// policy that calls it for one reason: this file is the half `make
  /// wiring-check` can reach. A refusal that has never been exercised is a
  /// refusal that fires for the first time on somebody's real config.
  ///
  /// An absent key is not a collision, and neither is one of ours — including
  /// one written by a copy of the app that has since moved, which Configure is
  /// about to rewrite in place.
  static func collisions(servers: [String: Any], keys: [String]) -> [String] {
    keys.filter { servers[$0] != nil && !isOurs(servers[$0]) }.sorted()
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

  /// What is under **one** key, against what should be there.
  ///
  /// `Audit` is this reduced over every expected entry, and a pane that draws a
  /// row per surface needs the un-reduced form: "points elsewhere —
  /// /Users/x/Downloads/Cupertino.app/..." spread across ten identical rows says
  /// nothing about which of the ten it is talking about.
  enum EntryState: Equatable {
    /// No entry under that key — or something there that is not an object at
    /// all, which nothing downstream could read as a server anyway.
    case missing
    /// Ours, and pointing at the bridge we would write.
    case matches
    /// Ours, pointing somewhere else — almost always a previous build, or a copy
    /// of the app that has moved. Carries where it points now.
    case stale(String)
    /// Present, and not ours. Carries where it points, or nil for a shape with
    /// neither a `command` nor a `url`.
    ///
    /// Unlike the two above it is not a fault in the wiring: it is somebody
    /// else's server sitting under a name this app wants. What happens next is
    /// policy rather than arithmetic — see `ClientWiring.collisions`.
    case foreign(String?)
  }

  /// Compared against `expectedCommand` — `ClientWiring.bridgePath` — and never
  /// against `args`.
  ///
  /// Checking the `--server=<id>` as well is cheap, and it would catch a
  /// hand-edited `cupertino-mail` reaching `--server=notes`. It is left out
  /// because the key is derived from the surface id rather than chosen by
  /// anybody: no path through this app produces that pair, so the check would
  /// only ever fire on a file somebody edited themselves — and it has no remedy
  /// to offer them that Configure does not already offer.
  static func state(of servers: [String: Any], key: String, expectedCommand: String) -> EntryState {
    guard let entry = servers[key] as? [String: Any] else { return .missing }
    let found = identity(of: entry)
    // Equality with the command we would write comes FIRST, and decides on its
    // own. `isOurs` is a suffix test, and its job is recognising entries written
    // by a copy of the app that has since moved; an entry already reaching the
    // exact command in hand needs no such inference. Asking the suffix first
    // makes the verdict depend on where the bundle happens to live, which is the
    // one thing this comparison is not about.
    if let found, found == expectedCommand { return .matches }
    guard isOurs(entry) else { return .foreign(found) }
    return .stale(found ?? "unknown")
  }

  /// The same conclusion as the `audit` below, from states already computed.
  ///
  /// Split out so the badge on a row and the sentence in a header are two
  /// renderings of ONE computation rather than two implementations of one rule,
  /// which is how they end up disagreeing about a file neither of them owns.
  ///
  /// `leftover` is handed in rather than folded out of `states`, and it has to
  /// be: an entry for a switched-off surface is filed under a key that is not in
  /// `expected` at all, so nothing computes a state for it and `.extra` would be
  /// unreachable from the fold.
  static func audit(
    states: [(key: String, label: String, state: EntryState)],
    leftover: [String]
  ) -> Audit {
    var missing: [String] = []
    for entry in states {
      switch entry.state {
      case .missing:
        missing.append(entry.label)
      case .matches:
        continue
      // The first in order wins, and it outranks everything below: a config
      // pointing at a bundle that has moved is one write away from working, and
      // the path it found is the only useful thing to say about it.
      case .stale(let found):
        return .stale(found)
      // Folded into `.stale` rather than given a verdict of its own. A
      // whole-file `.collides` would be a state with no button behind it — the
      // refusal lives in `ClientWiring`, and the ROW is where "taken" is worth
      // saying, because that is the only place it can name which key.
      case .foreign(let what):
        return .stale(what ?? "unknown")
      }
    }
    // A partially wired config used to report `.configured`, because any one
    // matching entry was enough. That made every new surface invisible to
    // everyone who had already configured the client — a green check beside a
    // config that would never gain the new server.
    if missing.count == states.count && leftover.isEmpty { return .notConfigured }
    // Missing wins over extra when both are true. A missing server breaks a tool
    // call; an extra one only costs an assistant definitions it will never use.
    // The same Update button fixes both in one write, so the row loses nothing
    // by naming the worse fault.
    if !missing.isEmpty { return .incomplete(missing) }
    return leftover.isEmpty ? .configured : .extra(leftover)
  }

  /// `expected` is the server key paired with the human label to name in
  /// `.incomplete`, in the order the labels should read.
  ///
  /// A forwarder over `state` since the detail pane landed. It keeps its
  /// signature because `ClientWiring` and `wiring-check` both call it, and it
  /// keeps its answers because sections 4, 5 and 5c of that script were written
  /// against the loop this replaced.
  static func audit(
    servers: [String: Any],
    expectedCommand: String,
    expected: [(key: String, label: String)],
    unexpected: [(key: String, label: String)]
  ) -> Audit {
    audit(
      states: expected.map {
        (
          key: $0.key, label: $0.label,
          state: state(of: servers, key: $0.key, expectedCommand: expectedCommand)
        )
      },
      // Handed in rather than derived by scanning for `isOurs` keys absent from
      // `expected`. That scan would flag `cupertino-<a surface this build has
      // never heard of>` — written by a NEWER copy of the app — as junk, which is
      // reporting an entry as stale because the reader is out of date.
      //
      // Only `isOurs` entries count, so a third-party squatter never puts a client
      // into a state whose Update button would have nothing to do.
      leftover: unexpected.filter { isOurs(servers[$0.key]) }.map(\.label))
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
    try write(
      JSONSerialization.data(
        withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
      to: url, backupSuffix: backupSuffix, expecting: expecting, newFileMode: newFileMode)
  }

  /// The same write, given bytes somebody else produced.
  ///
  /// Split out when the TOML client landed. A spliced `config.toml` is not
  /// serialised from a dictionary — the whole point of `ClientWiringTOML` is that
  /// it never re-encodes the file — so it arrives here as text. Everything below
  /// this line is identical for both, which is what stops the format from
  /// reaching any further into the app than the two functions that open and
  /// close a file.
  @discardableResult
  static func write(
    _ data: Data,
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
