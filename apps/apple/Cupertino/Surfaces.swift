import Foundation

/// The Apple surfaces Cupertino brokers access to.
///
/// This is a **closed table fixed at compile time**, and it is the same
/// invariant `native/launcher.c` was written to hold: a caller selects a
/// surface by *name*, never by path. A component that runs whatever path it is
/// handed would be a way for any local process to read the whole disk using a
/// permission the user granted for mail.
///
/// The stores mirror `docs/distribution.md`'s surface table.
struct Surface: Identifiable, Hashable {
  /// The wire name. `cupertino-bridge --server=<id>` matches on this and
  /// nothing else.
  let id: String
  let displayName: String
  /// Target of the Apple Events lane.
  let bundleID: String
  /// Where the file lane reads, relative to the home directory. `nil` for a
  /// surface that has no file lane yet.
  let storePath: String?
  /// Prefix for the server's environment variables, e.g. `APPLE_MAIL_`.
  /// See `packages/<id>/.env.example` for the full set.
  let envPrefix: String

  static let all: [Surface] = [
    Surface(
      id: "mail",
      displayName: "Mail",
      bundleID: "com.apple.mail",
      // The V number moves between macOS releases, which is why
      // packages/mail/src/client/locate.ts asks Mail itself first. For a
      // status row a glob is enough; the server does the real resolution.
      storePath: "Library/Mail/V*/MailData/Envelope Index",
      envPrefix: "APPLE_MAIL_"
    ),
    Surface(
      id: "notes",
      displayName: "Notes",
      bundleID: "com.apple.Notes",
      storePath: "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
      envPrefix: "APPLE_NOTES_"
    ),
    Surface(
      id: "reminders",
      displayName: "Reminders",
      bundleID: "com.apple.reminders",
      // The container, not the store. Reminders keeps its data in
      // Container_v1/Stores/Data-<UUID>.sqlite, and a UUID cannot be probed by
      // name — `resolveStore` only expands a glob in a directory component.
      // Reading the directory is the right question anyway: it is exactly the
      // `containerListable` signal packages/reminders/src/client/locate.ts uses,
      // because without the grant the container cannot even be listed, so the
      // store cannot be located at all.
      storePath: "Library/Group Containers/group.com.apple.reminders",
      envPrefix: "APPLE_REMINDERS_"
    ),
  ]

  static func named(_ id: String) -> Surface? {
    all.first { $0.id == id }
  }
}
