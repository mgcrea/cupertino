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
        "List every calendar with the account it belongs to, whether it is SHARED with other " +
        "people, and whether it looks writable. Two cautions. `isShared` means anything you " +
        "write there is visible to the others on it. And `isSubscribed` catches URL-subscribed " +
        "calendars but not every read-only one — Birthdays and Siri Suggestions are also " +
        "read-only — so a write can still be refused by Calendar itself.",
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
