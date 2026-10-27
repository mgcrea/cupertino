import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppleRemindersClient } from "../client/reminders.js";
import { wrap } from "./util.js";

export const registerAccountTools = (server: McpServer, client: AppleRemindersClient): void => {
  server.registerTool(
    "apple_reminders_list_accounts",
    {
      description:
        "List the Reminders accounts, with how many lists each holds. Start here to discover " +
        "account names for the other tools. `reminderCount` is null when Reminders will not count " +
        "an account's reminders, which is usual: per-list counts are in apple_reminders_list_lists.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => client.accounts()),
  );

  server.registerTool(
    "apple_reminders_list_lists",
    {
      description:
        "List every Reminders list, across accounts. Lists nest inside other lists (Reminders " +
        "calls those groups), so each entry carries its depth. Each also reports its total and " +
        "incomplete counts, which is the cheapest way to see where the live work is. Counts are " +
        "null for a list they could not be read for, which is not the same as empty.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => client.lists()),
  );
};
