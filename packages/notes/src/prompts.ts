import {
  promptArg,
  registerWorkflowPrompt,
  requiredPromptArg,
  type PromptContext,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { NOTES_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "notes", guide: NOTES_GUIDE };

/**
 * Notes' workflow prompts. Both encode an ordering no single tool description
 * can hold: search results are summaries and must be opened before they are
 * quoted, and a capture must look before it writes or it makes a duplicate.
 */
export const registerPrompts = (server: McpServer, allowWrites: boolean): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_notes_find",
    title: "Find notes about something",
    description:
      "Search the note library for everything on a topic and summarise what is actually written " +
      "there — opening the notes rather than answering from titles.",
    argsSchema: {
      about: requiredPromptArg('What to look for, e.g. "the Atlas pricing decision".'),
      folder: promptArg("Restrict to one folder, exactly as Notes spells it. Omit to span all."),
    },
    build: ({ about, folder }) => `Find what my notes say about: ${about}${
      folder ? `\n\nRestrict this to the ${folder} folder.` : ""
    }

1. \`apple_notes_search_notes\` for the distinctive words${
      folder ? ", scoped to that folder" : ""
    }. Try more than one phrasing before concluding there is nothing — these are
   personal notes, so the user's own shorthand is often what is written.
2. **Open the promising ones with \`apple_notes_get_note\`.** Search returns
   summaries; a title tells you a note exists, not what it says. Never quote or
   summarise a note you have only seen the title of.
3. Synthesise across the notes rather than listing them one by one. Say what was
   decided, what is still open, and where the notes contradict each other — that
   last one is usually the useful part.

Report any locked note you hit by name and say it is password-protected. It is
not empty, and nothing available here can open it.`,
  });

  if (!allowWrites) return;

  registerWorkflowPrompt(server, CTX, {
    name: "apple_notes_capture",
    title: "Capture something into Notes",
    description:
      "Write something into the note library, checking first whether it belongs in a note that " +
      "already exists. Requires writes to be enabled.",
    argsSchema: {
      what: requiredPromptArg("What to capture — the content, or where to get it from."),
      folder: promptArg("Folder to file it under, exactly as Notes spells it."),
    },
    build: ({ what, folder }) => `Capture this into Notes: ${what}

1. **Search first.** \`apple_notes_search_notes\` for the subject. A running note
   on this topic probably already exists, and a second one is worse than a
   longer first one.
2. If one exists, read it in full with \`apple_notes_get_note\`, then write back
   the existing content plus the new material with \`apple_notes_update_note\`.
   That tool **replaces** the body — send the whole note, not the addition, or
   you will delete everything that was there.
3. If nothing exists, \`apple_notes_create_note\`${folder ? ` in the ${folder} folder` : ""}. ${
      folder
        ? "Confirm that folder exists with `apple_notes_list_folders` first — a name that does not match is not created for you."
        : "Pick a folder from `apple_notes_list_folders` rather than inventing one."
    }
4. Give it a title someone would search for in six months, not a timestamp.

Tell the user which note you wrote to and whether it was new or extended.`,
  });
};
