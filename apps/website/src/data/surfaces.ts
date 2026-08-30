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
  id: "mail" | "notes" | "reminders" | "calendar" | "contacts" | "messages" | "safari" | "maps";
  // </generated:surfaces>
  name: string;
  pkg: string;
  /** Always registered. */
  read: readonly string[];
  /** Registered only when `*_ALLOW_WRITES` is true. */
  write: readonly string[];
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
    ],
    pitch:
      "Search, read and attachments across every folder and account, with five mutating tools behind the write gate.",
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
    id: "safari",
    name: "Safari",
    pkg: "@mgcrea/mcp-apple-safari",
    read: [
      "apple_safari_search_history",
      "apple_safari_get_page",
      "apple_safari_list_tabs",
      "apple_safari_list_bookmarks",
      "apple_safari_list_reading_list",
      "apple_safari_diagnostics",
    ],
    // Empty on purpose, and the only empty column here. Opening a URL or adding
    // to the Reading List navigates a real, visible browser, and no write on
    // this surface was ever probed. There is also no `do JavaScript` tool, so
    // nothing reads page content: that verb needs a developer-menu toggle which
    // is not a TCC grant and whose own state cannot be read, so diagnostics
    // could never say in advance whether it would work. Nor is there a second
    // route — Safari exposes no AXWebArea for its page content, measured on
    // macOS 26.6. See docs/safari.md.
    write: [],
    pitch:
      "History, live tabs and the Reading List. The one surface whose two lanes see different things rather than the same thing at different speeds.",
    withoutGrant:
      "Live tabs, and only those — the one thing in the whole bundle that works with no Full Disk Access at all. It needs an Automation grant instead.",
  },
] as const;

export const toolCount = (s: Surface) => s.read.length + s.write.length;
