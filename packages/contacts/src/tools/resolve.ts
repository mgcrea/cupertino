import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleContactsClient } from "../client/contacts.js";
import { encodeRef } from "../client/ref.js";
import { wrap } from "./util.js";

/**
 * The tool this surface was built for.
 *
 * Everything else here is an ordinary address book server. This one exists
 * because `chat.db` — and a caller ID, and an email header — carries an
 * identifier and no name, and turning one into the other is the only thing on
 * this machine that can.
 */
export const registerResolveTools = (server: McpServer, client: AppleContactsClient): void => {
  server.registerTool(
    "apple_contacts_resolve_handles",
    {
      description:
        "Turn phone numbers or email addresses into contact names. Give it the raw identifiers " +
        "from somewhere else — Messages handles, a caller ID, an email header — and it returns " +
        "one result per handle.\n\n" +
        "Read `status` on every result rather than assuming a name came back:\n" +
        '- "resolved" — exactly one contact. `name` is set.\n' +
        '- "unknown" — nobody in the address book has this number. COMMON AND NOT AN ERROR: ' +
        "measured on a real store, about one in six of even the busiest correspondents does not " +
        "resolve. Show the raw handle.\n" +
        '- "ambiguous" — more than one contact has it, so no name is returned. Do not guess; ' +
        "`matches` says how many.\n" +
        '- "shortcode" — a bank, a courier, a 2FA sender. Can never be a contact.\n\n' +
        "Phone matching is by trailing digits, because Contacts stores numbers as typed " +
        '("06 12 34 56 78") while most systems hand you E.164 ("+33612345678"). Exact string ' +
        "matching resolves almost nothing and is not used.",
      inputSchema: {
        handles: z
          .array(z.string().min(1))
          .min(1)
          .max(500)
          .describe(
            'Phone numbers or email addresses, in any format — "+33612345678", "06 12 34 56 78" ' +
              'and "user@example.com" all work.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ handles }) =>
      wrap(async () => {
        const { results, summary } = client.resolve(handles);
        return {
          summary,
          results: results.map((r) => ({
            handle: r.handle,
            kind: r.kind,
            status: r.status,
            name: r.name,
            matches: r.matches,
            ...(r.contact
              ? {
                  ref: encodeRef(r.contact.source, r.contact.recordPk),
                  organization: r.contact.organization,
                  account: r.contact.source,
                }
              : {}),
          })),
        };
      }),
  );
};
