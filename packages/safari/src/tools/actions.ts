import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * Acting inside a page, through the Safari extension.
 *
 * ## Why these are not `do JavaScript`
 *
 * Safari's only Apple Event that reaches into a page needs "Allow JavaScript
 * from Apple Events" — global, permanent, unscoped, and its state cannot be
 * read, so a user who enables it to click one button has enabled it for every
 * tab forever and nothing can tell them whether it is on. The extension is the
 * same capability consented one website at a time, visibly, revocably.
 *
 * ## Why an element ID and not a CSS selector
 *
 * A selector has to be written by something that already knows the DOM, which
 * means shipping the page's HTML to it and hoping the selector still matches on
 * arrival. When it does not match, it does not fail — it matches something
 * else, and the wrong button gets clicked. IDs come from an enumeration the
 * page itself just performed, and a stale one is an error rather than a
 * different element.
 *
 * ## The split between the read and the writes here
 *
 * `page_elements` is registered always: it changes nothing, and asking what is
 * on a page is the same class of act as reading its text, which this surface
 * already does. The three that ACT are behind `allowWrites`, because a click
 * can buy something.
 */
const elementIdArg = z
  .string()
  .min(1)
  .describe(
    'An element id from apple_safari_page_elements, like "e12". IDs are handed out per ' +
      "enumeration and DIE on navigation — never construct one, never reuse one across a page " +
      "change, and re-enumerate after any click that loaded something.",
  );

const urlArg = z
  .string()
  .min(1)
  .describe(
    "The exact URL of the page to act on, as apple_safari_list_tabs reports it. Required so a " +
      "command cannot land on a different tab than the one you looked at.",
  );

/** Shared by every action tool: the same failure means the same three things. */
const describeReach = (what: string): string =>
  `${what} Runs through the Cupertino Safari extension, so it needs NO Full Disk Access and NO ` +
  `Automation grant — what it needs is the extension enabled in Safari AND allowed on that ` +
  `specific website, which Safari grants one site at a time. The page must be open. Expect about ` +
  `a second of latency on a visible tab and up to ten on a background one, because the page polls ` +
  `for work rather than being pushed to.`;

export const registerElementTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_page_elements",
    {
      description: describeReach(
        "List what can be clicked or typed into on an open page — links, buttons, form fields — " +
          "each with a short id to use with apple_safari_click and apple_safari_fill. " +
          "This is how you find out what to click: do NOT guess a selector, and do not " +
          "construct ids. `inView` says whether the user can currently see it, which is the " +
          "tiebreaker when two elements share a label. The list is capped and `truncated` says " +
          "when it was cut.\n\n" +
          "A text field also carries what it currently holds, in `value` — EXCEPT where the " +
          "field looks like it holds a secret, and then `value` is null and `redacted` says " +
          'which kind. `redacted: "credential"` is a password or a card number and is never ' +
          'returned, whatever the settings say. `redacted: "code"` is a one-time 2FA field, ' +
          'returned only when the user has switched on "Read one-time codes" ' +
          "(APPLE_SAFARI_ALLOW_CODES). In both cases `hasValue` still says whether the field " +
          "is filled, which is usually the thing you actually needed to know.",
      ),
      inputSchema: {
        url: urlArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum elements to return. Defaults to 60."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, limit }) =>
      wrapResult(async () => {
        const result = await client.pageAction({ action: "elements", url, limit });
        if (!result.ok) return fail(result.error ?? "The page could not enumerate its elements.");
        return ok(
          compact({
            url,
            ...(result.data as Record<string, unknown>),
            idNote:
              "These ids are valid for this page only, until it navigates or re-renders. " +
              "Re-enumerate after anything that changes the page.",
          }),
        );
      }),
  );
};

export const registerActionTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_click",
    {
      description: describeReach(
        "Click an element on an open page, by an id from apple_safari_page_elements. The page " +
          "is scrolled to bring it into view first, so the user sees what was done. " +
          "IRREVERSIBLE and NOT idempotent: a click can submit a form, send a message or " +
          "complete a purchase, and this server cannot undo one. If the call times out, the " +
          "click MAY still have happened — do not retry it; look at the page instead with " +
          "apple_safari_read_page. After a click that navigates, previous element ids are dead.",
      ),
      inputSchema: { url: urlArg, elementId: elementIdArg },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, elementId }) =>
      wrapResult(async () => {
        const result = await client.pageAction({ action: "click", url, elementId });
        if (!result.ok) return fail(result.error ?? "The click did not happen.");
        return ok(
          compact({
            ...(result.data as Record<string, unknown>),
            url,
            staleNote:
              "If this click navigated or re-rendered the page, every element id from before it " +
              "is now dead. Enumerate again rather than reusing one.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_safari_fill",
    {
      description: describeReach(
        "Type text into a field on an open page, by an id from apple_safari_page_elements. " +
          "Replaces whatever the field held; it does not append. Fires the input and change " +
          "events a real keystroke would, so pages built on React or Vue see the value rather " +
          "than overwriting it on their next render. It does NOT submit — click the submit " +
          "button separately, which keeps the decision to send explicit.\n\n" +
          "A one-time 2FA code IS a legitimate thing to put through this, and is the case it " +
          "was built for: read one with apple_safari_find_codes or apple_messages_find_codes, " +
          "then fill it. Check the code is still current first — neither tool can tell an " +
          "expired code from a live one.\n\n" +
          "A PASSWORD or a card number is not. Nothing in this server can read either, so a " +
          "value you are about to type here came from somewhere else, and a page that asks for " +
          "one is asking the user rather than you.\n\n" +
          "Some sites split a code across several single-character boxes instead of one field. " +
          "This writes the whole string into ONE element, so on those it will not work — the " +
          "digits land in the first box or are rejected on the next render. Enumerate again " +
          "afterwards and check, rather than assuming it took.",
      ),
      inputSchema: {
        url: urlArg,
        elementId: elementIdArg,
        text: z.string().describe("The text to put in the field. An empty string clears it."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, elementId, text }) =>
      wrapResult(async () => {
        const result = await client.pageAction({ action: "fill", url, elementId, text });
        if (!result.ok) return fail(result.error ?? "The field could not be filled.");
        return ok(compact({ ...(result.data as Record<string, unknown>), url }));
      }),
  );

  server.registerTool(
    "apple_safari_scroll",
    {
      description: describeReach(
        "Scroll an open page by about one screen, up or down. Useful for reaching content that " +
          "loads only when scrolled to, and for changing which elements report `inView`. " +
          "Re-enumerate afterwards: scrolling can add elements to a page that lazy-loads.",
      ),
      inputSchema: {
        url: urlArg,
        direction: z.enum(["up", "down"]).optional().describe('Defaults to "down".'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, direction }) =>
      wrapResult(async () => {
        const result = await client.pageAction({
          action: "scroll",
          url,
          direction: direction ?? "down",
        });
        if (!result.ok) return fail(result.error ?? "The page could not be scrolled.");
        return ok(compact({ ...(result.data as Record<string, unknown>), url }));
      }),
  );
};
