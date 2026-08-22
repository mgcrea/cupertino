import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleContactsClient } from "../client/contacts.js";
import { decodeRef } from "../client/ref.js";
import { fail, ok, wrap } from "./util.js";

/**
 * The mutating tools. Registered only when `allowWrites` is on, and never
 * merely refused — an MCP client caches the tool list, so a tool that exists and
 * says no is a tool the model will keep trying.
 *
 * Two verbs, because the dictionary has two. There is no `delete_contacts`:
 * `sdef /System/Applications/Contacts.app` contains no delete command of any
 * kind, and writes go through Apple Events on every surface here because the
 * store is opened `PRAGMA query_only`. See `client/jxa/core.ts`.
 */

const labelledValue = z.object({
  label: z
    .string()
    .optional()
    .describe('Which kind, e.g. "mobile", "home", "work". Defaults to mobile for phones.'),
  value: z.string().min(1),
});

const fields = {
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  organization: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  company: z
    .boolean()
    .optional()
    .describe("True for an organisation rather than a person — Contacts shows it differently."),
};

/** The caveat both tools carry, because it is a property of Contacts itself. */
const SAVE_CAVEAT =
  "Contacts keeps edits in an unsaved buffer and its save command commits EVERYTHING pending, so " +
  "this also saves any edit someone has half-typed in the Contacts window. That is how the app's " +
  "scripting works, not a choice this server makes. The result is re-read after saving, so what " +
  "comes back is what Contacts stored rather than what was asked for.";

export const registerActionTools = (server: McpServer, client: AppleContactsClient): void => {
  server.registerTool(
    "apple_contacts_create_contact",
    {
      description:
        "Create a new contact in the address book. This is a real card in the user's real " +
        "Contacts, and on an iCloud account it syncs to their other devices within seconds. " +
        "Give at least one of firstName, lastName or organization. " +
        SAVE_CAVEAT,
      inputSchema: {
        ...fields,
        phones: z.array(labelledValue).optional(),
        emails: z.array(labelledValue).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ phones, emails, ...rest }) =>
      wrap(async () => {
        // A card with no name at all is not a contact, it is a blank row that
        // has to be found and removed by hand in the UI.
        if (!rest.firstName && !rest.lastName && !rest.organization) {
          return fail(
            "A contact needs at least one of firstName, lastName or organization — Contacts will " +
              "otherwise create a nameless card that is hard to find again.",
          );
        }
        return ok(
          await client.createContact({
            fields: rest,
            ...(phones ? { phones } : {}),
            ...(emails ? { emails } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    "apple_contacts_update_contact",
    {
      description:
        "Change an existing contact, or add a phone number or email address to one. Omitting a " +
        "field leaves it alone; passing null clears it. Phones and emails are ADDED, never " +
        "replaced — Contacts models them as separate objects, and there is no way to remove one " +
        "through its scripting dictionary. " +
        SAVE_CAVEAT,
      inputSchema: {
        ref: z
          .string()
          .min(1)
          .describe(
            'A contact ref from a search or resolve result (looks like "k1:<account>/<id>"). ' +
              "Do not construct one by hand.",
          ),
        ...fields,
        phones: z.array(labelledValue).optional().describe("Added to whatever is already there."),
        emails: z.array(labelledValue).optional().describe("Added to whatever is already there."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ref, phones, emails, ...rest }) =>
      wrap(async () => {
        const decoded = decodeRef(ref);
        const contact = client.get(decoded.source, decoded.recordPk);
        if (!contact) {
          return fail(
            `No contact for ref "${ref}". It was probably deleted, or the account holding it was ` +
              `removed, since the search ran. Re-run the search to get a current ref.`,
          );
        }
        // The file lane holds the rowid; Apple Events addresses people by their
        // own id. `ZUNIQUEID` is the bridge between the two, and a contact
        // without one cannot be reached from this side at all.
        if (!contact.uniqueId) {
          return fail(
            `The contact "${contact.displayName}" has no stable identifier in the address book ` +
              `database, so it cannot be addressed through Contacts' scripting interface. Edit it ` +
              `in Contacts.app instead.`,
          );
        }
        return ok(
          await client.updateContact({
            personId: contact.uniqueId,
            fields: rest,
            ...(phones ? { phones } : {}),
            ...(emails ? { emails } : {}),
          }),
        );
      }),
  );
};
