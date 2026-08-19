import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleNotesClient } from "../client/notes.js";
import { wrap } from "./util.js";

export const registerAccountTools = (server: McpServer, client: AppleNotesClient): void => {
  server.registerTool(
    "apple_notes_list_accounts",
    {
      description:
        "List the Notes accounts, with how many folders and notes each holds. Start here to " +
        "discover account names for the other tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => client.accounts()),
  );

  server.registerTool(
    "apple_notes_list_folders",
    {
      description:
        "List folders across every account. Folders nest, so each entry carries its depth and " +
        "the account it belongs to. Use the returned id with the move and create tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => client.folders()),
  );
};
