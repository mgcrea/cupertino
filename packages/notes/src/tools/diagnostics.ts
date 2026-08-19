import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleNotesClient } from "../client/notes.js";
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
  client: AppleNotesClient,
  ctx: { allowWrites: boolean },
): void => {
  server.registerTool(
    "apple_notes_diagnostics",
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

        const fullDiskAccess = located.readable
          ? "granted"
          : located.exists
            ? "denied"
            : "unknown (no store found)";

        return {
          server: { lanes },
          permissions: {
            automation: lanes.applescript === "live" ? "granted" : "denied-or-notes-not-running",
            fullDiskAccess,
            ...(located.readable
              ? {}
              : {
                  howToGrant: [
                    "System Settings > Privacy & Security > Full Disk Access",
                    "Add the app that launches this server (Terminal, iTerm, VS Code, Claude...), then restart it.",
                    "Granting it to Notes.app does nothing — the reader needs the permission, not Notes.",
                  ],
                }),
          },
          store: {
            path: located.storePath,
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
            indexMode: client.config.indexMode,
            maxResults: client.config.maxResults,
            searchCacheTtlMs: client.config.searchCacheTtlMs,
            attachmentDir: client.config.attachmentDir,
          },
          caveats: [
            "Without Full Disk Access the index lane is unavailable: search falls back to an " +
              "Apple Events bulk scan, which is fine on a small library and degrades linearly.",
            "Password-protected notes are encrypted at rest; no permission makes them readable.",
            "Attachment bytes need Full Disk Access — the scripting dictionary carries no file path.",
          ],
        };
      }).then((r) => r ?? ok({})),
  );
};
