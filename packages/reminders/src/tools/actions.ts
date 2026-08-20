import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleRemindersClient } from "../client/reminders.js";
import {
  confirmArg,
  dateArg,
  listArg,
  priorityArg,
  reminderRefArg,
  reminderRefsArg,
  wrap,
} from "./util.js";

/**
 * The mutating tools.
 *
 * Registered only when writes are enabled, so with the flag off they are
 * invisible to the model rather than merely refused.
 *
 * Every one of these re-reads the reminder afterwards and returns what
 * Reminders stored — not what was asked for. That matters most for dates: a
 * relative offset like "+2d" is resolved here, and the result says what instant
 * it became.
 */
export const registerActionTools = (server: McpServer, client: AppleRemindersClient): void => {
  server.registerTool(
    "apple_reminders_create_reminder",
    {
      description:
        "Create a reminder. With no list, it goes to the list Reminders itself treats as the " +
        "default — the same one the app would have used.",
      inputSchema: {
        name: z.string().min(1).describe("The reminder's title."),
        body: z.string().optional().describe("Notes attached to the reminder."),
        list: listArg,
        due: dateArg.optional(),
        remindMe: dateArg
          .optional()
          .describe("When to actually alert, if different from the due date."),
        priority: priorityArg,
        flagged: z.boolean().optional().describe("Flag it."),
      },
    },
    async (args) => wrap(() => client.createReminder(args)),
  );

  server.registerTool(
    "apple_reminders_update_reminder",
    {
      description:
        "Change fields on one reminder. Anything you omit is left alone. Setting `due` to a " +
        "bare day converts it to an all-day reminder; setting a date-time makes it timed.",
      inputSchema: {
        ref: reminderRefArg,
        name: z.string().optional(),
        body: z
          .string()
          .optional()
          .describe("Replaces the notes body. Pass an empty string to clear it."),
        due: dateArg.optional(),
        remindMe: dateArg.optional(),
        priority: priorityArg,
        flagged: z.boolean().optional(),
      },
    },
    async ({ ref, ...fields }) => wrap(() => client.updateReminder(ref, fields)),
  );

  server.registerTool(
    "apple_reminders_complete_reminders",
    {
      description:
        "Tick reminders off, or un-tick them with `completed: false`. Separate from update " +
        "because it is the common case and takes several at once.",
      inputSchema: {
        refs: reminderRefsArg,
        completed: z
          .boolean()
          .optional()
          .describe("Defaults to true. Pass false to mark them not done again."),
      },
    },
    async ({ refs, completed }) => wrap(() => client.completeReminders(refs, completed ?? true)),
  );

  server.registerTool(
    "apple_reminders_move_reminders",
    {
      description:
        "Move reminders to another list. NOTE: Reminders' scripting interface makes a list " +
        "read-only on a reminder, so this is a copy followed by a delete. Each moved reminder " +
        "therefore gets a NEW ref (returned alongside the old one) and a new creation date. " +
        "The original is deleted only after the copy is confirmed.",
      inputSchema: {
        refs: reminderRefsArg,
        list: z.string().min(1).describe("Target list name or id."),
        confirm: confirmArg,
      },
    },
    async ({ refs, list }) => wrap(() => client.moveReminders(refs, list)),
  );

  server.registerTool(
    "apple_reminders_delete_reminders",
    {
      description:
        "Delete reminders. Unlike Notes, Reminders has no Recently Deleted — this is " +
        "irreversible, so it requires an explicit confirm.",
      inputSchema: { refs: reminderRefsArg, confirm: confirmArg },
    },
    async ({ refs }) => wrap(() => client.deleteReminders(refs)),
  );
};
