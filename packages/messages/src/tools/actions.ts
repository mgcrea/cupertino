import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PreconditionError } from "../client/errors.js";
import type { AppleMessagesClient } from "../client/messages.js";
import { confirmArg, wrap } from "./util.js";

/**
 * The one mutating tool, registered only when `allowWrites` is on.
 *
 * Never merely refused at call time: an MCP client caches the tool list, so a
 * tool that exists and says no is a tool the model will keep trying. With writes
 * off this file is not reached and the send tool does not exist.
 *
 * ## One verb, because the dictionary has one
 *
 * `sdef /System/Applications/Messages.app` lists three commands — `send`,
 * `login`, `logout`. There is no edit, no delete, no mark-as-read, no typing
 * indicator, and no reaction: everything else this server can show you, it
 * cannot change. `login`/`logout` are not exposed because logging a user out of
 * iMessage across every device is not something to do behind a tool call.
 *
 * `send`'s direct parameter is typed `file` OR `text` in the dictionary, and
 * only the text form ships. See `client/jxa/core.ts` for why.
 */

const SIDE_EFFECT =
  "This sends a REAL message from the user's own iMessage/SMS account, immediately and " +
  "irreversibly. There is no unsend, no draft and no preview: the recipient's phone buzzes as " +
  "soon as this returns. Messages may be launched to do it, which the user will see. Confirm the " +
  "exact wording and the exact recipient with the user before calling this.";

export const registerActionTools = (server: McpServer, client: AppleMessagesClient): void => {
  server.registerTool(
    "apple_messages_send_message",
    {
      description:
        "Send a message to an existing conversation or to a phone number / email address. " +
        SIDE_EFFECT +
        " Prefer chatRef from apple_messages_list_chats over a raw handle: Messages refuses to " +
        "enumerate participants for a script, so an existing conversation is the only target " +
        "this server can address reliably — a handle with no conversation on this Mac will " +
        "usually fail rather than start a new thread. The result reports which targeting " +
        "strategy worked, and reconciles against the message store to hand back a real message " +
        "ref: reconciliation `matched` means the sent row was found and `message` is it, " +
        "`pending` means Messages accepted the send but has not written the row yet (normal on a " +
        "slow network — read the chat back, do NOT send again), and `unavailable` means there " +
        "was no existing chat to look in.",
      inputSchema: {
        chatRef: z
          .string()
          .optional()
          .describe(
            'An opaque chat ref from apple_messages_list_chats ("mc1:<guid>"). The reliable ' +
              "way to target a send. Do not construct one by hand.",
          ),
        to: z
          .string()
          .optional()
          .describe(
            "A phone number or email address, when there is no chat ref. Matched against the " +
              "store's own handles by last-9-digits, so local and international spellings of " +
              "the same number both work.",
          ),
        text: z.string().min(1).describe("Exactly what to send. Sent verbatim."),
        service: z
          .enum(["imessage", "sms", "rcs"])
          .optional()
          .describe(
            "Which service to prefer when addressing a handle with no existing chat. Ignored " +
              "when chatRef is given, since the chat already knows its service.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ chatRef, to, text, service }) =>
      wrap(async () => {
        // Both, or neither, is a caller error rather than something to guess at:
        // guessing here sends a real message to the wrong person.
        if (Boolean(chatRef) === Boolean(to)) {
          throw new PreconditionError(
            "Give exactly one of chatRef or to. chatRef targets an existing conversation and is " +
              "the reliable form; to addresses a phone number or email directly.",
          );
        }
        return client.sendMessage({
          ...(chatRef ? { chatRef } : {}),
          ...(to ? { to } : {}),
          ...(service ? { service } : {}),
          text,
        });
      }),
  );
};
