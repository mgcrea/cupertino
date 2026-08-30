import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * The live-tab tool — the present tense, and the only thing here that survives
 * without Full Disk Access.
 *
 * Two things in the description are there to stop a specific confident error,
 * not to be thorough:
 *
 *  * The match rate, because a model that is not told will read a null
 *    `history` as "never visited", which is a wrong statement about somebody's
 *    browsing. It means "not found in history".
 *  * The `active` / `frontmost` split, because "the current tab" is the most
 *    likely thing to be asked for here, and `active` is not it.
 */
export const registerTabTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_list_tabs",
    {
      description:
        "List the tabs currently open in Safari, across every window. This is the ONE Safari " +
        "tool that does not need Full Disk Access — it reads live state through Apple Events, so " +
        "it needs an Automation grant instead, and it requires Safari to be running. " +
        "To answer 'what am I looking at', use the tab marked `frontmost`: `active` means " +
        "selected in its own window, so a person with three windows open has three active tabs " +
        "and only one frontmost one. " +
        "Each tab optionally carries its matching history entry. A null `history` means the URL " +
        "was not found in history, NOT that the page was never visited: only about half of open " +
        "tabs match a history row, because session parameters and pages never committed to " +
        "history both produce a URL that is simply not there. `historyMatch` says how the match " +
        'was made — treat "query-stripped" as being about the path rather than about this exact ' +
        "page, since its visit count may cover other views of the same URL.",
      inputSchema: {
        enrich: z
          .boolean()
          .optional()
          .describe(
            "Look each tab up in history for its visit count and first-visited date. On by " +
              "default. Silently skipped when history is unreadable — tabs still come back.",
          ),
        // Deliberately not named `scope`: apple_safari_search_history already
        // uses that for "url" | "full", and one name with two disjoint value
        // sets across sibling tools is a trap.
        only: z
          .enum(["active", "frontmost"])
          .optional()
          .describe(
            'Narrow the list. "frontmost" returns just the one tab the user is looking at; ' +
              '"active" returns the selected tab of every window. Omit for every tab.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ enrich, only }) =>
      wrapResult(async () => {
        if (!client.config.liveTabs) {
          return fail(
            "Live tabs are disabled by configuration (APPLE_SAFARI_LIVE_TABS=false). This " +
              "server is running history-only and sends no Apple Event.",
          );
        }
        const wanted = enrich ?? true;
        const result = await client.tabs({ enrich: wanted });

        const tabs =
          only === "frontmost"
            ? result.tabs.filter((t) => t.frontmost)
            : only === "active"
              ? result.tabs.filter((t) => t.active)
              : result.tabs;

        const matched = tabs.filter((t) => t.history !== null);
        const byKind = (kind: string): number =>
          matched.filter((t) => t.historyMatch === kind).length;

        return ok(
          compact({
            windows: result.windows,
            appFrontmost: result.appFrontmost,
            tabs,
            count: tabs.length,
            // Reported as a ratio rather than left for the caller to count, so
            // "most of these did not match" is visible at a glance.
            historyMatched: result.enriched ? `${matched.length}/${tabs.length}` : undefined,
            // The breakdown, so a run that matched mostly by throwing query
            // strings away does not read like a run that matched exactly.
            historyMatchKinds:
              result.enriched && matched.length > 0
                ? compact({
                    exact: byKind("exact") || undefined,
                    normalized: byKind("normalized") || undefined,
                    queryStripped: byKind("query-stripped") || undefined,
                  })
                : undefined,
            // Only when it bit: with no readable window order there is no front
            // window, so every `frontmost` is false and a caller asking for one
            // gets an empty list that would otherwise look like "no tabs open".
            frontmostUnavailable: result.windowOrderUnknown
              ? "Safari did not report window ordering, so no tab could be identified as " +
                "frontmost. `active` is unaffected."
              : undefined,
            // Only when enrichment was ASKED FOR and could not be done. Saying
            // "history is not readable" to a caller that passed `enrich: false`
            // blames a permission for a choice they made — the confidently
            // wrong answer this surface exists to avoid.
            enrichmentUnavailable:
              wanted && !result.enriched
                ? "History is not readable, so no tab carries a history entry. This needs Full " +
                  "Disk Access; the tab list itself does not."
                : undefined,
          }),
        );
      }),
  );
};
