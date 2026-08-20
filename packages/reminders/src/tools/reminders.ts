import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleRemindersClient } from "../client/reminders.js";
import {
  includeCompletedArg,
  limitArg,
  listArg,
  priorityArg,
  reminderRefArg,
  wrap,
} from "./util.js";

/** Filters shared by list and search, declared once so the two cannot drift. */
const filterSchema = {
  list: listArg,
  includeCompleted: includeCompletedArg,
  dueBefore: z
    .string()
    .optional()
    .describe(
      'Only reminders due at or before this. A bare day means the WHOLE day, so "2026-08-20" ' +
        "includes everything due that evening. Same grammar as the due argument.",
    ),
  dueAfter: z
    .string()
    .optional()
    .describe(
      "Only reminders due at or after this. A bare day means from that morning. Combine with " +
        "dueBefore for a range.",
    ),
  flagged: z.boolean().optional().describe("Only flagged, or only unflagged."),
  priority: priorityArg,
  hasDueDate: z
    .boolean()
    .optional()
    .describe("true = only reminders with a due date; false = only those without one."),
  limit: limitArg,
};

export const registerReminderTools = (server: McpServer, client: AppleRemindersClient): void => {
  server.registerTool(
    "apple_reminders_list_reminders",
    {
      description:
        "List reminders, soonest due first, with undated ones last. Returns a `ref` per " +
        "reminder for the read and action tools. Completed reminders are excluded unless you " +
        "ask for them. Every filter is optional; with none, this is the whole live list.",
      inputSchema: filterSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        client.listReminders({
          ...args,
          limit: args.limit ?? Math.min(50, client.config.maxResults),
        }),
      ),
  );

  server.registerTool(
    "apple_reminders_search_reminders",
    {
      description:
        'Search reminders by text. `scope: "full"` (the default) matches the name and the ' +
        'notes body; `scope: "title"` matches only the name. Accepts the same filters as ' +
        "list_reminders, so you can search within one list or one date range.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for. Case-insensitive substring match."),
        scope: z
          .enum(["full", "title"])
          .optional()
          .describe("full = name and notes body (default). title = name only."),
        ...filterSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, scope, ...rest }) =>
      wrap(() =>
        client.searchReminders(query, {
          ...rest,
          ...(scope ? { scope } : {}),
          limit: rest.limit ?? Math.min(50, client.config.maxResults),
        }),
      ),
  );

  server.registerTool(
    "apple_reminders_get_reminder",
    {
      description:
        "Read one reminder in full by ref, including its notes body and any subtasks. " +
        "`dueDate` and `alldayDueDate` are reported separately from the combined `due` field, " +
        "so you can see which property actually holds the date.",
      inputSchema: { ref: reminderRefArg },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) => wrap(() => client.getReminder(ref)),
  );
};
