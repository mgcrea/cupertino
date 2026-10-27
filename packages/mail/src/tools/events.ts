import { normalizeFilter, type EventTypeAdapter, type WatchFilter } from "@mgcrea/mcp-apple-core";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "../client/errors.js";
import type { MailArrival } from "../client/watch.js";
import type { MailWatchService } from "./watch.js";

/**
 * Mail's `mail.received` event type for the draft MCP Events extension.
 *
 * It is an adapter over a `MailWatchService`, the same store handle and lookup a
 * watch reads. The service handed over must be its own, never one bound to a
 * watch registry: events and watches then keep separate handles on the index and
 * both are closed with the connection.
 */

const Args = z.object({
  from: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
  mailboxes: z.array(z.string().min(1)).max(20).optional(),
});

const invalidParams = (message: string): ProtocolError =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, message);

export const mailEventAdapter = (service: MailWatchService): EventTypeAdapter<MailArrival> => ({
  descriptor: {
    name: "mail.received",
    description:
      "New mail from chosen senders. Give `from` (exact addresses) and/or `domains` (matches " +
      "the domain and its subdomains); a sender is required. Envelope only, so fetch a body " +
      "with apple_mail_get_message. Sent, Drafts, Junk and Trash and your own addresses never " +
      "match. Needs Full Disk Access, and Mail has to be running for mail to arrive.",
    delivery: ["poll", "push"],
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Exact sender addresses, case-insensitive.",
        },
        domains: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Sender domains, e.g. acme.com. Matches @acme.com and any subdomain.",
        },
        mailboxes: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: 20,
          description:
            "Only mail in these mailboxes, named as in apple_mail_list_mailboxes. Omit for every " +
            "mailbox except Sent, Drafts, Junk and Trash.",
        },
      },
      anyOf: [{ required: ["from"] }, { required: ["domains"] }],
    },
    payloadSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        mailbox: { type: "string" },
        senderAddress: { type: ["string", "null"] },
        senderName: { type: ["string", "null"] },
        subject: { type: ["string", "null"] },
        dateReceived: { type: ["string", "null"] },
      },
      required: ["ref", "mailbox", "senderAddress", "senderName", "subject", "dateReceived"],
    },
  },

  async parseArguments(args: unknown): Promise<WatchFilter> {
    const parsed = Args.safeParse(args ?? {});
    if (!parsed.success) {
      throw invalidParams(
        `Invalid arguments for mail.received: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const { from, domains, mailboxes } = parsed.data;
    const sender = { ...(from ? { from } : {}), ...(domains ? { domains } : {}) };
    // The caller's own mistakes first, without touching the index: an empty
    // filter is InvalidParams whatever state the index is in.
    try {
      normalizeFilter(sender);
    } catch (err) {
      if (err instanceof PreconditionError) throw invalidParams(err.message);
      throw err;
    }
    // Opening the index is not the client's mistake, so it stays outside the wrap.
    await service.ensure();
    try {
      const scope = await service.resolveMailboxScope(mailboxes ?? []);
      return normalizeFilter({ ...sender, scope });
    } catch (err) {
      if (err instanceof PreconditionError) throw invalidParams(err.message);
      throw err;
    }
  },

  occurrence: (row) => ({
    eventId: row.key,
    timestamp: row.dateReceived ?? "",
    data: {
      ref: row.ref,
      mailbox: row.mailbox,
      senderAddress: row.senderAddress,
      senderName: row.senderName,
      subject: row.subject,
      dateReceived: row.dateReceived,
    },
  }),

  timestampMs: (row) => {
    if (row.dateReceived === null) return null;
    const ms = Date.parse(row.dateReceived);
    return Number.isNaN(ms) ? null : ms;
  },

  source: service.source,
  ensure: () => service.ensure(),
  identity: () => service.identity(),
  startTrigger: (onChange) => service.startTrigger(onChange),
});
