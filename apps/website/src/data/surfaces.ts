/**
 * The shipped surfaces, their tool names, and which of them the write
 * gate hides.
 *
 * These lists are transcribed from `packages/<surface>/src/tools/index.ts`, and the
 * split is the site's central claim: with `allowWrites` off the mutating tools
 * are never registered, so the host is never told they exist. Getting a name
 * wrong here is a claim the servers do not honour — check the tree, not the
 * README, which has drifted before.
 *
 * NOTE: promoting a surface into this list is a commercial act as well as a
 * technical one — docs/licensing.md ties a price rise to each surface shipping.
 * A surface belongs here once it has both halves of the read/write split the
 * write gate draws, and not before.
 */

export interface Surface {
  /** Anchor id and display key. */
  // <generated:surfaces> generated from surfaces.json by `make surfaces` — do not edit by hand
  id:
    | "mail"
    | "notes"
    | "reminders"
    | "calendar"
    | "contacts"
    | "messages"
    | "safari"
    | "maps"
    | "screen"
    | "sound"
    | "desktop";
  // </generated:surfaces>
  name: string;
  pkg: string;
  /** Always registered. */
  read: readonly string[];
  /** Registered only when `*_ALLOW_WRITES` is true. */
  write: readonly string[];
  /**
   * Reads registered only when their OWN flag is set — not `allowWrites`.
   *
   * A third column rather than a line in `read`, because `read` means "always
   * registered" and that is the site's claim about it. A tool that appears only
   * under `APPLE_MESSAGES_ALLOW_CODES` is not always registered, and listing it
   * as though it were would be exactly the kind of unhonoured claim the header
   * above warns about.
   */
  gated?: readonly { name: string; env: string; why: string }[];
  /** The one-line reason this surface exists. */
  pitch: string;
  /** What it can still do with no Full Disk Access at all. */
  withoutGrant: string;
}

export const SURFACES: readonly Surface[] = [
  {
    id: "mail",
    name: "Mail",
    pkg: "@mgcrea/mcp-apple-mail",
    read: [
      "apple_mail_search_messages",
      "apple_mail_list_messages",
      "apple_mail_count_messages",
      "apple_mail_query",
      "apple_mail_get_thread",
      "apple_mail_get_message",
      "apple_mail_get_message_source",
      "apple_mail_list_attachments",
      "apple_mail_list_accounts",
      "apple_mail_list_mailboxes",
      "apple_mail_diagnostics",
    ],
    write: [
      "apple_mail_send_message",
      "apple_mail_reply_to_message",
      "apple_mail_forward_message",
      "apple_mail_update_draft",
      "apple_mail_set_message_flags",
      "apple_mail_move_messages",
      "apple_mail_create_mailbox",
      "apple_mail_delete_messages",
      "apple_mail_check_for_new_mail",
      "apple_mail_save_attachment",
    ],
    pitch:
      "The deep one. Search, read, threads, attachments and message source across accounts and mailboxes; ten mutating tools behind the write gate.",
    withoutGrant: "Accounts, mailboxes and writes only — search falls back to the 74-second path.",
  },
  {
    id: "notes",
    name: "Notes",
    pkg: "@mgcrea/mcp-apple-notes",
    read: [
      "apple_notes_list_notes",
      "apple_notes_search_notes",
      "apple_notes_get_note",
      "apple_notes_list_attachments",
      "apple_notes_list_accounts",
      "apple_notes_list_folders",
      "apple_notes_diagnostics",
    ],
    write: [
      "apple_notes_create_note",
      "apple_notes_update_note",
      "apple_notes_move_note",
      "apple_notes_delete_notes",
      "apple_notes_save_attachment",
      "apple_notes_add_attachment",
    ],
    pitch:
      "Search, read and attachments across every folder and account, with six mutating tools behind the write gate.",
    withoutGrant:
      "Fully usable below roughly 5k notes with no grant at all — only attachment bytes need it.",
  },
  {
    id: "reminders",
    name: "Reminders",
    pkg: "@mgcrea/mcp-apple-reminders",
    read: [
      "apple_reminders_list_reminders",
      "apple_reminders_search_reminders",
      "apple_reminders_get_reminder",
      "apple_reminders_list_lists",
      "apple_reminders_list_accounts",
      "apple_reminders_diagnostics",
    ],
    write: [
      "apple_reminders_create_reminder",
      "apple_reminders_update_reminder",
      "apple_reminders_complete_reminders",
      "apple_reminders_move_reminders",
      "apple_reminders_delete_reminders",
    ],
    pitch:
      "Lists, due dates and search across every account, with five mutating tools behind the write gate.",
    withoutGrant: "Workable over Apple Events — the file lane is what makes search scale.",
  },
  {
    id: "calendar",
    name: "Calendar",
    pkg: "@mgcrea/mcp-apple-calendar",
    read: [
      "apple_calendar_list_events",
      "apple_calendar_search_events",
      "apple_calendar_find_availability",
      "apple_calendar_get_event",
      "apple_calendar_list_calendars",
      "apple_calendar_list_accounts",
      "apple_calendar_diagnostics",
    ],
    write: [
      "apple_calendar_create_event",
      "apple_calendar_update_event",
      "apple_calendar_delete_events",
    ],
    pitch:
      "Ranges, search, free time between events, and repeating events expanded properly, with three mutating tools behind the write gate.",
    withoutGrant:
      "Nothing — the only surface with no Apple Events read path fast enough to be a fallback.",
  },
  {
    id: "contacts",
    name: "Contacts",
    pkg: "@mgcrea/mcp-apple-contacts",
    read: [
      "apple_contacts_resolve_handles",
      "apple_contacts_search_contacts",
      "apple_contacts_list_contacts",
      "apple_contacts_get_contact",
      "apple_contacts_diagnostics",
    ],
    // Two, not three. Contacts' scripting dictionary has no delete command of
    // any kind — make, add, remove and save are the whole list — and writes go
    // through Apple Events because the store is query_only, so there is no way
    // to honour a delete tool. See docs/contacts.md.
    write: ["apple_contacts_create_contact", "apple_contacts_update_contact"],
    pitch:
      "Turns a phone number into a name, and creates or edits a card. Reads need no Automation prompt at all; only the two write tools do.",
    withoutGrant:
      "Nothing — but it asks for the Contacts permission rather than the whole disk, and unlike Full Disk Access that one prompts.",
  },
  {
    id: "messages",
    name: "Messages",
    pkg: "@mgcrea/mcp-apple-messages",
    read: [
      "apple_messages_list_chats",
      "apple_messages_list_messages",
      "apple_messages_search_messages",
      "apple_messages_count_messages",
      "apple_messages_get_message",
      "apple_messages_diagnostics",
    ],
    // `sdef` lists three commands — send, login and logout — and the other two
    // would sign the user out of iMessage on every device they own, so send is
    // the only Apple Event this surface ever sends. `save_attachment` sits
    // behind the same gate but is not one of the three: it copies a file
    // already on disk and sends no Apple Event at all, so a surface that is
    // "nothing without a grant" everywhere else can still save an attachment
    // with Full Disk Access alone. There is no edit, delete, mark-as-read or
    // reaction verb to expose. See docs/messages.md.
    write: ["apple_messages_send_message", "apple_messages_save_attachment"],
    // A read, and still not in `read`. It is gated on its own flag because this
    // server already holds the conversation history and a sibling holds Mail —
    // between them the password-reset channel — so adding live authentication
    // codes is a change of tier rather than one more query. Off by default, and
    // orthogonal to the write gate in both directions. See docs/passwords.md
    // for why the Passwords app itself is unreachable and this is what ships
    // instead.
    gated: [
      {
        name: "apple_messages_find_codes",
        env: "APPLE_MESSAGES_ALLOW_CODES",
        why: "Extracts one-time 2FA codes from recent messages. Off unless you turn it on.",
      },
    ],
    pitch:
      "Reads iMessage, SMS and RCS straight from chat.db — including the messages SQL cannot see — saves attachments, and sends, behind the write gate.",
    withoutGrant:
      "Nothing at all. Every read through Messages' own scripting interface fails, so this is the one surface with no second lane to degrade to.",
  },
  {
    id: "maps",
    name: "Maps",
    pkg: "@mgcrea/mcp-apple-maps",
    read: [
      "apple_maps_list_favorites",
      "apple_maps_list_collections",
      "apple_maps_list_collection_places",
      "apple_maps_list_unfiled_places",
      "apple_maps_list_recents",
      "apple_maps_search_places",
      "apple_maps_get_place",
      "apple_maps_diagnostics",
    ],
    // Writes are SQL into a CloudKit-mirrored Core Data store, because Maps has
    // no scripting dictionary and no App Intents registered on macOS. The place
    // record is never fabricated — Maps is asked to mint one through the maps://
    // URL scheme and it is copied — which is why this took four measured lanes
    // to arrive at. See docs/maps.md.
    write: ["apple_maps_add_favorite", "apple_maps_remove_favorite"],
    pitch:
      "The places you saved: favourites, Guides and recents, with real coordinates and addresses — including the ones filed in no Guide, which the app itself only shows in a union view. Saves and removes favourites behind the write gate.",
    withoutGrant: "Nothing at all — Maps is not scriptable, so the grant is the only way in.",
  },
  {
    id: "screen",
    name: "Screen",
    // No npm package, and not an oversight: this surface is served by the app
    // itself because ScreenCaptureKit is unreachable from node. A published
    // package could do nothing — the Screen Recording grant lives in the app.
    pkg: "—",
    read: ["apple_screen_list_targets", "apple_screen_diagnostics"],
    // Not a write in the mutating sense; it is gated because it puts a file on
    // disk and because pixels contain whatever the window was showing.
    write: [],
    gated: [
      {
        name: "apple_screen_capture_surface",
        env: "APPLE_SCREEN_ALLOW_CAPTURE",
        why: "Captures a surface app's window to a PNG. Off by default, and it supersedes the one-time-code gates — a Safari window renders a code whatever those say.",
      },
    ],
    pitch:
      "A picture of a window your assistant is already working with — Mail, Safari, Calendar — written to disk and handed back as a path. Only the apps Cupertino brokers: never an arbitrary app, window, display or region. Nothing is raised or focused, and a window sitting behind another app still captures its own content.",
    withoutGrant: "Nothing — Screen Recording is the only way in, and it takes effect on relaunch.",
  },
  {
    id: "sound",
    name: "Sound",
    // No npm package, for the same reason as Screen: CoreAudio, AVFoundation
    // and Speech are all unreachable from node, and switching the default audio
    // device has no command-line equivalent at all.
    pkg: "\u2014",
    // The only surface whose reads need NO permission of any kind. Devices and
    // volume answer on a Mac that has granted Cupertino nothing.
    read: ["apple_sound_list_devices", "apple_sound_get_volume", "apple_sound_diagnostics"],
    write: [
      "apple_sound_set_volume",
      "apple_sound_set_muted",
      "apple_sound_set_default_device",
      "apple_sound_speak",
    ],
    gated: [
      {
        name: "apple_sound_start_recording",
        env: "APPLE_SOUND_ALLOW_RECORDING",
        why: "Records from the microphone to a file. Off by default, needs the Microphone permission, and macOS shows its orange recording indicator \u2014 naming Cupertino \u2014 the whole time it runs.",
      },
      {
        name: "apple_sound_stop_recording",
        env: "APPLE_SOUND_ALLOW_RECORDING",
        why: "Finishes the recording and returns its path, size, duration and whether it was silent.",
      },
      {
        name: "apple_sound_recording_status",
        env: "APPLE_SOUND_ALLOW_RECORDING",
        why: "Whether a recording is running, read from the live recorder rather than from a cached flag.",
      },
    ],
    pitch:
      "Your Mac's speakers and microphone. List the audio devices, read and set the volume, mute, switch to your headphones \u2014 none of which needs any permission \u2014 and, behind a separate switch that is off by default, record a memo to a file. Recording is never hidden: macOS shows its orange indicator, naming Cupertino, for as long as it runs.",
    withoutGrant:
      "Devices, volume and mute all work with no grant at all. Only recording needs the Microphone permission.",
  },
  {
    id: "safari",
    name: "Safari",
    pkg: "@mgcrea/mcp-apple-safari",
    read: [
      "apple_safari_search_history",
      "apple_safari_get_page",
      "apple_safari_read_page",
      "apple_safari_list_tabs",
      "apple_safari_list_bookmarks",
      "apple_safari_list_reading_list",
      "apple_safari_page_elements",
      "apple_safari_diagnostics",
    ],
    // Two verbs that move a browser between pages, and nothing that acts
    // inside one. There is deliberately no `do JavaScript` tool: it needs a
    // developer-menu toggle which is not a TCC grant and whose own state
    // cannot be read, so diagnostics could never say in advance whether it
    // would work — and Safari exposes no AXWebArea for page content either
    // (measured, macOS 26.6). So page content comes from the bundled Safari
    // extension, which Safari scopes per website, as the toggle is not.
    // The same reasoning is why these two accept http and https URLs only: a
    // javascript: URL would reach that verb through a navigation tool. See
    // docs/safari.md.
    write: [
      "apple_safari_open_url",
      "apple_safari_add_reading_list_item",
      "apple_safari_click",
      "apple_safari_fill",
      "apple_safari_scroll",
    ],
    // A read, and still not in `read`. The extension can see a 2FA code a page
    // is showing, so that goes behind its own flag rather than arriving with
    // the rest. Two things move together when it is on: this tool, for a code
    // rendered as TEXT where there is no field to enumerate, and the value of a
    // one-time-code FIELD in apple_safari_page_elements. A password or a card
    // number is withheld either way, whatever the setting says.
    //
    // Weaker than the Messages gate of the same name, and worth saying so:
    // apple_safari_read_page is ungated, so turning this off removes the
    // targeted read, not every byte of a page. See docs/passwords.md for why
    // the Passwords app itself is unreachable and this is what ships instead.
    gated: [
      {
        name: "apple_safari_find_codes",
        env: "APPLE_SAFARI_ALLOW_CODES",
        why: "Reads a one-time 2FA code from a page you have allowed the extension on. Off unless you turn it on.",
      },
    ],
    pitch:
      "History, live tabs, the Reading List — and, through a Safari extension you enable per website, what a page actually says, plus clicking and typing on it. Opens a URL or saves one for later behind the write gate.",
    withoutGrant:
      "Live tabs and page contents — the only things in the whole bundle that work with no Full Disk Access at all. Tabs need an Automation grant; page contents need the extension, allowed per website.",
  },
] as const;

export const toolCount = (s: Surface) => s.read.length + s.write.length + (s.gated?.length ?? 0);
