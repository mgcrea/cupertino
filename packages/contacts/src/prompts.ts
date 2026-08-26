import {
  registerWorkflowPrompt,
  requiredPromptArg,
  type PromptContext,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CONTACTS_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "contacts", guide: CONTACTS_GUIDE };

/**
 * Contacts' one workflow prompt.
 *
 * There is one because there is one hard thing on this surface, and it is not
 * looking a name up — it is refusing to. An ambiguous handle returns no name on
 * purpose, and the failure this prompt exists to prevent is a model helpfully
 * choosing the first of three matches and presenting it as fact.
 */
export const registerPrompts = (server: McpServer): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_contacts_who_is",
    title: "Who is this",
    description:
      "Identify a person from a name, a phone number or an email address, reporting honestly " +
      "when the address book cannot say. Read-only.",
    argsSchema: {
      who: requiredPromptArg(
        'A name, phone number or email address — however it arrived, e.g. "+33612345678".',
      ),
    },
    build: ({ who }) => `Who is: ${who}

1. If that looks like a phone number or an email address, use
   \`apple_contacts_resolve_handles\` — pass it exactly as given, without
   reformatting it. If it looks like a name, use
   \`apple_contacts_search_contacts\`.
2. **Read \`status\` before you read \`name\`.** Report each case as what it is:
   - \`resolved\` — give the name.
   - \`unknown\` — say the address book does not have this handle and show it
     raw. This is normal, not a failure, and not worth apologising for.
   - \`ambiguous\` — say how many people share it and that you will not guess.
     Offer to show the candidates. **Never pick one.** A confidently wrong name
     is the one outcome here that nobody catches.
   - \`shortcode\` — say it is an automated sender, not a person.
3. On a resolved contact, \`apple_contacts_get_contact\` for the full card if the
   user wants more than the name.

If nothing resolves at all, check \`cupertino://contacts/diagnostics\` before
concluding the address book is empty — Contacts has its own permission, separate
from Full Disk Access, and a dismissed prompt looks exactly like no contacts.`,
  });
};
