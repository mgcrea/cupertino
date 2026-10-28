import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "../client/errors.js";
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
 * **Closing a tab that is not the agent's.** Closing destroys state the user
 * may not get back — a half-filled form, a page that no longer resolves — and
 * unlike every other verb here it cannot be undone by doing it again
 * differently. So `close_tabs` reaches only tabs `open_url` opened and
 * recorded, and only while each still shows the URL it was opened on; see
 * `client/opened.ts`.
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
/** A list only when it has something in it, so an empty outcome is no key at all. */
const some = <T>(xs: T[]): T[] | undefined => (xs.length > 0 ? xs : undefined);

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
      inputSchema: z.object({
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
      }),
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
            ref: result.ref ?? undefined,
            refNote: result.refNote ?? undefined,
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
        "Save a URL to Safari's Reading List. Nothing appears on screen: no tab opens and " +
        "nothing comes to the front. It is NOT inert on the network though — Safari fetches the " +
        "page in the background to build the entry, so this makes a request to that host from " +
        "the user's browser. Sends an Apple Event, so it " +
        "needs an Automation grant; it LAUNCHES Safari if it is not running. `title` and " +
        "`previewText` are BEST-EFFORT and usually ignored: Safari fetches the page itself and " +
        "overwrites both with what it finds there (measured — a custom title survived only on a " +
        "URL that does not resolve). Pass them for a page Safari cannot reach; expect the page's " +
        "own title everywhere else, and never report back the title you sent as the one saved. " +
        "NOT idempotent: asking " +
        "twice adds the item twice, and there is no verb to remove one. `verified` is true only " +
        "when the item was found by re-reading Bookmarks.plist afterwards; null means it could " +
        "not be confirmed — usually because Safari has not written that file yet, which is " +
        "normal immediately after an add and is NOT a reason to retry. Use " +
        "apple_safari_list_reading_list to see what is already saved before adding.",
      inputSchema: z.object({
        url: z.string().min(1).describe("The http:// or https:// URL to save."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Title to save it under. Overridden by the page's own title whenever Safari can " +
              "fetch the page, which is nearly always — so this only takes effect for a URL " +
              "that does not resolve.",
          ),
        previewText: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The blurb shown under the title, usually the first sentences of the article. " +
              "Safari extracts its own from the fetched page; assume this is overridden on the " +
              "same terms as `title`.",
          ),
      }),
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

  server.registerTool(
    "apple_safari_close_tabs",
    {
      description:
        "Close tabs an agent opened with apple_safari_open_url: the ones named by `refs`, or " +
        "every one still recorded with `all: true` — which includes tabs opened by other " +
        "sessions. Use it to clean up after research. A tab is closed ONLY while it still " +
        "shows the URL it was opened on, and only when no more tabs show that URL than agents " +
        "opened there — two agent tabs on one page are both closed, but a third tab on it " +
        "leaves all three open, since this server cannot tell tabs on the same page apart. " +
        "Everything else is left open and reported: `notFound` (the tab was closed, or it " +
        "moved to another page — a redirect, a link followed — so it may still be open " +
        "somewhere and is now the user's to close), `ambiguous` (more tabs show the URL than " +
        "agents opened, or a tab in that window could not be read), `stale` (it moved between " +
        "the check " +
        "and the close), `unknown` (a ref that is not in the record). Tell the user which " +
        "tabs were left open. Sends an Apple Event; does NOT launch Safari, and closes nothing " +
        "while it is quit. Closing a window's last tab closes the window. There is no undo, " +
        "though Safari's own History › Reopen Last Closed Tab works.",
      inputSchema: z.object({
        refs: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Refs from apple_safari_open_url results (look like "st1:<uuid>"). Give this or ' +
              "`all`.",
          ),
        all: z
          .literal(true)
          .optional()
          .describe("Every tab still in the record, whichever session opened it."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ refs, all }) =>
      wrapResult(async () => {
        if ((refs === undefined) === (all === undefined)) {
          throw new PreconditionError("Give exactly one of `refs` and `all`.");
        }
        const r = await client.closeTabs(refs ? { refs } : { all: true });
        return ok(
          compact({
            safariRunning: r.safariRunning ? undefined : false,
            closed: some(r.closed),
            notFound: some(r.notFound),
            ambiguous: some(r.ambiguous),
            stale: some(r.stale),
            unknown: some(r.unknown),
            note: r.safariRunning
              ? undefined
              : "Safari is not running, so nothing was closed. It was not launched to check, " +
                "and its tabs may come back when it reopens a session.",
          }),
        );
      }),
  );
};
