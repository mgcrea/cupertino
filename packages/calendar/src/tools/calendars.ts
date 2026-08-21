import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleCalendarClient } from "../client/calendar.js";
import { wrap } from "./util.js";

/**
 * NOTE ON `async` BELOW: core's `wrap` is typed `() => Promise<T>` because every
 * other surface reaches Apple Events. Calendar reads synchronous SQLite, so the
 * thunks are marked async here rather than widening a shared signature for all
 * four surfaces to accommodate one.
 */

export const registerCalendarTools = (server: McpServer, client: AppleCalendarClient): void => {
  server.registerTool(
    "apple_calendar_list_calendars",
    {
      description:
        "List every calendar, with the account it belongs to and whether it can be written to. " +
        "Subscribed calendars — holidays, birthdays, anything added by URL — are read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => client.calendars()),
  );

  server.registerTool(
    "apple_calendar_list_accounts",
    {
      description:
        "List the accounts Calendar syncs, with how many calendars each holds. Use this to scope " +
        "a search when the same calendar name exists in more than one account.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => client.accounts()),
  );
};
