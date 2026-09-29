import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { QUIET_AFTER_SECONDS } from "../client/pages.js";
import type { AppleSafariClient } from "../client/safari.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * What `read_page` returns when the caller names no `maxChars`.
 *
 * Roughly a long article. The extension stores up to 256 KiB of text and 1 MiB
 * of html per page, so an undefaulted cap meant a routine read could land a
 * quarter of a million tokens in the conversation.
 */
const DEFAULT_MAX_CHARS = 32_768;

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
 * ## Live first, capture second
 *
 * This started as a cache and nothing else: the extension pushes a capture
 * when a permitted page loads, and the read returned it. That is wrong on
 * exactly the pages people most want read. A single-page app renders its shell,
 * goes quiet while it fetches, and the shell is what got stored — Shopify's
 * app-submission form came back as "Skip to content" for as long as the tab
 * was open, while `page_elements` could enumerate every field on it through
 * the command channel.
 *
 * So the read asks the open tab first, over that same channel, and waits only
 * briefly (`liveReadTimeoutMs`). A visible tab answers within a second. A
 * hidden tab, a closed one, or a tab still running a content script from
 * before live reads existed does not — and the capture is still the right
 * answer for those, as long as it says so.
 *
 * ## The one wrong answer this can still give
 *
 * A capture describes the page as it WAS. Every response says which it is in
 * `source`, carries `capturedAt` and `ageSeconds`, and a capture that was
 * returned because the live read missed says why in `liveRead`. Reporting a
 * cached page as the current one is the specific failure the fallback
 * permits, and those fields are what prevent it.
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
        'It asks the open tab for its content as it is NOW, and `source` says "live" when ' +
        "that worked. A tab that cannot answer within a few seconds — hidden in the background, " +
        "closed, or running an extension from before an update — gets the snapshot the " +
        'extension stored instead, with `source: "capture"` and `liveRead` saying why. Check ' +
        "`ageSeconds` before describing a capture as the current page: it may be minutes old, " +
        "and on a single-page app it may be the empty shell from before the app rendered. " +
        "Form field VALUES are not page text — use apple_safari_page_elements for those. " +
        "It cannot fetch a URL that is not open: this reads what Safari already loaded, never " +
        "the network. " +
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
            `Truncate the returned content to this many characters. Defaults to ` +
              `${DEFAULT_MAX_CHARS.toLocaleString("en-US")}, which is a long article; raise it ` +
              `to read more. The response says whether it was cut.`,
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ url, format, maxChars }) =>
      wrapResult(async () => {
        const status = client.pagesStatus();
        // Defaulted rather than optional. Left unbounded this returned the
        // whole capture — up to the extension's own caps of 256 KiB of text or
        // 1 MiB of html, which is a quarter of a million tokens for a tool a
        // model reaches for casually. `get_message_source` already defaults its
        // byte budget for the same reason; this is that decision, applied here.
        const cap = maxChars ?? DEFAULT_MAX_CHARS;

        // No store at all means the extension has never run, so no tab can
        // answer either — skip the wait and say so below.
        const live =
          status.exists && client.config.liveReadTimeoutMs > 0
            ? await readLive(client, url, format ?? "text", cap)
            : null;
        if (live?.page) return ok(live.page);
        const liveRead = live?.miss;

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
          // A quiet lane changes what the miss MEANS. With recent captures, the
          // extension is demonstrably running and this URL simply is not one of
          // them. With nothing recent, the likelier story is that it was
          // switched off — and telling someone their URL is unpermitted when
          // the extension is off sends them to the wrong setting.
          const quiet =
            status.newestAgeSeconds !== null && status.newestAgeSeconds > QUIET_AFTER_SECONDS;
          return fail(
            quiet
              ? `No capture for that URL, and nothing has been captured for ` +
                  `${Math.round((status.newestAgeSeconds ?? 0) / 60)} minutes — the extension ` +
                  `looks switched off, or allowed on no site visited since. Check Safari > ` +
                  `Settings > Extensions. The ${status.count} page(s) still on disk are stale.`
              : `No capture for that exact URL. ${status.count} other page(s) are captured ` +
                  `recently, so the extension is working — this URL is either not open, on a ` +
                  `site the extension is not allowed on, or was captured under a slightly ` +
                  `different address. apple_safari_list_tabs reports the URL Safari itself holds.`,
          );
        }

        const { page, ageSeconds } = hit;
        const body = format === "html" ? page.html : page.text;
        const cut = body.length > cap;
        const content = cut ? body.slice(0, cap) : body;

        return ok(
          compact({
            url: page.url,
            title: page.title || undefined,
            source: "capture",
            liveRead,
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

/** Either the page, read live, or the one-line reason it could not be. */
type LiveOutcome = { page: Record<string, unknown>; miss?: never } | { page?: never; miss: string };

type LiveRead = {
  url: string;
  title: string;
  format: "text" | "html";
  content: string;
  totalChars: number;
  truncated: boolean;
  readAt: string;
};

const isLiveRead = (v: unknown): v is LiveRead =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as LiveRead).content === "string" &&
  typeof (v as LiveRead).readAt === "string";

/**
 * Ask the open tab for its content, and say in one line why not when it cannot.
 *
 * Never throws: every way this fails has the capture behind it, so a failure is
 * a reason to attach to the fallback rather than an error to report.
 */
const readLive = async (
  client: AppleSafariClient,
  url: string,
  format: "text" | "html",
  maxChars: number,
): Promise<LiveOutcome> => {
  const waited = `${(client.config.liveReadTimeoutMs / 1000).toFixed(1)}s`;
  try {
    const result = await client.pageAction(
      { action: "read", url, format, maxChars },
      { timeoutMs: client.config.liveReadTimeoutMs },
    );
    if (result.ok && isLiveRead(result.data)) {
      const data = result.data;
      return {
        page: compact({
          url: data.url,
          title: data.title || undefined,
          source: "live",
          // The same two fields a capture carries, so a caller checking age
          // does not need a second code path to learn this one is current.
          capturedAt: data.readAt,
          ageSeconds: 0,
          format: data.format,
          content: data.content,
          chars: data.content.length,
          truncated: data.truncated || undefined,
        }),
      };
    }
    // A tab running a content script from before live reads existed answers,
    // but not this question. That is fixed by reloading it, which is worth
    // saying in those words.
    if (!result.ok && /Unknown action/.test(result.error ?? "")) {
      return {
        miss:
          "The tab is running an extension build from before live reads — reload it to read it " +
          "live.",
      };
    }
    return {
      miss: `The tab answered but could not be read live: ${result.error ?? "no content"}.`,
    };
  } catch (error) {
    // Only a timeout is about the tab. Anything else — the command directory
    // unwritable, say — failed before any tab was asked, and blaming the tab
    // would send someone to Safari for a problem on this side.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("No page answered")) {
      return { miss: `The tab could not be asked: ${message}` };
    }
    return {
      miss:
        `The tab did not answer within ${waited} — it is in the background (a hidden tab ` +
        `checks in every 10s), closed, or the extension is not allowed on it.`,
    };
  }
};
