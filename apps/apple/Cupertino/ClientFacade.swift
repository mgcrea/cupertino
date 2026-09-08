import Foundation

/// Which MCP clients fetch tool schemas on their own, and therefore must never
/// be fronted.
///
/// ## Why the client is a term at all
///
/// "Load tools on demand" reads as a decision about a surface, and it is stored
/// that way — one switch app-wide, overridable per surface. But a surface feeds
/// every client wired to it at once, and the clients do not agree about what
/// they need. Claude Code and Claude Desktop already load an MCP server's tool
/// schemas only when they are about to use them, so fronting either one pays
/// the facade's whole cost to buy back only the tool names.
///
/// It is worse than a wash. The client's own tool search then indexes the
/// facade's four generic entries — `search_tools`, `describe_tool`, `call_tool`
/// — instead of `apple_mail_search_messages` and its twenty siblings, so the
/// thing that was supposed to make the surface findable makes it invisible.
///
/// ## An allowlist, not a capability field
///
/// MCP has no field for this. A client cannot say "I defer", so this is a list
/// backed by evidence about particular clients, and an id that is not on it —
/// including one this build has never heard of — does not defer. That default
/// is the safe one in the direction that matters: an unrecognised client gets
/// exactly the behaviour every client got before this existed.
///
/// The escape hatch runs both ways, which is why it is a tri-state rather than
/// a boolean. A client that starts deferring before this list is updated can be
/// marked by hand; one that stops can be unmarked.
enum ClientFacade {
  /// Clients known to fetch tool schemas on demand.
  ///
  /// Two entries. Claude Code has done this since 2.1.191; Claude Desktop was
  /// measured doing the same. Both are ids from `ClientWiring.clients`.
  static let deferring: Set<String> = ["claude-code", "claude-desktop"]

  /// `defersSchemas.<client>` — `"on"`, `"off"`, or absent for "use the table".
  ///
  /// A String and not a Bool for the reason `SurfaceSettings.lazyTools` is one:
  /// `bool(forKey:)` cannot tell "off" from "never set", and the third position
  /// is the whole point of an override.
  static func overrideKey(_ client: String) -> String { "defersSchemas.\(client)" }

  /// Whether this connection's client fetches schemas on its own.
  ///
  /// `nil` — a config written before `--client=` existed, or a client that was
  /// wired by hand — is not deferring. Absence is not evidence, and treating it
  /// as such would silently turn the facade off for everybody with an older
  /// config.
  static func defersSchemas(_ client: String?) -> Bool {
    guard let client else { return false }
    return defersSchemas(
      client, override: UserDefaults.standard.string(forKey: overrideKey(client)))
  }

  /// The decision, with the stored override passed in.
  ///
  /// Split out so `make unit` can assert the tri-state without a defaults
  /// domain, the way `ClientWiringMerge` is split from the file it writes.
  static func defersSchemas(_ client: String, override: String?) -> Bool {
    if let override, !override.isEmpty { return override == "on" }
    return deferring.contains(client)
  }
}
