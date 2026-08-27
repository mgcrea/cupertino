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

import { resolveEpoch, type Epoch } from "./dates.js";

/**
 * Maps' file lane. There is no other lane.
 *
 * ## What is measured, and what is NOT
 *
 * MEASURED by `pnpm probe:maps` on macOS 26.6 — 146 schema objects, fingerprint
 * `2bbc03143125`, Core Data, `ZCREATETIME` on apple-seconds:
 *
 *     ZFAVORITEITEM     23 rows   ZCOLLECTION      10 rows
 *     ZCOLLECTIONITEM   29 rows   ZHISTORYITEM     33 rows
 *     ZMIXINMAPITEM     68 rows   ZREVIEWEDPLACE   24 rows
 *
 * and the id bridge, verified by running the join rather than by reading column
 * names: `ZMIXINMAPITEM`'s inverse relationships partition exactly —
 * 29 collection items + 20 favourites + 19 history rows = 68 = every row.
 *
 * NOT measured: this file has never been run against the real store by its
 * author, who has no Full Disk Access. Everything below is written against a
 * probe REPORT, which is one step further from the data than
 * `packages/safari/src/client/store.ts` was, and that file already treats every
 * column as optional. This one goes further in two ways.
 *
 * ## Columns are resolved BY COVERAGE, not by first name match
 *
 * The probe found `ZHISTORYITEM` carrying both `ZLATITUDE` (1 of 33 rows) and
 * `ZLATITUDE1` (19 of 33). A resolver that took the first candidate it
 * recognised would pick the column that is null 97% of the time and report that
 * Maps holds almost no coordinates. So each logical field names several
 * candidates and the one with the **most non-null values** wins, counted at
 * open time. That is a real query per candidate, run once, on tables of tens of
 * rows.
 *
 * ## The collection membership key is DISCOVERED, and may not exist
 *
 * The probe found no `ZCOLLECTION` column on `ZCOLLECTIONITEM`, so how an item
 * belongs to a collection is genuinely unknown — Core Data names a foreign key
 * after the RELATIONSHIP, and it may also be a many-to-many `Z_*` join table.
 * Rather than guess, the candidates are tried in order and, when none is found,
 * collections are listed WITHOUT their items and every caller is told so. A
 * collection with an unexplained empty item list is the failure this avoids.
 *
 * `SchemaDriftError` fires for exactly one condition — none of the three
 * place-bearing tables exists — because without them there is no surface.
 * Everything else is a capability downgrade that is reported, never a throw.
 */

export const FAVORITES_TABLE = "ZFAVORITEITEM";
export const COLLECTIONS_TABLE = "ZCOLLECTION";
export const COLLECTION_ITEMS_TABLE = "ZCOLLECTIONITEM";
export const HISTORY_TABLE = "ZHISTORYITEM";
export const MAP_ITEMS_TABLE = "ZMIXINMAPITEM";

/**
 * Candidates per logical field, best-known first — but order only breaks ties.
 * Coverage decides. See the header.
 */
const NAME_CANDIDATES = ["ZMAPITEMNAME", "ZCUSTOMNAME", "ZLOCATIONDISPLAY", "ZTITLE"] as const;
const LAT_CANDIDATES = ["ZLATITUDE", "ZLATITUDE1"] as const;
const LON_CANDIDATES = ["ZLONGITUDE", "ZLONGITUDE1"] as const;
const ADDRESS_CANDIDATES = ["ZMAPITEMADDRESS", "ZORIGINATINGADDRESSSTRING"] as const;
const MUID_CANDIDATES = ["ZMUID"] as const;
const MAP_ITEM_FK_CANDIDATES = ["ZMAPITEM"] as const;
const CREATED_CANDIDATES = ["ZCREATETIME"] as const;
const MODIFIED_CANDIDATES = ["ZMODIFICATIONTIME"] as const;
const COLLECTION_TITLE_CANDIDATES = ["ZTITLE", "ZNAME", "ZCUSTOMNAME"] as const;

/** How an item says which collection it is in. Unknown; see the header. */
const COLLECTION_FK_CANDIDATES = [
  "ZCOLLECTION",
  "ZCOLLECTION1",
  "ZPARENTCOLLECTION",
  "ZOWNINGCOLLECTION",
] as const;

export type FieldMap = {
  name: string | null;
  customName: string | null;
  latitude: string | null;
  longitude: string | null;
  address: string | null;
  muid: string | null;
  mapItem: string | null;
  created: string | null;
  modified: string | null;
};

export type EntityFacts = {
  table: string;
  present: boolean;
  rows: number;
  columns: Set<string>;
  fields: FieldMap;
};

export type StoreCapabilities = {
  fingerprint: string;
  tables: string[];
  favorites: EntityFacts;
  collections: EntityFacts;
  collectionItems: EntityFacts;
  history: EntityFacts;
  mapItems: EntityFacts;
  /** Resolved membership key on ZCOLLECTIONITEM, or null when none was found. */
  collectionFk: string | null;
  epoch: Epoch;
};

export type PlaceRow = {
  id: number;
  name: string | null;
  customName: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  muid: number | null;
  createdRaw: number | null;
  modifiedRaw: number | null;
  /**
   * False when the row has no linked `ZMIXINMAPITEM`.
   *
   * MEASURED: 3 of 23 favourites, and they carry no name and no coordinate
   * either. Almost certainly the unconfigured Home / Work / School slots that
   * Maps creates whether or not anyone fills them in. They are RETURNED rather
   * than filtered, with this flag, because silently dropping rows is how a
   * caller concludes a favourite was deleted.
   */
  linked: boolean;
};

export type CollectionRow = {
  id: number;
  title: string | null;
  placesCount: number | null;
  createdRaw: number | null;
  modifiedRaw: number | null;
};

const isRealTable = (name: string): boolean => !name.startsWith("sqlite_");

/** A `NULL AS alias` column reads back as null; every other value is coerced. */
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v as number);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v as string);

/**
 * Pick the candidate column with the most non-null values.
 *
 * Returns null when none of the candidates exists, and also when they all exist
 * and are all empty — an all-null column is not a usable field, and reporting
 * one as resolved would produce a result whose every value is null with no
 * explanation.
 */
const resolveField = (
  db: DatabaseSync,
  table: string,
  columns: Set<string>,
  candidates: readonly string[],
  rows: number,
): string | null => {
  const present = candidates.filter((c) => columns.has(c));
  if (present.length === 0) return null;
  if (rows === 0) return present[0] ?? null;
  let best: { name: string; count: number } | null = null;
  for (const name of present) {
    let count = 0;
    try {
      count = Number(
        (
          db.prepare(`SELECT COUNT("${name}") AS c FROM "${table}"`).get() as {
            c: number | bigint;
          }
        ).c,
      );
    } catch {
      continue;
    }
    if (!best || count > best.count) best = { name, count };
  }
  return best && best.count > 0 ? best.name : (present[0] ?? null);
};

const countRows = (db: DatabaseSync, table: string): number => {
  try {
    return Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number | bigint }).c,
    );
  } catch {
    return 0;
  }
};

const describeEntity = (
  db: DatabaseSync,
  table: string,
  tables: string[],
  nameCandidates: readonly string[] = NAME_CANDIDATES,
): EntityFacts => {
  const present = tables.includes(table);
  if (!present) {
    return {
      table,
      present: false,
      rows: 0,
      columns: new Set(),
      fields: {
        name: null,
        customName: null,
        latitude: null,
        longitude: null,
        address: null,
        muid: null,
        mapItem: null,
        created: null,
        modified: null,
      },
    };
  }
  const columns = new Set(columnsOf(db, table));
  const rows = countRows(db, table);
  const pick = (cands: readonly string[]): string | null =>
    resolveField(db, table, columns, cands, rows);
  return {
    table,
    present,
    rows,
    columns,
    fields: {
      name: pick(nameCandidates),
      // Always named directly: it is the user's own label and must never be
      // confused with the place's name, even when it wins on coverage.
      customName: columns.has("ZCUSTOMNAME") ? "ZCUSTOMNAME" : null,
      latitude: pick(LAT_CANDIDATES),
      longitude: pick(LON_CANDIDATES),
      address: pick(ADDRESS_CANDIDATES),
      muid: pick(MUID_CANDIDATES),
      mapItem: pick(MAP_ITEM_FK_CANDIDATES),
      created: pick(CREATED_CANDIDATES),
      modified: pick(MODIFIED_CANDIDATES),
    },
  };
};

export const introspect = (db: DatabaseSync, now: number = Date.now()): StoreCapabilities => {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter(isRealTable);

  const favorites = describeEntity(db, FAVORITES_TABLE, tables);
  const collectionItems = describeEntity(db, COLLECTION_ITEMS_TABLE, tables);
  const history = describeEntity(db, HISTORY_TABLE, tables);

  if (!favorites.present && !collectionItems.present && !history.present) {
    throw new SchemaDriftError(
      `Maps' store has none of "${FAVORITES_TABLE}", "${COLLECTION_ITEMS_TABLE}" or ` +
        `"${HISTORY_TABLE}" (found: ${tables.join(", ") || "nothing"}). This is either not a ` +
        `MapsSync store or Apple has restructured it. Nothing can be read from it.`,
    );
  }

  const collections = describeEntity(db, COLLECTIONS_TABLE, tables, COLLECTION_TITLE_CANDIDATES);
  const mapItems = describeEntity(db, MAP_ITEMS_TABLE, tables);

  const collectionFk = COLLECTION_FK_CANDIDATES.find((c) => collectionItems.columns.has(c)) ?? null;

  // The epoch comes from whichever place table has the most rows and a created
  // column — one measurement for the whole store, since every entity is written
  // by the same framework.
  const dated = [favorites, collectionItems, history, mapItems]
    .filter((e) => e.present && e.rows > 0 && e.fields.created)
    .toSorted((a, b) => b.rows - a.rows)[0];
  let maxCreated: number | null = null;
  if (dated?.fields.created) {
    try {
      maxCreated = (
        db
          .prepare(`SELECT MAX(CAST("${dated.fields.created}" AS REAL)) AS m FROM "${dated.table}"`)
          .get() as { m: number | null }
      ).m;
    } catch {
      maxCreated = null;
    }
  }

  return {
    fingerprint: fingerprintSchema(db),
    tables,
    favorites,
    collections,
    collectionItems,
    history,
    mapItems,
    collectionFk,
    epoch: resolveEpoch(maxCreated, now),
  };
};

export class MapsStore {
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
   * One column, or `NULL` under the same alias when it could not be resolved.
   *
   * The same guard `packages/safari` uses, and needed more here: this schema was
   * read from a probe report rather than from the database, so a wrong
   * expectation should cost one field instead of the whole lane.
   */
  #col(column: string | null, alias: string, table = "t"): string {
    return column ? `${table}."${column}" AS ${alias}` : `NULL AS ${alias}`;
  }

  #placeSelect(e: EntityFacts): string {
    const f = e.fields;
    return [
      `t."Z_PK" AS id`,
      this.#col(f.name, "name"),
      this.#col(f.customName, "customName"),
      this.#col(f.latitude, "latitude"),
      this.#col(f.longitude, "longitude"),
      this.#col(f.address, "address"),
      this.#col(f.muid, "muid"),
      this.#col(f.created, "createdRaw"),
      this.#col(f.modified, "modifiedRaw"),
      f.mapItem ? `t."${f.mapItem}" AS mapItem` : `NULL AS mapItem`,
    ].join(", ");
  }

  #toPlace(r: Record<string, unknown>): PlaceRow {
    return {
      id: Number(r.id),
      name: str(r.name),
      customName: str(r.customName),
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      address: str(r.address),
      muid: num(r.muid),
      createdRaw: num(r.createdRaw),
      modifiedRaw: num(r.modifiedRaw),
      linked: r.mapItem !== null && r.mapItem !== undefined,
    };
  }

  #entityFor(kind: "favorite" | "collection-item" | "history"): EntityFacts {
    if (kind === "favorite") return this.caps.favorites;
    if (kind === "collection-item") return this.caps.collectionItems;
    return this.caps.history;
  }

  /** One entity's places, newest first when a date is available. */
  places(
    kind: "favorite" | "collection-item" | "history",
    opts: { limit: number; collectionId?: number | undefined; query?: string | undefined },
  ): { rows: PlaceRow[]; truncated: boolean } {
    const e = this.#entityFor(kind);
    if (!e.present || e.rows === 0) return { rows: [], truncated: false };

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts.collectionId !== undefined) {
      if (!this.caps.collectionFk) return { rows: [], truncated: false };
      where.push(`t."${this.caps.collectionFk}" = ?`);
      params.push(opts.collectionId);
    }

    if (opts.query) {
      const pattern = `%${escapeLike(opts.query)}%`;
      const clauses: string[] = [];
      for (const col of [e.fields.name, e.fields.customName, e.fields.address]) {
        if (!col) continue;
        clauses.push(`t."${col}" LIKE ? ESCAPE '\\'`);
        params.push(pattern);
      }
      // No searchable column means no rows can match. Returning everything
      // would be worse than returning nothing: it reads as a successful search.
      if (clauses.length === 0) return { rows: [], truncated: false };
      where.push(`(${clauses.join(" OR ")})`);
    }

    const limit = Math.max(1, opts.limit);
    params.push(limit + 1);

    const order = e.fields.modified
      ? `t."${e.fields.modified}" DESC`
      : e.fields.created
        ? `t."${e.fields.created}" DESC`
        : `t."Z_PK" DESC`;

    const sql =
      `SELECT ${this.#placeSelect(e)} FROM "${e.table}" t ` +
      (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
      `ORDER BY ${order} LIMIT ?`;

    const raw = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return {
      rows: raw.slice(0, limit).map((r) => this.#toPlace(r)),
      truncated: raw.length > limit,
    };
  }

  /** One place by entity and row id. */
  place(kind: "favorite" | "collection-item" | "history", id: number): PlaceRow | null {
    const e = this.#entityFor(kind);
    if (!e.present) return null;
    const sql = `SELECT ${this.#placeSelect(e)} FROM "${e.table}" t WHERE t."Z_PK" = ? LIMIT 1`;
    const r = this.db.prepare(sql).get(id) as Record<string, unknown> | undefined;
    return r ? this.#toPlace(r) : null;
  }

  collections(opts: { limit: number }): { rows: CollectionRow[]; truncated: boolean } {
    const e = this.caps.collections;
    if (!e.present || e.rows === 0) return { rows: [], truncated: false };
    const limit = Math.max(1, opts.limit);
    const hasCount = e.columns.has("ZPLACESCOUNT");
    const order = e.fields.modified ? `t."${e.fields.modified}" DESC` : `t."Z_PK" DESC`;
    const sql =
      `SELECT t."Z_PK" AS id, ${this.#col(e.fields.name, "title")}, ` +
      `${hasCount ? `t."ZPLACESCOUNT" AS placesCount` : `NULL AS placesCount`}, ` +
      `${this.#col(e.fields.created, "createdRaw")}, ` +
      `${this.#col(e.fields.modified, "modifiedRaw")} ` +
      `FROM "${e.table}" t ORDER BY ${order} LIMIT ?`;
    const raw = this.db.prepare(sql).all(limit + 1) as Record<string, unknown>[];
    return {
      rows: raw.slice(0, limit).map((r) => ({
        id: Number(r.id),
        title: r.title === null || r.title === undefined ? null : String(r.title),
        placesCount: r.placesCount === null ? null : Number(r.placesCount),
        createdRaw: r.createdRaw === null ? null : Number(r.createdRaw),
        modifiedRaw: r.modifiedRaw === null ? null : Number(r.modifiedRaw),
      })),
      truncated: raw.length > limit,
    };
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
}): MapsStore => {
  const opened = openReadOnly(opts.path, opts.mode ?? "auto", {
    envVar: "APPLE_MAPS_INDEX_MODE",
    label: "Maps' place store",
    ...(opts.hint ? { hint: opts.hint } : {}),
    validate: (db) => introspect(db, opts.now),
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () =>
      opts.logger?.warn?.(
        "maps: opened immutable; places saved since the last checkpoint may be missing",
      ),
  });
  return new MapsStore({
    db: opened.db,
    caps: opened.validated,
    path: opts.path,
    mode: opened.mode,
  });
};
