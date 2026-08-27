import { promptArg, registerWorkflowPrompt, type PromptContext } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAPS_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "maps", guide: MAPS_GUIDE };

/**
 * Maps' one workflow prompt.
 *
 * It exists because "where was that place" spans three lists that hold the same
 * kind of thing for different reasons — a favourite is deliberate, a collection
 * entry is filed, a recent is incidental — and searching only one produces a
 * confident answer to a question nobody asked. The prompt also carries the
 * refusal: this server does not know about places the user has never saved, and
 * the most likely way to be wrong here is to answer anyway.
 */
export const registerPrompts = (server: McpServer): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_maps_where_was_that_place",
    title: "Find a place I saved",
    description:
      "Track down a saved place across favourites, Guides and recents — three lists that hold " +
      "places for different reasons. Read-only.",
    argsSchema: {
      about: promptArg('What the place was, e.g. "the ramen place near the office".'),
    },
    build: ({ about }) => `Find the saved place ${about ? `matching: ${about}` : "I am after"}.

Start with \`apple_maps_search_places\` — it covers favourites, Guide entries and
recents in one call, and tells you which kind each match came from. That
distinction is the answer, not a detail: a favourite is somewhere I chose to
keep, a recent is somewhere I merely looked at once.

If that finds nothing, list the three directly before concluding it is not
there — a place I saved under my own label ("Mum's") will not match a search for
what it actually is.

Then report what you found, with the address and how it was saved.

Three things to get right:
- If nothing matches, say I have not saved it. Do **not** fall back to guessing
  a place from general knowledge — this server only knows what is on this Mac,
  and inventing an address is the worst possible failure here.
- An entry with \`linked: false\` is an unconfigured Home/Work/School slot, not
  a place. Do not report it as one.
- If a date reads null, the date is unknown. Do not describe it as old.

If every list comes back empty, check \`cupertino://maps/diagnostics\` before
concluding I have saved nothing — this surface has no second lane, so a missing
Full Disk Access grant takes all of it at once.`,
  });
};
