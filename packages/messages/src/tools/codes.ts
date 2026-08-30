import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { extractCode } from "../client/codes.js";
import type { AppleMessagesClient } from "../client/messages.js";
import { limitArg, wrap } from "./util.js";

/**
 * The one-time-code tool, registered only when `allowCodes` is on.
 *
 * It exists because the Passwords app cannot be reached at all — every lane is
 * closed, see `docs/passwords.md` — while the channel 2FA codes actually arrive
 * on is a store this server already reads under a grant the user has already
 * given. The value it adds over `apple_messages_search_messages` is not access,
 * which was never missing; it is EXTRACTION, which is where the mistakes live.
 * See `client/codes.ts` for why that is not a regex.
 *
 * The window defaults tight on purpose. A one-time code is only interesting
 * while it is live, and a generous default turns this into a tool that reads
 * months of authentication history for no benefit.
 */
const MAX_WINDOW_MINUTES = 60;
const DEFAULT_WINDOW_MINUTES = 10;

export const registerCodeTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_find_codes",
    {
      description:
        "Find one-time authentication codes (2FA/OTP) in recently received messages. Looks " +
        `back ${DEFAULT_WINDOW_MINUTES} minutes by default, ${MAX_WINDOW_MINUTES} at most, and ` +
        "only at messages you received — never at ones you sent.\n\n" +
        "CHECK `ageSeconds` BEFORE USING A CODE. An expired code is still in the store and " +
        "reads exactly like a live one; most issuers expire them within 5-10 minutes, and this " +
        "tool cannot tell which have. If the newest match is older than the window the user " +
        "expected, say so rather than offering it.\n\n" +
        "`confidence` says how the match was made and is not decoration. " +
        '"high" means the code was bound to a domain (`@site.com #123456`) or sat directly ' +
        'against a word like "verification code" — safe to use. "medium" means the keyword was ' +
        'further away, or two candidates tied. "low" means there was no keyword at all and only ' +
        "the sender being a shortcode suggested it. On anything below high, read the message " +
        "with apple_messages_get_message and confirm against the body before using the digits.\n\n" +
        "A `matched` value ending in `-ambiguous` means the message held more than one plausible " +
        "code and this tool did not guess — confirm which one is wanted.\n\n" +
        "Returning nothing is the normal result when no code has arrived. It does NOT mean the " +
        "code was missed, and it is not a reason to re-run with a longer window: if a code was " +
        "sent it is in the store within seconds. Prefer asking the user to trigger a new one.",
      inputSchema: {
        service: z
          .string()
          .optional()
          .describe(
            'Narrow to one issuer by matching the sender or the message text — "Google", ' +
              '"bank", "Github". Case-insensitive substring. Omit to see every recent code.',
          ),
        withinMinutes: z
          .number()
          .int()
          .min(1)
          .max(MAX_WINDOW_MINUTES)
          .optional()
          .describe(
            `How far back to look, in minutes. Default ${DEFAULT_WINDOW_MINUTES}, max ` +
              `${MAX_WINDOW_MINUTES}. Keep it short: a code older than a few minutes has ` +
              "usually expired, and a wide window just returns history.",
          ),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ service, withinMinutes, limit }) =>
      // See the note in `chats.ts`: core's `wrap` is typed `() => Promise<T>`
      // because most tool bodies await something. This one does not.
      wrap(async () => {
        const minutes = withinMinutes ?? DEFAULT_WINDOW_MINUTES;
        const since = new Date(Date.now() - minutes * 60_000);
        const { fromApple } = client.window(since);

        const needle = service?.trim().toLowerCase();
        const codes = client
          .listMessages({ ...(fromApple === undefined ? {} : { fromApple }), limit })
          // Never a message the user sent. A code they forwarded to somebody is
          // not a code they were issued, and returning it would be a small
          // exfiltration dressed up as a feature.
          .filter((m) => !m.fromMe)
          .filter((m) => {
            if (!needle) return true;
            const haystack = `${m.from.name ?? ""} ${m.from.handle ?? ""} ${m.text ?? ""}`;
            return haystack.toLowerCase().includes(needle);
          })
          .flatMap((m) => {
            const match = extractCode(m.text, {
              fromShortcode: m.from.resolution === "shortcode",
            });
            if (!match) return [];
            const sentAtMs = m.sentAt ? Date.parse(m.sentAt) : Number.NaN;
            return [
              {
                code: match.code,
                confidence: match.confidence,
                matched: match.matched,
                ...(match.boundTo ? { boundTo: match.boundTo } : {}),
                from: m.from,
                sentAt: m.sentAt,
                ageSeconds: Number.isNaN(sentAtMs)
                  ? null
                  : Math.max(0, Math.round((Date.now() - sentAtMs) / 1000)),
                // The ref, so a low-confidence match can be checked against the
                // body rather than trusted. Cheaper than returning the body here
                // and it keeps the caller's next step explicit.
                ref: m.ref,
                chat: m.chat,
              },
            ];
          });

        return {
          windowMinutes: minutes,
          searchedSince: since.toISOString(),
          count: codes.length,
          codes,
        };
      }),
  );
};
