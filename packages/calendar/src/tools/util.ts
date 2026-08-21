/**
 * Calendar's tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
 * re-exported here so tools import from one place.
 *
 * Calendar's own zod args (event refs, the date grammar, the range block) land
 * with the tools that take them.
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

import { z } from "zod";

// ─── Calendar's own args ─────────────────────────────────────────────────────

export const eventRefArg = z
  .string()
  .min(1)
  .describe(
    'An opaque event ref from a list or search result (looks like "c1:<calendar>/<occurrence>/<uid>"). ' +
      "Do not construct one by hand.",
  );

export const calendarArg = z
  .string()
  .optional()
  .describe(
    'A calendar name or uid, e.g. "Work". Use apple_calendar_list_calendars to see what exists.',
  );

/**
 * The date grammar, written out in full.
 *
 * Load-bearing: the caller is usually a model that gets one retry, and the
 * difference between naming a day and naming an instant is the difference
 * between a whole-day range and a one-minute one.
 */
export const fromArg = z
  .string()
  .optional()
  .describe(
    'Start of the window. ISO-8601 "2026-08-21" or "2026-08-21T09:00", or "today", "tomorrow", ' +
      '"next monday", "+2d". A bare day starts at that morning. Defaults to today.',
  );

export const toArg = z
  .string()
  .optional()
  .describe(
    "End of the window. A bare day runs through that EVENING, so naming the same day for both " +
      "gives that whole day. Defaults to a week after the start.",
  );

export const includeDeclinedArg = z
  .boolean()
  .optional()
  .describe("Include events you have declined. Off by default; they are still on the calendar.");

export const includeCancelledArg = z
  .boolean()
  .optional()
  .describe(
    "Include events an organiser cancelled but that are still in the store. Off by default.",
  );
