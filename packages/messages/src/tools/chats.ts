import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMessagesClient } from "../client/messages.js";
import { limitArg, wrap } from "./util.js";

/**
 * NOTE ON `async` BELOW: core's `wrap` is typed `() => Promise<T>` because most
 * surfaces reach Apple Events. Messages reads synchronous SQLite and never
 * leaves the process, so the thunks are marked async here rather than widening a
 * shared signature for every surface to accommodate one.
 */
export const registerChatTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_list_chats",
    {
      description:
        "List conversations, most recently active first, with their participants and message " +
        "counts. Names come from Contacts where they resolve; where they do not, the raw phone " +
        "number or email is shown and `resolution` says why. Use the returned ref to read one " +
        "conversation with apple_messages_list_messages.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => wrap(async () => client.listChats(limit)),
  );
};
