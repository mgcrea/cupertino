import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleRemindersClient } from "../client/reminders.js";
import { ok, wrap } from "./util.js";

/**
 * Build the report.
 *
 * Split out of the tool registration so the `cupertino://reminders/diagnostics`
 * resource can serve the same bytes. Two renderings of one probe: duplicated,
 * the resource and the tool would drift, and the disagreement would surface as
 * "the diagnostics lied" — the one thing this file must never do.
 */
export const buildDiagnostics = async (
  client: AppleRemindersClient,
  ctx: { allowWrites: boolean },
): Promise<Record<string, unknown>> => {
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
      automation: lanes.applescript === "live" ? "granted" : "denied-or-reminders-not-running",
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
        "works with Automation alone. But a bulk read costs about 700ms PER PROPERTY on " +
        "that bridge — roughly nine seconds for a full listing, whatever the library " +
        "size — so the index lane carries listing and search whenever it is available.",
      "Without the index, `dueAllDay` is a guess. Reminders populates BOTH `due date` " +
        "and `allday due date` for every dated reminder, so only the store's ZALLDAY " +
        "column can actually answer it. Each result says which source it used.",
      "Subtasks need the index. The scripting dictionary types a reminder's container " +
        'as "list or reminder", but calling container() on a reminder throws every ' +
        "time, so parentage is unreachable over Apple Events.",
      "Also index-only: attachments, alarms, recurrence and location alerts. There is " +
        "no URL field in this store despite the folklore — it was looked for and is " +
        "not there.",
      "Moving a reminder between lists is a copy-and-delete, because the scripting " +
        "dictionary makes a reminder's list read-only. Moved reminders get a new ref.",
      "Apple Events results are cached for " +
        `${client.config.searchCacheTtlMs}ms. Checking for changes costs about as much ` +
        "as re-reading everything, so there is no cheaper invalidation to be had.",
    ],
  };
};

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
    async () => wrap(() => buildDiagnostics(client, ctx)).then((r) => r ?? ok({})),
  );
};
