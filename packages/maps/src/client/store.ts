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
 *     ZFAVORITEITEM     24 rows   ZCOLLECTION      10 rows
 *     ZCOLLECTIONITEM   30 rows   ZHISTORYITEM     34 rows
 *     ZMIXINMAPITEM     71 rows   ZREVIEWEDPLACE   24 rows
 *
 * and the id bridge, verified by running the join rather than by reading column
 * names: `ZMIXINMAPITEM`'s inverse relationships partition exactly —
 * 30 collection items + 21 favourites + 20 history rows = 71 = every row.
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
 * ## Collection membership is a JOIN TABLE, and it is VALIDATED not guessed
 *
 * MEASURED: membership is `Z_6PLACES(Z_6COLLECTIONS, Z_7PLACES)`, a Core Data
 * many-to-many. `Z_PRIMARYKEY` decodes ordinal 6 as Collection and 7 as
 * CollectionItem, so the relationship is `Collection.places`.
 *
 * Four column names were guessed here before it was found — ZCOLLECTION,
 * ZCOLLECTION1, ZPARENTCOLLECTION, ZOWNINGCOLLECTION — and the store has none
 * of them, so every guide listed empty. A many-to-many leaves NO COLUMN on
 * either entity, so no list of column names could have contained the answer.
 * The near-miss is what makes this worth stating: `ZCOLLECTIONITEM.ZMAPITEM`
 * joins `ZCOLLECTION` for 3 of 10 collections, and a resolver picking the
 * best-covered joinable column would have chosen it and been confidently wrong.
 *
 * So membership is resolved BY RUNNING THE JOIN and scoring it against an
 * oracle the store hands over for free: `ZCOLLECTION.ZPLACESCOUNT`, Maps' own
 * count per guide. A candidate is accepted only when it reproduces all ten
 * numbers exactly with no key pointing at a missing collection. That survives
 * Apple renaming the relationship, which a hard-coded `Z_6PLACES` would not.
 *
 * The oracle is not independent evidence, and it is stronger for it. Core Data
 * maintains `ZPLACESCOUNT` with a trigger that reads:
 *
 *     UPDATE ZCOLLECTION SET ZPLACESCOUNT =
 *       (SELECT IFNULL(COUNT(Z_6COLLECTIONS), 0)
 *          FROM Z_6PLACES WHERE Z_6COLLECTIONS = NEW.Z_PK)
 *
 * so Apple's own schema states the relationship this resolver re-derives. The
 * count match is therefore guaranteed for the true mechanism rather than lucky,
 * and coincidental for anything else. The triggers are visible only in the
 * captured fixture — `pnpm probe:maps --write` omits them from the replay
 * because they call Core Data's private SQLite functions, which is recorded in
 * `writeFixture`.
 *
 * Because it is many-to-many, one place can sit in several guides, and the
 * membership query uses `IN (SELECT ...)` rather than a JOIN so a place in two
 * guides is not returned twice from one of them.
 *
 * MEASURED: 30 item rows, 18 of them in a guide. The other 12 belong to no
 * collection at all; all 30 link to a `ZMIXINMAPITEM`, so they are intact
 * places rather than broken rows.
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

/**
 * The stable per-entry identifier, if this store has one.
 *
 * FOUND BY WATCHING MAPS WRITE, not by reading the schema: every row Maps
 * created during `pnpm probe:maps-write` carried `ZIDENTIFIER`, a 16-byte blob
 * — a UUID. It is not in the read probe's report because that probe only looked
 * for columns it already had candidates for, which is a good argument for
 * diffing a live write even when the read surface already works.
 *
 * `ZORIGINALIDENTIFIER` is deliberately NOT a candidate. It exists on
 * `ZCOLLECTIONITEM` and is populated on 3 rows of 30 — it records where an entry
 * was copied FROM, so it is neither complete nor unique to the entry.
 */
const IDENTIFIER_CANDIDATES = ["ZIDENTIFIER"] as const;

/**
 * Maps' own count of the places in a guide, and the oracle every membership
 * candidate is scored against. See the header.
 */
const COLLECTION_COUNT_COLUMN = "ZPLACESCOUNT";

/** Core Data's own tables, which are never a relationship. */
const RESERVED_JOIN_TABLES = new Set(["Z_METADATA", "Z_MODELCACHE", "Z_PRIMARYKEY"]);

export type FieldMap = {
  /**
   * The column holding a stable UUID, or null when this store has none good
   * enough to address rows by. See `resolveIdentifier`.
   */
  identifier: string | null;
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

/**
 * How an item says which collection it is in, once proved against the oracle.
 *
 * Two shapes because Core Data has two: a scalar foreign key named after the
 * relationship, and a `Z_<ordinal><RELATIONSHIP>` join table for a
 * many-to-many. THIS store uses the second. Both are carried because the
 * resolver proves whichever is there rather than assuming, and a store that
 * changes shape should degrade rather than read the wrong column.
 */
export type CollectionMembership =
  | { kind: "column"; column: string }
  | { kind: "joinTable"; table: string; collectionColumn: string; itemColumn: string };

export type StoreCapabilities = {
  fingerprint: string;
  tables: string[];
  favorites: EntityFacts;
  collections: EntityFacts;
  collectionItems: EntityFacts;
  history: EntityFacts;
  mapItems: EntityFacts;
  /**
   * The proved membership mechanism, or null when nothing reproduced
   * `ZPLACESCOUNT` and collections must therefore list without their places.
   */
  membership: CollectionMembership | null;
  /**
   * The membership mechanism as one short string, for diagnostics.
   *
   * Kept because `apple_maps_diagnostics` reported `collectionFk` before this
   * was understood, and a field that silently changes meaning is worse than one
   * that widens: it now names a join table as well as a column.
   */
  collectionFk: string | null;
  epoch: Epoch;
};

export type PlaceRow = {
  id: number;
  /**
   * The stable identifier, when the store has one. Null means refs on this
   * entity fall back to the row id and are only good for the session.
   */
  uuid: string | null;
  name: string | null;
  customName: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  /**
   * Apple's place id, carried as a STRING.
   *
   * MEASURED on a real store: `-2679868148951248105`. It is a 64-bit integer and
   * `node:sqlite` THROWS on one past `Number.MAX_SAFE_INTEGER` rather than
   * truncating, so reading it as a number failed the whole listing with
   * "Value is too large to be represented as a JavaScript number" — one column
   * taking down every favourite. `docs/surfaces.md` states the rule this broke:
   * read such columns as BigInt or `CAST(... AS TEXT)`.
   *
   * The fixture used a small id, so the offline suite passed. Only the real
   * store has ids of this size.
   */
  muid: string | null;
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
  uuid: string | null;
  title: string | null;
  placesCount: number | null;
  createdRaw: number | null;
  modifiedRaw: number | null;
};

/**
 * How a caller addresses one row.
 *
 * Two shapes rather than one because the store decides which is available, not
 * the caller: a store whose `ZIDENTIFIER` is complete gets durable refs, one
 * without falls back to row ids. Making the difference explicit in the type
 * means a resolver cannot quietly treat a row id as a uuid when the store
 * changed underneath it.
 */
export type EntityKey = { uuid: string } | { rowId: number };

const isRealTable = (name: string): boolean => !name.startsWith("sqlite_");

/**
 * `HEX()` of a 16-byte blob to a canonical UUID.
 *
 * Returns null on anything that is not exactly 32 hex characters. Core Data
 * stores a UUID attribute as 16 raw bytes, so a different length means the
 * column is not what this code thinks it is — and a malformed ref that still
 * looks ref-shaped would be resolved against the wrong row rather than rejected.
 */
const toUuid = (hex: unknown): string | null => {
  if (hex === null || hex === undefined) return null;
  const h = String(hex).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

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
      // COUNT() is always small. The VALUES are not — see PlaceRow.muid — so
      // nothing here ever selects the column itself.
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

/**
 * The identifier column, but ONLY if it can actually carry every ref.
 *
 * Coverage is not enough here, and this is the difference between a fix and a
 * trap. A column populated on the rows Maps has written lately and null on the
 * ones that predate it would work perfectly for every place the user saves from
 * now on and fail silently for the places they already had — the failure mode
 * hardest to notice and worst to hit, since the older entries are the ones a
 * person is most likely to ask about.
 *
 * So the bar is TOTAL: set on every row, and distinct across every row. Anything
 * less returns null and the store falls back to `Z_PK`, which is worse but
 * uniformly worse. Measured on a real store: 24/24 favourites, 30/30 collection
 * items, 10/10 collections, 33/33 recents, all distinct.
 */
const resolveIdentifier = (
  db: DatabaseSync,
  table: string,
  columns: Set<string>,
  rows: number,
): string | null => {
  const present = IDENTIFIER_CANDIDATES.filter((c) => columns.has(c));
  if (present.length === 0 || rows === 0) return null;
  for (const name of present) {
    try {
      const r = db
        .prepare(
          `SELECT COUNT("${name}") AS nset, COUNT(DISTINCT "${name}") AS ndistinct FROM "${table}"`,
        )
        .get() as { nset: number | bigint; ndistinct: number | bigint };
      if (Number(r.nset) === rows && Number(r.ndistinct) === rows) return name;
    } catch {
      continue;
    }
  }
  return null;
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
        identifier: null,
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
      identifier: resolveIdentifier(db, table, columns, rows),
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

/**
 * Maps' own places-per-guide, keyed by collection row id.
 *
 * Null when the store has no `ZPLACESCOUNT`, which changes what the resolver
 * below is allowed to accept — see `resolveMembership`.
 */
const declaredCounts = (db: DatabaseSync, collections: EntityFacts): Map<number, number> | null => {
  if (!collections.present || !collections.columns.has(COLLECTION_COUNT_COLUMN)) return null;
  try {
    const rows = db
      .prepare(`SELECT "Z_PK" AS pk, "${COLLECTION_COUNT_COLUMN}" AS n FROM "${collections.table}"`)
      .all() as { pk: number | bigint; n: number | bigint | null }[];
    return new Map(rows.map((r) => [Number(r.pk), Number(r.n ?? 0)]));
  } catch {
    return null;
  }
};

/**
 * Group a candidate's keys and count the items under each.
 *
 * Keys are read as TEXT because `ZMUID` is an INTEGER column holding 64-bit
 * place ids, and `node:sqlite` THROWS on those rather than truncating — reading
 * raw would drop the candidate into a catch instead of rejecting it on the
 * evidence. See `PlaceRow.muid`.
 */
const tally = (db: DatabaseSync, sql: string): Map<number, number> => {
  try {
    const rows = db.prepare(sql).all() as { pk: string | null; n: number | bigint }[];
    return new Map(
      rows.filter((r) => r.pk !== null).map((r) => [Number(r.pk), Number(r.n)] as const),
    );
  } catch {
    return new Map();
  }
};

/**
 * Does this candidate reproduce Maps' own counts, exactly, for every guide?
 *
 * Exactness is the whole test. `ZCOLLECTIONITEM.ZMAPITEM` matches 3 of 10
 * collections by coincidence, so "mostly right" is precisely the answer that
 * must be rejected. A key pointing at no collection at all (`unknown`) is
 * disqualifying for the same reason.
 */
const reproducesCounts = (declared: Map<number, number>, tallies: Map<number, number>): boolean => {
  for (const pk of tallies.keys()) if (!declared.has(pk)) return false;
  for (const [pk, n] of declared) if ((tallies.get(pk) ?? 0) !== n) return false;
  return true;
};

/**
 * Find how an item belongs to a collection, by running each candidate join.
 *
 * Scalar columns are tried before join tables only so the cheaper query runs
 * first; the verdict does not depend on order, because a candidate is accepted
 * only when it reproduces every count. When several would qualify the first is
 * taken, and that ambiguity cannot arise on a store whose counts are distinct.
 *
 * WITHOUT the oracle the bar changes rather than disappearing: a single join
 * table whose every key resolves on both sides is accepted, and anything
 * ambiguous is refused. That is weaker evidence, and it is the reason the
 * result is reported to callers rather than assumed.
 */
const resolveMembership = (
  db: DatabaseSync,
  collectionItems: EntityFacts,
  collections: EntityFacts,
  tables: string[],
): CollectionMembership | null => {
  if (!collectionItems.present || !collections.present) return null;
  const declared = declaredCounts(db, collections);

  if (declared) {
    for (const column of collectionItems.columns) {
      if (["Z_PK", "Z_ENT", "Z_OPT"].includes(column)) continue;
      const tallies = tally(
        db,
        `SELECT CAST(t."${column}" AS TEXT) AS pk, COUNT(*) AS n FROM "${collectionItems.table}" t
           WHERE t."${column}" IS NOT NULL GROUP BY t."${column}"`,
      );
      if (tallies.size > 0 && reproducesCounts(declared, tallies))
        return { kind: "column", column };
    }
  }

  const joinTables = tables.filter((t) => t.startsWith("Z_") && !RESERVED_JOIN_TABLES.has(t));
  const accepted: CollectionMembership[] = [];
  for (const table of joinTables) {
    const columns = columnsOf(db, table);
    // Both orientations: the column names do not say which side is which, and
    // reading `Z_6COLLECTIONS` as the collection side is an inference, not a
    // fact. On the real store the wrong orientation scores 3 of 10.
    for (const collectionColumn of columns) {
      for (const itemColumn of columns) {
        if (collectionColumn === itemColumn) continue;
        const tallies = tally(
          db,
          `SELECT CAST(j."${collectionColumn}" AS TEXT) AS pk, COUNT(*) AS n FROM "${table}" j
             JOIN "${collectionItems.table}" t ON t."Z_PK" = j."${itemColumn}"
           GROUP BY j."${collectionColumn}"`,
        );
        if (tallies.size === 0) continue;
        if (declared) {
          if (reproducesCounts(declared, tallies))
            return { kind: "joinTable", table, collectionColumn, itemColumn };
          continue;
        }
        // No oracle: demand that every key on both sides resolves to a real row.
        const orphaned = tally(
          db,
          `SELECT CAST(j."${collectionColumn}" AS TEXT) AS pk, COUNT(*) AS n FROM "${table}" j
             LEFT JOIN "${collections.table}" c ON c."Z_PK" = j."${collectionColumn}"
           WHERE c."Z_PK" IS NULL GROUP BY j."${collectionColumn}"`,
        );
        if (orphaned.size === 0)
          accepted.push({ kind: "joinTable", table, collectionColumn, itemColumn });
      }
    }
  }
  // Exactly one unambiguous reading, or nothing. Two candidates mean the
  // evidence does not distinguish them, and picking one would be a guess.
  return accepted.length === 1 ? (accepted[0] ?? null) : null;
};

/** The mechanism as one short string, for diagnostics. */
const describeMembership = (m: CollectionMembership | null): string | null => {
  if (!m) return null;
  return m.kind === "column" ? m.column : `${m.table}(${m.collectionColumn}, ${m.itemColumn})`;
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

  const membership = resolveMembership(db, collectionItems, collections, tables);

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
    membership,
    collectionFk: describeMembership(membership),
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

  /**
   * The same, for a column whose value may not fit in a JS double.
   *
   * SQLite holds 64-bit integers; a JS number holds 53 bits of them, and
   * `node:sqlite` refuses rather than silently losing precision. Casting in SQL
   * keeps the exact value and moves the decision about what to do with it out
   * of the driver.
   */
  #colText(column: string | null, alias: string, table = "t"): string {
    return column ? `CAST(${table}."${column}" AS TEXT) AS ${alias}` : `NULL AS ${alias}`;
  }

  #placeSelect(e: EntityFacts): string {
    const f = e.fields;
    return [
      `t."Z_PK" AS id`,
      f.identifier ? `HEX(t."${f.identifier}") AS uuid` : `NULL AS uuid`,
      this.#col(f.name, "name"),
      this.#col(f.customName, "customName"),
      this.#col(f.latitude, "latitude"),
      this.#col(f.longitude, "longitude"),
      this.#col(f.address, "address"),
      this.#colText(f.muid, "muid"),
      this.#col(f.created, "createdRaw"),
      this.#col(f.modified, "modifiedRaw"),
      f.mapItem ? `t."${f.mapItem}" AS mapItem` : `NULL AS mapItem`,
    ].join(", ");
  }

  #toPlace(r: Record<string, unknown>): PlaceRow {
    return {
      id: Number(r.id),
      uuid: toUuid(r.uuid),
      name: str(r.name),
      customName: str(r.customName),
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      address: str(r.address),
      // MEASURED on a real store: 12 of 20 linked favourites carry ZMUID = 0.
      // Zero is a sentinel for "no Apple place id", not an id, and reporting it
      // as one invites a caller to treat two unrelated places as the same
      // place. Only 8 of the 20 have a real id, and all 8 are 19 digits.
      muid:
        r.muid === null || r.muid === undefined || String(r.muid) === "0" ? null : String(r.muid),
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

  /**
   * Items belonging to no collection at all, or null when unanswerable.
   *
   * MEASURED: 30 collection items, 18 filed in a guide, 12 in none — and Core
   * Data has deleted nothing (`Z_PRIMARYKEY.Z_MAX` equals the live count for
   * both `Collection` and `CollectionItem`), so these are not the debris of
   * removed guides. 7 of the 12 appear nowhere else in the store: not as a
   * favourite, not in another guide, not in recents. They are places the user
   * saved that no other tool can reach.
   *
   * `NOT IN` needs the null guard. A subquery yielding a single NULL makes
   * `NOT IN` false for EVERY row, so the filter would silently return nothing
   * and read as "you have no unfiled places" — the failure this whole surface
   * keeps having to design against.
   */
  #unfiledClause(): string | null {
    const m = this.caps.membership;
    if (!m) return null;
    if (m.kind === "column") return `t."${m.column}" IS NULL`;
    return (
      `t."Z_PK" NOT IN (SELECT j."${m.itemColumn}" FROM "${m.table}" j ` +
      `WHERE j."${m.itemColumn}" IS NOT NULL)`
    );
  }

  /** How many collection items are filed in no collection; null when unknown. */
  unfiledCount(): number | null {
    const e = this.caps.collectionItems;
    const clause = this.#unfiledClause();
    if (!e.present || !clause) return null;
    try {
      return Number(
        (
          this.db.prepare(`SELECT COUNT(*) AS c FROM "${e.table}" t WHERE ${clause}`).get() as {
            c: number | bigint;
          }
        ).c,
      );
    } catch {
      return null;
    }
  }

  /** One entity's places, newest first when a date is available. */
  places(
    kind: "favorite" | "collection-item" | "history",
    opts: {
      limit: number;
      collectionId?: number | undefined;
      query?: string | undefined;
      /** Only items filed in NO collection. See `#unfiledClause`. */
      unfiled?: boolean | undefined;
    },
  ): { rows: PlaceRow[]; truncated: boolean } {
    const e = this.#entityFor(kind);
    if (!e.present || e.rows === 0) return { rows: [], truncated: false };

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts.collectionId !== undefined) {
      const m = this.caps.membership;
      // Nothing reproduced ZPLACESCOUNT, so which places are in this guide is
      // genuinely unknown. Empty is the honest answer and callers are told why.
      if (!m) return { rows: [], truncated: false };
      if (m.kind === "column") {
        where.push(`t."${m.column}" = ?`);
      } else {
        // IN, not JOIN, because the question is set membership: is this item
        // in this guide. A JOIN also multiplies the row by the number of
        // matching join rows, which is 1 today only because Core Data gives the
        // table a compound primary key — a property of the schema rather than
        // of the query. IN does not depend on it.
        where.push(
          `t."Z_PK" IN (SELECT j."${m.itemColumn}" FROM "${m.table}" j ` +
            `WHERE j."${m.collectionColumn}" = ?)`,
        );
      }
      params.push(opts.collectionId);
    }

    if (opts.unfiled) {
      const clause = this.#unfiledClause();
      // Membership is unresolved, so "in no collection" is not a question this
      // store can answer either. Empty, and the caller is told why.
      if (!clause) return { rows: [], truncated: false };
      where.push(clause);
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

  /**
   * The WHERE clause and parameter for one key, or null when the key cannot be
   * honoured against this entity.
   *
   * A uuid key against a store with no resolved identifier column returns null
   * rather than falling back to the row id. The two number spaces are unrelated,
   * so a fallback would resolve to a real but WRONG place — the one outcome
   * worse than not finding it.
   *
   * `HEX()` on both sides rather than `X'..'` literal: it keeps the comparison
   * in one form, and these tables are tens of rows, so the lost index is free.
   */
  #keyClause(e: EntityFacts, key: EntityKey): { sql: string; param: string | number } | null {
    if ("uuid" in key) {
      if (!e.fields.identifier) return null;
      return {
        sql: `HEX(t."${e.fields.identifier}") = ?`,
        param: key.uuid.replaceAll("-", "").toUpperCase(),
      };
    }
    return { sql: `t."Z_PK" = ?`, param: key.rowId };
  }

  /** One place by entity and key. */
  place(kind: "favorite" | "collection-item" | "history", key: EntityKey): PlaceRow | null {
    const e = this.#entityFor(kind);
    if (!e.present) return null;
    const clause = this.#keyClause(e, key);
    if (!clause) return null;
    const sql = `SELECT ${this.#placeSelect(e)} FROM "${e.table}" t WHERE ${clause.sql} LIMIT 1`;
    const r = this.db.prepare(sql).get(clause.param) as Record<string, unknown> | undefined;
    return r ? this.#toPlace(r) : null;
  }

  /**
   * A collection key to the row id its items point at.
   *
   * Collection membership is a Core Data foreign key, so it holds `Z_PK` values
   * whatever the ref carries. A uuid ref has to be translated before it can
   * filter items, and this is the one place that happens.
   */
  collectionRowId(key: EntityKey): number | null {
    if (!("uuid" in key)) return key.rowId;
    const e = this.caps.collections;
    const clause = this.#keyClause(e, key);
    if (!e.present || !clause) return null;
    const r = this.db
      .prepare(`SELECT t."Z_PK" AS id FROM "${e.table}" t WHERE ${clause.sql} LIMIT 1`)
      .get(clause.param) as { id: number | bigint } | undefined;
    return r ? Number(r.id) : null;
  }

  collections(opts: { limit: number }): { rows: CollectionRow[]; truncated: boolean } {
    const e = this.caps.collections;
    if (!e.present || e.rows === 0) return { rows: [], truncated: false };
    const limit = Math.max(1, opts.limit);
    const hasCount = e.columns.has("ZPLACESCOUNT");
    const order = e.fields.modified ? `t."${e.fields.modified}" DESC` : `t."Z_PK" DESC`;
    const sql =
      `SELECT t."Z_PK" AS id, ` +
      `${e.fields.identifier ? `HEX(t."${e.fields.identifier}") AS uuid` : `NULL AS uuid`}, ` +
      `${this.#col(e.fields.name, "title")}, ` +
      `${hasCount ? `t."ZPLACESCOUNT" AS placesCount` : `NULL AS placesCount`}, ` +
      `${this.#col(e.fields.created, "createdRaw")}, ` +
      `${this.#col(e.fields.modified, "modifiedRaw")} ` +
      `FROM "${e.table}" t ORDER BY ${order} LIMIT ?`;
    const raw = this.db.prepare(sql).all(limit + 1) as Record<string, unknown>[];
    return {
      rows: raw.slice(0, limit).map((r) => ({
        id: Number(r.id),
        uuid: toUuid(r.uuid),
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
