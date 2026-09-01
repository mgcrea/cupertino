import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WEEKDAY_KEYS } from "../client/availability.js";
import type { AppleCalendarClient } from "../client/calendar.js";
import {
  calendarArg,
  includeCancelledArg,
  includeDeclinedArg,
  limitArg,
  resolveLimit,
  toArg,
  wrap,
} from "./util.js";

/**
 * The one read on this surface that answers a question instead of returning
 * rows, and the only one whose result is the COMPLEMENT of what it read.
 *
 * It lives apart from `events.ts` for that reason. The three tools there share
 * a failure mode — return fewer events than exist, flag it, and the caller is
 * merely under-informed. This one turns the same shortfall into a positive
 * claim that a time is free, so its refusal paths are load-bearing rather than
 * defensive, and keeping them next to a `list_events` that legitimately pages
 * would invite someone to make the two consistent.
 */
export const registerAvailabilityTools = (server: McpServer, client: AppleCalendarClient): void => {
  server.registerTool(
    "apple_calendar_find_availability",
    {
      description:
        "Find the times nothing is on the calendar, long enough to hold a meeting of a given " +
        'length. This is the tool for "when am I free", "find me 45 minutes next week" or ' +
        '"what does Thursday look like" — reach for it instead of listing events and looking ' +
        "for gaps yourself, which is where an occurrence of a repeating meeting gets missed. " +
        "Working hours default to 09:00-18:00 on weekdays, in THIS MACHINE'S timezone, and only " +
        "time inside them is offered. Slots start on a 15-minute boundary and each one reports " +
        "how long the whole gap is, which is usually longer than you asked for. " +
        "Time already past today is never offered. " +
        "It refuses rather than guesses: if the window holds too many events to read, if this " +
        "store does not expand repeating events, or if the window runs past the range the " +
        "expansion covers, you get `degraded: true` and a reason instead of free time that is " +
        "not free. An empty `slots` list means BOOKED; `degraded` means UNKNOWN. " +
        "Declined and cancelled events do not block time; all-day events do not either, but " +
        "they are listed in `allDayEvents` so you can see the holiday you are about to book over.",
      inputSchema: {
        durationMinutes: z
          .number()
          .int()
          .min(1)
          .max(1_440)
          .describe("How long the meeting needs to be. A gap shorter than this is not returned."),
        from: z
          .string()
          .optional()
          .describe(
            'Start of the window. ISO-8601 "2026-08-21" or "2026-08-21T09:00", or "today", ' +
              '"tomorrow", "next monday", "+2d". Defaults to today. A start already in the past ' +
              "is pulled forward to now.",
          ),
        to: toArg,
        calendar: calendarArg,
        dayStart: z
          .string()
          .optional()
          .describe(
            'Earliest time of day to offer, local wall clock, e.g. "09:00". Defaults to ' +
              "APPLE_CALENDAR_WORKDAY_START (09:00).",
          ),
        dayEnd: z
          .string()
          .optional()
          .describe(
            'Latest time of day to offer, e.g. "18:00" — or "24:00" for the end of the day. ' +
              "Defaults to APPLE_CALENDAR_WORKDAY_END (18:00).",
          ),
        weekdays: z
          .array(z.enum(WEEKDAY_KEYS))
          .min(1)
          .optional()
          .describe(
            'Which days to offer, e.g. ["mon","tue","wed","thu","fri"]. Defaults to the ' +
              "configured working week. Pass all seven to include the weekend.",
          ),
        granularityMinutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .refine((n) => 60 % n === 0, {
            message: "must divide 60 evenly — 5, 10, 15, 20, 30 or 60",
          })
          .optional()
          .describe("Slot starts are rounded up to this boundary. Default 15."),
        allDayBusy: z
          .boolean()
          .optional()
          .describe(
            "Let an all-day event block its whole day. Off by default, because an all-day event " +
              'is as often a birthday as a holiday, and blocking on "Ana\'s birthday" would hide ' +
              "a working day. They are reported in `allDayEvents` either way — read that before " +
              "booking rather than turning this on blindly.",
          ),
        respectFreeMarking: z
          .boolean()
          .optional()
          .describe(
            'Skip events the calendar marks as "free" rather than "busy". Off by default: the ' +
              "stored constant is inferred from EventKit and has not been measured against a " +
              "real store, and reading it wrongly would offer a slot that is booked. Every busy " +
              "block reports its raw value so you can check before turning this on.",
          ),
        includeDeclined: includeDeclinedArg,
        includeCancelled: includeCancelledArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () =>
        client.findAvailability({
          ...args,
          dayStart: args.dayStart ?? client.config.workdayStart,
          dayEnd: args.dayEnd ?? client.config.workdayEnd,
          weekdays: args.weekdays ?? client.config.workdays,
          granularityMinutes: args.granularityMinutes ?? 15,
          allDayBusy: args.allDayBusy ?? false,
          respectFreeMarking: args.respectFreeMarking ?? false,
          limit: resolveLimit(args.limit, client.config.maxResults),
        }),
      ),
  );
};
