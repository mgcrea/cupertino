import { normalizeFilter, type EventTypeAdapter, type WatchFilter } from "@mgcrea/mcp-apple-core";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "../client/errors.js";
import type { MessageArrival } from "../client/watch.js";
import type { MessagesWatchService } from "./watch.js";

/**
 * Messages' `messages.received` event type for the draft MCP Events extension.
 *
 * It is an adapter over a `MessagesWatchService`, the same store handle, handle
 * resolution and trigger a watch uses. The service handed over must be its own,
 * never one bound to a watch registry: events and watches then keep separate
 * handles on chat.db and both are closed with the connection.
 */

const Args = z.object({
  from: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
});

const invalidParams = (message: string): ProtocolError =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, message);

export const messagesEventAdapter = (
  service: MessagesWatchService,
): EventTypeAdapter<MessageArrival> => ({
  descriptor: {
    name: "messages.received",
    description:
      "New messages from chosen handles. Give `from` (email addresses, or phone numbers in " +
      "international form such as +33612345678) and/or `domains` (email handles only; matches " +
      "the domain and its subdomains); a sender is required. Metadata only, so fetch the text " +
      "with apple_messages_get_message and the `id`. Your own messages and tapbacks never " +
      "match. Needs Full Disk Access; Messages does not have to be running.",
    delivery: ["poll", "push"],
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "Email addresses, or phone numbers in international form (+33612345678: no trunk 0, " +
            "no (0)); spaces and punctuation are ignored, but a local spelling like 06 12 34 56 " +
            "78 never matches. An entry the store does not hold is kept without spaces or " +
            "punctuation, lowercased: it fires only if the store later holds exactly that spelling.",
        },
        domains: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "Email domains, e.g. acme.com. Matches only email handles, never a phone number.",
        },
      },
      anyOf: [{ required: ["from"] }, { required: ["domains"] }],
    },
    payloadSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        chat: { type: ["string", "null"] },
        handle: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
      },
      required: ["id", "chat", "handle", "date"],
    },
  },

  async parseArguments(args: unknown): Promise<WatchFilter> {
    const parsed = Args.safeParse(args ?? {});
    if (!parsed.success) {
      throw invalidParams(
        `Invalid arguments for messages.received: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const { from, domains } = parsed.data;
    const typed = { ...(from ? { from } : {}), ...(domains ? { domains } : {}) };
    // The caller's own mistakes first, without touching the store: an empty
    // filter is InvalidParams whatever state chat.db is in.
    try {
      normalizeFilter(typed);
    } catch (err) {
      if (err instanceof PreconditionError) throw invalidParams(err.message);
      throw err;
    }
    // Opening the store is not the client's mistake, so it stays outside the wrap.
    await service.ensure();
    try {
      // `unresolved` handles are kept: a poll result has nowhere to report them.
      const resolved = service.resolveFrom(from ?? []).from;
      return normalizeFilter({
        ...(resolved.length > 0 ? { from: resolved } : {}),
        ...(domains ? { domains } : {}),
      });
    } catch (err) {
      if (err instanceof PreconditionError) throw invalidParams(err.message);
      throw err;
    }
  },

  occurrence: (row) => ({
    eventId: row.key,
    timestamp: row.date ?? "",
    data: { id: row.id, chat: row.chat, handle: row.handle, date: row.date },
  }),

  timestampMs: (row) => {
    if (row.date === null) return null;
    const ms = Date.parse(row.date);
    return Number.isNaN(ms) ? null : ms;
  },

  source: service.source,
  ensure: () => service.ensure(),
  identity: () => service.identity(),
  startTrigger: (onChange) => service.startTrigger(onChange),
});
