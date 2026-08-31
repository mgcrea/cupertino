import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * The extension lane: reading what a page actually says.
 *
 * ## Why this exists at all, and why it is not `do JavaScript`
 *
 * Reading page content is the most common thing asked of this surface and the
 * one it could not do. Both routes that need no new machinery were measured
 * dead: `do JavaScript` needs a Safari developer-menu toggle that is not a TCC
 * grant and whose state cannot be read, and Accessibility reaches Safari's
 * window and stops at the chrome — no `AXWebArea`, because the page renders out
 * of process. See docs/safari.md.
 *
 * So this lane is a Safari Web Extension, and the difference that matters is
 * the permission model: it can only see websites the user has allowed it on,
 * one at a time, revocably, from Safari's own UI. The toggle would have granted
 * every process on the machine the ability to run script in every tab.
 *
 * ## The one wrong answer this can give
 *
 * It is a CACHE, not a live read. The extension pushes a capture when a
 * permitted page loads; nothing here can ask for a fresh one. So the page a
 * caller gets is whatever that URL last looked like, which may be minutes old
 * and may describe a page the user has already navigated away from.
 *
 * Every response therefore carries `capturedAt` and `ageSeconds`, and the
 * description says plainly that it may be stale. Reporting a cached page as the
 * current one is the specific failure this design permits, and the timestamp is
 * the only thing that prevents it.
 */
export const registerPageTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_read_page",
    {
      description:
        "Read the content of a page open in Safari, as readable text or raw HTML. Needs the " +
        "Cupertino Safari extension installed, enabled, and ALLOWED ON THAT WEBSITE — Safari " +
        "grants extensions per site, so a page you have not permitted returns nothing even " +
        "though the extension is on. " +
        "This is NOT a live read: the extension captures a page when it loads, so what comes " +
        "back is that snapshot. Check `ageSeconds` and `capturedAt` before describing it as the " +
        "current page — the user may have navigated away, and a page captured minutes ago can " +
        "be stale. It also cannot fetch a URL that is not open: this reads what Safari already " +
        "loaded, never the network. " +
        "Not to be confused with apple_safari_get_page, which returns a HISTORY row — visit " +
        "counts and dates — and no page content at all.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            "The exact URL of the page, as apple_safari_list_tabs reports it. Matching is " +
              "exact; there is no search.",
          ),
        format: z
          .enum(["text", "html"])
          .optional()
          .describe(
            'What to return. "text" (the default) is the readable content with script and ' +
              'style removed — far smaller, and what is usually wanted. "html" is the raw ' +
              "outerHTML, which on a modern page is mostly framework markup and can be " +
              "hundreds of kilobytes.",
          ),
        maxChars: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Truncate the returned content to this many characters. The response says whether " +
              "it was cut.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ url, format, maxChars }) =>
      wrapResult(async () => {
        const status = client.pagesStatus();
        const hit = client.page(url);

        if (!hit) {
          // Three different reasons, and telling them apart is the whole point:
          // "not installed" is a setup problem, "nothing captured" is a
          // permission problem, and "this URL specifically" is neither.
          if (!status.exists) {
            return fail(
              "No captures at all — the Cupertino Safari extension has never run. Install " +
                "Cupertino, then enable the extension in Safari > Settings > Extensions. Note " +
                "a locally built Debug app ships no extension; only an installed release does.",
            );
          }
          if (status.count === 0) {
            return fail(
              "The extension has run but captured nothing. Safari grants extensions one site " +
                "at a time: open the page, click the Cupertino icon in Safari's toolbar, and " +
                "choose to allow it on that website. Enabling the extension alone is not enough.",
            );
          }
          return fail(
            `No capture for that exact URL. ${status.count} other page(s) are captured, so the ` +
              `extension is working — this URL is either not open, on a site the extension is ` +
              `not allowed on, or was captured under a slightly different address. ` +
              `apple_safari_list_tabs reports the URL Safari itself holds.`,
          );
        }

        const { page, ageSeconds } = hit;
        const body = format === "html" ? page.html : page.text;
        const cut = maxChars !== undefined && body.length > maxChars;
        const content = cut ? body.slice(0, maxChars) : body;

        return ok(
          compact({
            url: page.url,
            title: page.title || undefined,
            capturedAt: page.capturedAt,
            ageSeconds,
            format: format ?? "text",
            content,
            chars: content.length,
            // Two different truncations, and conflating them would hide one.
            // `truncated` is this call's `maxChars`; `captureTruncated` means
            // the extension itself hit its per-entry byte cap when it stored
            // the page, so the content was already incomplete on disk.
            truncated: cut || undefined,
            captureTruncated:
              (format === "html" ? page.htmlTruncated : page.textTruncated) || undefined,
            stale:
              ageSeconds > 300
                ? `Captured ${Math.round(ageSeconds / 60)} minutes ago. Safari may be showing ` +
                  `something else now — say when this was captured rather than describing it ` +
                  `as the current page.`
                : undefined,
          }),
        );
      }),
  );
};
