import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import type { AppleMessagesClient } from "../client/messages.js";
import { wrap } from "./util.js";

/**
 * Build the report.
 *
 * Split out of the tool registration so the `cupertino://messages/diagnostics`
 * resource can serve the same bytes. Two renderings of one probe: duplicated,
 * the resource and the tool would drift, and the disagreement would surface as
 * "the diagnostics lied" — the one thing this file must never do.
 */
export const buildDiagnostics = async (
  client: AppleMessagesClient,
): Promise<Record<string, unknown>> => {
  const status = client.status();
  const writes = client.config.allowWrites;
  return {
    server: { name: BUILD_INFO.name, version: BUILD_INFO.version },
    lane: {
      reads: "file lane (read-only SQLite)",
      writes: writes
        ? "apple_messages_send_message, over Apple Events. The only mutating command " +
          "the Messages dictionary offers."
        : "off — APPLE_MESSAGES_ALLOW_WRITES is not set, so the send tool is not " +
          "registered and this server sends no Apple Event at all.",
      appleEvents:
        "no read path exists, and never will. Measured: every read attempt fails, and " +
        'Messages answers "Application isn\'t running" even while it is running, because ' +
        "it is a windowless background process that declines to wake for a script. " +
        "Sending is the one thing that works.",
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
      "Messages stopped writing the plain `text` column between late February and late " +
        "March 2026: every message since is stored only as an archived blob, which is " +
        "decoded here. `textSource` on each result says which lane answered. Across all " +
        "history the blob-only share is about 3%, but for anything recent it is ~100%, " +
        "so a reader without the decoder would report that the conversation stopped in " +
        "February.",
      "Names come from Contacts, which has its own separate permission. `unknown` is a " +
        "normal outcome and not an error — about one in six of even the busiest " +
        "correspondents has no contact card. When `contacts.available` is false, nobody " +
        "looked at all and every handle is raw.",
      "Tapbacks are rows in the message table. They are filtered out of conversations by " +
        "default and reported on the message they target instead.",
      writes
        ? "Sending is real and immediate, and it is the ONLY thing this server can " +
          "change — the dictionary has no edit, delete, mark-as-read or reaction " +
          "command. Messages hands back no identifier for what it sent, so the sent row " +
          'is found by re-reading the store; `reconciliation: "pending"` means it has ' +
          "not appeared yet, which is not a failure and must not be retried."
        : "This server cannot send: APPLE_MESSAGES_ALLOW_WRITES is off. With it on, one " +
          "tool appears — apple_messages_send_message — and it is the only mutating " +
          "command the Messages dictionary offers.",
    ],
  };
};

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
    async () => wrap(() => buildDiagnostics(client)),
  );
};
