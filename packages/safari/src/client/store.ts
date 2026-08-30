import type { DatabaseSync } from "node:sqlite";

import {
  columnsOf,
  escapeLike,
  fingerprintSchema,
  openReadOnly,
  SchemaDriftError,
  type Logger,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

import { resolveEpoch, toStoreTime, type Epoch } from "./dates.js";

/**
 * Safari's file lane.
 *
 * ## Why there is a file lane at all
 *
 * Not for speed, and not as a faster route to the same data. docs/safari.md's
 * headline finding is that Safari's two lanes **see almost disjoint things**:
 * Apple Events sees only what is open right now, and the file lane sees
 * everything except that. There is no tradeoff to litigate, because there is
 * nothing to trade. Apple Events cannot answer "what did I read last Tuesday"
 * at any price — Safari's dictionary simply has no verb for it.
 *
 * The store is also cheap enough that the question never comes up:
 *
 *     history items          7,814
 *     history visits        19,384
 *     LIKE search on url     16 ms   (7,424 hits)
 *     LIKE search on title    4 ms  (14,833 hits)
 *
 * ## What is measured, and what is NOT
 *
 * Measured (docs/safari.md, macOS 26.6): the file is `~/Library/Safari/History.db`,
 * 6,615,040 bytes, 16 objects across 9 tables, schema fingerprint `1d20bcd2b9a5`,
 * opening `mode=ro` in 0 ms. The tables `history_items`, `history_visits` and
 * `history_tombstones` exist. `history_items.url` is the URL column, confirmed
 * by scanning every TEXT column in the database rather than by assuming.
 *
 * The DDL is measured too, now: `test/fixtures/safari-history.sql` was captured
 * by `pnpm probe:safari --write` and is replayed by `test/store.test.ts`. This
 * file was originally written against a guess, and the guess was right about
 * everything it named — `history_item` as the join column, `id` as the primary
 * key, `url TEXT NOT NULL UNIQUE` — and silent about things it did not know
 * existed, of which `history_visits.synthesized` is the one that matters.
 *
 * `synthesized` is deliberately unused. Safari's own
 * `history_visits__last_visit` index orders by it, so it is clearly load-bearing
 * for Safari, but what it MEANS is unmeasured — plausibly redirect
 * intermediates or otherwise non-navigational rows. Filtering on a guess would
 * change which visit counts as "the last one" on the strength of an assumption,
 * so it is recorded and left alone.
 *
 * Every column still goes through `#col()`, which yields `NULL AS alias` when
 * absent, and the join column is still DISCOVERED at open time rather than
 * named. Measured today is not measured forever: Apple renames things, and the
 * cost of one should be one field rather than the whole lane.
 *
 * `SchemaDriftError` fires for exactly one condition — a missing
 * `history_items` — because without it there is no surface at all. Everything
 * else is a capability downgrade that is reported, never a throw. The one thing
 * that must never happen is a silently short list.
 */

/** The tables this lane reads. `history_items` is the only mandatory one. */
const ITEMS_TABLE = "history_items";
const VISITS_TABLE = "history_visits";
const TOMBSTONES_TABLE = "history_tombstones";

/**
 * Candidate names for the visits→items foreign key, most likely first.
 *
 * Discovered rather than hardcoded because the probe reports `colsOf` but its
 * output has never been read on a granted machine. If none of these is present
 * the visits leg is disabled and every visit-derived field reports as absent,
 * which is a server that still answers "have I been to this URL" correctly.
 */
const ITEM_FK_CANDIDATES = ["history_item", "history_item_id", "item_id", "item"] as const;

/**
 * The items primary key, resolved the same way and for the same reason.
 *
 * `rowid` is the fallback rather than a guess: every SQLite table that is not
 * WITHOUT ROWID has one, and when `id` is declared `INTEGER PRIMARY KEY` it IS
 * the rowid, so the two agree wherever both exist.
 */
const ITEM_PK_CANDIDATES = ["id", "rowid"] as const;

export type StoreCapabilities = {
  fingerprint: string;
  tables: string[];
  /** False means `SchemaDriftError` — there is no surface without it. */
  hasItems: boolean;
  hasVisits: boolean;
  hasTombstones: boolean;
  itemColumns: Set<string>;
  visitColumns: Set<string>;
  /** The resolved visits→items join column, or null when none was found. */
  itemFk: string | null;
  /** The resolved items primary key. Falls back to `rowid`, which always exists. */
  itemPk: string;
  /** How this store's timestamps map onto real time. Detected, never assumed. */
  epoch: Epoch;
  counts: { items: number; visits: number | null };
};

export type HistoryRow = {
  url: string;
  title: string | null;
  visitCount: number | null;
  /** Apple/unix seconds as stored — rendered by the caller through `epoch`. */
  lastVisitedRaw: number | null;
  firstVisitedRaw: number | null;
  loadSuccessful: boolean | null;
  /** True when at least one visit for this item was reached via a redirect. */
  viaRedirect: boolean | null;
};

export type RangeQuery = {
  from?: Date | undefined;
  to?: Date | undefined;
  query?: string | undefined;
  /** Which text the query matches. `full` also searches page titles. */
  scope?: "url" | "full" | undefined;
  limit: number;
};

const isRealTable = (name: string): boolean => !name.startsWith("sqlite_");

export const introspect = (db: DatabaseSync, now: number = Date.now()): StoreCapabilities => {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter(isRealTable);

  const hasItems = tables.includes(ITEMS_TABLE);
  const hasVisits = tables.includes(VISITS_TABLE);

  if (!hasItems) {
    throw new SchemaDriftError(
      `Safari's history database has no "${ITEMS_TABLE}" table (found: ${tables.join(", ") || "nothing"}). ` +
        `This is either not a History.db or Apple has restructured it. Nothing can be read from it.`,
    );
  }

  const itemColumns = new Set(columnsOf(db, ITEMS_TABLE));
  const visitColumns = hasVisits ? new Set(columnsOf(db, VISITS_TABLE)) : new Set<string>();
  const itemFk = hasVisits ? (ITEM_FK_CANDIDATES.find((c) => visitColumns.has(c)) ?? null) : null;
  const itemPk = ITEM_PK_CANDIDATES.find((c) => itemColumns.has(c)) ?? "rowid";

  const count = (table: string): number =>
    Number((db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c);

  // The epoch is read from the store's own newest timestamp. `CAST(... AS REAL)`
  // keeps a large integer from ever materialising on the JS side, where
  // `node:sqlite` throws past MAX_SAFE_INTEGER rather than truncating — the
  // failure that made a probe announce "no dates present" for 97,414 populated
  // rows. See packages/messages/src/client/dates.ts for that account.
  const maxVisit =
    hasVisits && visitColumns.has("visit_time")
      ? (
          db
            .prepare(`SELECT MAX(CAST("visit_time" AS REAL)) AS m FROM "${VISITS_TABLE}"`)
            .get() as { m: number | null }
        ).m
      : null;

  return {
    fingerprint: fingerprintSchema(db),
    tables,
    hasItems,
    hasVisits,
    hasTombstones: tables.includes(TOMBSTONES_TABLE),
    itemColumns,
    visitColumns,
    itemFk,
    itemPk,
    epoch: resolveEpoch(maxVisit, now),
    counts: { items: count(ITEMS_TABLE), visits: hasVisits ? count(VISITS_TABLE) : null },
  };
};

export class SafariStore {
  readonly db: DatabaseSync;
  readonly caps: StoreCapabilities;
  readonly path: string;
  readonly mode: ReadOnlyMode;

  constructor(opts: {
    db: DatabaseSync;
    caps: StoreCapabilities;
    path: string;
    mode: ReadOnlyMode;
  }) {
    this.db = opts.db;
    this.caps = opts.caps;
    this.path = opts.path;
    this.mode = opts.mode;
  }

  /**
   * One column, or `NULL` under the same alias when it is absent.
   *
   * The whole schema is reverse-engineered and unversioned, and — unusually for
   * this repo — has not been read back from a real machine even once. An Apple
   * rename, or a wrong expectation written here, should cost one field rather
   * than the lane.
   */
  #col(present: Set<string>, table: string, name: string, alias = name): string {
    return present.has(name) ? `${table}."${name}" AS ${alias}` : `NULL AS ${alias}`;
  }

  /** True when the visits leg can be joined at all. */
  get hasVisitLeg(): boolean {
    return this.caps.hasVisits && this.caps.itemFk !== null;
  }

  /**
   * One result row into a `HistoryRow`.
   *
   * Every read goes through here, so the `#col()` guards above have exactly one
   * place downstream that decides what a `NULL AS alias` means. Note the
   * asymmetry that is deliberate: `null` stays `null` rather than becoming `0`
   * or `false`, because "this store has no such column" and "zero visits" are
   * different facts and only one of them is about the person browsing.
   */
  #toRow(r: Record<string, unknown>): HistoryRow {
    return {
      url: String(r.url),
      title: r.title === null || r.title === undefined ? null : String(r.title),
      visitCount: r.visitCount === null ? null : Number(r.visitCount),
      lastVisitedRaw: r.lastVisitedRaw === null ? null : Number(r.lastVisitedRaw),
      firstVisitedRaw: r.firstVisitedRaw === null ? null : Number(r.firstVisitedRaw),
      loadSuccessful: r.loadSuccessful === null ? null : Boolean(Number(r.loadSuccessful)),
      viaRedirect: r.viaRedirect === null ? null : Boolean(Number(r.viaRedirect)),
    };
  }

  #selectList(): string {
    const i = this.caps.itemColumns;
    const v = this.caps.visitColumns;
    const visits = this.hasVisitLeg;
    return [
      `i."url" AS url`,
      this.#col(i, "i", "visit_count", "visitCount"),
      // Every visit-derived field collapses to NULL without the join, rather
      // than the query failing. "Have I been to this URL" still answers.
      visits && v.has("visit_time")
        ? `MAX(CAST(v."visit_time" AS REAL)) AS lastVisitedRaw`
        : `NULL AS lastVisitedRaw`,
      visits && v.has("visit_time")
        ? `MIN(CAST(v."visit_time" AS REAL)) AS firstVisitedRaw`
        : `NULL AS firstVisitedRaw`,
      // The title lives on the VISIT, not the item: one URL can have been
      // titled differently over time. The newest non-null wins, which is what
      // a reader means by "the title of that page".
      visits && v.has("title") && v.has("visit_time")
        ? `(SELECT v2."title" FROM "${VISITS_TABLE}" v2
             WHERE v2."${this.caps.itemFk}" = i."${this.caps.itemPk}" AND v2."title" IS NOT NULL
             ORDER BY CAST(v2."visit_time" AS REAL) DESC LIMIT 1) AS title`
        : `NULL AS title`,
      visits && v.has("load_successful")
        ? `MAX(v."load_successful") AS loadSuccessful`
        : `NULL AS loadSuccessful`,
      visits && v.has("redirect_source")
        ? `MAX(CASE WHEN v."redirect_source" IS NOT NULL THEN 1 ELSE 0 END) AS viaRedirect`
        : `NULL AS viaRedirect`,
    ].join(", ");
  }

  /**
   * Search and range-filter history.
   *
   * The range predicate applies to VISIT times, so it is only available when
   * the visits leg joined. Without it a range is not silently ignored — the
   * caller is told through `rangeApplied` on the result, because a filter that
   * quietly does nothing is how a caller concludes it browsed the same amount
   * every week of its life.
   */
  search(q: RangeQuery): { rows: HistoryRow[]; rangeApplied: boolean; truncated: boolean } {
    const i = this.caps.itemColumns;
    const v = this.caps.visitColumns;
    const visits = this.hasVisitLeg;
    const canRange = visits && v.has("visit_time");

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (q.query) {
      // `escapeLike` matters more here than anywhere else in this repo: a URL
      // is made of the characters LIKE treats as wildcards. Searching for
      // "100%" unescaped matches every row in the table.
      const pattern = `%${escapeLike(q.query)}%`;
      const clauses = [`i."url" LIKE ? ESCAPE '\\'`];
      params.push(pattern);
      if (q.scope === "full" && visits && v.has("title")) {
        clauses.push(
          `EXISTS (SELECT 1 FROM "${VISITS_TABLE}" vt
                   WHERE vt."${this.caps.itemFk}" = i."${this.caps.itemPk}" AND vt."title" LIKE ? ESCAPE '\\')`,
        );
        params.push(pattern);
      }
      where.push(`(${clauses.join(" OR ")})`);
    }

    if (canRange && q.from) {
      where.push(`v."visit_time" >= ?`);
      params.push(toStoreTime(q.from, this.caps.epoch));
    }
    if (canRange && q.to) {
      where.push(`v."visit_time" <= ?`);
      params.push(toStoreTime(q.to, this.caps.epoch));
    }

    // One extra row, so "there is more" is known rather than inferred from a
    // result that happens to be exactly `limit` long.
    const limit = Math.max(1, q.limit);
    params.push(limit + 1);

    const sql =
      `SELECT ${this.#selectList()} FROM "${ITEMS_TABLE}" i ` +
      (visits
        ? `LEFT JOIN "${VISITS_TABLE}" v ON v."${this.caps.itemFk}" = i."${this.caps.itemPk}" `
        : "") +
      (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
      `GROUP BY i."${this.caps.itemPk}" ` +
      `ORDER BY ${canRange ? `lastVisitedRaw DESC` : i.has("visit_count") ? `i."visit_count" DESC` : `i."${this.caps.itemPk}" DESC`} ` +
      `LIMIT ?`;

    const raw = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const truncated = raw.length > limit;

    return {
      rows: raw.slice(0, limit).map((r) => this.#toRow(r)),
      rangeApplied: canRange && Boolean(q.from ?? q.to),
      truncated,
    };
  }

  /** One item by its exact URL — the identity this surface uses everywhere. */
  get(url: string): HistoryRow | null {
    const visits = this.hasVisitLeg;
    const sql =
      `SELECT ${this.#selectList()} FROM "${ITEMS_TABLE}" i ` +
      (visits
        ? `LEFT JOIN "${VISITS_TABLE}" v ON v."${this.caps.itemFk}" = i."${this.caps.itemPk}" `
        : "") +
      `WHERE i."url" = ? GROUP BY i."${this.caps.itemPk}" LIMIT 1`;
    const r = this.db.prepare(sql).get(url) as Record<string, unknown> | undefined;
    return r ? this.#toRow(r) : null;
  }

  /**
   * Many items by exact URL, in one query.
   *
   * Exists for the tab join, which asks about every candidate spelling of every
   * open tab at once — measured at 28-76 tabs, and the variant ladder makes
   * that a few hundred URLs. As individual `get()` calls that is a few hundred
   * prepared statements; as one `IN` it is a single indexed lookup, because
   * `history_items.url` is `TEXT NOT NULL UNIQUE`.
   *
   * Chunked because SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is a real
   * ceiling and a person with a lot of tabs open is exactly who would hit it.
   * The map is keyed by the URL as ASKED, so a caller that walked a ladder can
   * find out which rung answered.
   */
  getMany(urls: string[]): Map<string, HistoryRow> {
    const found = new Map<string, HistoryRow>();
    if (urls.length === 0) return found;

    const visits = this.hasVisitLeg;
    const unique = [...new Set(urls)];
    const CHUNK = 400;

    for (let start = 0; start < unique.length; start += CHUNK) {
      const chunk = unique.slice(start, start + CHUNK);
      const sql =
        `SELECT ${this.#selectList()} FROM "${ITEMS_TABLE}" i ` +
        (visits
          ? `LEFT JOIN "${VISITS_TABLE}" v ON v."${this.caps.itemFk}" = i."${this.caps.itemPk}" `
          : "") +
        `WHERE i."url" IN (${chunk.map(() => "?").join(", ")}) ` +
        `GROUP BY i."${this.caps.itemPk}"`;

      for (const r of this.db.prepare(sql).all(...chunk) as Record<string, unknown>[]) {
        found.set(String(r.url), this.#toRow(r));
      }
    }

    return found;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed, or the handle died with the process. Nothing to do.
    }
  }
}

export const openStore = (opts: {
  path: string;
  mode?: ReadOnlyMode;
  logger?: Logger;
  now?: number;
  hint?: string;
}): SafariStore => {
  // `introspect` runs as `validate`, i.e. INSIDE the open ladder rather than
  // after it. That is what core's contract asks for, and it matters here: a
  // History.db that opens `ro` but reads as structurally wrong should fall
  // through to `immutable` and be retried, not be returned as a working store.
  const opened = openReadOnly(opts.path, opts.mode ?? "auto", {
    envVar: "APPLE_SAFARI_INDEX_MODE",
    label: "Safari's history database",
    ...(opts.hint ? { hint: opts.hint } : {}),
    validate: (db) => introspect(db, opts.now),
    // A drifted schema is not something another open mode can fix.
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () => opts.logger?.warn?.("safari: opened immutable; recent visits may be missing"),
  });
  return new SafariStore({
    db: opened.db,
    caps: opened.validated,
    path: opts.path,
    mode: opened.mode,
  });
};
