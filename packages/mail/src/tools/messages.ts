import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMailClient } from "../client/mail.js";
import { messageRefArg, wrap } from "./util.js";

/**
 * Reading one message.
 *
 * `get_message` and `get_message_source` are deliberately separate tools. A
 * routine read should not drag two megabytes of base64 attachment and forty
 * Received: headers into the conversation; when you actually need those — chasing
 * a spoofed sender, say — you ask for them explicitly.
 */
export const registerMessageTools = (
  server: McpServer,
  client: AppleMailClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "apple_mail_get_message",
    {
      description:
        "Read one message: decoded headers, the plain-text body, and a list of its attachments. " +
        "HTML-only mail is converted to text. Long bodies are truncated with an explicit marker " +
        "rather than silently cut. Reads the message file directly when Full Disk Access allows, " +
        "and otherwise asks Mail, which is slower but works — so this tool does not need the " +
        "search index.",
      inputSchema: {
        ref: messageRefArg,
        maxBodyBytes: z
          .number()
          .int()
          .min(256)
          .max(2_000_000)
          .optional()
          .describe("Override the body truncation limit for this call."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, maxBodyBytes }) =>
      wrap(async () => {
        const { message, parsed, source, fallbackReason } = await client.getMessageBody(
          ref,
          maxBodyBytes ? { maxBodyBytes } : {},
        );

        if (!parsed) {
          // AppleScript fallback: Mail hands back display text, not MIME, so
          // there is no attachment manifest to report here.
          return {
            ref: message.ref,
            source,
            subject: message.subject,
            sender: message.sender,
            dateReceived: message.dateReceived,
            read: message.read,
            flagged: message.flagged,
            body: message.content ?? "",
            // The reason comes from an actual lookup rather than a fixed guess.
            // The old text always blamed Full Disk Access, which sent people to
            // a setting that was already correct whenever the real cause was a
            // mailbox path we failed to resolve.
            note:
              "Body came from Mail rather than the message file, so attachment details are not " +
              `available. ${fallbackReason ?? ""}`.trimEnd(),
          };
        }

        return {
          ref: message.ref,
          source,
          headers: parsed.headers,
          subject: message.subject ?? parsed.headers.subject,
          sender: message.sender ?? parsed.headers.from,
          dateReceived: message.dateReceived,
          read: message.read,
          flagged: message.flagged,
          bodyFrom: parsed.bodyFrom,
          truncated: parsed.truncated,
          body: parsed.body,
          attachments: parsed.attachments,
          // Derive the note from what was actually found, not from the file
          // layout. Keying it on `partial` alone produced a note saying sizes
          // read as 0 beside an attachment reporting 1 byte and inline: true.
          ...(parsed.attachments.some((a) => !a.inline)
            ? {
                note:
                  "Some attachments are stored outside this message file, so their sizes are " +
                  "unknown and apple_mail_save_attachment cannot retrieve them. Open the message " +
                  "in Mail to download them first.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "apple_mail_get_message_source",
    {
      description:
        "Get the raw RFC 5322 source of a message — every header and the undecoded body. Use this " +
        "for header forensics (Received chains, SPF/DKIM/DMARC results, List-Unsubscribe), not for " +
        "reading mail: apple_mail_get_message gives you the readable version without the noise. " +
        "Capped and pageable via offset.",
      inputSchema: {
        ref: messageRefArg,
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Byte offset to start from. Default 0."),
        maxBytes: z
          .number()
          .int()
          .min(256)
          .max(1_000_000)
          .optional()
          .describe("How many bytes to return. Default 32768."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ref, offset, maxBytes }) =>
      wrap(async () =>
        client.getMessageSource(ref, { offset: offset ?? 0, maxBytes: maxBytes ?? 32_768 }),
      ),
  );

  server.registerTool(
    "apple_mail_list_attachments",
    {
      description:
        "List a message's attachments: filename, MIME type, size and whether the bytes are present " +
        "locally. Metadata only — it never returns file contents. A size of 0 with a filename means " +
        "Mail stored the attachment outside the message file, which is normal.",
      inputSchema: { ref: messageRefArg },
      annotations: { readOnlyHint: true },
    },
    async ({ ref }) =>
      wrap(async () => {
        const { parsed, source, fallbackReason } = await client.getMessageBody(ref, {
          maxBodyBytes: 1024,
        });
        if (!parsed) {
          return {
            degraded: true,
            capability: "message-file",
            reason:
              "The message file was not read, and Mail's scripting interface does not expose a " +
              `MIME attachment manifest. ${fallbackReason ?? ""}`.trimEnd(),
            hint: "See the `messageFile` section of apple_mail_diagnostics, which probes this lane.",
          };
        }
        return { ref, source, count: parsed.attachments.length, attachments: parsed.attachments };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "apple_mail_save_attachment",
    {
      description:
        "Save one attachment to disk. It can only write into APPLE_MAIL_ATTACHMENT_DIR (default " +
        "~/Downloads) and will not overwrite an existing file unless you ask it to. Write-gated " +
        "because it puts a file on the user's disk, even though it changes nothing in Mail.",
      inputSchema: {
        ref: messageRefArg,
        filename: z.string().min(1).describe("Exact filename from apple_mail_list_attachments."),
        overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ref, filename, overwrite }) =>
      wrap(async () => client.saveAttachment(ref, filename, overwrite ? { overwrite } : {})),
  );
};
