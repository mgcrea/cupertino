import { z } from "zod";

/**
 * Reminders' tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
 * re-exported here so tools import from one place.
 */
export {
  compact,
  confirmArg,
  fail,
  limitArg,
  ok,
  okText,
  toFailure,
  wrap,
  wrapResult,
  type ToolResult,
} from "@mgcrea/mcp-apple-core";

// ─── Reminders' own args ─────────────────────────────────────────────────────

export const reminderRefArg = z
  .string()
  .min(1)
  .describe(
    'An opaque reminder ref from a search or list result (looks like "r1:x-apple-reminder://…"). ' +
      "Do not construct one by hand.",
  );

export const reminderRefsArg = z
  .array(z.string().min(1))
  .min(1)
  .max(200)
  .describe("Reminder refs from a search or list result.");

export const listArg = z
  .string()
  .optional()
  .describe(
    'A list name or id, e.g. "Groceries". Lists can be nested inside other lists; give the ' +
      "leaf name. Use apple_reminders_list_lists to see what exists.",
  );

export const priorityArg = z
  .enum(["none", "low", "medium", "high"])
  .optional()
  .describe(
    "Reminders stores priority as 0-9 and shows four buckets; these are the four. " +
      "A value synced from another CalDAV client is bucketed into the nearest one.",
  );

/**
 * The date grammar, written out in full.
 *
 * The description is load-bearing: the caller is usually a model that gets one
 * retry, and the difference between a bare day and a date-time is the
 * difference between an all-day reminder and one due at a specific minute.
 */
export const dateArg = z
  .string()
  .describe(
    'ISO-8601 — "2026-08-20" for an all-day reminder, "2026-08-20T09:00" for a timed one — ' +
      'or a relative offset: "+2d", "+3h", "+45m", "+1w", "today", "tomorrow", ' +
      '"tomorrow 09:00", "next monday". Resolved in local time. Naming a day gives an all-day ' +
      "reminder; naming a time or a duration gives a timed one. The result echoes back the " +
      "absolute time it resolved to.",
  );

export const includeCompletedArg = z
  .boolean()
  .optional()
  .describe(
    "Include completed reminders. Off by default, matching what Reminders itself shows — a " +
      "long-lived account holds years of finished items.",
  );
