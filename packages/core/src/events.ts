import { ProtocolError as SdkProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import {
  inScope,
  matchesSender,
  sameFile,
  type ArrivalRow,
  type ArrivalSource,
  type FileIdentity,
  type WatchFilter,
} from "./watches.js";

/**
 * The engine for the draft MCP Events extension (SEP-3415), independent of any
 * surface.
 *
 * It owns what is the same for Mail and Messages: the cursor a client carries,
 * where a poll or a stream starts from it, and the scan that turns rows past a
 * cursor into occurrences. Reading the store, parsing a surface's filter and
 * shaping a row's payload are an `EventTypeAdapter` each surface supplies.
 */

/** The key under `capabilities.extensions` that declares the extension. */
export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

/**
 * The extension's own JSON-RPC error codes, beside the SDK's `InvalidParams`
 * (-32602), which a malformed cursor or an empty filter uses.
 */
export const EVENTS_ERRORS = {
  NotFound: -32023,
  ResourceExhausted: -32025,
  Unsupported: -32026,
} as const;

/** What `events/list` says about one event type. */
export type EventDescriptor = {
  name: string;
  description: string;
  delivery: ("poll" | "push")[];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
};

/** One event as a client receives it. `cursor` is set on poll results and left off pushed frames. */
export type EventOccurrence = {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: string | null;
};

/**
 * What a surface supplies for one event type. `source`, `ensure`, `identity` and
 * `startTrigger` are the same four things a watch service needs, so an adapter is
 * usually built over the store handle the surface already has.
 */
export type EventTypeAdapter<R extends ArrivalRow> = {
  descriptor: EventDescriptor;
  /** Validates the subscription arguments. Throws a ProtocolError with InvalidParams. */
  parseArguments(args: unknown): Promise<WatchFilter>;
  /** A row as an occurrence: its id, when it was received, and the envelope payload. */
  occurrence(row: R): { eventId: string; timestamp: string; data: Record<string, unknown> };
  /** When the row was received, for the `maxAge` floor; null when the row has no date. */
  timestampMs(row: R): number | null;
  source: ArrivalSource<R>;
  /** Opens or refreshes whatever `source` reads, before a scan. */
  ensure(): Promise<void>;
  /** The store file's identity now, or null when it cannot be read. */
  identity(): FileIdentity | null;
  startTrigger(onChange: () => void): { stop(): void };
};

const invalidParams = (message: string): SdkProtocolError =>
  new SdkProtocolError(ProtocolErrorCode.InvalidParams, message);

/**
 * `v1.<dev>-<ino>.<rowid>`.
 *
 * A rowid alone cannot tell Mail's index from Messages' chat.db, nor a rebuilt
 * index from the one before it, and a rowid from the wrong store would silently
 * skip or replay rows. The file identity rides along so `resolveStart` can see
 * that the cursor belongs to a store that is gone.
 */
export const encodeCursor = (store: FileIdentity, rowid: number): string =>
  `v1.${store.dev}-${store.ino}.${rowid}`;

const CURSOR = /^v1\.(\d+)-(\d+)\.(\d+)$/;

/** The inverse of `encodeCursor`. Anything else is the client's mistake: InvalidParams. */
export const decodeCursor = (cursor: string): { store: FileIdentity; rowid: number } => {
  const m = CURSOR.exec(cursor);
  if (m === null) {
    throw invalidParams(`"${cursor}" is not an events cursor; pass back one this server returned.`);
  }
  const [dev, ino, rowid] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![dev, ino, rowid].every(Number.isSafeInteger)) {
    throw invalidParams(`"${cursor}" is not an events cursor; a number in it is out of range.`);
  }
  return { store: { dev, ino }, rowid };
};

/**
 * Where a poll or a stream starts. A null or absent cursor means now: `head`.
 *
 * A cursor from another store (the other surface, or an index rebuilt under a
 * new inode) or one above `head` (a renumbered store) cannot be resumed, and is
 * not an error: the client did nothing wrong. It starts from `head` and says
 * `truncated`, so the client knows events may have been missed in between.
 * Only a malformed cursor throws.
 */
export const resolveStart = (
  cursor: string | null | undefined,
  store: FileIdentity | null,
  head: number,
): { from: number; truncated: boolean } => {
  if (cursor === null || cursor === undefined) return { from: head, truncated: false };
  const decoded = decodeCursor(cursor);
  if (store === null || !sameFile(decoded.store, store) || decoded.rowid > head) {
    return { from: head, truncated: true };
  }
  return { from: decoded.rowid, truncated: false };
};

export type ScanResult<R> = {
  rows: R[];
  /** The last row examined, not the last match, so the next call never re-judges a row. */
  cursor: number;
  /** Matching rows were skipped for being older than `floorMs`. */
  truncated: boolean;
  /** More rows are waiting past `cursor`. */
  hasMore: boolean;
};

/**
 * The matches after `from`, oldest first, at most `maxEvents` of them.
 *
 * Follows `WatchRegistry.read`: one call examines at most `scanLimit` rows, so a
 * filter that matches almost nothing in a huge backlog cannot hold the process,
 * and `cursor` is the last row examined so the caller can continue from it.
 * A match older than `floorMs` (the `maxAge` of a subscription) is skipped, not
 * returned, and the result is `truncated`. This `truncated` is only about that
 * skip; `resolveStart` reports its own, and the caller combines them.
 */
export const scanEvents = <R extends ArrivalRow>(
  adapter: Pick<EventTypeAdapter<R>, "source" | "timestampMs">,
  filter: WatchFilter,
  from: number,
  opts: { maxEvents: number; scanLimit: number; floorMs?: number | undefined },
): ScanResult<R> => {
  const scanned = adapter.source.since(from, opts.scanLimit);
  const rows: R[] = [];
  let cursor = from;
  let truncated = false;
  let hasMore = false;
  for (const row of scanned) {
    if (!row.excluded && matchesSender(filter, row.sender) && inScope(filter, row.scope)) {
      const at = adapter.timestampMs(row);
      if (opts.floorMs !== undefined && at !== null && at < opts.floorMs) {
        truncated = true;
      } else {
        if (rows.length === opts.maxEvents) {
          hasMore = true;
          break;
        }
        rows.push(row);
      }
    }
    cursor = row.cursor;
  }
  if (!hasMore && scanned.length === opts.scanLimit) {
    hasMore = adapter.source.since(cursor, 1).length > 0;
  }
  return { rows, cursor, truncated, hasMore };
};
