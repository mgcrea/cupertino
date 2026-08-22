import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import type { AppleMessagesClient } from "../client/messages.js";
import { wrap } from "./util.js";

export const registerDiagnosticsTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_diagnostics",
    {
      description:
        "Report whether the Messages store could be opened, how much is in it, whether names " +
        "are being resolved, and what this server cannot do. Start here when a read returns " +
        "nothing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const status = client.status();
        return {
          server: { name: BUILD_INFO.name, version: BUILD_INFO.version },
          lane: {
            reads: "file lane (read-only SQLite)",
            writes: "none — this server registers no mutating tool",
            appleEvents:
              "no read path exists. Measured: every attempt fails, and Messages answers " +
              '"Application isn\'t running" even while it is running, because it is a ' +
              "windowless background process that declines to wake for a script.",
          },
          store: {
            path: status.located.storePath,
            exists: status.located.exists,
            readable: status.located.readable,
            opened: status.store.opened,
            mode: status.store.mode,
            fingerprint: status.store.fingerprint,
            counts: status.counts,
            reason: status.located.reason,
          },
          contacts: status.contacts,
          caveats: [
            "Full Disk Access is MANDATORY here, unlike every other surface in this bundle. " +
              "There is no Apple Events read lane to fall back to, so without the grant this " +
              "server can do nothing at all.",
            "Roughly 3% of messages store their text only in an archived blob, not in a plain " +
              "column. Those are decoded on read; `textSource` on each result says which lane " +
              "answered. A tool that read the column alone would silently return nothing for " +
              "one message in thirty-two.",
            "Names come from Contacts, which has its own separate permission. `unknown` is a " +
              "normal outcome and not an error — about one in six of even the busiest " +
              "correspondents has no contact card. When `contacts.available` is false, nobody " +
              "looked at all and every handle is raw.",
            "Tapbacks are rows in the message table. They are filtered out of conversations by " +
              "default and reported on the message they target instead.",
            "This server cannot send. Sending was deliberately never probed, and Apple Events " +
              "returns no chat identifier at all, so a sent message could not be reconciled " +
              "against anything read here.",
          ],
        };
      }),
  );
};
