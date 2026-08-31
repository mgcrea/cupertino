import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, ok, wrapResult } from "./util.js";

/**
 * The mutating tools, registered only when `APPLE_SAFARI_ALLOW_WRITES` is on.
 *
 * ## What is deliberately absent
 *
 * **Anything that acts inside a page.** No click, no form fill, no scroll. The
 * only Apple Event that could do it is `do JavaScript`, which needs a global,
 * permanent, unreadable Safari toggle — see the header of `jxa/writes.ts`. That
 * capability belongs on the extension lane, where Safari gates it per website.
 *
 * **`close_tab`.** Closing a tab destroys state the user may not be able to get
 * back — a half-filled form, a page that no longer resolves — and unlike every
 * other verb here it cannot be undone by doing it again differently. It is not
 * hard to add; it is a separate decision.
 *
 * **`search_web`.** It is `open_url` with the search engine's URL, and one verb
 * that navigates is easier to reason about than two.
 *
 * ## Both descriptions carry a disclosure the caller cannot infer
 *
 * That these verbs LAUNCH Safari when it is not running. Any Apple Event does,
 * and for a navigation verb that is correct behaviour — but a model deciding
 * whether to call this on a quiet machine should know that "add this to my
 * Reading List" can put a browser on somebody's screen.
 */
export const registerWriteTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_open_url",
    {
      description:
        "Open a URL in Safari — in a new tab by default, or in the tab the user is currently " +
        "looking at. Sends an Apple Event, so it needs an Automation grant and NOT Full Disk " +
        "Access. LAUNCHES Safari if it is not running. Only http:// and https:// URLs are " +
        "accepted; a javascript: URL is refused because it would execute script in the page, " +
        "which this server does not offer. This does NOT wait for the page to load, so the " +
        "returned tab may still show the previous URL or no title — call apple_safari_list_tabs " +
        'a moment later to see where it landed. `route` says how the page was placed: "tab-push" ' +
        'and "current-tab" put it exactly where asked, while either "open-location" spelling ' +
        "means Safari chose, so the page may be in a different window than expected. To read " +
        "what the page then says, use apple_safari_read_page — which needs the Safari extension " +
        "enabled on that site and is a separate lane from this one.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe("The http:// or https:// URL to open. Other schemes are refused."),
        target: z
          .enum(["new-tab", "current-tab"])
          .optional()
          .describe(
            'Where to put it. "new-tab" (the default) leaves the current page alone. ' +
              '"current-tab" NAVIGATES AWAY from what the user is looking at, losing scroll ' +
              "position and any unsubmitted form on it — ask for it only when the user means " +
              "to replace the page in front of them.",
          ),
        activate: z
          .boolean()
          .optional()
          .describe(
            "Bring Safari to the front. Off by default, so opening a page in the background " +
              "does not steal focus from what the user is doing. Safari may come forward anyway " +
              "when it had no window to put the tab in.",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, target, activate }) =>
      wrapResult(async () => {
        const result = await client.openUrl({
          url,
          target: target ?? "new-tab",
          activate: activate ?? false,
        });
        return ok(
          compact({
            opened: url,
            route: result.route,
            windows: result.windows,
            tab: result.tab,
            launchedSafari: result.launchedSafari ? true : undefined,
            // Only when it happened. A note about imprecise placement on a run
            // that placed the tab precisely is noise that trains a reader to
            // skip the field.
            placementNote:
              result.route === "open-location" || result.route === "open-location-fallback"
                ? "Safari chose where this page went — there was no window to add a tab to, or " +
                  "the precise route failed. It may be in another window."
                : undefined,
            loadNote:
              "The page was asked for, not waited for. `tab` is read back immediately and can " +
              "still describe the previous page.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_safari_add_reading_list_item",
    {
      description:
        "Save a URL to Safari's Reading List. This is the one write on this surface that " +
        "changes nothing on screen: no tab opens and no page loads. Sends an Apple Event, so it " +
        "needs an Automation grant; it LAUNCHES Safari if it is not running. Omit `title` and " +
        "`previewText` unless you have better ones than the page's own — Safari fills both in " +
        "itself, and passing a blank replaces a real title with nothing. NOT idempotent: asking " +
        "twice adds the item twice, and there is no verb to remove one. `verified` is true only " +
        "when the item was found by re-reading Bookmarks.plist afterwards; null means it could " +
        "not be confirmed — usually because Safari has not written that file yet, which is " +
        "normal immediately after an add and is NOT a reason to retry. Use " +
        "apple_safari_list_reading_list to see what is already saved before adding.",
      inputSchema: {
        url: z.string().min(1).describe("The http:// or https:// URL to save."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Title to save it under. Omit to let Safari use the page's own."),
        previewText: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The blurb shown under the title, usually the first sentences of the article. " +
              "Omit to let Safari extract it.",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, title, previewText }) =>
      wrapResult(async () => {
        const result = await client.addReadingListItem({ url, title, previewText });
        return ok(
          compact({
            added: url,
            verified: result.verified,
            verifyNote: result.verifyNote ?? undefined,
            launchedSafari: result.launchedSafari ? true : undefined,
            duplicateNote:
              "The Reading List accepts duplicates and this server cannot remove one. Do not " +
              "call again for the same URL on an unconfirmed result.",
          }),
        );
      }),
  );
};
