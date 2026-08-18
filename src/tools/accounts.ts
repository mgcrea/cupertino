import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMailClient } from "../client/mail.js";
import { accountArg, wrap } from "./util.js";

/**
 * Account and mailbox listing.
 *
 * Both are AppleScript-primary rather than index-primary, which is the reverse
 * of what "SQLite is the fast lane" suggests. Two reasons: it is genuinely fast
 * here (0.6s for every account and mailbox on this machine, because the cost is
 * O(mailboxes) not O(messages)), and the Envelope Index stores no account
 * display names at all — only UUIDs inside `mailboxes.url` — so an index-first
 * implementation has to invent names from URL fragments and gets them wrong.
 */
export const registerAccountTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_list_accounts",
    {
      description:
        "List the mail accounts configured in Apple Mail: display name, UUID, type, addresses and " +
        "mailbox names. Start here — the account name or UUID is what every other tool takes, and " +
        "the mailbox names come back exactly as Mail spells them.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () =>
        (await client.accounts()).map((a) => ({
          id: a.id,
          name: a.name,
          enabled: a.enabled,
          type: a.accountType,
          emailAddresses: a.emailAddresses,
          fullName: a.fullName,
          mailboxes: a.mailboxes,
        })),
      ),
  );

  server.registerTool(
    "apple_mail_list_mailboxes",
    {
      description:
        "List mailboxes, optionally with message counts. Counts cost one round-trip per mailbox " +
        "(~0.3s each), so `withCounts` is off by default — turn it on for one account, not for all " +
        "of them. Note that `unread` here is Mail's cached badge value and can be wrong; " +
        "apple_mail_count_messages reports both sources.",
      inputSchema: {
        account: accountArg,
        withCounts: z
          .boolean()
          .optional()
          .describe(
            "Include total and unread per mailbox. Costs ~0.3s per mailbox. Default false.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ account, withCounts }) =>
      wrap(async () => {
        const accountUuids = account
          ? [(await client.mailboxes.resolveAccount(account)).id]
          : undefined;
        return client.listMailboxes({
          ...(accountUuids ? { accountUuids } : {}),
          withCounts: withCounts ?? false,
        });
      }),
  );
};
