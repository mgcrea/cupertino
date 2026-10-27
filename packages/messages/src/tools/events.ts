import {
  isoMs,
  occurrenceTimestamp,
  parseSenderArgs,
  type EventTypeAdapter,
} from "@mgcrea/mcp-apple-core";
import { z } from "zod";

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

  parseArguments: (args) =>
    parseSenderArgs("messages.received", Args, args, {
      open: () => service.ensure(),
      resolve: async ({ from, domains }) => {
        // `unresolved` handles are kept: a poll result has nowhere to report them.
        const resolved = service.resolveFrom(from ?? []).from;
        return {
          ...(resolved.length > 0 ? { from: resolved } : {}),
          ...(domains ? { domains } : {}),
        };
      },
    }),

  occurrence: (row) => ({
    eventId: row.key,
    timestamp: occurrenceTimestamp(row.date),
    data: { id: row.id, chat: row.chat, handle: row.handle, date: row.date },
  }),

  timestampMs: (row) => isoMs(row.date),

  source: service.source,
  ensure: () => service.refresh(),
  identity: () => service.identity(),
  startTrigger: (onChange) => service.startTrigger(onChange),
});
