import {
  promptArg,
  registerWorkflowPrompt,
  requiredPromptArg,
  type PromptContext,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { REMINDERS_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "reminders", guide: REMINDERS_GUIDE };

/**
 * Reminders' workflow prompts.
 *
 * The capture prompt is the reason this file exists. Turning a thread into
 * reminders is the single most requested thing on this surface and the single
 * easiest to get wrong: run it twice over the same source and you have two of
 * everything, because no tool here deduplicates and no tool description is the
 * right place to say so.
 */
export const registerPrompts = (server: McpServer, allowWrites: boolean): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_reminders_whats_due",
    title: "What's due",
    description:
      "Report what is actually outstanding across the lists, separating overdue from upcoming " +
      "and from undated. Read-only — it does not complete or reschedule anything.",
    argsSchema: {
      window: promptArg('How far ahead to look, e.g. "today", "this week". Defaults to 7 days.'),
      list: promptArg("Restrict to one list, exactly as Reminders spells it. Omit for all."),
    },
    build: ({ window, list }) => `Tell me what is due${
      window ? ` ${window}` : " over the next 7 days"
    }${list ? `, in the ${list} list` : ""}.

1. ${
      list
        ? `Confirm the ${list} list exists via \`apple_reminders_list_lists\` — a name that does not match returns nothing, which reads as an empty list.`
        : "`apple_reminders_list_lists` first, so you know what you are covering."
    }
2. \`apple_reminders_list_reminders\` with \`completed: false\` and a date bound.
   Do not page everything and filter afterwards.
3. Separate into **overdue**, **due in the window**, and **undated**. The
   undated group matters: it is where things go to be forgotten, so surface the
   oldest few rather than dropping them.
4. Where a reminder has subtasks, say how many are outstanding — a parent that
   looks like one item can be six.

Report it as a list someone can act on, ordered by when it is due. Do not
complete, reschedule or move anything.`,
  });

  if (!allowWrites) return;

  registerWorkflowPrompt(server, CTX, {
    name: "apple_reminders_capture_action_items",
    title: "Capture action items as reminders",
    description:
      "Turn a thread, a meeting or a note into reminders — checking what already exists first, " +
      "because re-running this over the same source is how duplicates happen. Requires writes.",
    argsSchema: {
      source: requiredPromptArg(
        'What to extract from, e.g. "yesterday\'s thread with the Atlas client".',
      ),
      list: promptArg("Which list to file them under, exactly as Reminders spells it."),
      due: promptArg(
        'When they are due, e.g. "Friday". Applied to all unless the source says otherwise.',
      ),
    },
    build: ({ source, list, due }) => `Capture the action items from: ${source}

1. Extract only what is genuinely **mine to do**. Something the other person
   committed to is not my action item; note it separately if it matters, but do
   not create a reminder for it.
2. **Check what already exists before creating anything.**
   \`apple_reminders_search_reminders\` for each item's distinctive words${
     list ? `, scoped to the ${list} list` : ""
   }. If this source has been captured before, the reminders are already there
   and a second set is worse than none. Nothing here deduplicates for you.
3. ${
      list
        ? `Confirm the ${list} list exists with \`apple_reminders_list_lists\` — creating into a mistyped name does not fail loudly.`
        : "Pick a list from `apple_reminders_list_lists` rather than inventing one."
    }
4. Create one reminder per action, with \`apple_reminders_create_reminder\`. Title
   it as the thing to do, starting with a verb — not as the topic it came from.
   Put the context and the source in the notes body so it still makes sense in a
   month.${due ? `\n5. Set all of them due ${due} unless the source names a specific date for one, in which case use that.` : "\n5. Set a due date where the source names one. Leave the rest undated rather than inventing deadlines."}

Then list what you created and what you deliberately skipped, so the user can
tell you missed nothing.`,
  });
};
