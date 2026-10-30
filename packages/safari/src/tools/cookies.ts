import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { describeReach, urlArg } from "./actions.js";
import { compact, ok, wrapResult } from "./util.js";

/**
 * The cookies tool, registered only when `allowCookies` is on.
 *
 * ## Why it exists
 *
 * To hand a signed-in session to a local tool without the user copying it out
 * of Safari by hand. The case that asked for it needs three HttpOnly cookies
 * from finance.yahoo.com, and nothing else on this surface can see one: a page
 * script cannot, the network tools mask cookie headers, and Safari's own store
 * is a file behind Full Disk Access. See `client/cookies.ts`.
 *
 * ## Why it is gated twice
 *
 * The flag decides whether the tool exists; `APPLE_SAFARI_COOKIE_HOSTS` decides
 * which sites it may read. A login cookie IS the login, so a flag alone would
 * hand any agent any session in the browser. Under both sits Safari's own
 * per-site grant, since the read runs in the extension.
 *
 * ## Why no value comes back
 *
 * A result lands in the conversation, which is the wrong place for a session.
 * The listing is metadata; the values go to a 0600 file by `saveAs`, which is
 * also a write and so also needs `allowWrites`.
 */
export const registerCookieTools = (
  server: McpServer,
  client: AppleSafariClient,
  ctx: { allowWrites: boolean },
): void => {
  const writesNote = ctx.allowWrites
    ? ""
    : " Writes are currently OFF on this server, so `saveAs` will be refused until " +
      "APPLE_SAFARI_ALLOW_WRITES is set.";

  server.registerTool(
    "apple_safari_cookies",
    {
      description: describeReach(
        "List the cookies Safari would send to an open page, HttpOnly ones included: for each, " +
          "its name, domain, path, secure, httpOnly, sameSite and expiry (`expires`, null for a " +
          "session cookie). It NEVER returns a cookie's value inline, whatever you ask: a login " +
          "cookie is the login itself, and this conversation is the wrong place for it.\n\n" +
          "To hand a session to a local tool, pass `names` and `saveAs`. The named cookies are " +
          'written to that file as one Cookie header value ("A3=…; T=…; Y=…", no "Cookie:" ' +
          "prefix and no trailing newline), mode 0600, into APPLE_SAFARI_DOWNLOAD_DIR (default " +
          "~/Downloads). `saveAs` is a bare filename, refuses an existing file unless " +
          "`overwrite: true`, and needs APPLE_SAFARI_ALLOW_WRITES. The result gives the path, " +
          "the names and the byte count. A name the page does not have writes nothing and says " +
          "which; a signed-out page lacks its login cookies.\n\n" +
          "Only pages on a site listed in APPLE_SAFARI_COOKIE_HOSTS can be read (a registrable " +
          'domain like "example.com" covers its subdomains); anything else is refused before ' +
          "the browser is asked, and only the user can change that setting." +
          writesNote,
      ),
      inputSchema: z.object({
        url: urlArg,
        names: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Cookie names. Without saveAs, narrows the listing to these; with saveAs, the " +
              "cookies to write, in this order. Required with saveAs.",
          ),
        saveAs: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Write the named cookies to this filename in APPLE_SAFARI_DOWNLOAD_DIR. A bare name " +
              "only. Needs APPLE_SAFARI_ALLOW_WRITES.",
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace an existing file of that name. Defaults to false."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      wrapResult(async () => {
        const result = await client.cookies(args);
        return ok(
          compact({
            ...result,
            valuesNote: result.saved
              ? "The values are in the file and nowhere else. Treat it as the login itself: " +
                "hand its path to the tool that needs it, and delete it when done."
              : "No values here, by design. To use a session, pass names and saveAs.",
          }),
        );
      }),
  );
};
