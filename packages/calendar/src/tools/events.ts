import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleCalendarClient } from "../client/calendar.js";
import {
  calendarArg,
  eventRefArg,
  fromArg,
  includeCancelledArg,
  includeDeclinedArg,
  limitArg,
  resolveLimit,
  toArg,
  wrap,
} from "./util.js";

/** Declared once and spread into both tools, so the two cannot drift apart. */
const filterSchema = {
  calendar: calendarArg,
  includeDeclined: includeDeclinedArg,
  includeCancelled: includeCancelledArg,
  limit: limitArg,
};

export const registerEventTools = (server: McpServer, client: AppleCalendarClient): void => {
  server.registerTool(
    "apple_calendar_list_events",
    {
      description:
        "List events in a date range, earliest first. Occurrences of repeating events are " +
        "expanded, so a weekly standup appears once per week rather than once. The result " +
        "carries a `coverage` block naming the window the expansion is known to cover; if your " +
        "range runs past it, `truncated` is set and says what is missing rather than returning a " +
        "short list silently. Returns a `ref` per event for get_event.",
      inputSchema: { from: fromArg, to: toArg, ...filterSchema },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () =>
        client.listEvents({
          ...args,
          limit: resolveLimit(args.limit, client.config.maxResults, 50),
        }),
      ),
  );

  server.registerTool(
    "apple_calendar_search_events",
    {
      description:
        "Search events by text, most recent first. Unbounded in time unless you give `from` or " +
        "`to`. Matches each event ONCE at its series start — it does not expand occurrences, so " +
        "use list_events with a range to see individual instances of a repeating event.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for. Matched case-insensitively."),
        scope: z
          .enum(["summary", "full"])
          .optional()
          .describe('"summary" (default) searches titles; "full" adds notes and location.'),
        from: fromArg,
        to: toArg,
        ...filterSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () =>
        client.searchEvents({
          ...args,
          limit: resolveLimit(args.limit, client.config.maxResults, 50),
        }),
      ),
  );

  server.registerTool(
    "apple_calendar_get_event",
    {
      description:
        "Full detail for one event: notes, location, URL, conference link, and whether it has " +
        "attendees or repeats. A ref naming one occurrence reports that occurrence's times and " +
        "carries a `seriesRef` pointing at the whole series.",
      inputSchema: { ref: eventRefArg },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) => wrap(async () => client.getEvent(ref)),
  );
};
