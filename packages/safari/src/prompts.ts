import { promptArg, registerWorkflowPrompt, type PromptContext } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SAFARI_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "safari", guide: SAFARI_GUIDE };

/**
 * Safari's one workflow prompt.
 *
 * It exists because "find that page again" is a question about three different
 * stores — history, open tabs, the Reading List — that no single tool can
 * answer, and picking one of them produces a confident answer to a question
 * nobody asked.
 */
export const registerPrompts = (server: McpServer): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_safari_what_was_i_reading",
    title: "Find something I was reading",
    description:
      "Track down a page across history, open tabs and the Reading List — three separate stores " +
      "that answer three different questions. Read-only.",
    argsSchema: {
      about: promptArg('What the page was about, e.g. "the article on SQLite WAL mode".'),
      since: promptArg('Roughly when, e.g. "yesterday", "last week". Omit if unknown.'),
    },
    build: ({ about, since }) => `Find the page ${about ? `about: ${about}` : "I was reading"}${
      since ? `\n\nRoughly ${since}.` : ""
    }

These are three separate stores and they answer different questions, so check
the ones that fit rather than assuming history covers everything:

1. \`apple_safari_search_history\` — where it is if I visited it and moved on${
      since ? ", bounded by the date I gave you" : ""
    }.
2. \`apple_safari_list_tabs\` — where it is if it is **still open**. Safari never
   writes open tabs to disk, so history cannot answer this one.
3. \`apple_safari_list_reading_list\` — where it is if I saved it for later.
   Bookmarks (\`apple_safari_list_bookmarks\`) are a fourth, for things filed
   deliberately.

Report which store each result came from — "still open in a tab" and "visited
last Tuesday" are different answers and the user will act on them differently.

Two things not to say:
- If a tab has no matching history row, that means **not found**, not never
  visited. Only about 55% of open tabs match one; the URL is the only join key
  and it is lossy.
- If a date comes back null, say the date is unknown. Do not present it as old.

If one lane returns nothing at all, check \`cupertino://safari/diagnostics\`
before concluding the page does not exist — the lanes have separate permissions
and one being denied while the other works is normal here.`,
  });
};
