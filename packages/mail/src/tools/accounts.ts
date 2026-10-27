import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppleMailClient } from "../client/mail.js";
import { accountArg, wrap } from "./util.js";

/**
 * Account and mailbox listing.
 *
 * Names are AppleScript-primary rather than index-primary, which is the reverse
 * of what "SQLite is the fast lane" suggests: the Envelope Index stores no
 * account display names at all — only UUIDs inside `mailboxes.url` — so an
 * index-first implementation has to invent names from URL fragments and gets
 * them wrong. They are read once, with the account list, and cached.
 *
 * Counts are the other way round. Mail's per-mailbox counts measured 1.2 s for
 * every mailbox and are its cached badge values; the index counts the messages
 * themselves in one pass, so it answers whenever it is live.
 */
export const registerAccountTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_list_accounts",
    {
      description:
        "List the mail accounts configured in Apple Mail: display name, UUID, type, addresses and " +
        "mailbox names. Start here — the account name or UUID is what every other tool takes, and " +
        "the mailbox names come back exactly as Mail spells them.",
      inputSchema: z.object({}),
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
        "List mailboxes, optionally with message counts. With Full Disk Access the counts come " +
        "from Mail's search index in one pass, agree with apple_mail_count_messages, and are null " +
        'for a mailbox the index does not hold (`countsSource: "index"`). Without it they cost ' +
        "one round-trip per mailbox (~0.3s each) and `unread` is Mail's cached badge value, which " +
        "can be wrong — so then turn `withCounts` on for one account, not for all of them.",
      inputSchema: z.object({
        account: accountArg,
        withCounts: z
          .boolean()
          .optional()
          .describe(
            "Include total and unread per mailbox. Cheap with the search index; ~0.3s per " +
              "mailbox without it. Default false.",
          ),
      }),
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
