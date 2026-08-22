import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import type { AppleContactsClient } from "../client/contacts.js";
import { wrap } from "./util.js";

/**
 * What this server can currently do, and why not more.
 *
 * The caveats are the point. Two of them are specific to this surface and both
 * produce a plausible wrong answer rather than an error, which is exactly the
 * kind of thing a caller cannot discover for itself.
 */
export const registerDiagnosticsTools = (server: McpServer, client: AppleContactsClient): void => {
  server.registerTool(
    "apple_contacts_diagnostics",
    {
      description:
        "Report which Contacts stores were opened, how many contacts each holds, and what this " +
        "server cannot do. Start here when a lookup returns nothing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const status = client.status();
        const located = status.located;

        return {
          server: { name: BUILD_INFO.name, version: BUILD_INFO.version },
          lane: {
            // There is only one, and saying so is more useful than implying a choice.
            reads: "file lane (read-only SQLite)",
            writes: "none — this server registers no mutating tool",
            appleEvents: "not used at all, so no Automation grant is needed or requested",
          },
          stores: {
            directory: located.dirPath,
            directoryListable: located.dirListable,
            found: located.candidates.length,
            opened: status.shards.length,
            sourcesSeen: located.sourceCount,
            totalContacts: status.totalContacts,
            shards: status.shards,
            indexMode: status.indexMode,
            reason: located.reason,
          },
          resolution: {
            phoneSuffixDigits: client.config.phoneSuffixDigits,
            note:
              "Phone matching uses the last N digits because Contacts stores numbers as typed. " +
              "Fewer digits resolves more handles and collides more; the ambiguous count in a " +
              "resolve result is how to tell whether a change helped.",
          },
          caveats: [
            "Contacts is protected by its own privacy permission, NOT by Full Disk Access, and " +
              "unlike Full Disk Access macOS prompts for it. A store that cannot be opened " +
              "usually means that prompt was dismissed — re-enable this app under System " +
              "Settings > Privacy & Security > Contacts.",
            "The address book is spread across several databases: one per account, plus a root " +
              "store that is normally almost empty. All readable ones are unioned. If " +
              "`opened` is lower than `found`, some accounts are missing from every answer here.",
            "A handle that resolves to more than one contact is reported as ambiguous with no " +
              "name, never as a guess. Putting the wrong name on a message is worse than " +
              "putting none, because it does not look wrong.",
            "Contacts held in two accounts are folded together on their link id, matching what " +
              "Contacts.app shows as one unified card. A contact with no link id is not folded.",
            "This server is read-only by construction. It cannot create, edit or delete a " +
              "contact, and enabling writes does not add a tool.",
          ],
        };
      }),
  );
};
