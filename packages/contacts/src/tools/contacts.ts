import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleContactsClient } from "../client/contacts.js";
import { encodeRef, decodeRef } from "../client/ref.js";
import { fail, limitArg, ok, wrap, wrapResult } from "./util.js";

/**
 * NOTE ON `async` BELOW: core's `wrap` is typed `() => Promise<T>` because most
 * surfaces reach Apple Events. Contacts reads synchronous SQLite and never
 * leaves the process, so the thunks are marked async here rather than widening a
 * shared signature for every surface to accommodate one.
 */

export const registerContactTools = (server: McpServer, client: AppleContactsClient): void => {
  server.registerTool(
    "apple_contacts_search_contacts",
    {
      description:
        "Search the address book by name, nickname or organisation. Returns a ref for each " +
        "match, plus which account it came from — the same person can legitimately appear twice " +
        "if they are in two accounts. Use apple_contacts_get_contact for phone numbers and " +
        "email addresses.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for in names and organisations."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) =>
      wrap(async () =>
        client.search(query, limit).map((c) => ({
          ref: encodeRef(c.source, c.recordPk),
          name: c.displayName,
          organization: c.organization,
          jobTitle: c.jobTitle,
          account: c.source,
        })),
      ),
  );

  server.registerTool(
    "apple_contacts_list_contacts",
    {
      description:
        "List contacts across every account. This is the whole address book, so prefer " +
        "apple_contacts_search_contacts when you are looking for someone specific.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      wrap(async () =>
        client.list(limit).map((c) => ({
          ref: encodeRef(c.source, c.recordPk),
          name: c.displayName,
          organization: c.organization,
          account: c.source,
        })),
      ),
  );

  server.registerTool(
    "apple_contacts_get_contact",
    {
      description:
        "One contact in full: name, organisation, job title, every phone number and every " +
        "email address, each with its label.",
      inputSchema: {
        ref: z
          .string()
          .min(1)
          .describe(
            'An opaque contact ref from a list or search result (looks like "k1:<account>/<id>"). ' +
              "Do not construct one by hand.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const decoded = decodeRef(ref);
        const contact = client.get(decoded.source, decoded.recordPk);
        if (!contact) {
          return fail(
            `No contact for ref "${ref}". It was probably deleted, or the account holding it ` +
              `was removed, since the search ran. Re-run the search to get a current ref.`,
          );
        }
        return ok({
          ref,
          name: contact.displayName,
          firstName: contact.firstName,
          lastName: contact.lastName,
          nickname: contact.nickname,
          organization: contact.organization,
          jobTitle: contact.jobTitle,
          account: contact.source,
          isMe: contact.isMe,
          phones: contact.phones,
          emails: contact.emails,
        });
      }),
  );
};
