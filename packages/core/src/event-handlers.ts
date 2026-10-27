import {
  McpServer,
  ProtocolError as SdkProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Era } from "./cli.js";
import {
  encodeCursor,
  EVENTS_ERRORS,
  EVENTS_EXTENSION_ID,
  resolveStart,
  scanEvents,
  type EventOccurrence,
  type EventTypeAdapter,
} from "./events.js";

/**
 * Serving the draft MCP Events extension (SEP-3415): `events/list` and
 * `events/poll` here, `events/stream` beside them in a later change.
 *
 * It is served on the modern era only. On a legacy instance nothing is declared
 * and nothing is registered, so every `events/*` method answers -32601 on its
 * own, which is what a client of that era should see.
 */

export type EventsOptions = {
  era: Era;
  // oxlint-disable-next-line typescript/no-explicit-any -- one list holds adapters over different row types
  adapters: EventTypeAdapter<any>[];
  /** What a poll result tells the client to wait before the next poll. Default 10000. */
  nextPollMs?: number;
  /** Heartbeat period of a stream, in ms. Default 25000. */
  heartbeatMs?: number;
  /** Concurrent streams allowed per connection. Default 10. */
  maxStreams?: number;
  /** The clock `maxAgeMs` is measured against. Default `Date.now`; a test seam. */
  now?: () => number;
};

const DEFAULT_NEXT_POLL_MS = 10_000;
const MAX_EVENTS = 50;
const SCAN_LIMIT = 1000;

const ListParams = z.looseObject({});
const ListResult = z.looseObject({});

const PollParams = z.looseObject({
  name: z.string(),
  arguments: z.unknown().optional(),
  cursor: z.string().nullable().optional(),
  maxEvents: z.number().optional(),
  maxAgeMs: z.number().int().min(0).optional(),
});
const PollResult = z.looseObject({});

/** `maxEvents` as the scan takes it: an integer in 1..50, 50 when absent. */
const clampMaxEvents = (n: number | undefined): number =>
  n === undefined || Number.isNaN(n)
    ? MAX_EVENTS
    : Math.min(MAX_EVENTS, Math.max(1, Math.trunc(n)));

/**
 * What a failed read of an event type becomes on the wire. A `ProtocolError` is
 * already what a client should see and passes through; anything else is an
 * internal error naming the event. Shared with `events/stream`, which sends the
 * same thing in `notifications/events/error`.
 */
export const readFailure = (name: string, err: unknown): SdkProtocolError => {
  if (err instanceof SdkProtocolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SdkProtocolError(
    ProtocolErrorCode.InternalError,
    `Could not read ${name} events: ${message}`,
  );
};

/**
 * Register `events/list` and `events/poll` on `server`. Call before `connect`.
 * The returned closer is for the connection's `onclose`; it has nothing to
 * release until streams exist.
 */
export const registerEvents = (server: McpServer, opts: EventsOptions): { close(): void } => {
  if (opts.era === "legacy") return { close: () => {} };

  const nextPollMs = opts.nextPollMs ?? DEFAULT_NEXT_POLL_MS;
  const now = opts.now ?? Date.now;
  const byName = new Map<string, (typeof opts.adapters)[number]>();
  for (const a of opts.adapters) {
    if (byName.has(a.descriptor.name)) {
      throw new Error(`Two event adapters are named "${a.descriptor.name}".`);
    }
    byName.set(a.descriptor.name, a);
  }

  server.server.registerCapabilities({ extensions: { [EVENTS_EXTENSION_ID]: {} } });

  server.server.setRequestHandler(
    "events/list",
    { params: ListParams, result: ListResult },
    () => ({
      events: opts.adapters.map((a) => a.descriptor),
    }),
  );

  server.server.setRequestHandler(
    "events/poll",
    { params: PollParams, result: PollResult },
    async (params) => {
      const adapter = byName.get(params.name);
      if (adapter === undefined) {
        throw new SdkProtocolError(
          EVENTS_ERRORS.NotFound,
          `No event named "${params.name}"; events/list says which exist.`,
          { kind: "event" },
        );
      }
      try {
        const filter = await adapter.parseArguments(params.arguments ?? {});
        // `ensure` first: `identity` and `source` read what it opens.
        await adapter.ensure();
        const store = adapter.identity();
        const start = resolveStart(params.cursor, store, adapter.source.head());
        // A null cursor means now, so there is no age to bound; `maxAgeMs` only
        // limits how far back a resumed cursor may reach.
        const floorMs =
          params.cursor !== null && params.cursor !== undefined && params.maxAgeMs !== undefined
            ? now() - params.maxAgeMs
            : undefined;
        const scan = scanEvents(adapter, filter, start.from, {
          maxEvents: clampMaxEvents(params.maxEvents),
          scanLimit: SCAN_LIMIT,
          floorMs,
        });
        // With no readable store there is nothing a cursor could name; leave the
        // client's position alone rather than invent one.
        const cursor = store === null ? (params.cursor ?? null) : encodeCursor(store, scan.cursor);
        const events: EventOccurrence[] = scan.rows.map((row) => ({
          ...adapter.occurrence(row),
          name: adapter.descriptor.name,
        }));
        return {
          events,
          cursor,
          truncated: start.truncated || scan.truncated,
          hasMore: scan.hasMore,
          nextPollMs,
        };
      } catch (err) {
        throw readFailure(adapter.descriptor.name, err);
      }
    },
  );

  return { close: () => {} };
};
