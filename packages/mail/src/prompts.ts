import {
  promptArg,
  registerWorkflowPrompt,
  requiredPromptArg,
  type PromptContext,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAIL_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "mail", guide: MAIL_GUIDE };

/**
 * Mail's workflow prompts.
 *
 * Each one exists because the ordering it encodes is not a property of any
 * single tool, so no tool description can hold it: triage is "search, never
 * page"; finding a thread is "cheap filters before the expensive body lane";
 * replying is "read the thread first, and a body-less reply tool leaves a blank
 * page". All three are rebuilt from scratch by every model in every session
 * otherwise.
 */
export const registerPrompts = (server: McpServer, allowWrites: boolean): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_mail_triage",
    title: "Triage a mailbox",
    description:
      "Work through what arrived and report what needs a human: who is waiting, what is " +
      "committed to, what can be ignored. Read-only — it proposes, it does not file or reply.",
    argsSchema: {
      mailbox: promptArg('Mailbox to triage, e.g. "INBOX". Omit for the default inbox.'),
      account: promptArg("Account display name or UUID. Omit to span every visible account."),
      since: promptArg("ISO date lower bound, e.g. 2026-08-18. Omit for the last 7 days."),
    },
    build: ({
      mailbox,
      account,
      since,
    }) => `Triage ${mailbox ? `the ${mailbox} mailbox` : "the inbox"}${
      account ? ` on the ${account} account` : ""
    }, covering ${since ? `everything since ${since}` : "the last 7 days"}.

1. Call \`apple_mail_search_messages\` with a \`dateFrom\` bound${
      mailbox ? ` and \`mailbox\`` : ""
    }. Do not page \`apple_mail_list_messages\` — the index is what makes this fast.
2. Group by sender and thread. Use \`apple_mail_get_thread\` where a subject
   recurs, so a five-message exchange is read once, not five times.
3. Sort into: **needs a reply from me**, **waiting on someone else**, **for
   information**, **ignorable**. Put anything with a date or a commitment in it
   at the top, and say what the commitment is.
4. Read bodies only for the messages that reach the first two groups. Subjects
   and senders decide the other two.

Report what you found. Do not flag, move, delete or reply to anything — if an
action looks obviously right, propose it and let the user say yes.

If any call comes back \`degraded: true\`, stop and say which mailbox you could
not read and why. An unread index is not an empty inbox.`,
  });

  registerWorkflowPrompt(server, CTX, {
    name: "apple_mail_find_thread",
    title: "Find a thread about something",
    description:
      "Track down a conversation from a vague description — a project name, a person, something " +
      "half-remembered — spending the cheap search lanes before the expensive body lane.",
    argsSchema: {
      about: requiredPromptArg(
        'What the thread is about, in whatever words the user used, e.g. "the Atlas pricing thread".',
      ),
      since: promptArg("ISO date lower bound, if the user knows roughly when. Omit if not."),
    },
    build: ({ about, since }) => `Find the mail thread about: ${about}${
      since ? `\n\nThe user thinks it was on or after ${since}.` : ""
    }

Spend the cheap lanes first — each of these reads the index, so run them before
touching any message body:

1. \`apple_mail_search_messages\` with \`query\` (subject and sender) for the
   distinctive words. Proper nouns beat common ones.
2. If that misses, try \`subject\` alone, then \`sender\` if the description names
   a person${since ? ", always with `dateFrom`" : ""}.
3. Only if steps 1–2 come up empty, use \`body\` — and **only with a narrowing
   filter alongside it**${
     since ? " (you have a date, so use it)" : " (a mailbox, a sender, or a date bound)"
   }. Without one it will refuse rather than answer from a partial scan, and
   that refusal is not "no results".

When you have a candidate, call \`apple_mail_get_thread\` on it and summarise the
exchange: who said what, what was decided, what is outstanding.

If several threads match, list them with dates and participants and ask which
one — do not pick for the user.`,
  });

  if (!allowWrites) return;

  registerWorkflowPrompt(server, CTX, {
    name: "apple_mail_draft_reply",
    title: "Draft a reply",
    description:
      "Read a thread properly, then leave a written draft in Mail for review. Never sends: the " +
      "draft waits for a human. Requires writes to be enabled.",
    argsSchema: {
      ref: promptArg("Message ref to reply to, from a search or list result. Omit to find it."),
      about: promptArg("If no ref: what the thread is about, so it can be found first."),
      instruction: promptArg(
        'What the reply should say or do, e.g. "accept, propose Thursday instead".',
      ),
    },
    build: ({ ref, about, instruction }) => `Draft a reply${
      ref ? ` to ${ref}` : about ? ` to the thread about: ${about}` : ""
    }.${instruction ? `\n\nWhat it should say: ${instruction}` : ""}

${
  ref
    ? `1. Read the full exchange with \`apple_mail_get_thread\` before writing a word.`
    : `1. Find the thread first — \`apple_mail_search_messages\` on subject and sender, body only
   with a narrowing filter — then read it in full with \`apple_mail_get_thread\`.
   If more than one thread matches, ask which before drafting.`
}
2. Match how this correspondent is actually written to: the greeting, the
   sign-off, the length, whether contractions appear. Read the user's own
   earlier messages in the thread for that, not just the incoming one.
3. Answer every question that was actually asked. A reply that addresses the
   last paragraph and drops the other three is the common failure here.
4. Call \`apple_mail_reply_to_message\` **with a \`body\`**. Calling it without one
   leaves an empty draft with the original quoted underneath — a blank page,
   which must never be reported as a written reply.
5. Leave \`sendNow\` at its default. This produces a draft in Mail; a human
   decides whether it goes.

Then tell the user what you drafted and what you assumed, so they can correct
it before sending.`,
  });
};
