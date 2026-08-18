import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMailClient } from "../client/mail.js";
import { confirmArg, messageRefsArg, wrap } from "./util.js";

/**
 * Mutating tools.
 *
 * The whole file is behind `allowWrites` in the aggregator: with writes off
 * these are never registered, so the model cannot see them, cannot call them,
 * and is not tempted to explain to the user why it will not.
 */
export const registerActionTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_set_message_flags",
    {
      description:
        "Set read / flagged / junk state on one or more messages. Pass only the fields you want to " +
        "change; the rest are left alone. This is one tool rather than four because the four are " +
        "one Apple Event when batched, and because refs in the same mailbox are grouped into a " +
        "single round-trip. The response reports the state Mail re-read after the change, not what " +
        "was requested — Mail's search index updates on its own schedule, so a follow-up search may " +
        "briefly still show the old value.",
      inputSchema: {
        refs: messageRefsArg,
        read: z.boolean().optional().describe("Mark read (true) or unread (false)."),
        flagged: z.boolean().optional().describe("Set or clear the flag."),
        flagIndex: z
          .number()
          .int()
          .min(-1)
          .max(6)
          .optional()
          .describe("Flag colour: 0-6, or -1 to clear. Only meaningful when flagged is true."),
        junk: z.boolean().optional().describe("Mark as junk (true) or not junk (false)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ refs, read, flagged, flagIndex, junk }) =>
      wrap(async () => {
        if (
          read === undefined &&
          flagged === undefined &&
          flagIndex === undefined &&
          junk === undefined
        ) {
          return { changed: 0, note: "No flag fields were supplied, so nothing was changed." };
        }
        return client.setFlags(refs, {
          ...(read === undefined ? {} : { read }),
          ...(flagged === undefined ? {} : { flagged }),
          ...(flagIndex === undefined ? {} : { flagIndex }),
          ...(junk === undefined ? {} : { junk }),
        });
      }),
  );

  server.registerTool(
    "apple_mail_move_messages",
    {
      description:
        "Move messages to another mailbox, optionally in another account. The refs you passed in " +
        "are DEAD afterwards: a moved message gets a new row id, so the response returns fresh refs " +
        "and reports any message it could not re-locate. Requires confirm: true.",
      inputSchema: {
        refs: messageRefsArg,
        destinationMailbox: z
          .string()
          .min(1)
          .describe('Target mailbox name, e.g. "Archive" or "[Gmail]/All Mail".'),
        destinationAccount: z
          .string()
          .optional()
          .describe("Target account name or UUID. Defaults to each message's own account."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ refs, destinationMailbox, destinationAccount }) =>
      wrap(async () =>
        client.moveMessages(refs, {
          destinationMailbox,
          ...(destinationAccount ? { destinationAccount } : {}),
        }),
      ),
  );

  server.registerTool(
    "apple_mail_delete_messages",
    {
      description:
        "Delete messages. This follows the account's own 'move deleted messages to Trash' setting, " +
        "which this server does not control — for an account with that setting off, deletion is " +
        "immediate and NOT recoverable from here. The response reports which behaviour applied. " +
        "Requires confirm: true.",
      inputSchema: {
        refs: messageRefsArg,
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ refs }) => wrap(async () => client.deleteMessages(refs)),
  );

  server.registerTool(
    "apple_mail_check_for_new_mail",
    {
      description:
        "Ask Mail to sync now, for one account or all of them. Unlike the read tools this will " +
        "launch Mail if it is not running, and it causes real network activity against the mail " +
        "servers, which is why it is a write-gated tool.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe("Account name or UUID. Omit to check every account."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ account }) => wrap(async () => client.checkForNewMail(account)),
  );
};
