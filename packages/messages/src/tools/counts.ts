import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMessagesClient } from "../client/messages.js";
import { decodeChatRef } from "../client/ref.js";
import { COUNT_GROUP_FIELDS } from "../client/store.js";
import {
  chatRefArg,
  describeAggregation,
  fromArg,
  groupByArg,
  includeReactionsArg,
  limitArg,
  wrap,
} from "./util.js";

/** ISO-8601 in, or a clear refusal. Same grammar as `list_messages`. */
const parseBound = (raw: string | undefined, field: string): Date | undefined => {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Could not read ${field} from ${JSON.stringify(raw)}. Use ISO-8601: "2026-08-01" or ` +
        `"2026-08-01T09:00".`,
    );
  }
  return d;
};

/**
 * The cheap-answer lane on this surface: counts, and counts per group.
 *
 * Narrower than Mail's `apple_mail_query` on purpose. Mail's version also
 * projects rows, because a mail row is mostly metadata and dropping half of it
 * saves real tokens; a Messages row's bulk IS its text, and a message listing
 * without the text is rarely the question. What was actually missing here is
 * arithmetic: a sent/received split, per-period volume, and per-handle totals
 * across the several chats one person can occupy — none of which
 * `apple_messages_list_chats` can answer, and all of which otherwise mean
 * paging conversations into the context to tally them by hand.
 *
 * Metadata only, and that boundary is load-bearing rather than a first cut: see
 * `COUNT_GROUP_FIELDS` in `store.ts` for why a text-derived aggregate cannot be
 * offered on a store whose recent bodies live in a blob.
 */
export const registerCountTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_count_messages",
    {
      description:
        "Count messages without reading them. Answers 'how many', 'how many did I send', " +
        "'who do I message most' and 'which month was busiest' as arithmetic the store does, " +
        "rather than a page of conversations you tally by hand. Every result splits `sent` and " +
        "`received`.\n\n" +
        "`groupBy` counts per day, month, chat, handle or direction, over EVERY match rather " +
        "than the first `limit` of them — `limit` caps how many groups come back. Grouping by " +
        "handle is the one to reach for when a person has several conversations, since " +
        "apple_messages_list_chats already gives you per-CHAT totals.\n\n" +
        "Counts metadata only: there is no text filter here, because message bodies from 2026 " +
        "onward live in an archived blob that SQL cannot see, and a count that quietly skipped " +
        "them would look exactly like a correct one. Use apple_messages_search_messages for " +
        "anything about what was said. Tapbacks are excluded unless you ask for them.",
      inputSchema: {
        chatRef: chatRefArg,
        handle: z
          .string()
          .optional()
          .describe(
            "Only messages with this correspondent — a phone number or email, matched as a " +
              "substring. Spans every chat they appear in, which is the difference from chatRef.",
          ),
        direction: z
          .enum(["sent", "received"])
          .optional()
          .describe("Only what you sent, or only what you received. Omit for both."),
        from: fromArg,
        to: z
          .string()
          .optional()
          .describe("End of the window, ISO-8601, exclusive. Omit to count up to now."),
        includeReactions: includeReactionsArg,
        groupBy: groupByArg(COUNT_GROUP_FIELDS, "Day and month buckets are LOCAL calendar dates."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chatRef, handle, direction, from, to, includeReactions, groupBy, limit }) =>
      wrap(async () => {
        const window = client.window(parseBound(from, "from"), parseBound(to, "to"));
        const result = client.countMessages(
          {
            ...(chatRef ? { chatGuid: decodeChatRef(chatRef) } : {}),
            ...(handle === undefined ? {} : { handle }),
            ...(direction === undefined ? {} : { direction }),
            ...window,
            ...(includeReactions === undefined ? {} : { includeReactions }),
            ...(limit === undefined ? {} : { limit }),
          },
          groupBy,
        );

        if (!("groups" in result)) return result;

        // `count` rather than `total` on a bucket, because that is the name the
        // shared aggregation envelope uses and a model that has read Mail's
        // grouped results should not have to learn a second spelling.
        return describeAggregation(
          groupBy as string,
          result.groups.map(({ total, ...rest }) => ({ ...rest, count: total })),
          result,
        );
      }),
  );
};
