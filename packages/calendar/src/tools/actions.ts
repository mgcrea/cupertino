import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleCalendarClient } from "../client/calendar.js";
import { calendarArg, confirmArg, eventRefArg, wrap } from "./util.js";

/**
 * The mutating tools.
 *
 * Registered only when `allowWrites` is on — not merely refused, absent, so a
 * host is never told they exist.
 *
 * ## No `attendees` parameter, anywhere
 *
 * Adding an attendee sends an email to a person. That is not something to do
 * behind a tool call, and leaving it out of the schema is a stronger guarantee
 * than validating it away. `test/jxa.test.ts` asserts the scripts cannot set it
 * either, so there are two places to remove rather than one to forget.
 */

const startArg = z
  .string()
  .describe(
    'When it starts. ISO-8601 "2026-08-21" for an all-day event or "2026-08-21T09:00" for a ' +
      'timed one, or "tomorrow 09:00", "next monday", "+2d". Naming a bare day makes it all-day.',
  );

const endArg = z
  .string()
  .optional()
  .describe(
    "When it ends. Give this or durationMinutes; with neither, the default length applies.",
  );

const durationArg = z
  .number()
  .int()
  .min(1)
  .max(60 * 24 * 366)
  .optional()
  .describe("Length in minutes, as an alternative to `end`.");

export const registerActionTools = (server: McpServer, client: AppleCalendarClient): void => {
  server.registerTool(
    "apple_calendar_create_event",
    {
      description:
        "Create an event. THIS IS A REAL EVENT ON A REAL CALENDAR: on an iCloud, CalDAV or " +
        "Exchange calendar it syncs within seconds and there is no draft state and no undo. " +
        "Check apple_calendar_list_calendars first — writing to one where `isShared` is true is " +
        "visible to everyone else on that calendar, so prefer a personal one unless the user " +
        "meant to share it. Read-only calendars are refused. This tool cannot add attendees, " +
        "which would email a person. The result reports what Calendar actually stored, which is " +
        "not always what was asked for.",
      inputSchema: {
        summary: z.string().min(1).describe("The event's title."),
        calendar: calendarArg,
        start: startArg,
        end: endArg,
        durationMinutes: durationArg,
        allDay: z
          .boolean()
          .optional()
          .describe(
            "Force an all-day event. Usually unnecessary: a bare day in `start` means one.",
          ),
        location: z.string().optional(),
        description: z.string().optional().describe("The event's notes."),
        url: z.string().optional(),
      },
    },
    async (args) => wrap(() => client.createEvent(args)),
  );

  server.registerTool(
    "apple_calendar_update_event",
    {
      description:
        "Change an existing event. On a shared calendar the change is visible to everyone else " +
        "on it. Note that Apple Events has no transaction: if a change is refused part-way " +
        "through, earlier fields may already have been written, so the result is the truth " +
        "about what the event now looks like. Only whole events can be edited: a ref naming " +
        "ONE occurrence " +
        "of a repeating event is refused, because Calendar's scripting interface cannot detach a " +
        "single occurrence and applying the change to the series would move every other one too. " +
        'To change a single occurrence, delete it with scope "occurrence" and create a ' +
        "replacement.",
      inputSchema: {
        ref: eventRefArg,
        summary: z.string().min(1).optional(),
        start: startArg.optional(),
        end: endArg,
        durationMinutes: durationArg,
        allDay: z.boolean().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
        url: z.string().optional(),
      },
    },
    async (args) => wrap(() => client.updateEvent(args)),
  );

  server.registerTool(
    "apple_calendar_delete_events",
    {
      description:
        "Delete whole events. Each result says whether the event ACTUALLY went — Calendar " +
        "silently declines to delete a repeating event, reporting no error, so `deleted` is " +
        "decided by re-reading the calendar rather than by the call succeeding. " +
        "A ref naming ONE occurrence of a repeating event is refused: " +
        "Calendar's scripting interface cannot remove a single occurrence, and deleting the " +
        "series instead would take every other one with it. Delete a single occurrence in " +
        "Calendar.app, or pass the `seriesRef` from get_event to remove the whole series. " +
        '"All future occurrences" is not offered either — it needs two writes with no ' +
        "transaction between them.",
      inputSchema: {
        refs: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe(
            "Event refs from a list or search result. Each must name a whole event, not one " +
              "occurrence of a repeating one.",
          ),
        confirm: confirmArg,
      },
    },
    async ({ refs }) => wrap(() => client.deleteEvents(refs)),
  );
};
