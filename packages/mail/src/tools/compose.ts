import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMailClient } from "../client/mail.js";
import { confirmArg, messageRefArg, wrap } from "./util.js";

/**
 * Composing and sending.
 *
 * Sending is the only action in this server that is irreversible AND visible to
 * other people, so it carries two independent gates rather than one:
 *
 *   1. `APPLE_MAIL_ALLOW_WRITES` must be on, or these tools do not exist.
 *   2. `sendNow` defaults to FALSE, which leaves the draft open in Mail for a
 *      human to read. Setting it to true additionally requires `confirm: true`.
 *
 * The default is the important half. An agent that drafts is useful and safe;
 * an agent that sends is neither by default.
 */

const sendNowArg = z
  .boolean()
  .optional()
  .describe(
    "Send immediately instead of leaving a draft. Defaults to FALSE, which opens the message in " +
      "Mail for a human to review and send. When true, confirm must also be true.",
  );

const bodyArg = z.string().min(1).describe("Plain text body.");

const recipientsArg = (kind: string) =>
  z.array(z.string().email()).optional().describe(`${kind} email addresses.`);

/** Reject sendNow without confirm before anything reaches Mail. */
const assertSendGate = (sendNow: boolean | undefined, confirm: boolean | undefined): void => {
  if (sendNow && confirm !== true) {
    throw new Error(
      "Refusing to send: sendNow is true but confirm is not. Sending mail is irreversible and " +
        "visible to the recipient, so it needs an explicit confirm: true. Omit sendNow to leave a " +
        "draft open for review instead.",
    );
  }
};

export const registerComposeTools = (server: McpServer, client: AppleMailClient): void => {
  server.registerTool(
    "apple_mail_send_message",
    {
      description:
        "Compose a new message. By DEFAULT this does not send: it opens a draft in Mail for the " +
        "user to review, which is almost always what you want. Only pass sendNow: true (with " +
        "confirm: true) when the user has explicitly asked for the mail to go out now.",
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe("Account to send from, by name or UUID. Defaults to Mail's default account."),
        to: recipientsArg("To"),
        cc: recipientsArg("Cc"),
        bcc: recipientsArg("Bcc"),
        subject: z.string().describe("Subject line."),
        body: bodyArg,
        sendNow: sendNowArg,
        confirm: z.literal(true).optional().describe("Required when sendNow is true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ account, to, cc, bcc, subject, body, sendNow, confirm }) =>
      wrap(async () => {
        assertSendGate(sendNow, confirm);
        if (!to?.length && !cc?.length && !bcc?.length) {
          throw new Error("No recipients: pass at least one of to, cc or bcc.");
        }
        return client.sendMessage({
          ...(account ? { account } : {}),
          to: to ?? [],
          cc: cc ?? [],
          bcc: bcc ?? [],
          subject,
          body,
          sendNow: sendNow ?? false,
        });
      }),
  );

  server.registerTool(
    "apple_mail_reply_to_message",
    {
      description:
        "Reply to a message. By default it opens a draft in Mail with the original quoted beneath " +
        "your text, for the user to review. Pass replyToAll to include every original recipient. " +
        "Only pass sendNow: true (with confirm: true) when explicitly asked to send now. " +
        "Success means the body was read back out of the composer window and matched; an error " +
        "means the draft is EMPTY and must not be described to the user as ready. Filling the " +
        "composer brings Mail to the front for a moment and borrows the clipboard, both of which " +
        "are put back.",
      inputSchema: {
        ref: messageRefArg,
        body: bodyArg,
        replyToAll: z
          .boolean()
          .optional()
          .describe("Reply to every recipient, not just the sender."),
        sendNow: sendNowArg,
        confirm: z.literal(true).optional().describe("Required when sendNow is true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ ref, body, replyToAll, sendNow, confirm }) =>
      wrap(async () => {
        assertSendGate(sendNow, confirm);
        return client.replyOrForward(ref, {
          mode: "reply",
          body,
          replyToAll: replyToAll ?? false,
          sendNow: sendNow ?? false,
        });
      }),
  );

  server.registerTool(
    "apple_mail_forward_message",
    {
      description:
        "Forward a message to new recipients. By default it opens a draft in Mail for review. " +
        "Only pass sendNow: true (with confirm: true) when explicitly asked to send now. " +
        "When a note is given, success means it was read back out of the composer window and " +
        "matched. Filling the composer brings Mail to the front for a moment and borrows the " +
        "clipboard, both of which are put back.",
      inputSchema: {
        ref: messageRefArg,
        to: z.array(z.string().email()).min(1).describe("Who to forward to."),
        body: z.string().optional().describe("Optional note to add above the forwarded message."),
        sendNow: sendNowArg,
        confirm: z.literal(true).optional().describe("Required when sendNow is true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ ref, to, body, sendNow, confirm }) =>
      wrap(async () => {
        assertSendGate(sendNow, confirm);
        return client.replyOrForward(ref, {
          mode: "forward",
          to,
          ...(body ? { body } : {}),
          sendNow: sendNow ?? false,
        });
      }),
  );

  server.registerTool(
    "apple_mail_update_draft",
    {
      description:
        "Replace the body of an unsent draft. Mail has no way to edit a saved draft — its " +
        "`content` is read-only and there is no open or edit command — so this RECREATES it: a " +
        "new draft with the same recipients and a new body, and the old one deleted once the " +
        "replacement is confirmed present. The ref you passed in is DEAD afterwards and the " +
        "result carries the new one. " +
        "It REFUSES rather than doing damage, and returns `replaced: false` with a reason when " +
        "it does: on a reply or forward draft, because In-Reply-To is set by Mail's reply " +
        "command and a recreated one would silently start a new thread; on a draft carrying " +
        "attachments, because they cannot be re-attached; and on anything that is not in the " +
        "Drafts mailbox, because deleting a sent or received message and writing a lookalike is " +
        "not editing. In every refusal the original is untouched. If the replacement cannot be " +
        "confirmed the original is KEPT and you are told there are now two — never assume a " +
        "clean swap without reading `replaced`.",
      inputSchema: {
        ref: messageRefArg,
        body: z
          .string()
          .min(1)
          .describe(
            "The complete new body. This REPLACES the draft's text rather than appending to it, " +
              "so include everything that should remain — read the draft first with " +
              "apple_mail_get_message if you are editing rather than rewriting.",
          ),
        subject: z
          .string()
          .optional()
          .describe(
            "A new subject. Defaults to the draft's existing one. A draft with no subject at " +
              "all is refused unless you pass one, because the subject is how the replacement " +
              "is found again before the original is deleted.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ ref, body, subject }) =>
      wrap(async () => client.updateDraft(ref, { body, ...(subject ? { subject } : {}) })),
  );
};

export { assertSendGate };
