/**
 * The three shipped surfaces, their tool names, and which of them the write
 * gate hides.
 *
 * These lists are transcribed from `packages/<surface>/src/tools/index.ts`, and the
 * split is the site's central claim: with `allowWrites` off the mutating tools
 * are never registered, so the host is never told they exist. Getting a name
 * wrong here is a claim the servers do not honour — check the tree, not the
 * README, which has drifted before.
 *
 * Calendar is deliberately NOT in this list. Its six read tools are real and its
 * index lane is live, but it has no write tools yet — and every surface above
 * is defined by the read/write split the write gate draws. Promoting a
 * half-surface would also trip the price ladder in docs/licensing.md, which
 * commits to a rise when "Calendar ships". It stays in `IN_PROGRESS` until the
 * writes land.
 */

export interface Surface {
  /** Anchor id and display key. */
  id: "mail" | "notes" | "reminders";
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
      "apple_mail_set_message_flags",
      "apple_mail_move_messages",
      "apple_mail_delete_messages",
      "apple_mail_check_for_new_mail",
      "apple_mail_save_attachment",
    ],
    pitch:
      "The deep one. Search, read, threads, attachments and message source across accounts and mailboxes; eight mutating tools behind the write gate.",
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
] as const;

export const toolCount = (s: Surface) => s.read.length + s.write.length;

/**
 * Built and shipping, but not yet claimable as a surface.
 *
 * The distinction from NOT_STARTED is real rather than cosmetic: the app
 * already brokers Calendar, the store opens read-only and every table the
 * design needs is present. What is missing is the one measurement that decides
 * whether a range query is CORRECT, and shipping listing tools before it would
 * risk the quietest possible bug.
 */
export const IN_PROGRESS = [
  {
    name: "Calendar",
    pkg: "@mgcrea/mcp-apple-calendar",
    /** Transcribed from `packages/calendar/src/tools/*.ts`, same rule as above. */
    registered: [
      "apple_calendar_list_events",
      "apple_calendar_search_events",
      "apple_calendar_get_event",
      "apple_calendar_list_calendars",
      "apple_calendar_list_accounts",
      "apple_calendar_diagnostics",
    ],
    lands: "create, update and delete, behind the write gate",
    why:
      "Reads are done, including the hard part: Calendar keeps expanded repeats in a cache " +
      "table holding more rows than the events table itself, so a weekly meeting is returned " +
      "once per week rather than once — and when a range runs past what the store has expanded, " +
      "the result says so instead of quietly coming back short.",
    withoutGrant:
      "Nothing. This is the first surface with no Apple Events read path fast enough to be a " +
      "fallback: one 90-day range query costs 3.4 seconds, so every read needs the grant.",
  },
] as const;

/** Messages has no Apple Events read path at all, so it cannot ship without the grant. */
export const NOT_STARTED = [
  { name: "Messages", why: "no read API exists without the file lane" },
] as const;
