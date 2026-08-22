import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * The live-tab tool — the present tense, and the only thing here that survives
 * without Full Disk Access.
 *
 * The description carries the 60.7% measurement because a model that is not
 * told will interpret a null `history` as "never visited", which is a
 * confidently wrong statement about somebody's browsing. It is "not found in
 * history", and the difference matters.
 */
export const registerTabTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_list_tabs",
    {
      description:
        "List the tabs currently open in Safari, across every window. This is the ONE Safari " +
        "tool that does not need Full Disk Access — it reads live state through Apple Events, so " +
        "it needs an Automation grant instead, and it requires Safari to be running. " +
        "Each tab optionally carries its matching history entry. A null `history` means the URL " +
        "was not found in history, NOT that the page was never visited: only about 55% of open " +
        "tabs match a history row, because redirects, session parameters and pages never " +
        "committed to history all produce a URL that is simply not there.",
      inputSchema: {
        enrich: z
          .boolean()
          .optional()
          .describe(
            "Look each tab up in history for its visit count and first-visited date. On by " +
              "default. Silently skipped when history is unreadable — tabs still come back.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ enrich }) =>
      wrapResult(async () => {
        if (!client.config.liveTabs) {
          return fail(
            "Live tabs are disabled by configuration (APPLE_SAFARI_LIVE_TABS=false). This " +
              "server is running history-only and sends no Apple Event.",
          );
        }
        const result = await client.tabs({ enrich: enrich ?? true });
        const matched = result.tabs.filter((t) => t.history !== null).length;
        return ok(
          compact({
            windows: result.windows,
            tabs: result.tabs,
            count: result.tabs.length,
            // Reported as a ratio rather than left for the caller to count, so
            // "most of these did not match" is visible at a glance.
            historyMatched: result.enriched ? `${matched}/${result.tabs.length}` : undefined,
            enrichmentUnavailable: result.enriched
              ? undefined
              : "History is not readable, so no tab carries a history entry. This needs Full " +
                "Disk Access; the tab list itself does not.",
          }),
        );
      }),
  );
};
