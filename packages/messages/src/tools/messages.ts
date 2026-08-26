import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMessagesClient } from "../client/messages.js";
import { decodeChatRef, decodeMessageRef } from "../client/ref.js";
import {
  chatRefArg,
  fail,
  fromArg,
  includeReactionsArg,
  limitArg,
  messageRefArg,
  ok,
  toArg,
  wrap,
  wrapResult,
} from "./util.js";

/** ISO-8601 in, or a clear refusal. No relative grammar on this surface yet. */
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

export const registerMessageTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_list_messages",
    {
      description:
        "Read messages, newest first — the whole store, or one conversation, or a date window. " +
        "Tapbacks are excluded by default because they are rows in the same table and would " +
        "otherwise read as messages nobody typed.\n\n" +
        "Every message carries `from.name` where Contacts resolves it and `from.handle` always. " +
        "`from.resolution` is worth reading: `unknown` is COMMON AND NOT AN ERROR — measured on a " +
        "real store, about one in six of even the busiest correspondents has no contact card.",
      inputSchema: {
        chatRef: chatRefArg,
        from: fromArg,
        to: toArg,
        includeReactions: includeReactionsArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ chatRef, from, to, includeReactions, limit }) =>
      wrap(async () => {
        const window = client.window(parseBound(from, "from"), parseBound(to, "to"));
        return client.listMessages({
          ...(chatRef ? { chatRef: decodeChatRef(chatRef) } : {}),
          ...window,
          ...(includeReactions === undefined ? {} : { includeReactions }),
          ...(limit === undefined ? {} : { limit }),
        });
      }),
  );

  server.registerTool(
    "apple_messages_search_messages",
    {
      description:
        "Search message text across every conversation. Matches are substring and " +
        "case-insensitive.\n\n" +
        "This searches ALL messages, including the roughly 3% whose text lives only in an " +
        "archived blob rather than in a plain column — those are invisible to any SQL query and " +
        "are decoded here. `textSource` on each result says which produced it.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => wrap(async () => client.searchMessages(query, limit)),
  );

  server.registerTool(
    "apple_messages_get_message",
    {
      description:
        "One message in full, with its tapbacks and attachments. Reactions are reported here " +
        "rather than mixed into the conversation, which is the whole reason list_messages " +
        "filters them out.",
      inputSchema: { ref: messageRefArg },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const message = client.getMessage(decodeMessageRef(ref));
        if (!message) {
          return fail(
            `No message for ref "${ref}". It was probably deleted since the search ran. ` +
              `Re-run the search to get a current ref.`,
          );
        }
        return ok(message);
      }),
  );
};
