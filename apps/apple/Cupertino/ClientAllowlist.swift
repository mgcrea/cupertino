import Foundation

/// Whether Claude Code will load an entry Cupertino wrote, given the
/// `allowedMcpServers` and `deniedMcpServers` in its settings.
///
/// Claude Code hides a server its allowlist refuses: it is missing from `/mcp`
/// and `claude mcp list`, with nothing saying why. So a surface Cupertino wired
/// correctly can be absent from every session, and the config file alone says
/// it is fine. The list is usually Bastion's (its "Only Bastion" switch builds
/// one from `.claude.json`), but anybody can write one by hand.
///
/// The rules, from Claude Code's managed-MCP documentation:
///
/// - The lists from every settings scope are one list. Unset allows
///   everything; an empty list allows nothing.
/// - `allowManagedMcpServersOnly` in managed settings drops the user's
///   allowlist, never its denylist.
/// - A stdio server passes on a `serverCommand` equal to its command and args,
///   in order, `env` ignored. A `serverName` counts only while the merged list
///   holds no `serverCommand` at all. A `serverUrl` never admits one.
/// - A remote server mirrors that with URLs: once the merged list holds any
///   `serverUrl`, it passes only on a pattern its `url` matches (`*` matches
///   anything), and its `serverName` no longer counts. Without one, it is
///   matched by name. A `serverCommand` never admits one.
/// - A denylist match wins over everything: by name, by command for a stdio
///   server, by URL pattern for a remote one.
///
/// Only the user's `settings.json` and managed settings are read. A project's
/// own settings merge into the same lists, so inside one repository a list can
/// be wider or narrower than this says. `${VAR}` expansion is not modelled;
/// Cupertino's entries carry none.
///
/// Foundation only, so `make wiring-check` runs it against fixtures.
nonisolated enum ClientAllowlist {
  static let allowedKey = "allowedMcpServers"
  static let deniedKey = "deniedMcpServers"
  static let managedOnlyKey = "allowManagedMcpServersOnly"

  /// `~/.claude/settings.json`, for the default profile Cupertino wires.
  static var userSettingsURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".claude/settings.json")
  }

  static let managedSettingsURL = URL(
    fileURLWithPath: "/Library/Application Support/ClaudeCode/managed-settings.json")

  struct Policy {
    /// Nil when no scope sets an allowlist, which allows everything.
    let allowed: [[String: Any]]?
    let deniedByUser: [[String: Any]]
    let deniedByManaged: [[String: Any]]
    /// `allowManagedMcpServersOnly`: nothing in the user's file can admit a
    /// server, so the only remedy is whoever manages the Mac.
    let isManagedOnly: Bool
    /// The user's list holds Bastion's wildcard, so Bastion maintains it.
    let isBastions: Bool

    /// Whether a `serverName` rule still counts. One `serverCommand` anywhere
    /// in the merged list stops every stdio server passing by name.
    var matchesByCommand: Bool { allowed?.contains { $0["serverCommand"] != nil } == true }

    /// The same for remote servers: one `serverUrl` anywhere in the merged
    /// list stops every URL server passing by name.
    var matchesByURL: Bool { allowed?.contains { $0["serverUrl"] != nil } == true }
  }

  enum Verdict: Equatable {
    case allowed
    /// An allowlist is set and nothing in it admits the entry.
    case notAllowed
    /// The denylist names it. Nothing overrides that. `inManaged` when a
    /// managed entry names it, which the user's file cannot lift.
    case denied(inManaged: Bool)
  }

  static func policy(user: [String: Any], managed: [String: Any]) -> Policy {
    let managedOnly = managed[managedOnlyKey] as? Bool == true
    let allowLists = [
      managed[allowedKey] as? [Any], managedOnly ? nil : user[allowedKey] as? [Any],
    ]
    .compactMap { $0 }
    let userAllowed = user[allowedKey] as? [Any] ?? []
    return Policy(
      allowed: allowLists.isEmpty ? nil : allowLists.flatMap(objects),
      deniedByUser: objects(user[deniedKey] as? [Any] ?? []),
      deniedByManaged: objects(managed[deniedKey] as? [Any] ?? []),
      isManagedOnly: managedOnly,
      isBastions: !managedOnly && userAllowed.contains(where: isBastionWildcard))
  }

  /// An entry with neither a command nor a URL is not this check's to judge,
  /// and reads as allowed.
  static func verdict(key: String, entry: Any?, policy: Policy) -> Verdict {
    if let url = url(of: entry) { return verdict(key: key, url: url, policy: policy) }
    guard let command = command(of: entry) else { return .allowed }
    func matches(_ rule: [String: Any]) -> Bool {
      if let name = rule["serverName"] as? String { return name == key }
      if let ruleCommand = rule["serverCommand"] as? [String] { return ruleCommand == command }
      return false
    }
    if policy.deniedByManaged.contains(where: matches) { return .denied(inManaged: true) }
    if policy.deniedByUser.contains(where: matches) { return .denied(inManaged: false) }
    guard let allowed = policy.allowed else { return .allowed }
    let admitted = allowed.contains { rule in
      if rule["serverCommand"] != nil { return matches(rule) }
      if rule["serverName"] != nil { return !policy.matchesByCommand && matches(rule) }
      return false
    }
    return admitted ? .allowed : .notAllowed
  }

  /// A remote server: Cupertino's HTTP entries.
  private static func verdict(key: String, url: String, policy: Policy) -> Verdict {
    func matches(_ rule: [String: Any]) -> Bool {
      if let name = rule["serverName"] as? String { return name == key }
      if let pattern = rule["serverUrl"] as? String { return glob(pattern, matches: url) }
      return false
    }
    if policy.deniedByManaged.contains(where: matches) { return .denied(inManaged: true) }
    if policy.deniedByUser.contains(where: matches) { return .denied(inManaged: false) }
    guard let allowed = policy.allowed else { return .allowed }
    let admitted = allowed.contains { rule in
      if rule["serverUrl"] != nil { return matches(rule) }
      if rule["serverName"] != nil { return !policy.matchesByURL && matches(rule) }
      return false
    }
    return admitted ? .allowed : .notAllowed
  }

  /// A `serverUrl` pattern against a URL, whole: `*` matches any run of
  /// characters, everything else only itself.
  static func glob(_ pattern: String, matches url: String) -> Bool {
    let expression =
      "^"
      + pattern.split(separator: "*", omittingEmptySubsequences: false)
      .map { NSRegularExpression.escapedPattern(for: String($0)) }
      .joined(separator: ".*") + "$"
    return url.range(of: expression, options: .regularExpression) != nil
  }

  /// The `serverCommand` entry that admits `entry`: its command and args.
  static func rule(for entry: Any?) -> [String: Any]? {
    command(of: entry).map { ["serverCommand": $0] }
  }

  /// The entry to offer for `key`, in the kind the list already uses. A list of
  /// names gets a name: adding the first `serverCommand` to it would stop every
  /// other stdio server it allows by name from passing.
  ///
  /// A URL entry gets its exact URL under a list that matches by URL, never a
  /// `/s/*` wildcard, which `isBastionWildcard` would take for Bastion's.
  static func rule(key: String, entry: Any?, policy: Policy) -> [String: Any]? {
    if let url = url(of: entry) {
      return policy.matchesByURL ? ["serverUrl": url] : ["serverName": key]
    }
    return policy.matchesByCommand ? rule(for: entry) : ["serverName": key]
  }

  /// Entries to paste into an existing `allowedMcpServers` array: one object
  /// per line, comma-separated, without brackets of their own.
  static func snippet(_ rules: [[String: Any]]) -> String {
    rules.compactMap { rule in
      (try? JSONSerialization.data(
        withJSONObject: rule, options: [.sortedKeys, .withoutEscapingSlashes]))
        .map { String(decoding: $0, as: UTF8.self) }
    }
    .joined(separator: ",\n")
  }

  /// Read both files. A file that is missing or does not parse counts as
  /// setting nothing: this is a warning, and a wrong one is worse than none.
  static func read() -> Policy {
    policy(user: object(at: userSettingsURL), managed: object(at: managedSettingsURL))
  }

  private static func object(at url: URL) -> [String: Any] {
    guard let data = try? Data(contentsOf: url),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return object
  }

  /// A remote server's URL, nil for a stdio one.
  static func url(of entry: Any?) -> String? {
    guard let entry = entry as? [String: Any], entry["command"] == nil else { return nil }
    return entry["url"] as? String
  }

  private static func command(of entry: Any?) -> [String]? {
    guard let entry = entry as? [String: Any], let command = entry["command"] as? String
    else { return nil }
    return [command] + (entry["args"] as? [String] ?? [])
  }

  private static func objects(_ list: [Any]) -> [[String: Any]] {
    list.compactMap { $0 as? [String: Any] }
  }

  /// Bastion's `http://127.0.0.1:<port>/s/*`, on any loopback spelling and
  /// port, as Bastion's own `ClientLockdown.isBastionPattern` reads it.
  private static func isBastionWildcard(_ rule: Any) -> Bool {
    guard let url = (rule as? [String: Any])?["serverUrl"] as? String else { return false }
    return url.range(
      of: #"^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+/s/\*$"#, options: .regularExpression)
      != nil
  }
}
