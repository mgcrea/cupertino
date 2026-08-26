import {
  promptArg,
  registerWorkflowPrompt,
  requiredPromptArg,
  type PromptContext,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MESSAGES_GUIDE } from "./guide.js";

const CTX: PromptContext = { surface: "messages", guide: MESSAGES_GUIDE };

/**
 * Messages' workflow prompts.
 *
 * The send prompt carries the only genuinely irreversible action in this
 * bundle. Everywhere else a mistake leaves a draft, an extra reminder or a
 * wrong-looking event; here it puts words in someone's pocket under the user's
 * name, with no undo and no draft state to catch it.
 */
export const registerPrompts = (server: McpServer, allowWrites: boolean): void => {
  registerWorkflowPrompt(server, CTX, {
    name: "apple_messages_catch_up",
    title: "Catch up on a conversation",
    description:
      "Read back what has been said in a chat and what is waiting on a reply, with handles " +
      "resolved to names where that is actually possible. Read-only.",
    argsSchema: {
      chat: promptArg(
        "Who or which chat — a name, a handle, or a chat ref. Omit for recent chats.",
      ),
      since: promptArg('How far back, e.g. "yesterday", "last week". Defaults to recent history.'),
    },
    build: ({
      chat,
      since,
    }) => `Catch me up on ${chat ? `the conversation with ${chat}` : "my recent messages"}${
      since ? `, covering ${since}` : ""
    }.

1. \`apple_messages_list_chats\` to find ${
      chat
        ? "the right conversation. If several match, ask which rather than picking."
        : "what has been active."
    }
2. \`apple_messages_list_messages\` over that chat${since ? " with a date bound" : ""}.
3. Summarise what was actually said and, most importantly, **what is waiting on
   me** — a question asked and not answered is the thing worth surfacing.
4. Where a handle has no name, say so and show the handle raw. Do not guess who
   it is from context. If \`contacts.available\` is false in diagnostics, say that
   names could not be looked up at all — that is different from these people
   being unknown.

Ignore tapbacks as messages; they are reactions on the message they target and
a "liked" is not a reply. If the history appears to stop in early 2026, that is
the blob-storage change described in the guide, not the end of the conversation
— check \`textSource\` before reporting a gap.`,
  });

  if (!allowWrites) return;

  registerWorkflowPrompt(server, CTX, {
    name: "apple_messages_send",
    title: "Send a message",
    description:
      "Compose and send an iMessage or SMS. Requires writes. Sending is immediate and cannot be " +
      "undone — this prompt confirms the recipient before anything goes out.",
    argsSchema: {
      to: requiredPromptArg("Who to send to — a name, phone number or email address."),
      message: promptArg("What to say, or the gist of it. Omit to be asked."),
    },
    build: ({ to, message }) => `Send a message to ${to}.${
      message ? `\n\nWhat it should say: ${message}` : ""
    }

1. Work out the exact handle. \`apple_messages_list_chats\` to find an existing
   conversation with this person — an established chat is better evidence of the
   right handle than an address book match, because it is the one they actually
   reply on.
2. Read the last few messages in that chat. It tells you which language they
   write in, how formal they are, and whether something is already pending.
3. **Show the user the exact handle and the exact text, and wait for them to
   confirm.** There is no draft state here and no undo: the call sends. A
   message to the wrong handle cannot be recalled, and it is sent under the
   user's name.
4. On confirmation, \`apple_messages_send_message\`.
5. If the result says \`reconciliation: "pending"\`, **the message was sent.**
   Messages returns no identifier, so the sent row is found by re-reading the
   store and has not appeared yet. Do not retry — retrying sends it twice. Say
   it went out and that confirmation is lagging.`,
  });
};
