import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMailClient } from "../client/mail.js";
import { accountArg, limitArg, mailboxArg, wrap } from "./util.js";

/**
 * Listing and counting.
 *
 * `apple_mail_search_messages` lands here in Phase 2, once the Envelope Index
 * lane exists. It is deliberately absent rather than stubbed: a registered tool
 * that always answers "not implemented" is worse than one the model never sees.
 */
export const registerSearchTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_list_messages",
    {
      description:
        "List the newest messages in one mailbox, most recent first. Returns a `ref` per message " +
        "that the read and action tools take. Without the search index this runs over Apple Events " +
        "and is capped (default 50) because each additional message costs about 40ms per field — " +
        "ask for 20 unless you have a reason not to. For anything involving a filter, use " +
        "apple_mail_search_messages.",
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ account, mailbox, limit }) =>
      wrap(async () => {
        const accounts = await client.accounts();
        const resolved = account ? await client.mailboxes.resolveAccount(account) : accounts[0];
        if (!resolved) {
          return { messages: [], note: "No accounts are visible to this server." };
        }
        const box = mailbox ?? (resolved.mailboxes.includes("INBOX") ? "INBOX" : "Inbox");
        const result = await client.listRecent(resolved, box, limit ?? 25);
        const lanes = await client.lanes();
        return {
          account: resolved.name,
          mailbox: result.mailbox,
          total: result.total,
          returned: result.messages.length,
          source: "applescript",
          ...(lanes.index === "live"
            ? {}
            : {
                note:
                  `Listing came from Apple Events and is capped at ${client.config.degradedMaxMessages}. ` +
                  `The search index is ${lanes.index}: ${lanes.indexReason ?? "unavailable"}`,
              }),
          messages: result.messages,
        };
      }),
  );

  server.registerTool(
    "apple_mail_count_messages",
    {
      description:
        "Count messages in a mailbox. Cheap in both lanes, so this works with no extra permissions. " +
        "The `unread` figure is reported per source: Mail's own cached count is fast but can be " +
        "flatly wrong (observed reporting 0 for a mailbox holding 1618 unread messages), so treat " +
        "the index figure as authoritative when it is present.",
      inputSchema: {
        account: accountArg,
        mailbox: mailboxArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ account, mailbox }) =>
      wrap(async () => {
        const accounts = await client.accounts();
        const resolved = account ? await client.mailboxes.resolveAccount(account) : accounts[0];
        if (!resolved) return { note: "No accounts are visible to this server." };
        const box = mailbox ?? (resolved.mailboxes.includes("INBOX") ? "INBOX" : "Inbox");
        const counts = await client.countMailbox(resolved, box);
        return {
          account: resolved.name,
          mailbox: counts.mailbox,
          total: counts.total,
          unread: { applescript: counts.unread, index: null },
          note: "unread.applescript is Mail's cached badge value and may be stale or zero.",
        };
      }),
  );
};
