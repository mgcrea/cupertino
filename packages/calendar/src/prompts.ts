import {
  promptArg,
  registerWorkflowPrompt,
  requiredPromptArg,
  type PromptContext,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CALENDAR_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "calendar", guide: CALENDAR_GUIDE };

/**
 * Calendar's workflow prompts.
 *
 * The scheduling one carries the constraint that costs the most when it is
 * missed: this server can create an event but cannot invite anyone to it, so a
 * model that treats "schedule a meeting with Ana" as done has told the user
 * something false about a message that was never sent.
 */
export const registerPrompts = (server: McpServer, allowWrites: boolean): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_calendar_whats_my_day",
    title: "What my day looks like",
    description:
      "Read back a day or a range as something you can act on — what is fixed, what is " +
      "movable, and where the real free time is. Read-only.",
    argsSchema: {
      when: promptArg(
        'Which day or range, e.g. "today", "tomorrow", "next week". Defaults to today.',
      ),
      calendar: promptArg("Restrict to one calendar, exactly as Calendar spells it."),
    },
    build: ({ when, calendar }) => `Tell me what ${when ?? "today"} looks like${
      calendar ? `, on the ${calendar} calendar` : ""
    }.

1. \`apple_calendar_list_events\` over that range${
      calendar ? " for that calendar" : ""
    }. Bound the range explicitly — do not list open-endedly and trim afterwards.
2. Then \`apple_calendar_find_availability\` over the same range, so you can say
   where the usable gaps are rather than leaving the user to subtract meetings
   from a day in their head. Report each gap's real length.
3. Call out anything in \`allDayEvents\` — a holiday or someone's day off changes
   what the rest of the day means, and it does not block time by default.
4. Flag the pressure points: back-to-back blocks with no gap, anything starting
   before or ending after normal hours, and any two events that overlap.

If a call comes back \`degraded: true\`, say which part of the range you could not
read. An empty result means booked; degraded means unknown, and they must not be
reported the same way.`,
  });

  if (!allowWrites) return;

  registerWorkflowPrompt(server, CTX, {
    name: "apple_calendar_schedule",
    title: "Schedule something",
    description:
      "Find a time that genuinely works and put an event on the calendar. Requires writes. " +
      "Note that this cannot invite anyone — it creates the event only.",
    argsSchema: {
      what: requiredPromptArg('What the event is, e.g. "45 minutes with Ana about pricing".'),
      when: promptArg('Constraint on when, e.g. "next week", "Thursday afternoon".'),
      calendar: promptArg("Which calendar to create it on, exactly as Calendar spells it."),
    },
    build: ({ what, when, calendar }) => `Schedule: ${what}${when ? `\n\nWhen: ${when}` : ""}

1. Work out the duration from the description; ask if it is genuinely unclear
   rather than defaulting to an hour.
2. \`apple_calendar_find_availability\` over ${
      when ? `the window implied by "${when}"` : "the coming week"
    }. Do not list events and pick a gap yourself — a repeating meeting's
   occurrence is exactly what that misses.
3. Offer the user two or three real options before creating anything, with the
   full length of each gap so they can see whether it is tight. If availability
   comes back \`degraded: true\`, stop and say you could not check — do not offer
   a slot you could not verify.
4. On their choice, \`apple_calendar_create_event\`${
      calendar
        ? ` on the ${calendar} calendar`
        : " on a calendar from the inventory, not an invented name"
    }.

**Then be explicit about what did not happen: nobody was invited.** This server
has no \`attendees\` parameter on any tool — adding one would send mail, and it
deliberately cannot. If someone else needs to be at this, the event is on the
calendar and the invitation still has to be sent from Calendar by hand. Say so
plainly; do not let "scheduled with Ana" stand when Ana was never told.`,
  });
};
