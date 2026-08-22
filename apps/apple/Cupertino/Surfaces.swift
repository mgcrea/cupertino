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
///
/// **`Surface.all` below is generated from `surfaces.json`** by `make surfaces`.
/// Edit the manifest, not the array — CI regenerates and fails on any drift. The
/// list used to live in ten places by hand, and the fifth surface is what made
/// that untenable.
struct Surface: Identifiable, Hashable {
  /// The wire name. `cupertino-bridge --server=<id>` matches on this and
  /// nothing else.
  let id: String
  let displayName: String
  /// Target of the Apple Events lane, and the app whose icon represents this
  /// surface. Always set — even a surface that never sends an Apple Event has
  /// an app behind it, and `SurfaceIcon` asks LaunchServices for it by this id.
  let bundleID: String
  /// Whether this surface ever sends an Apple Event.
  ///
  /// False means no Automation prompt is ever shown for it and none is needed:
  /// Contacts reads its store and nothing else. Asking for a permission the code
  /// never uses is the opposite of what the closed table is for.
  let usesAppleEvents: Bool
  /// Whether the server has any mutating tool for the write toggle to gate.
  ///
  /// False hides the toggle rather than showing one that changes nothing —
  /// Contacts registers no write tool at all, by construction.
  let supportsWrites: Bool
  /// Where the file lane reads, relative to the home directory. `nil` for a
  /// surface that has no file lane yet.
  let storePath: String?
  /// Which permission actually gates that path.
  ///
  /// Not always Full Disk Access, which was an assumption until Contacts
  /// disproved it — see docs/contacts.md. Contacts sits behind its own TCC
  /// service, and unlike Full Disk Access macOS PROMPTS for that one, so the
  /// advice a failing surface should give is different in kind.
  let storePermission: StorePermission
  /// Prefix for the server's environment variables, e.g. `APPLE_MAIL_`.
  /// See `packages/<id>/.env.example` for the full set.
  let envPrefix: String

  enum StorePermission: Hashable {
    /// The indivisible whole-disk grant. Never prompts; must be given by hand.
    case fullDiskAccess
    /// The Contacts privacy grant. Prompts on first read.
    case contacts
  }

  // <generated:surfaces> generated from surfaces.json by `make surfaces` — do not edit by hand
  static let all: [Surface] = [
    Surface(
      id: "mail",
      displayName: "Mail",
      // The V number moves between macOS releases, which is why
      // packages/mail/src/client/locate.ts asks Mail itself first. For a
      // status row a glob is enough; the server does the real resolution.
      bundleID: "com.apple.mail",
      usesAppleEvents: true,
      supportsWrites: true,
      storePath: "Library/Mail/V*/MailData/Envelope Index",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_MAIL_"
    ),
    Surface(
      id: "notes",
      displayName: "Notes",
      bundleID: "com.apple.Notes",
      usesAppleEvents: true,
      supportsWrites: true,
      storePath: "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_NOTES_"
    ),
    Surface(
      id: "reminders",
      displayName: "Reminders",
      // The container, not the store. Reminders keeps its data in
      // Container_v1/Stores/Data-<UUID>.sqlite, and a UUID cannot be probed by
      // name — `resolveStore` only expands a glob in a directory component.
      // Reading the directory is the right question anyway: it is exactly the
      // `containerListable` signal packages/reminders/src/client/locate.ts uses,
      // because without the grant the container cannot even be listed, so the
      // store cannot be located at all.
      bundleID: "com.apple.reminders",
      usesAppleEvents: true,
      supportsWrites: true,
      storePath: "Library/Group Containers/group.com.apple.reminders",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_REMINDERS_"
    ),
    Surface(
      id: "calendar",
      displayName: "Calendar",
      // NOT `com.apple.Calendar`, which does not exist. Calendar.app kept the
      // bundle id it shipped with as iCal, and this is the only surface in the
      // table where the display name and the bundle id disagree — the same
      // shape of trap as `com.apple.Notes` vs `com.apple.reminders` above,
      // which this project has already been caught by once.
      //
      // A constant filename, unlike Reminders' generated UUID directory. That
      // makes this the best Full Disk Access probe in the table: `access(2)`
      // on a known path answers the question directly, with no listing step
      // that could fail for its own reasons.
      bundleID: "com.apple.iCal",
      usesAppleEvents: true,
      supportsWrites: true,
      storePath: "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_CALENDAR_"
    ),
    Surface(
      id: "contacts",
      displayName: "Contacts",
      // Reads are file-lane and need no Automation grant; writes are Apple
      // Events, like every other surface, because the store is query_only.
      // With allowWrites off this server sends no Apple Event at all, which
      // is the only reason `usesAppleEvents` being true is not the whole
      // story — see docs/contacts.md.
      //
      // There is no delete verb. `sdef` for Contacts contains the string
      // "delete" zero times: make, add, remove and save are the whole
      // command list, and `remove` only takes a person out of a group.
      //
      // The DIRECTORY, not a database. Contacts keeps one store per account
      // under Sources/<uuid>/ plus a root file that held ONE contact of 421
      // on the probed machine. Naming the root database would point the
      // status row at a file that is present, readable and empty.
      //
      // And it is not Full Disk Access that gates it: Contacts has its own
      // TCC service, which — unlike Full Disk Access — prompts.
      bundleID: "com.apple.AddressBook",
      usesAppleEvents: true,
      supportsWrites: true,
      storePath: "Library/Application Support/AddressBook",
      storePermission: .contacts,
      envPrefix: "APPLE_CONTACTS_"
    ),
  ]
  // </generated:surfaces>

  static func named(_ id: String) -> Surface? {
    all.first { $0.id == id }
  }
}
