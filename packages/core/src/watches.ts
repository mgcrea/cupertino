import { randomBytes } from "node:crypto";
import { watch as fsWatch, statSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { PreconditionError } from "./errors.js";
import type { Logger } from "./osascript.js";
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

/** The most scope keys one filter may carry. Counted apart from the sender entries. */
const MAX_SCOPE_KEYS = 50;

/**
 * Who a watch follows, and optionally where.
 *
 * `scope` is a list of opaque keys. Core never reads them: a surface's source
 * stamps each row with the keys it belongs to (Mail: its mailbox and its Gmail
 * labels), the watch carries the keys it wants, and a row is for the watch only
 * if the two lists share one. A watch with no `scope` takes rows from anywhere.
 */
export type WatchFilter = { from: string[]; domains: string[]; scope?: string[] };

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
export const normalizeFilter = (input: {
  from?: string[];
  domains?: string[];
  scope?: string[];
}): WatchFilter => {
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
  // Keys are opaque, so they are trimmed and de-duplicated but never case-folded.
  const scope = [...new Set((input.scope ?? []).map((k) => k.trim()).filter((k) => k !== ""))];
  if (scope.length > MAX_SCOPE_KEYS) {
    throw new PreconditionError(`A watch takes at most ${MAX_SCOPE_KEYS} scope keys.`);
  }
  return scope.length > 0 ? { from, domains, scope } : { from, domains };
};

/**
 * Whether a row is in the watch's scope: always when the watch has none, else
 * when the row carries at least one of the watch's keys. A row with no scope is
 * outside every scoped watch.
 */
export const inScope = (filter: WatchFilter, rowScope: readonly string[] | undefined): boolean =>
  filter.scope === undefined || (rowScope?.some((k) => filter.scope!.includes(k)) ?? false);

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

/**
 * What tells a file replaced by rename from the same file written to: a store
 * rebuilt as a new file and renamed over the old name has a new inode, while
 * SQLite appending to it, or to its `-wal`, keeps the one it had.
 */
export type FileIdentity = { dev: number; ino: number };

/** `path`'s identity now, or null when it cannot be read (missing mid-replace, EACCES). */
export const fileIdentity = (path: string): FileIdentity | null => {
  try {
    const { dev, ino } = statSync(path);
    return { dev, ino };
  } catch {
    return null;
  }
};

export const sameFile = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino;

/** `cupertino://mail/watch/w_1a2b3c4d`. */
export const watchUri = (surface: string, id: string): string => surfaceUri(surface, `watch/${id}`);

/**
 * One arrival.
 *
 * `key` is the row's own identity (a message guid), carried so a result can name
 * what it found; nothing in the registry compares on it. `excluded` rows advance
 * the cursor but never match: own mail, tapbacks, Junk.
 */
export type ArrivalRow = {
  cursor: number;
  key: string;
  sender: string | null;
  excluded?: boolean;
  /**
   * Opaque keys the source files this row under. `excluded` is for what no watch
   * should ever see; `scope` is for what only some watches asked for.
   */
  scope?: string[];
};

/**
 * Every field `ArrivalRow` declares, which is to say every field that is the
 * registry's and not a reader's. Typed as a record over its keys so a field
 * added to `ArrivalRow` fails to compile here until it is listed.
 */
const INTERNAL: Record<keyof ArrivalRow, true> = {
  cursor: true,
  key: true,
  sender: true,
  excluded: true,
  scope: true,
};

/** What a read hands a client for one row: the surface's fields, none of the registry's. */
export type PublicArrival<R extends ArrivalRow> = Omit<R, keyof ArrivalRow>;

/**
 * A row as a read returns it. The cursor is the read's, once, not each row's;
 * `sender` is the lowercased matching form beside the surface's own; `scope`
 * and `excluded` are bookkeeping; `key` names the row to nobody outside.
 */
export const publicView = <R extends ArrivalRow>(row: R): PublicArrival<R> =>
  Object.fromEntries(
    Object.entries(row).filter(([k]) => !Object.hasOwn(INTERNAL, k)),
  ) as PublicArrival<R>;

export type ArrivalSource<R extends ArrivalRow> = {
  /** Highest cursor in the store now. */
  head(): number;
  /** Rows with cursor > after, ascending, at most `limit`. */
  since(after: number, limit: number): R[];
};

export type Watch = { id: string; uri: string; filter: WatchFilter; createdAt: number };

export type WatchRead<R> = {
  /** The watch's id (`w_…`), as the tool returned it. */
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
  /** Scans one tick may run before it stops and leaves the rest to the next. Default 10. */
  tickBatches?: number;
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
 * is then tried against each filter: a row is a match when `matchesSender` passes
 * and the row is in the watch's `scope` (see `inScope`), identically in `tick` and
 * `read`. A tick only says *that* something matched;
 * `read` is what returns the rows, so a missed or coalesced notification costs
 * nothing: the next read still finds everything after the cursor.
 *
 * ## Why a tick stops after `tickBatches` scans
 *
 * The store is read synchronously, on the event loop. A backlog of many
 * thousand rows above the mark (Mail syncing an account it had not fetched, or
 * re-adding mail under new ROWIDs) would otherwise be one scan that holds the
 * process until it ends. So a tick reads at most `tickBatches` × `scanLimit`
 * rows, keeps the mark where it stopped, and the next trigger or poll carries
 * on from there. A watch hit in that share is notified now; the rest of the
 * backlog notifies on the ticks that reach it.
 */
export class WatchRegistry<R extends ArrivalRow> {
  readonly #surface: string;
  readonly #source: ArrivalSource<R>;
  readonly #onUpdate: (uri: string) => void;
  readonly #startTrigger: WatchRegistryOptions<R>["startTrigger"];
  readonly #maxWatches: number;
  readonly #scanLimit: number;
  readonly #tickBatches: number;
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
    this.#tickBatches = opts.tickBatches ?? 10;
    this.#readLimit = opts.readLimit ?? 50;
    this.#mintId = opts.mintId ?? defaultMintId;
  }

  get size(): number {
    return this.#watches.size;
  }

  /**
   * The highest cursor already scanned. A source compares its head to this to
   * know whether the next tick has rows to judge, before paying to prepare them.
   */
  get mark(): number {
    return this.#mark;
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
   * first, at most `readLimit` of them. An `after` below the watch's start is
   * raised to it: a watch is a statement about what arrives once it is set, and
   * a client's cursor must not turn it into a search of the past.
   *
   * One call examines at most `scanLimit` rows, so a filter that matches almost
   * nothing in a huge backlog cannot hold the process. When the scan stops
   * early, `cursor` is the last row it examined, not the last match, and `more`
   * says to call again from there.
   */
  read(id: string, after?: number): WatchRead<R> | null {
    const watch = this.#watches.get(id);
    if (!watch) return null;
    const from = Math.max(after ?? watch.createdAt, watch.createdAt);
    const rows = this.#source.since(from, this.#scanLimit);
    const messages: R[] = [];
    let cursor = from;
    let more = false;
    for (const row of rows) {
      if (
        !row.excluded &&
        matchesSender(watch.filter, row.sender) &&
        inScope(watch.filter, row.scope)
      ) {
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
    return { watch: watch.id, filter: watch.filter, cursor, messages, more };
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
    for (let batch = 0; batch < this.#tickBatches; batch++) {
      const rows = this.#source.since(after, this.#scanLimit);
      for (const row of rows) {
        if (row.excluded) continue;
        for (const watch of this.#watches.values()) {
          if (
            row.cursor > watch.createdAt &&
            matchesSender(watch.filter, row.sender) &&
            inScope(watch.filter, row.scope)
          ) {
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

export type TriggerOptions = {
  dir: string;
  /** Basenames that count, e.g. ["chat.db", "chat.db-wal"]. */
  names: string[];
  /** Quiet time after the last event before `onChange` runs. Default 500. */
  debounceMs?: number;
  /** Longest a burst may defer `onChange`, from its first event. Default 3000. */
  maxWaitMs?: number;
  /** Floor for a missed event: `onChange` runs this often regardless. Default 60_000. */
  pollMs?: number;
  /** Injected by tests. */
  watch?: typeof fsWatch;
  logger?: Logger;
};

/**
 * Tells a watch registry that a SQLite store may have changed.
 *
 * ## Why the files and their directory are both watched
 *
 * Neither level is enough alone. Measured on macOS (scripts/spike-watch-arrivals.mjs),
 * a watch on the *directory* does not fire when SQLite appends to an existing
 * `-wal`: it fires only when the `-wal` or `-shm` is created or removed, and on
 * a checkpoint. A watch on the `-wal` *file* fired on every insert. So each
 * named file is watched directly, which is what sees arrivals, and the directory
 * is watched too, because SQLite deletes and recreates the `-wal` around
 * checkpoints and when the last connection closes, and a watch on the old inode
 * goes quiet without saying so. A rename of a name in the directory re-arms that
 * name's file watcher. A file missing at start is normal and is armed when it
 * appears.
 *
 * Only the given names count, for triggering and for re-arming. `-shm` churns
 * constantly and says nothing about new rows.
 *
 * ## Two independent timers
 *
 * Events are debounced from the last one, because an arrival is a burst of
 * writes. A burst that never goes quiet (a long sync writes the `-wal` many
 * times a second for minutes) would keep restarting that wait, and the arrivals
 * in it would be left to the poll. So a burst also has a ceiling: `onChange`
 * runs `maxWaitMs` after its first event however busy it still is, and the next
 * event starts a new burst. The poll is separate and unconditional: `fs.watch` can drop events
 * (a network volume, a replaced directory, a watcher that errored), and a
 * missed event must cost one interval of latency, not an arrival never seen.
 * Both are `unref`ed and the watchers are non-persistent, so none of this keeps
 * the process alive after stdin closes.
 *
 * A watcher that cannot be created (missing directory, EACCES) is logged once
 * and the rest is armed regardless; the poll remains.
 */
export const fileTrigger =
  (opts: TriggerOptions) =>
  (onChange: () => void): { stop(): void } => {
    const { dir, names, logger } = opts;
    const debounceMs = opts.debounceMs ?? 500;
    const maxWaitMs = opts.maxWaitMs ?? 3000;
    const pollMs = opts.pollMs ?? 60_000;
    const watch = opts.watch ?? fsWatch;
    const wanted = new Set(names);

    let stopped = false;
    let warned = false;
    let dirWatcher: FSWatcher | undefined;
    const files = new Map<string, FSWatcher>();
    let debounce: NodeJS.Timeout | undefined;
    /** Set on a burst's first event, cleared when the burst fires. */
    let ceiling: NodeJS.Timeout | undefined;

    const warn = (path: string, err: unknown): void => {
      if (warned) return;
      warned = true;
      logger?.warn?.(`cannot watch ${path}, relying on the poll`, err);
    };

    // `onChange` reads a store that can be busy, locked or unreadable, and it runs
    // from a timer, where a throw would be an uncaught exception. Failures are
    // logged once until a call succeeds, so a store that stays broken costs one
    // line, not one per poll.
    let failing = false;
    const fire = (): void => {
      if (stopped) return;
      try {
        onChange();
        failing = false;
      } catch (err) {
        if (!failing) logger?.warn?.("watch trigger callback failed", err);
        failing = true;
      }
    };

    const settle = (): void => {
      if (debounce) clearTimeout(debounce);
      if (ceiling) clearTimeout(ceiling);
      debounce = undefined;
      ceiling = undefined;
    };

    const schedule = (): void => {
      if (stopped) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        settle();
        fire();
      }, debounceMs).unref();
      ceiling ??= setTimeout(() => {
        settle();
        fire();
      }, maxWaitMs).unref();
    };

    const disarm = (name: string): void => {
      const w = files.get(name);
      files.delete(name);
      try {
        w?.close();
      } catch {
        // Already closed.
      }
    };

    const arm = (name: string): void => {
      disarm(name);
      const path = join(dir, name);
      try {
        const w = watch(path, { persistent: false });
        w.on("change", schedule);
        // A deleted file errors or renames its watcher; the directory re-arms it.
        w.on("error", () => disarm(name));
        files.set(name, w);
      } catch (err) {
        // A file that is not there yet is normal, not a failure.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") warn(path, err);
      }
    };

    try {
      dirWatcher = watch(dir, { persistent: false });
      dirWatcher.on("change", (eventType: string, filename: string | Buffer | null) => {
        if (stopped) return;
        const name = filename == null ? undefined : filename.toString();
        if (name !== undefined && !wanted.has(name)) return;
        if (eventType === "rename") {
          for (const n of name === undefined ? names : [name]) arm(n);
        }
        schedule();
      });
      dirWatcher.on("error", (err: unknown) => warn(dir, err));
    } catch (err) {
      warn(dir, err);
    }
    for (const name of names) arm(name);

    // The poll also re-arms: a missed rename, a watcher that errored, or a file
    // absent at start would otherwise stay unwatched for the trigger's lifetime.
    const poll = setInterval(() => {
      if (stopped) return;
      for (const name of names) if (!files.has(name)) arm(name);
      fire();
    }, pollMs);
    poll.unref();

    return {
      stop() {
        stopped = true;
        clearInterval(poll);
        settle();
        for (const name of files.keys()) disarm(name);
        try {
          dirWatcher?.close();
        } catch {
          // Already closed.
        }
        dirWatcher = undefined;
      },
    };
  };
