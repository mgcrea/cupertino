import { setImmediate as nextTurn } from "node:timers/promises";

import {
  McpServer,
  ProtocolError as SdkProtocolError,
  ProtocolErrorCode,
  SUBSCRIPTION_ID_META_KEY,
  type RequestId,
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
import { sameFile, type FileIdentity, type WatchFilter } from "./watches.js";

/**
 * Serving the draft MCP Events extension (SEP-3415): `events/list`,
 * `events/poll` and `events/stream`.
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
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_MAX_STREAMS = 10;
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

const StreamParams = z.looseObject({
  name: z.string(),
  arguments: z.unknown().optional(),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().min(0).optional(),
});
const StreamResult = z.looseObject({});

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

const notFound = (name: string): SdkProtocolError =>
  new SdkProtocolError(
    EVENTS_ERRORS.NotFound,
    `No event named "${name}"; events/list says which exist.`,
    { kind: "event" },
  );

/**
 * Where a scan starts after `cursor`. A null cursor means now, so there is no
 * age to bound; `maxAgeMs` only limits how far back a resumed cursor may reach.
 */
const ageFloor = (
  cursor: string | null | undefined,
  maxAgeMs: number | undefined,
  now: () => number,
): number | undefined =>
  cursor !== null && cursor !== undefined && maxAgeMs !== undefined ? now() - maxAgeMs : undefined;

// oxlint-disable-next-line typescript/no-explicit-any -- as in EventsOptions
type AnyAdapter = EventTypeAdapter<any>;

/** One open `events/stream`. */
type Stream = {
  readonly id: RequestId;
  readonly filter: WatchFilter;
  /** The store `cursor` counts rows in; null while none could be read. */
  store: FileIdentity | null;
  /** The last row this stream has judged. */
  cursor: number;
  /** The cursor to show while `store` is null: the one the client came with. */
  readonly heldCursor: string | null;
  /** The first `active` is written; nothing else may go before it. */
  active: boolean;
  closed: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Writes one frame stamped with the subscription id, unless the stream has ended. */
  send(method: string, params: Record<string, unknown>): Promise<void>;
  /** Ends the stream: no frame after this, heartbeat cleared, trigger released. */
  end(): void;
};

/**
 * The open streams of one event type and the trigger they share. Every scan for
 * them runs through `queue`, one at a time, so a stream is never scanned twice
 * at once and its first `active` is written before anything a trigger finds.
 */
type Group = {
  streams: Set<Stream>;
  trigger: { stop(): void } | undefined;
  queue: Promise<void>;
  /** A tick is queued and has not started; another change can ride on it. */
  tickQueued: boolean;
};

/** Runs `step` after every scan already queued for this event type. */
const enqueue = (group: Group, step: () => Promise<void>): void => {
  // Each step reports its own failures on the stream; this catch only keeps
  // one that slipped through from stalling the queue behind it.
  group.queue = group.queue.then(step).catch(() => {});
};

const noop = (): void => {};

/** A stream's cursor as the client sees it. */
const wireCursor = (s: Stream): string | null =>
  s.store === null ? s.heldCursor : encodeCursor(s.store, s.cursor);

/**
 * Register the `events/*` methods on `server`. Call before `connect`. The
 * returned closer is for the connection's `onclose`: it ends every open stream
 * and stops their triggers.
 */
export const registerEvents = (server: McpServer, opts: EventsOptions): { close(): void } => {
  if (opts.era === "legacy") return { close: () => {} };

  const nextPollMs = opts.nextPollMs ?? DEFAULT_NEXT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxStreams = opts.maxStreams ?? DEFAULT_MAX_STREAMS;
  const now = opts.now ?? Date.now;
  const byName = new Map<string, AnyAdapter>();
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
      if (adapter === undefined) throw notFound(params.name);
      try {
        const filter = await adapter.parseArguments(params.arguments ?? {});
        // `ensure` first: `identity` and `source` read what it opens.
        await adapter.ensure();
        const store = adapter.identity();
        const start = resolveStart(params.cursor, store, adapter.source.head());
        const scan = scanEvents(adapter, filter, start.from, {
          maxEvents: clampMaxEvents(params.maxEvents),
          scanLimit: SCAN_LIMIT,
          floorMs: ageFloor(params.cursor, params.maxAgeMs, now),
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

  // ------------------------------------------------------------- stream ---

  const groups = new Map<AnyAdapter, Group>(
    opts.adapters.map((a) => [
      a,
      { streams: new Set(), trigger: undefined, queue: Promise.resolve(), tickQueued: false },
    ]),
  );
  /** Streams open or being opened on this connection, against `maxStreams`. */
  let slots = 0;
  let shut = false;

  const sendFailure = (adapter: AnyAdapter, s: Stream, err: unknown): Promise<void> => {
    const e = readFailure(adapter.descriptor.name, err);
    return s.send("notifications/events/error", {
      error: { code: e.code, message: e.message, ...(e.data !== undefined && { data: e.data }) },
    });
  };

  /** The first `active`, then the heartbeat, which carries the cursor from here on. */
  const activate = async (s: Stream, truncated: boolean): Promise<void> => {
    if (s.closed) return;
    s.active = true;
    s.heartbeat = setInterval(() => {
      void s.send("notifications/events/heartbeat", { cursor: wireCursor(s) });
    }, heartbeatMs);
    // A stream is the client's to end; it must not keep the process alive.
    s.heartbeat.unref();
    await s.send("notifications/events/active", { cursor: wireCursor(s), truncated });
  };

  /**
   * Delivers what arrived past `s.cursor`, one scan at a time, until the store
   * has nothing more. `opening` is set for the stream's first drain only: the
   * `truncated` its start resolved to, and the `maxAgeMs` floor, which bounds
   * replay from a resumed cursor and nothing after it.
   */
  const drain = async (
    adapter: AnyAdapter,
    s: Stream,
    opening?: { truncated: boolean; floorMs: number | undefined },
  ): Promise<void> => {
    const store = s.store;
    if (store === null) return;
    for (;;) {
      const from = s.cursor;
      let scan;
      let frames: { row: number; params: Record<string, unknown> }[];
      try {
        scan = scanEvents(adapter, s.filter, from, {
          maxEvents: SCAN_LIMIT,
          scanLimit: SCAN_LIMIT,
          floorMs: opening?.floorMs,
        });
        frames = scan.rows.map((row) => ({
          row: row.cursor,
          params: {
            ...adapter.occurrence(row),
            name: adapter.descriptor.name,
            cursor: encodeCursor(store, row.cursor),
          },
        }));
      } catch (err) {
        await nextTurn();
        if (!s.active) await activate(s, opening?.truncated ?? false);
        await sendFailure(adapter, s, err);
        return;
      }
      // The scan held the thread. A cancel that reached the transport meanwhile
      // is processed only once it lets go, so give it that turn before writing:
      // a stream cancelled during its scan then writes nothing after the cancel.
      await nextTurn();
      if (s.closed) return;
      if (!s.active) {
        await activate(s, (opening?.truncated ?? false) || scan.truncated);
      } else if (scan.truncated) {
        // A later batch of the opening backlog fell under the age floor.
        await s.send("notifications/events/active", { cursor: wireCursor(s), truncated: true });
      }
      for (const frame of frames) {
        if (s.closed) return;
        await s.send("notifications/events/event", frame.params);
        s.cursor = frame.row;
      }
      s.cursor = scan.cursor;
      if (!scan.hasMore) return;
    }
  };

  /** A change on the trigger: every open stream of the type, each from its own cursor. */
  const tick = async (adapter: AnyAdapter, group: Group): Promise<void> => {
    group.tickQueued = false;
    const streams = [...group.streams].filter((s) => s.active && !s.closed);
    if (streams.length === 0) return;
    let store: FileIdentity | null;
    let head: number;
    try {
      await adapter.ensure();
      store = adapter.identity();
      head = adapter.source.head();
    } catch (err) {
      await nextTurn();
      for (const s of streams) await sendFailure(adapter, s, err);
      return;
    }
    for (const s of streams) {
      if (s.closed) continue;
      if (store === null) {
        await sendFailure(adapter, s, new Error("its store cannot be read"));
      } else if (s.store === null || !sameFile(s.store, store) || s.cursor > head) {
        // The store was rebuilt or replaced, so the stream's rowid names nothing
        // in it. Start again from the head and say events may have been missed.
        s.store = store;
        s.cursor = head;
        await s.send("notifications/events/active", { cursor: wireCursor(s), truncated: true });
      } else {
        await drain(adapter, s);
      }
    }
  };

  const schedule = (adapter: AnyAdapter, group: Group): void => {
    if (group.tickQueued) return;
    group.tickQueued = true;
    enqueue(group, () => tick(adapter, group));
  };

  server.server.setRequestHandler(
    "events/stream",
    { params: StreamParams, result: StreamResult },
    async (params, ctx) => {
      const adapter = byName.get(params.name);
      if (adapter === undefined) throw notFound(params.name);
      const name = adapter.descriptor.name;
      const group = groups.get(adapter);
      if (group === undefined) throw new Error(`No stream group for "${name}".`);
      if (!adapter.descriptor.delivery.includes("push")) {
        throw new SdkProtocolError(
          EVENTS_ERRORS.Unsupported,
          `"${name}" is not delivered by push; read it with events/poll.`,
          { feature: "deliveryMode", value: "push" },
        );
      }
      // Counted before the first await, so streams opened together cannot all
      // pass the check before any of them is counted.
      if (shut || slots >= maxStreams) {
        throw new SdkProtocolError(
          EVENTS_ERRORS.ResourceExhausted,
          `At most ${maxStreams} event streams can be open on one connection; cancel one first.`,
          { limit: "streams", max: maxStreams },
        );
      }
      slots += 1;

      let filter: WatchFilter;
      let store: FileIdentity | null;
      let start: { from: number; truncated: boolean };
      try {
        filter = await adapter.parseArguments(params.arguments ?? {});
        // `ensure` first: `identity`, `source` and the trigger read what it opens.
        await adapter.ensure();
        store = adapter.identity();
        start = resolveStart(params.cursor, store, adapter.source.head());
      } catch (err) {
        slots -= 1;
        throw readFailure(name, err);
      }

      const { id, signal } = ctx.mcpReq;
      if (signal.aborted || shut) {
        slots -= 1;
        return {};
      }

      let finish = noop;
      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const s: Stream = {
        id,
        filter,
        store,
        cursor: start.from,
        heldCursor: params.cursor ?? null,
        active: false,
        closed: false,
        heartbeat: undefined,
        send: async (method, frame) => {
          if (s.closed) return;
          try {
            await ctx.mcpReq.notify({
              method,
              params: { ...frame, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } },
            });
          } catch {
            // The transport is closing; the connection's close ends the stream.
          }
        },
        end: () => {
          if (s.closed) return;
          s.closed = true;
          clearInterval(s.heartbeat);
          signal.removeEventListener("abort", s.end);
          group.streams.delete(s);
          slots -= 1;
          if (group.streams.size === 0) {
            group.trigger?.stop();
            group.trigger = undefined;
          }
          finish();
        },
      };

      group.streams.add(s);
      if (group.trigger === undefined) {
        try {
          group.trigger = adapter.startTrigger(() => schedule(adapter, group));
        } catch (err) {
          s.end();
          throw readFailure(name, err);
        }
      }
      signal.addEventListener("abort", s.end, { once: true });
      // Queued in the same turn as the add, so it runs before any tick that
      // includes this stream: `active` is always its first frame.
      const floorMs = ageFloor(params.cursor, params.maxAgeMs, now);
      enqueue(group, async () => {
        if (s.closed) return;
        if (s.store === null) await activate(s, start.truncated);
        else await drain(adapter, s, { truncated: start.truncated, floorMs });
      });

      await ended;
      // Only written when the server ends the stream; after a cancel the SDK
      // writes nothing, which is what the SEP expects on stdio.
      return { _meta: { [SUBSCRIPTION_ID_META_KEY]: id } };
    },
  );

  return {
    close: () => {
      shut = true;
      // `end` deletes from the set it is iterating; a Set's iterator allows that.
      for (const group of groups.values()) for (const s of group.streams) s.end();
    },
  };
};
