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

const clean = (values: readonly string[] | undefined, strip?: RegExp): string[] => [
  ...new Set(
    (values ?? [])
      .map((v) => (strip ? v.trim().toLowerCase().replace(strip, "") : v.trim().toLowerCase()))
      .filter((v) => v !== ""),
  ),
];

/**
 * Trim, lowercase and de-duplicate a filter, or refuse one that names nobody.
 *
 * Domains lose a leading `@` because people write both `acme.com` and
 * `@acme.com`, and they mean the same thing.
 */
export const normalizeFilter = (input: { from?: string[]; domains?: string[] }): WatchFilter => {
  const from = clean(input.from);
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

/**
 * One arrival.
 *
 * `key` is the row's own identity (a message guid), carried so a result can name
 * what it found; nothing in the registry compares on it. `excluded` rows advance
 * the cursor but never match: own mail, tapbacks, Junk.
 */
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

/**
 * The watches of one connection, and the scan that tells them something arrived.
 *
 * ## The cursor is a ROWID, and it only ever grows
 *
 * Arrival order is ROWID order, so a scan asks the store for rows past the last
 * cursor it saw. That is only sound because both stores declare their message
 * table `INTEGER PRIMARY KEY AUTOINCREMENT` (Mail's `messages`, Messages'
 * `message`; the captured DDL is in each package's test fixtures), which makes
 * SQLite never hand out a ROWID twice, even after the newest row is deleted. A
 * store that dropped AUTOINCREMENT would reuse the top id, and a row inserted
 * under it would sit at or below the cursor and be missed.
 *
 * ## Why a lower head resets the mark
 *
 * The one way a cursor goes backwards is a store rebuilt from scratch, such as
 * Mail re-indexing and renumbering. Rows under the old mark would then never be
 * scanned, so a head below the mark resets the mark to the head. It notifies
 * nothing, because the rows now there are not arrivals; it is the old numbering
 * that is gone. Watches created above the new head are lowered with it.
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
  /** Highest cursor already scanned. */
  #mark = 0;
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
    const createdAt = this.#source.head();
    // With no watches nothing was scanning, so the old mark is stale.
    if (this.#watches.size === 0) this.#mark = createdAt;
    let id = this.#mintId();
    while (this.#watches.has(id)) id = this.#mintId();
    const watch: Watch = { id, uri: watchUri(this.#surface, id), filter, createdAt };
    this.#watches.set(id, watch);
    if (this.#trigger === undefined && this.#startTrigger) {
      this.#trigger = this.#startTrigger(() => this.tick());
    }
    return watch;
  }

  remove(id: string): boolean {
    const removed = this.#watches.delete(id);
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
    const head = this.#source.head();
    if (head < this.#mark) {
      this.#mark = head;
      // A watch born above the new head would otherwise never see a row again.
      for (const [id, watch] of this.#watches) {
        if (watch.createdAt > head) this.#watches.set(id, { ...watch, createdAt: head });
      }
      return;
    }
    const hit = new Set<string>();
    let after = this.#mark;
    for (;;) {
      const rows = this.#source.since(after, this.#scanLimit);
      for (const row of rows) {
        if (row.excluded) continue;
        for (const watch of this.#watches.values()) {
          if (row.cursor > watch.createdAt && matchesSender(watch.filter, row.sender)) {
            hit.add(watch.id);
          }
        }
      }
      const tail = rows.at(-1);
      if (tail) after = tail.cursor;
      if (rows.length < this.#scanLimit) break;
    }
    this.#mark = after;
    for (const id of hit) {
      const watch = this.#watches.get(id);
      if (!watch) continue;
      // One listener failing must not cost the other watches their notification.
      try {
        this.#onUpdate(watch.uri);
      } catch {
        // The registry has no log; a listener owns its own failures.
      }
    }
  }

  close(): void {
    this.#watches.clear();
    this.#stopTrigger();
  }

  #stopTrigger(): void {
    this.#trigger?.stop();
    this.#trigger = undefined;
  }
}
