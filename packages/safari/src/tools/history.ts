import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { parseRange } from "../client/dates.js";
import { decodeHistoryRef } from "../client/ref.js";
import type { AppleSafariClient } from "../client/safari.js";
import {
  compact,
  fail,
  fromArg,
  historyRefArg,
  limitArg,
  ok,
  resolveLimit,
  scopeArg,
  toArg,
  wrapResult,
} from "./util.js";

/**
 * The history tools — everything about the past.
 *
 * Each description states the permission fact plainly, because on this surface
 * it is not the usual "slower without the grant". Without Full Disk Access
 * these tools do not degrade; they have nothing to read. Saying so in the
 * description is what stops a model concluding, from an error it half-read,
 * that the person simply has not browsed.
 */
export const registerHistoryTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_search_history",
    {
      description:
        "Search Safari browsing history by URL or page title, optionally within a date range. " +
        "Needs Full Disk Access — there is no second lane for history, so without the grant this " +
        "returns an error rather than an empty list. Results are pages (one per URL), newest " +
        "visit first, each with a visit count and a ref for apple_safari_get_page.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Text to look for. Omit to list history in the range instead of searching. " +
              'Wildcards are escaped, so searching for "100%" finds that literal string.',
          ),
        scope: scopeArg,
        from: fromArg,
        to: toArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, scope, from, to, limit }) =>
      wrapResult(async () => {
        const config = client.config;
        const range = parseRange({
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          defaultRangeDays: config.defaultRangeDays,
          maxRangeDays: config.maxRangeDays,
        });

        const capped = resolveLimit(limit, config.maxResults);
        const result = client.search({
          ...(query ? { query } : {}),
          scope: scope ?? "full",
          from: range.from,
          to: range.to,
          limit: capped,
        });

        return ok(
          compact({
            pages: result.pages,
            count: result.pages.length,
            range: { from: range.from.toISOString(), to: range.to.toISOString() },
            // Every one of these is a case where the answer is narrower than
            // the question. A caller that is not told will read the result as
            // complete, which is the failure this surface is most prone to.
            rangeClamped: range.clamped
              ? `The requested window exceeded maxRangeDays (${config.maxRangeDays}) and was ` +
                `trimmed at the older end; the most recent results are all present.`
              : undefined,
            rangeIgnored:
              !result.rangeApplied && (from || to)
                ? "This store has no usable visit-time column, so the date range was NOT applied. " +
                  "Every result is unfiltered by date."
                : undefined,
            truncated: result.truncated
              ? `More results exist beyond limit=${capped}.`
              : undefined,
            datesUnavailable: result.datesAvailable
              ? undefined
              : "Timestamps could not be placed on a known epoch, so every date reads null. " +
                "They are withheld rather than guessed — see apple_safari_diagnostics.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_safari_get_page",
    {
      description:
        "Get one page from browsing history by its ref, with visit counts and first/last visit " +
        "times. Needs Full Disk Access.",
      inputSchema: { ref: historyRefArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const url = decodeHistoryRef(ref);
        const page = client.get(url);
        if (!page) {
          return fail(
            `No history entry for that ref. Safari may have cleared it, or it may have aged out ` +
              `of the retention window since the search ran. Re-run the search for a current ref.`,
          );
        }
        return ok({ page });
      }),
  );
};
