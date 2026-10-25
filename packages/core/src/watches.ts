import { randomBytes } from "node:crypto";

import { PreconditionError } from "./errors.js";
import { surfaceUri } from "./resources.js";

/**
 * Incoming-arrival watches, independent of any surface.
 *
 * A watch is a sender filter plus a position in an append-ordered store. Mail's
 * `Envelope Index` and Messages' `chat.db` are both that: a table whose ROWID
 * grows as things arrive. This file owns the part that is the same for both,
 * which is deciding what is new and who it is for, and leaves reading the store
 * to an `ArrivalSource` each surface supplies.
 *
 * ## Why the filter requires a sender
 *
 * An unfiltered watch would announce every message that arrives, which is a
 * wake-up per mail for a model that cannot act on most of them. Requiring at
 * least one address or domain keeps a watch a statement about someone, and
 * bounds what a single registered watch can cost to evaluate.
 */

/** The most addresses and domains one filter may carry, together. */
const MAX_FILTER_ENTRIES = 50;

export type WatchFilter = { from: string[]; domains: string[] };

const clean = (values: readonly string[] | undefined, strip: RegExp): string[] => [
  ...new Set(
    (values ?? []).map((v) => v.trim().toLowerCase().replace(strip, "")).filter((v) => v !== ""),
  ),
];

/**
 * Trim, lowercase and de-duplicate a filter, or refuse one that names nobody.
 *
 * Domains lose a leading `@` because people write both `acme.com` and
 * `@acme.com`, and they mean the same thing.
 */
export const normalizeFilter = (input: { from?: string[]; domains?: string[] }): WatchFilter => {
  const from = clean(input.from, /^$/);
  const domains = clean(input.domains, /^@+/);
  if (from.length === 0 && domains.length === 0) {
    throw new PreconditionError(
      "A watch needs a sender: give at least one entry in `from` or `domains`.",
    );
  }
  if (from.length + domains.length > MAX_FILTER_ENTRIES) {
    throw new PreconditionError(
      `A watch takes at most ${MAX_FILTER_ENTRIES} entries across \`from\` and \`domains\`.`,
    );
  }
  return { from, domains };
};

/**
 * Whether `sender` is one the filter names.
 *
 * A domain matches the address's own domain or any subdomain of it, so
 * `acme.com` covers `jo@eu.acme.com`. It is compared on the part after the last
 * `@` and on a label boundary: `jo@notacme.com` is not Acme, and neither is
 * `acme.com@evil.io`, whose local part merely looks like a domain.
 */
export const matchesSender = (filter: WatchFilter, sender: string | null): boolean => {
  if (sender === null) return false;
  const who = sender.trim().toLowerCase();
  if (filter.from.includes(who)) return true;
  const at = who.lastIndexOf("@");
  if (at < 0) return false;
  const domain = who.slice(at + 1);
  return filter.domains.some((d) => domain === d || domain.endsWith(`.${d}`));
};

/** `cupertino://mail/watch/w_1a2b3c4d`. */
export const watchUri = (surface: string, id: string): string => surfaceUri(surface, `watch/${id}`);

/** `excluded` rows advance the cursor but never match: own mail, tapbacks, Junk. */
export type ArrivalRow = { cursor: number; key: string; sender: string | null; excluded?: boolean };

export type ArrivalSource<R extends ArrivalRow> = {
  /** Highest cursor in the store now. */
  head(): number;
  /** Rows with cursor > after, ascending, at most `limit`. */
  since(after: number, limit: number): R[];
};

export type Watch = { id: string; uri: string; filter: WatchFilter; createdAt: number };

export type WatchRead<R> = {
  watch: string;
  filter: WatchFilter;
  cursor: number;
  messages: R[];
  more: boolean;
};

export type WatchRegistryOptions<R extends ArrivalRow> = {
  surface: string;
  source: ArrivalSource<R>;
  onUpdate: (uri: string) => void;
  /** Started on the first add, stopped on the last remove. */
  startTrigger?: (onChange: () => void) => { stop(): void };
  /** Per connection. Default 10. */
  maxWatches?: number;
  /** Rows examined per scan. Default 1000. */
  scanLimit?: number;
  /** Matches returned per read. Default 50. */
  readLimit?: number;
  mintId?: () => string;
};

const defaultMintId = (): string => `w_${randomBytes(4).toString("hex")}`;

/** Where the last scan stopped. `key` tells a reused cursor from the same row. */
type Mark = { cursor: number; key: string | null };

/**
 * The watches of one connection, and the scan that tells them something arrived.
 *
 * ## Why rows carry a key as well as a cursor
 *
 * Arrival order is ROWID order, but SQLite hands out `max(ROWID) + 1`, so when
 * the newest row is deleted the next insert takes the same ROWID. A cursor
 * alone would then sit at the old head and never see the replacement. So a scan
 * restarts one row early, re-reading the row at the remembered head, and drops
 * it only when its key still equals the remembered one. A different key at the
 * same cursor is a new arrival.
 *
 * ## Why a tick scans once for every watch
 *
 * The store is read once per trigger however many watches exist, and each row
 * is then tried against each filter. A tick only says *that* something matched;
 * `read` is what returns the rows, so a missed or coalesced notification costs
 * nothing: the next read still finds everything after the cursor.
 */
export class WatchRegistry<R extends ArrivalRow> {
  readonly #surface: string;
  readonly #source: ArrivalSource<R>;
  readonly #onUpdate: (uri: string) => void;
  readonly #startTrigger: WatchRegistryOptions<R>["startTrigger"];
  readonly #maxWatches: number;
  readonly #scanLimit: number;
  readonly #readLimit: number;
  readonly #mintId: () => string;
  readonly #watches = new Map<string, Watch>();
  /** Each watch's head at creation, so a row that reused that cursor still counts as new. */
  readonly #born = new Map<string, Mark>();
  #mark: Mark = { cursor: 0, key: null };
  #trigger: { stop(): void } | undefined;

  constructor(opts: WatchRegistryOptions<R>) {
    this.#surface = opts.surface;
    this.#source = opts.source;
    this.#onUpdate = opts.onUpdate;
    this.#startTrigger = opts.startTrigger;
    this.#maxWatches = opts.maxWatches ?? 10;
    this.#scanLimit = opts.scanLimit ?? 1000;
    this.#readLimit = opts.readLimit ?? 50;
    this.#mintId = opts.mintId ?? defaultMintId;
  }

  get size(): number {
    return this.#watches.size;
  }

  add(filter: WatchFilter): Watch {
    if (this.#watches.size >= this.#maxWatches) {
      throw new PreconditionError(
        `This connection already has ${this.#maxWatches} watches. Remove one before adding another.`,
      );
    }
    const born = this.#markHead();
    const createdAt = born.cursor;
    // With no watches nothing was scanning, so the old mark is stale.
    if (this.#watches.size === 0) this.#mark = born;
    let id = this.#mintId();
    while (this.#watches.has(id)) id = this.#mintId();
    const watch: Watch = { id, uri: watchUri(this.#surface, id), filter, createdAt };
    this.#watches.set(id, watch);
    this.#born.set(id, born);
    if (this.#trigger === undefined && this.#startTrigger) {
      this.#trigger = this.#startTrigger(() => this.tick());
    }
    return watch;
  }

  remove(id: string): boolean {
    const removed = this.#watches.delete(id);
    this.#born.delete(id);
    if (removed && this.#watches.size === 0) this.#stopTrigger();
    return removed;
  }

  /**
   * The matches after `after` (default: when the watch was created), oldest
   * first, at most `readLimit` of them.
   *
   * One call examines at most `scanLimit` rows, so a filter that matches almost
   * nothing in a huge backlog cannot hold the process. When the scan stops
   * early, `cursor` is the last row it examined, not the last match, and `more`
   * says to call again from there.
   */
  read(id: string, after?: number): WatchRead<R> | null {
    const watch = this.#watches.get(id);
    if (!watch) return null;
    const rows = this.#source.since(after ?? watch.createdAt, this.#scanLimit);
    const messages: R[] = [];
    let cursor = after ?? watch.createdAt;
    let more = false;
    for (const row of rows) {
      if (!row.excluded && matchesSender(watch.filter, row.sender)) {
        if (messages.length === this.#readLimit) {
          more = true;
          break;
        }
        messages.push(row);
      }
      cursor = row.cursor;
    }
    if (!more && rows.length === this.#scanLimit) {
      more = this.#source.since(cursor, 1).length > 0;
    }
    return { watch: watch.uri, filter: watch.filter, cursor, messages, more };
  }

  /** Scan what arrived since the last tick and notify each watch it concerns. */
  tick(): void {
    if (this.#watches.size === 0) return;
    const hit = new Set<string>();
    const start = this.#mark;
    let after = Math.max(start.cursor - 1, 0);
    let first = true;
    let last: Mark | undefined;
    for (;;) {
      const rows = this.#source.since(after, this.#scanLimit);
      for (const row of rows) {
        if (first && row.cursor === start.cursor && row.key === start.key) continue;
        if (row.excluded) continue;
        for (const watch of this.#watches.values()) {
          if (this.#isNewTo(watch, row) && matchesSender(watch.filter, row.sender)) {
            hit.add(watch.id);
          }
        }
      }
      first = false;
      const tail = rows.at(-1);
      if (tail) {
        last = { cursor: tail.cursor, key: tail.key };
        after = tail.cursor;
      }
      if (rows.length < this.#scanLimit) break;
    }
    // No rows at all means the head moved backwards (rows deleted), so re-read it.
    this.#mark = last ?? this.#markHead();
    for (const id of hit) {
      const watch = this.#watches.get(id);
      if (watch) this.#onUpdate(watch.uri);
    }
  }

  close(): void {
    this.#watches.clear();
    this.#born.clear();
    this.#stopTrigger();
  }

  /** Arrived after the watch did: a later cursor, or the same cursor holding a different row. */
  #isNewTo(watch: Watch, row: R): boolean {
    const born = this.#born.get(watch.id);
    if (!born) return false;
    return row.cursor > born.cursor || (row.cursor === born.cursor && row.key !== born.key);
  }

  #stopTrigger(): void {
    this.#trigger?.stop();
    this.#trigger = undefined;
  }

  /** The head's cursor and key, read together so a reused cursor can be told apart. */
  #markHead(): Mark {
    const cursor = this.#source.head();
    const rows = this.#source.since(Math.max(cursor - 1, 0), 2);
    const row = rows.find((r) => r.cursor === cursor);
    return { cursor, key: row?.key ?? null };
  }
}
