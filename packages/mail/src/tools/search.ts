import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMailClient } from "../client/mail.js";
import { accountArg, limitArg, mailboxArg, messageRefArg, resolveLimit, wrap } from "./util.js";

/** Searching, listing and counting. */
export const registerSearchTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_search_messages",
    {
      description:
        "Search mail by any combination of text, body text, sender, recipient, subject, mailbox, " +
        "account, read/flagged state, attachments and date range. This is the tool to reach for " +
        "whenever a filter is involved — it reads Mail's own search index, so it is fast even " +
        "across a six-figure archive. Returns a `ref` per message for the read and action tools. " +
        "Requires Full Disk Access; without it this returns degraded:true and you should fall back " +
        "to apple_mail_list_messages on a specific mailbox.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free text matched against subject and sender. For bodies, use `body`."),
        body: z
          .string()
          .optional()
          .describe(
            "Free text matched against message BODIES. There is no body index on macOS, so this " +
              "reads the message files of whatever the other filters leave — cost is linear in " +
              "that number. COMBINE IT WITH A NARROWING FILTER (mailbox, sender, dateFrom) or it " +
              "will exceed the scan bound and refuse rather than answer from a partial scan. The " +
              "result's `bodyScan` block reports how many messages were considered and scanned.",
          ),
        sender: z.string().optional().describe("Match the sender address or display name."),
        recipient: z.string().optional().describe("Match any recipient address."),
        subject: z.string().optional().describe("Match the subject only."),
        account: accountArg,
        mailbox: mailboxArg,
        unreadOnly: z.boolean().optional().describe("Only unread messages."),
        flaggedOnly: z.boolean().optional().describe("Only flagged messages."),
        hasAttachment: z.boolean().optional().describe("Only messages carrying an attachment."),
        dateFrom: z.string().optional().describe("ISO date/time lower bound, e.g. 2026-01-01."),
        dateTo: z.string().optional().describe("ISO date/time upper bound."),
        limit: limitArg,
        offset: z.number().int().min(0).optional().describe("Skip this many results, for paging."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () => {
        const result = await client.searchMessages({
          ...args,
          limit: resolveLimit(args.limit, client.config.maxResults),
          offset: args.offset ?? 0,
        });
        if (!result) {
          return {
            degraded: true,
            capability: "search-index",
            reason: client.indexError ?? "the search index is unavailable",
            hint:
              "Grant Full Disk Access and restart the host app, or use apple_mail_list_messages " +
              "for a capped listing of one mailbox. Call apple_mail_diagnostics for details.",
          };
        }
        /*
         * A refusal, not an empty result. The distinction is the whole point of
         * the bound: "no messages matched" and "too many messages to check"
         * look identical to a model unless the second one says so.
         */
        if (result.bodyScan?.status === "over-bound") {
          const { candidates, bound } = result.bodyScan;
          return {
            degraded: true,
            capability: "body-scan",
            reason:
              `${candidates} messages match the other filters, above the ${bound}-message body ` +
              `scan bound. Nothing was scanned, so this is not "no results".`,
            hint:
              "Narrow with mailbox, account, sender or dateFrom and try again — a body search " +
              "over a few hundred candidates is near-instant. Raise APPLE_MAIL_BODY_SCAN_MAX " +
              "only if a slow answer is genuinely wanted.",
            candidates,
            bound,
          };
        }

        return {
          returned: result.messages.length,
          source: result.source,
          indexAgeSeconds: result.indexAgeSeconds,
          ...(result.bodyScan ? { bodyScan: result.bodyScan } : {}),
          ...(result.walBlind
            ? { warning: "Index opened WAL-blind (immutable); very recent mail may be missing." }
            : {}),
          messages: result.messages,
        };
      }),
  );

  server.registerTool(
    "apple_mail_get_thread",
    {
      description:
        "Get every message in the conversation containing a given message, oldest first, across " +
        "mailboxes and accounts. Metadata only — use apple_mail_get_message for bodies. Requires " +
        "Full Disk Access.",
      inputSchema: {
        ref: messageRefArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, limit }) =>
      wrap(async () => {
        const messages = await client.threadOf(
          ref,
          resolveLimit(limit, client.config.maxResults, 50),
        );
        if (!messages) {
          return {
            degraded: true,
            capability: "search-index",
            reason: client.indexError ?? "the search index is unavailable",
            hint: "Threading needs Mail's search index. Call apple_mail_diagnostics for details.",
          };
        }
        return { returned: messages.length, messages };
      }),
  );

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
        const result = await client.listRecent(
          resolved,
          box,
          resolveLimit(limit, client.config.maxResults),
        );
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
        const viaIndex = await client.countViaIndex({ account: resolved.name, mailbox: box });
        return {
          account: resolved.name,
          mailbox: counts.mailbox,
          total: viaIndex?.total ?? counts.total,
          unread: { applescript: counts.unread, index: viaIndex?.unread ?? null },
          note: viaIndex
            ? "Prefer unread.index: unread.applescript is Mail's cached badge value and is " +
              "sometimes flatly wrong (observed as 0 for a mailbox with 1618 unread)."
            : "unread.applescript is Mail's cached badge value and may be stale or zero. " +
              "Grant Full Disk Access for the authoritative count.",
        };
      }),
  );
};
