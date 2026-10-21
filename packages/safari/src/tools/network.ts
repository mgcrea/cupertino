import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";
import { describeReach, urlArg } from "./actions.js";
import { compact, fail, ok, wrapResult } from "./util.js";

/**
 * Reading what a page fetched, through the Safari extension.
 *
 * ## Why this is its own gate and not `allowWrites`
 *
 * Nothing here changes anything (but one optional file and one optional reload,
 * which ARE behind `allowWrites`). What it exposes is the traffic of a page the
 * user has already allowed the extension on, and that is the sort of thing a
 * session token rides in. So the tools exist only when the user switched on
 * "Read network traffic", the way `find_codes` exists only for its own gate.
 *
 * ## What cannot be redacted
 *
 * Headers are filtered by name: `authorization`, `cookie`, `set-cookie` and
 * anything with `token`, `secret` or `api-key` in the name come back as
 * `<redacted: N chars>`. Bodies are NOT touched. A JSON response that contains
 * a token is returned with the token in it, because there is no way to know
 * which string in an arbitrary body is a secret, and a guess that sometimes
 * missed would be worse than saying plainly that none is attempted. The tool
 * descriptions say so, because the model deciding whether to read a body is the
 * only place that decision can be made.
 *
 * ## The shape of a session
 *
 * `record` arms the tab, the page does what it does, `list` finds the request,
 * `get` reads (or saves) its body. Ids are minted per page load and die with
 * it, which is why `record` with `reload: true` exists: the first request of a
 * page is the one most worth seeing, and the only way to be armed before it is
 * to arm and then reload.
 */

/**
 * `"404"` or `"400-599"`, nothing else. One string because a model asks for
 * "the failures" as a range far more often than as a pair of numbers, and
 * because two optional numbers can be given in the wrong order where one range
 * cannot be given in a wrong shape.
 */
const STATUS = /^(\d{3})(?:-(\d{3}))?$/;

const statusArg = z
  .string()
  .regex(STATUS, 'A status like "404" (exact) or "400-599" (an inclusive range).')
  .describe(
    'HTTP status to match: "404" for exactly that status, or "400-599" for an inclusive range. ' +
      "A console line has no status, and so does a request that failed before an answer " +
      "(use `failed` for those); a status filter leaves them out.",
  );

/** What every network description says about what Safari cannot see. */
const LIMITS =
  "Captured: fetch() and XMLHttpRequest calls made by the TOP frame of the page, plus " +
  "console errors and warnings. NOT captured: subframes (an iframe's traffic is invisible), " +
  "web workers and service workers, <img>/<script>/<link> bodies (their URLs and timing can " +
  "be listed, never their bytes), and WebSockets. Records live in the page's memory and ids " +
  "die on reload or navigation.";

/** What every network description says about secrets. */
const REDACTION =
  "Bodies are NOT redacted: only headers named authorization, proxy-authorization, cookie, " +
  "set-cookie, or containing token, secret or api-key are masked. A body that holds a " +
  "credential comes back with it, so read one only when you need to.";

export const registerNetworkTools = (
  server: McpServer,
  client: AppleSafariClient,
  ctx: { allowWrites: boolean },
): void => {
  // With writes off, say so where the caller will see it. The refusal itself
  // lives in the client, and one sentence here saves the round trip of finding
  // out from an error.
  const writesNote = ctx.allowWrites
    ? ""
    : " Writes are currently OFF on this server, so `reload` and `saveAs` will be refused " +
      "until APPLE_SAFARI_ALLOW_WRITES is set.";

  server.registerTool(
    "apple_safari_network_record",
    {
      description: describeReach(
        "Start, stop, clear or report network recording on an open page. Recording is opt-in " +
          'per tab: nothing is wrapped until you call this with action "start", so a page ' +
          "that was never armed has no history to read. Arming survives a reload of the same " +
          "tab for `armMinutes` (default 15, at most 120) and then expires on its own, so a " +
          'forgotten recording does not run all day; "stop" ends it at once.\n\n' +
          "To see a page's FIRST requests, pass `reload: true`: it arms and then reloads the " +
          "tab. That re-runs the page (and can re-send a form's request), so it needs " +
          "APPLE_SAFARI_ALLOW_WRITES; without it the call is refused. The alternative is to " +
          "start recording and then trigger the request yourself.\n\n" +
          LIMITS +
          " " +
          REDACTION +
          " Request ids from before a reload are dead after it; list again." +
          writesNote,
      ),
      inputSchema: {
        url: urlArg,
        action: z
          .enum(["start", "stop", "clear", "status"])
          .describe(
            '"start" arms the tab (and replaces the options of an armed one), "stop" disarms ' +
              'it and keeps what was recorded, "clear" drops the records, "status" reports ' +
              "the state, record counts and expiry without changing anything.",
          ),
        kinds: z
          .array(z.enum(["fetch", "xhr", "console"]))
          .optional()
          .describe('Which events to record. Defaults to all three: ["fetch", "xhr", "console"].'),
        captureBodies: z
          .boolean()
          .optional()
          .describe("Keep response bodies. Defaults to true. Off records metadata only."),
        bodyFilter: z
          .string()
          .optional()
          .describe(
            "Keep bodies only for requests whose URL contains this text; metadata is kept for " +
              "all. Use it to spare the buffer when only one endpoint matters.",
          ),
        maxBodyBytes: z
          .number()
          .int()
          .min(1)
          .max(50 * 1024 * 1024)
          .optional()
          .describe(
            "Largest body kept, per request. Defaults to 10 MiB, at most 50 MiB. A larger body " +
              "is cut and listed with `bodyTruncated: true`, and jsonPath, decode and saveAs " +
              "refuse it rather than work from half a document.",
          ),
        armMinutes: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("How long the arming lasts across reloads. Defaults to 15, at most 120."),
        reload: z
          .boolean()
          .optional()
          .describe(
            "Arm, then reload the tab so recording starts at the page's first request. " +
              "Defaults to false. Needs APPLE_SAFARI_ALLOW_WRITES.",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, action, ...rest }) =>
      wrapResult(async () => {
        const state = await client.networkRecord({ url, op: action, ...rest });
        return ok(
          compact({
            ...state,
            idNote:
              "Request ids are valid for this page load only. A reload or navigation kills " +
              "them; list again afterwards.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_safari_network_list",
    {
      description: describeReach(
        "List what an open page has fetched, newest last, as metadata only: id, kind, method, " +
          "URL, status, timing, sizes, content type, and whether a body is available. Bodies " +
          "are read with apple_safari_network_get. Filter by `kind`, `urlContains`, `method`, " +
          '`status` ("404" or "400-599") or `failed` (a network error, a status of 400 or ' +
          "more, or a console error), and page with `after` and `limit`; `next` in the result " +
          "is the cursor for the following page and `dropped` says how many records the buffer " +
          "has already let go of, so a short list is never silent.\n\n" +
          'Entries of kind "resource" come from the browser\'s resource timing and are listed ' +
          "even when recording is off: they give URL and timing for images, scripts and " +
          "stylesheets, never a body, and carry a status only where Safari reports one.\n\n" +
          LIMITS +
          " " +
          REDACTION,
      ),
      inputSchema: {
        url: urlArg,
        kind: z.enum(["fetch", "xhr", "console", "resource"]).optional(),
        urlContains: z.string().optional().describe("Keep entries whose URL contains this text."),
        method: z.string().optional().describe('An HTTP method, like "POST". Any case.'),
        status: statusArg.optional(),
        failed: z
          .boolean()
          .optional()
          .describe(
            "true keeps only failures (a network error, a status of 400 or more, a console " +
              "error); false keeps only the rest.",
          ),
        after: z
          .string()
          .optional()
          .describe("A request id from a previous result's `next`, to continue after it."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries to return. Defaults to 50, at most 500."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, kind, urlContains, method, status, failed, after, limit }) =>
      wrapResult(async () => {
        let statusMin: number | undefined;
        let statusMax: number | undefined;
        if (status !== undefined) {
          const m = STATUS.exec(status) as RegExpExecArray;
          statusMin = Number(m[1]);
          statusMax = m[2] === undefined ? statusMin : Number(m[2]);
          if (statusMin > statusMax) {
            return fail(
              `status "${status}" is a range that ends before it starts. Write it low to high, ` +
                'like "400-599".',
            );
          }
        }
        const result = await client.networkList({
          url,
          filter: compact({ kind, urlContains, method, statusMin, statusMax, failed }),
          after,
          limit,
        });
        return ok(
          compact({
            ...result,
            idNote:
              "Ids are valid for this page load only. Pass them to apple_safari_network_get " +
              "exactly as listed.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_safari_network_get",
    {
      description: describeReach(
        "Read one recorded request, by an id from apple_safari_network_list: its headers " +
          '(on by default; pass `headers: false` to omit) and its body, `part: "response"` ' +
          '(default) or `"request"`. Inline text is capped at 20,000 characters a call; ' +
          "`truncated`, `totalChars` and `nextOffset` say whether there is more, and `offset` " +
          "with `maxChars` pages through it. `bodyTruncated: true` means the PAGE stored only " +
          "the first maxBodyBytes of a larger body.\n\n" +
          "To get a FILE out of an API response (a PDF returned as base64 inside JSON, say) do " +
          'not read it inline: pass `jsonPath` to select the field (like "data.document.content"), ' +
          '`decode: "base64"` to turn it into bytes, and `saveAs` to write it. The bytes go ' +
          "to disk and never into this conversation; the result gives the path, the byte count " +
          "and a type sniffed from the first bytes (`type` is null when it was not " +
          "recognised, which says nothing about whether the file is good). `saveAs` writes " +
          "into APPLE_SAFARI_DOWNLOAD_DIR (default ~/Downloads), takes a bare filename with no " +
          "path, and refuses an existing file unless `overwrite: true`.\n\n" +
          "jsonPath, decode and saveAs work on the WHOLE body, so they are refused for a body " +
          "the page cut short, and a path that does not resolve fails naming the keys that are " +
          "there. `saveAs` needs APPLE_SAFARI_ALLOW_WRITES.\n\n" +
          LIMITS +
          " " +
          REDACTION +
          writesNote,
      ),
      inputSchema: {
        url: urlArg,
        id: z
          .string()
          .min(1)
          .describe(
            'A request id from apple_safari_network_list, like "3f9a2c1d-r12", passed exactly ' +
              "as listed. The part before the dash names the page load that recorded it; the " +
              "id is dead once that page reloads or navigates.",
          ),
        part: z.enum(["response", "request"]).optional().describe('Defaults to "response".'),
        headers: z
          .boolean()
          .optional()
          .describe("Include the headers, sensitive ones masked. Defaults to true."),
        jsonPath: z
          .string()
          .optional()
          .describe(
            "Select one value from a JSON body: a dotted path with bracket indices, like " +
              '"data.document.content" or "items[0].pdf" (a leading "$" is optional). Needs ' +
              "the whole body.",
          ),
        decode: z
          .enum(["base64"])
          .optional()
          .describe(
            "Decode the selected value (or the whole body) from base64. Standard and URL-safe " +
              "alphabets and a data: prefix are accepted; anything else is an error rather than " +
              "a quietly wrong file.",
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Where to start in the body text, for paging. Defaults to 0."),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(20_000)
          .optional()
          .describe("Characters to return inline. Defaults to and is capped at 20,000."),
        saveAs: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Write the result to this filename in APPLE_SAFARI_DOWNLOAD_DIR instead of returning " +
              "it. A bare name only. Needs APPLE_SAFARI_ALLOW_WRITES.",
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace an existing file of that name. Defaults to false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      wrapResult(async () => {
        const result = await client.networkGet(args);
        return ok(
          compact({
            ...result,
            // Said in words as well as `null`, because a model reading
            // `"type": null` may take it for a failure to detect rather than a
            // type nobody on the list matched. The file is written either way.
            savedNote:
              result.saved && result.saved.type === null
                ? "The file was saved as named. Its type was not recognised from its first " +
                  "bytes, which is not an error: only PDF, PNG, JPEG, GIF, ZIP and JSON are sniffed."
                : undefined,
          }),
        );
      }),
  );
};
