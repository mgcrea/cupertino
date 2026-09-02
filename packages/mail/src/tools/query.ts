import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GROUP_FIELDS } from "../client/envelope.js";
import type { AppleMailClient } from "../client/mail.js";
import {
  accountArg,
  describeAggregation,
  groupByArg,
  limitArg,
  mailboxArg,
  project,
  resolveLimit,
  selectArg,
  wrap,
} from "./util.js";

/** What a search result actually carries, and therefore what `select` may name. */
const SELECTABLE = [
  "ref",
  "subject",
  "sender",
  "dateReceived",
  "dateSent",
  "read",
  "flagged",
  "size",
] as const;

/**
 * The cheap-answer lane: same index as `apple_mail_search_messages`, but able to
 * return less than a whole row, or a count instead of the rows.
 *
 * Read-only by construction — it reaches nothing but the index — and registered
 * only on servers with writes off, so the surface a write-enabled client sees is
 * unchanged while this is proven out.
 */
export const registerQueryTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_query",
    {
      description:
        "Answer a question ABOUT your mail without reading the mail. Takes the same index " +
        "filters as apple_mail_search_messages, plus two things it cannot do: `select` to keep " +
        "only the fields you need, and `groupBy` to get counts per sender, mailbox, subject, " +
        "day or month. Reach for this whenever the question is 'how many', 'who most', 'which " +
        "mailbox' or 'when' — one grouped call replaces paging through hundreds of messages " +
        "and tallying them by hand. Grouping counts every match, not just the first `limit`. " +
        "Body search is not offered here (it is a linear file scan, which does not belong " +
        "behind an aggregate) — use apple_mail_search_messages for that. " +
        "Requires Full Disk Access; without it this returns degraded:true.",
      inputSchema: {
        query: z.string().optional().describe("Free text matched against subject and sender."),
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
        groupBy: groupByArg(GROUP_FIELDS),
        select: selectArg,
        limit: limitArg,
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Skip this many rows, for paging. Ignored when grouping."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupBy, select, limit, offset, ...filters }) =>
      wrap(async () => {
        const resolved = resolveLimit(limit, client.config.maxResults);

        if (groupBy) {
          const result = await client.groupMessages({ ...filters, limit: resolved }, groupBy);
          if (!result) return degraded(client);
          return {
            ...describeAggregation(groupBy, result.groups, result),
            indexAgeSeconds: result.indexAgeSeconds,
            ...walBlindWarning(result.walBlind),
          };
        }

        const result = await client.searchMessages({
          ...filters,
          limit: resolved,
          offset: offset ?? 0,
        });
        if (!result) return degraded(client);

        const { rows, unknownFields } = project(result.messages, select, SELECTABLE);
        return {
          returned: rows.length,
          indexAgeSeconds: result.indexAgeSeconds,
          ...(unknownFields
            ? {
                unknownFields,
                hint: `Selectable fields are: ${SELECTABLE.join(", ")}.`,
              }
            : {}),
          ...walBlindWarning(result.walBlind),
          messages: rows,
        };
      }),
  );
};

/**
 * The same degradation the other index-backed tools report. Kept identical on
 * purpose: a model that has learned what `capability: "search-index"` means
 * should not have to learn a second spelling of it here.
 */
const degraded = (client: AppleMailClient) => ({
  degraded: true,
  capability: "search-index",
  reason: client.indexError ?? "the search index is unavailable",
  hint:
    "Grant Full Disk Access and restart the host app, then retry. " +
    "Call apple_mail_diagnostics for details.",
});

const walBlindWarning = (walBlind: boolean) =>
  walBlind
    ? { warning: "Index opened WAL-blind (immutable); very recent mail may be missing." }
    : {};
