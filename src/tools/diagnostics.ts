import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import type { AppleMailClient } from "../client/mail.js";
import type { ToolContext } from "./index.js";
import { wrap } from "./util.js";

/**
 * The first tool anyone should call when something looks wrong. Every
 * permission this server depends on is invisible until you ask for it, and the
 * failure modes (a TCC denial, a stale index, a mailbox that reports zero
 * unread) all look like "the tool is broken" from the outside.
 */
export const registerDiagnosticsTools = (
  server: McpServer,
  client: AppleMailClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "apple_mail_diagnostics",
    {
      description:
        "Report what this server can currently do and why. Shows whether Mail is running, whether " +
        "Automation and Full Disk Access are granted, where Mail's data lives, whether the search " +
        "index is readable and how stale it is, per-account message caching, and the active " +
        "write/allowlist settings. Call this first whenever a tool returns `degraded: true` or a " +
        "permission error — it names the exact System Settings pane to open.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const lanes = await client.lanes();
        const located = await client.locate();

        let accounts: unknown[] = [];
        let accountsError: string | null = null;
        try {
          accounts = (await client.accounts()).map((a) => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            type: a.accountType,
            emailAddresses: a.emailAddresses,
            mailboxCount: a.mailboxes.length,
            // Headers-only caching means .emlx bodies are not on disk and the
            // body lane has to fall back to a per-message Apple Event.
            messageCaching: a.messageCaching,
          }));
        } catch (err) {
          accountsError = err instanceof Error ? err.message : String(err);
        }

        const indexAgeSeconds = located.mtime
          ? Math.max(0, Math.round((Date.now() - Date.parse(located.mtime)) / 1000))
          : null;

        return {
          server: {
            name: BUILD_INFO.name,
            version: BUILD_INFO.version,
            gitCommit: BUILD_INFO.gitCommit,
            node: process.version,
            platform: process.platform,
          },
          lanes,
          permissions: {
            automation: lanes.applescript === "live" ? "granted" : "denied-or-mail-not-running",
            fullDiskAccess: located.readable
              ? "granted"
              : located.exists
                ? "denied"
                : "unknown (no index file found)",
            ...(located.readable
              ? {}
              : {
                  howToGrant: [
                    "System Settings > Privacy & Security > Full Disk Access",
                    "Add the app that launches this server (Terminal, iTerm, VS Code, Claude...), then restart it.",
                    "Granting it to Mail.app does nothing — the reader needs the permission, not Mail.",
                  ],
                }),
          },
          mailData: {
            root: located.mailRoot,
            dataVersion: located.dataVersion,
            envelopeIndex: located.envelopeIndexPath,
            foundVia: located.strategy,
            exists: located.exists,
            readable: located.readable,
            sizeBytes: located.sizeBytes,
            indexAgeSeconds,
            // A -wal means some mail may live outside the main file. Whether a
            // given read would miss it depends on checkpoint timing, which is
            // exactly why the server opens with mode=ro and does not gamble.
            walPresent: located.walPresent,
            walSizeBytes: located.walSizeBytes,
            reason: located.reason,
          },
          settings: {
            allowWrites: ctx.allowWrites,
            accountAllowlist: client.config.accounts.length
              ? client.config.accounts
              : "(all accounts)",
            indexMode: client.config.indexMode,
            degradedMaxMessages: client.config.degradedMaxMessages,
            maxResults: client.config.maxResults,
            attachmentDir: client.config.attachmentDir,
          },
          accounts,
          ...(accountsError ? { accountsError } : {}),
          caveats: [
            "Mailbox `unread` from the AppleScript lane is Mail's cached badge value and can " +
              "disagree with the real count (observed: 0 reported for a mailbox with 1618 unread " +
              "messages). Counts are labelled with their source; prefer the index when it is live.",
          ],
        };
      }),
  );
};
