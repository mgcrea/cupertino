import { extractCode } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * The one-time-code tool, registered only when `allowCodes` is on.
 *
 * ## Why it exists beside `page_elements`
 *
 * With the same setting on, `page_elements` already returns the value of an OTP
 * FIELD. This reaches the other case, and it is the ordinary one: the code
 * arrives as TEXT, in a webmail message or an issuer's dashboard, where there
 * is no input to enumerate at all.
 *
 * ## Why not `read_page`
 *
 * That reads the capture store, which is written at `document_idle` and after a
 * route change. A code delivered by XHR into an already-open tab is not in it.
 * This scans the live DOM at command time, so it sees what no capture holds.
 *
 * ## What it adds over both
 *
 * EXTRACTION, which is the same argument `apple_messages_find_codes` makes over
 * `search_messages` — access was never the missing part. The heuristic is
 * shared with Messages (`extractCode` in core) and is SMS-shaped; a web page is
 * a far richer source of digit runs, so it is reused rather than re-validated.
 * That is why `confidence` matters more here, not less.
 */
export const registerCodeTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_find_codes",
    {
      description:
        "Find a one-time authentication code (2FA/OTP) in the text of an open page. Runs " +
        "through the Cupertino Safari extension, so it needs NO Full Disk Access and NO " +
        "Automation grant — what it needs is the extension enabled in Safari AND allowed on " +
        "that specific website, which Safari grants one site at a time. The page must be open. " +
        "Expect about a second of latency on a visible tab and up to ten on a background one.\n\n" +
        "THERE IS NO `ageSeconds` HERE AND THERE CANNOT BE. A message carries the time it " +
        "arrived; a paragraph on a page does not. A code that expired twenty minutes ago sits " +
        "in the DOM looking exactly like one that arrived a second ago, and this tool also " +
        "cannot tell whether a code has already been used. `pageAgeSeconds` bounds the age " +
        "from ABOVE and never from below: a page loaded four seconds ago can only hold a " +
        "four-second-old code, but a webmail tab open for six hours tells you nothing.\n\n" +
        "`confidence` says how the match was made and is not decoration. " +
        '"high" means the code was bound to a domain (`@site.com #123456`) or sat directly ' +
        'against a word like "verification code". "medium" means the keyword was further ' +
        "away, or two candidates tied. On anything below high, read `context` — it is the " +
        "exact text the code was taken from — and confirm before using the digits. Note that " +
        '"low" cannot occur on this lane: a page has no sender to corroborate with, so a digit ' +
        "run with no keyword near it yields nothing at all.\n\n" +
        "This reads what the page SHOWS. It cannot read a password, a card number, or the " +
        "Passwords app, and no setting changes that.\n\n" +
        "Returning nothing is the normal result. It does NOT mean the code was missed: prefer " +
        "asking the user to trigger a new one, or check the page is the one holding the code.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            "The exact URL of the page to scan, as apple_safari_list_tabs reports it. Required " +
              "so the scan cannot land on a different tab than the one you meant.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe("Maximum passages to scan for digits. Defaults to 10."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, limit }) =>
      wrapResult(async () => {
        const startedAt = Date.now();
        const result = await client.pageAction({ action: "codes", url, limit });
        if (!result.ok) return fail(result.error ?? "The page could not be scanned for codes.");
        const data = result.data as {
          excerpts?: { text: string; inView: boolean }[];
          truncated?: boolean;
          scannedAt?: string;
          pageAgeSeconds?: number;
        };

        // Extraction happens HERE, never in the page: one tested copy of the
        // judgement, and the content script stays a thing that only reports.
        const codes = (data.excerpts ?? []).flatMap((excerpt) => {
          const match = extractCode(excerpt.text);
          if (!match) return [];
          return [
            compact({
              code: match.code,
              confidence: match.confidence,
              matched: match.matched,
              boundTo: match.boundTo ?? null,
              // The excerpt is already bounded and is the exact string the
              // match came from, so returning it is cheap. Messages withholds
              // the message body because the alternative there is a whole
              // thread; here "go read the page" would cost a full read_page to
              // check one digit run.
              context: excerpt.text.slice(0, 120),
              inView: excerpt.inView,
            }),
          ];
        });

        const rank = { high: 0, medium: 1, low: 2 } as const;
        codes.sort(
          (a, b) =>
            rank[a.confidence as keyof typeof rank] - rank[b.confidence as keyof typeof rank],
        );

        return ok(
          compact({
            url,
            scannedAt: data.scannedAt ?? null,
            pageAgeSeconds: data.pageAgeSeconds ?? null,
            roundTripMs: Date.now() - startedAt,
            count: codes.length,
            truncated: data.truncated ?? false,
            codes,
            ...(codes.length === 0
              ? {
                  note:
                    "No code in the text of this page, which is the normal result. The code may " +
                    "not have arrived yet, may be on a different page, or may be in a field " +
                    "rather than the text — try apple_safari_page_elements for that.",
                }
              : {
                  ageNote:
                    "These codes carry no timestamp. Check pageAgeSeconds, and prefer a code " +
                    "the user can confirm is the current one.",
                }),
          }),
        );
      }),
  );
};
