import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleRemindersClient } from "../client/reminders.js";
import { ok, wrap } from "./util.js";

/**
 * One tool that answers "why is this not working".
 *
 * Lanes are probed before anything else is read, because the first Apple Event
 * is what triggers the Automation prompt: reading accounts first and probing
 * afterwards makes the two disagree whenever that first event loses the race.
 */
export const registerDiagnosticsTools = (
  server: McpServer,
  client: AppleRemindersClient,
  ctx: { allowWrites: boolean },
): void => {
  server.registerTool(
    "apple_reminders_diagnostics",
    {
      description:
        "Report which lanes are live, which macOS permissions are granted, and what each " +
        "missing one is blocking. Start here when a tool returns degraded or fails — it names " +
        "the exact System Settings pane to open.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const lanes = await client.lanes();
        const located = client.locate();
        const accounts = lanes.applescript === "live" ? await client.accounts() : [];

        /**
         * Reminders' Full Disk Access signal is not "can I read the file" but
         * "can I list the directory". The store's filename carries a generated
         * UUID, so without the grant there is no path to even test.
         */
        const fullDiskAccess = located.readable
          ? "granted"
          : located.containerListable
            ? "denied (found the store, cannot read it)"
            : "denied (cannot list the container, so the store cannot be located)";

        return {
          server: { lanes },
          permissions: {
            automation:
              lanes.applescript === "live" ? "granted" : "denied-or-reminders-not-running",
            fullDiskAccess,
            ...(located.readable
              ? {}
              : {
                  howToGrant: [
                    "System Settings > Privacy & Security > Full Disk Access",
                    "Add the app that launches this server (Terminal, iTerm, VS Code, Claude...), then restart it.",
                    "Granting it to Reminders.app does nothing — the reader needs the permission, not Reminders.",
                  ],
                }),
          },
          store: {
            containerPath: located.containerPath,
            path: located.storePath,
            containerListable: located.containerListable,
            candidates: located.candidates.length,
            exists: located.exists,
            readable: located.readable,
            sizeBytes: located.size,
            walPresent: located.walPresent,
            walSizeBytes: located.walSizeBytes,
            fingerprint: lanes.storeFingerprint,
            reason: located.reason,
          },
          accounts,
          settings: {
            allowWrites: ctx.allowWrites,
            accountAllowlist: client.config.accounts,
            listAllowlist: client.config.lists,
            defaultList: client.config.defaultList ?? null,
            includeCompleted: client.config.includeCompleted,
            indexMode: client.config.indexMode,
            maxResults: client.config.maxResults,
            searchCacheTtlMs: client.config.searchCacheTtlMs,
          },
          caveats: [
            "Reminders' scripting dictionary covers the core model read-write, so this server " +
              "is fully usable with Automation alone — unlike Mail, where search without Full " +
              "Disk Access takes over a minute.",
            "What the dictionary has no class for at all: tags, the URL field, recurrence " +
              "rules, location alerts and attached images. Those need the index lane.",
            "Moving a reminder between lists is a copy-and-delete, because the scripting " +
              "dictionary makes a reminder's list read-only. Moved reminders get a new ref.",
            "Results are cached for " +
              `${client.config.searchCacheTtlMs}ms. Checking for changes costs about as much ` +
              "as re-reading everything, so there is no cheaper invalidation to be had.",
          ],
        };
      }).then((r) => r ?? ok({})),
  );
};
