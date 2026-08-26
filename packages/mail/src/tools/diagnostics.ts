import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import type { AppleMailClient } from "../client/mail.js";
import type { ToolContext } from "./index.js";
import { wrap } from "./util.js";

/**
 * Build the report.
 *
 * Split out of the tool registration so the `cupertino://mail/diagnostics`
 * resource can serve the same bytes. Two renderings of one probe: duplicated,
 * the resource and the tool would drift, and the disagreement would surface as
 * "the diagnostics lied" — the one thing this file must never do.
 */
export const buildDiagnostics = async (
  client: AppleMailClient,
  ctx: ToolContext,
): Promise<Record<string, unknown>> => {
  // Probe the lanes FIRST. lanes() is the call that retries past the
  // cold-start Automation prompt, and a successful probe caches the
  // accounts — so the account list below is read from the same evidence
  // the lane status is derived from. Doing it the other way round makes
  // the two disagree whenever the first Apple Event loses the race.
  const lanes = await client.lanes();
  const located = await client.locate();
  // End-to-end probe of the message-file lane: resolve a real message to
  // a path and read a byte of it. Without this the report can say Full
  // Disk Access is granted while every file read on an account fails.
  const messageFile = await client.probeMessageFile();

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
    messageFile,
    /*
     * Body search is its own lane and reports as one, because "it found
     * nothing" and "it could not look" are the two answers a caller must
     * never confuse. It rides on the message-file lane — no file, no body
     * — so its readiness is that lane's readiness plus a declared bound.
     */
    bodySearch: {
      available: messageFile.some((p) => p.status === "ok"),
      via: "index narrows, message files are scanned",
      reason: messageFile.some((p) => p.status === "ok")
        ? null
        : "Body search reads .emlx files, and no account produced one. An account cached " +
          "headers-only has no bodies on disk at all; otherwise this is the message-file " +
          "lane failing, which the messageFile block above explains per account.",
      scanBound: client.config.bodyScanMax,
      readBytesPerMessage: client.config.bodyScanBytes,
      note:
        "There is no body index on macOS to use: the Envelope Index has no FTS table, and " +
        "the Spotlight volume index excludes ~/Library entirely. Cost is linear in the " +
        "messages left by the other filters, so a body search wants a narrowing filter.",
    },
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
      // Off means the prompts and the cupertino:// resources are not registered
      // at all. Reported here because this tool still is, so it stays the one
      // place that explains a capability the client cannot see.
      exposePrompts: client.config.exposePrompts,
      accountAllowlist: client.config.accounts.length ? client.config.accounts : "(all accounts)",
      indexMode: client.config.indexMode,
      degradedMaxMessages: client.config.degradedMaxMessages,
      bodyScanMax: client.config.bodyScanMax,
      maxResults: client.config.maxResults,
      attachmentDir: client.config.attachmentDir,
    },
    accounts,
    ...(accountsError ? { accountsError } : {}),
    caveats: [
      "`messageFile` is per account on purpose: mailbox layout differs by provider, so one " +
        "account's lane can be dead while another's works. `unreachable` with " +
        "`fullDiskAccess: granted` means the path was wrong, not the permission.",
      "Mailbox `unread` from the AppleScript lane is Mail's cached badge value and can " +
        "disagree with the real count (observed: 0 reported for a mailbox with 1618 unread " +
        "messages). Counts are labelled with their source; prefer the index when it is live.",
    ],
  };
};

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
        "index is readable and how stale it is, whether the message file lane actually resolves " +
        "and reads a real message per account, per-account message caching, and the active " +
        "write/allowlist settings. Call this first whenever a tool returns `degraded: true` or a " +
        "permission error — it names the exact System Settings pane to open.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => buildDiagnostics(client, ctx)),
  );
};
