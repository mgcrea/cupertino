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
    Surface(
      id: "messages",
      displayName: "Messages",
      // The bundle id disagrees with the display name, as Calendar's does:
      // Messages.app is still com.apple.MobileSMS underneath. It is the
      // liveness check for the send script and is used by nothing else.
      //
      // usesAppleEvents is TRUE for exactly one verb, and the asymmetry is
      // the whole story of this surface. Every READ through the scripting
      // dictionary fails — measured, not assumed — and Messages answers
      // "Application isn't running" even while NSRunningApplication reports
      // it running, because it is a windowless background process that
      // declines to wake for a script. `send` is the one command that works,
      // so Apple Events here is a WRITE lane and nothing else. With
      // APPLE_MESSAGES_ALLOW_WRITES off, no Apple Event is ever sent and no
      // Automation grant is ever requested.
      //
      // supportsWrites is TRUE, and it covers exactly one tool.
      // `sdef` lists three commands — send, login, logout — and only send
      // is exposed: logging a user out of iMessage on every device they own
      // is not something to do behind a tool call. There is no edit, delete,
      // mark-as-read or reaction verb in the dictionary at all.
      //
      // The send is reconciled through the FILE lane, which is what made it
      // shippable. Apple Events returns no identifier for what it sent —
      // docs/messages.md called the id bridge unanswerable by construction —
      // so the outgoing row is found by re-reading chat.db afterwards. The
      // read lane also picks the target: Messages will not enumerate
      // participants for a script, but it will accept a chat guid, and the
      // store holds one for every conversation.
      //
      // Full Disk Access is MANDATORY here rather than an upgrade. Every
      // other surface degrades to a slower server without it; this one has
      // no second lane and simply does not exist. docs/distribution.md
      // retired "try before you grant" partly because of this surface.
      bundleID: "com.apple.MobileSMS",
      usesAppleEvents: true,
      supportsWrites: true,
      storePath: "Library/Messages/chat.db",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_MESSAGES_"
    ),
    Surface(
      id: "safari",
      displayName: "Safari",
      // The only surface whose two lanes are NOT fallbacks for each other.
      // Everywhere else both lanes reach the same data and the choice is
      // speed. Here they see almost disjoint things: Apple Events sees only
      // what is open right now, the file lane sees everything except that.
      // An ungranted Safari server is not a slower Safari server, it is a
      // different and much smaller one.
      //
      // So usesAppleEvents is TRUE while supportsWrites is FALSE, which no
      // other surface does. Apple Events is a READ lane here, and that does
      // not breach the lane policy in docs/distribution.md: the policy
      // forbids a slow Apple Events read lane that DUPLICATES the file lane.
      // Live tabs are not duplicated by anything. The file lane cannot
      // answer 'what is open right now' at any price, because Safari never
      // writes it down.
      //
      // storePath names History.db, but the grant covers a directory:
      // Bookmarks.plist sits beside it and holds the Reading List. One file
      // is named because the status row needs one path to test, and history
      // is the larger half.
      //
      // supportsWrites is FALSE for v0.1. Opening a URL or adding to the
      // Reading List is an Apple Event that navigates a real, visible
      // browser, and docs/safari.md records that no write was ever probed.
      //
      // A THIRD permission exists and is deliberately not needed. Safari's
      // `do JavaScript` requires 'Allow JavaScript from Apple Events', a
      // developer-menu toggle that is not a TCC grant and whose own state is
      // unreadable. This server ships no verb that needs it, which is what
      // keeps Permissions.swift's two-state model honest for this surface.
      bundleID: "com.apple.Safari",
      usesAppleEvents: true,
      supportsWrites: false,
      storePath: "Library/Safari/History.db",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_SAFARI_"
    ),
    Surface(
      id: "maps",
      displayName: "Maps",
      // The FIRST surface with usesAppleEvents FALSE. Maps ships no scripting
      // dictionary at all: there is no .sdef in /System/Applications/Maps.app,
      // checked directly rather than inferred from NSAppleScriptEnabled. So this
      // is the first entry that does not widen the Apple Events consent string,
      // and the first server in the bundle that can never send an Apple Event.
      //
      // Its file lane is MANDATORY for the same reason Messages' is: there is no
      // second lane to degrade to. Without Full Disk Access there is no slower
      // Maps server, there is no Maps server.
      //
      // storePath names a file with NO EXTENSION, which is why this surface was
      // declared 'no file lane' three separate times before it was found. A sweep
      // for *.db / *.sqlite* misses it entirely. It also sits in Data/Maps/, the
      // one directory of Maps' container that Full Disk Access gates, so a listing
      // taken without the grant omits the directory and the omission reads as
      // absence of data. And group.com.apple.Maps is a decoy: it exists, it is
      // EPERM rather than empty, and it holds three files that are not the store.
      //
      // The version in the name will move. packages/maps/src/client/locate.ts
      // falls back to scanning for a MapsSync_* sibling rather than reporting a
      // rename as 'Maps has never been used'. A glob is not used, for the reason
      // the Reminders entry gives: resolveStore only expands one in a directory
      // component.
      //
      // supportsWrites is FALSE, and unlike Safari's it is not merely unprobed.
      // The store is mirrored to iCloud by NSPersistentCloudKitContainer, so a
      // write is not a write to a file. It is an edit to one replica of a
      // synchronising object graph, underneath a running app that is also editing
      // it, with NSCK* bookkeeping tables a third-party writer would not maintain.
      // That needs its own probe before it needs a flag.
      //
      // Columns are resolved BY COVERAGE rather than by name, which no other
      // surface has needed. ZHISTORYITEM carries both ZLATITUDE (1 row of 33) and
      // ZLATITUDE1 (19 of 33); taking the first recognised name would report that
      // Maps holds almost no coordinates.
      bundleID: "com.apple.Maps",
      usesAppleEvents: false,
      supportsWrites: false,
      storePath: "Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1",
      storePermission: .fullDiskAccess,
      envPrefix: "APPLE_MAPS_"
    ),
  ]
  // </generated:surfaces>

  static func named(_ id: String) -> Surface? {
    all.first { $0.id == id }
  }
}
