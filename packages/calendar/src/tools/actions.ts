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
        "Create an event. THIS IS A REAL EVENT ON A REAL CALENDAR: on a shared, CalDAV or " +
        "Exchange calendar it syncs within seconds and other people see it, and there is no " +
        "draft state. Subscribed calendars (holidays, birthdays, anything added by URL) are " +
        "read-only and will be refused. This tool cannot add attendees — that would email a " +
        "person. The result reports what Calendar actually stored, which is not always what was " +
        "asked for.",
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
        "Change an existing event. Only whole events can be edited: a ref naming ONE occurrence " +
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
        'Delete events. `scope` is required and has no default: "series" removes the event and ' +
        'EVERY occurrence of it, while "occurrence" removes only the single instance your ref ' +
        "names, by adding its date to the event's excluded dates — which is what Calendar itself " +
        'does, and is reversible in the app. "All future occurrences" is not offered, because it ' +
        "needs two writes with no transaction between them.",
      inputSchema: {
        refs: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe("Event refs from a list or search result."),
        scope: z
          .enum(["series", "occurrence"])
          .describe(
            'REQUIRED. "series" deletes the whole event; "occurrence" cancels just the one ' +
              "instance the ref names. Choosing wrongly here is the difference between " +
              "cancelling one lunch and deleting a standing meeting.",
          ),
        confirm: confirmArg,
      },
    },
    async ({ refs, scope }) => wrap(() => client.deleteEvents(refs, scope)),
  );
};
