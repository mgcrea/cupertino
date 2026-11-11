import { DatabaseSync } from "node:sqlite";

import type { EntityKey } from "./store.js";
import { defaultOpenUrl, MapsWriteError, type OpenUrl } from "./write.js";

/**
 * Finding a place record for the store lane, without writing anything.
 *
 * The store lane saves through Maps' own Core Data model, and it can only COPY
 * a place record (`ZMIXINMAPITEM.ZMAPITEMSTORAGE`) that Maps minted — the same
 * rule `write.ts` explains at length: the record is a GEO protobuf nobody here
 * can generate, and a fabricated one would reach every device on the account.
 * So before the lane is asked to write, this finds a record to copy and names
 * the item that OWNS it, by that item's `ZIDENTIFIER`, because the lane fetches
 * through the model by uuid, not by row id.
 *
 * Two ways to get one, in order, both lifted from `MapsWriter.addFavorite`:
 *
 *   1. A record already in the store within about a metre of the coordinate,
 *      owned by a favourite, a saved place or a recent. Costs nothing.
 *   2. Seeding: open `maps://?q=<query>` and poll Recents above a watermark for
 *      the record Maps files there. Leaves a Recents entry, which is why the
 *      first way is always tried first.
 *
 * Every connection here is read-only, and none is held across the seed: Maps is
 * being asked to write the very row being waited for.
 */

/** The owning item's kind, as the Swift lane's `MapsWriter.SourceKind` spells it. */
export type SourceKind = "favorite" | "savedPlace" | "recent";

export type PlaceSource = {
  kind: SourceKind;
  /** The owning item's `ZIDENTIFIER`, as a lowercase dashed uuid. */
  id: string;
  /** The record's own coordinate, which is Maps' canonical one. */
  latitude: number;
  longitude: number;
  /** True when Maps had to be asked to resolve the place, leaving a Recents entry. */
  seeded: boolean;
};

const STORAGE_POLL_MS = 250;

/** A pause that yields the event loop, unlike `Atomics.wait`, which does not. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Progress, on stderr: stdout carries the MCP protocol. See `write.ts`. */
const progress = (message: string): void => {
  process.stderr.write(`[apple-maps-mcp] ${message}\n`);
};

/**
 * Same doorway: 1e-5 degrees is ~1.1 m of latitude. Close enough that two rows
 * are one place, far enough apart that neighbouring shops are not merged.
 */
const NEAR = 1e-5;

/**
 * How far a resolved place may sit from the caller's coordinate: ~250 m. The
 * caller's number and Apple's routinely differ by a building's width, and a
 * search resolves to the entrance rather than the pin.
 */
const SEED_TOLERANCE = 2.5e-3;

const near = (aLat: number, aLon: number, bLat: number, bLon: number): boolean =>
  Math.abs(aLat - bLat) <= SEED_TOLERANCE && Math.abs(aLon - bLon) <= SEED_TOLERANCE;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Metres between two coordinates, for the error message only. */
const haversineMetres = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
};

/** `HEX(ZIDENTIFIER)` to the dashed lowercase form `write.ts`'s `uuidOf` produces. */
const uuidOfHex = (hex: unknown): string | null => {
  if (typeof hex !== "string") return null;
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * A row's entity, by name.
 *
 * `ZCOLLECTIONITEM` holds both `CollectionPlaceItem` and `CollectionTransitItem`
 * rows, and `ZHISTORYITEM` more than places, so the table alone does not say a
 * row is a saved place or a recent place. A missing entity yields NULL, and a
 * comparison with NULL matches nothing, which is the right answer for a store
 * that has no such entity.
 */
const entityIs = (alias: string, name: "CollectionPlaceItem" | "HistoryPlaceItem"): string =>
  `${alias}."Z_ENT" = (SELECT "Z_ENT" FROM "Z_PRIMARYKEY" WHERE "Z_NAME" = '${name}')`;

/**
 * An identifier the lane can be given: present and the 16 bytes of a uuid. A
 * row without one cannot be named to the lane, which fetches by uuid only.
 */
const named = (alias: string): string => `LENGTH(${alias}."ZIDENTIFIER") = 16`;

const TABLE_OF: Record<"favorite" | "collection-item" | "history", string> = {
  favorite: "ZFAVORITEITEM",
  "collection-item": "ZCOLLECTIONITEM",
  history: "ZHISTORYITEM",
};

type SourceRow = { kind: SourceKind; hex: string; lat: number; lon: number };

/**
 * A favourite or saved place as it stands in the store, for a tool's answer.
 *
 * The name is the label when the user set one, else the place's own name, as
 * the read tools render it. The coordinate is the item's, else its map
 * item's: a field the store does not hold is null, never the caller's guess.
 */
export type StoredPlace = {
  id: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class PlaceSourceFinder {
  readonly #path: string;
  readonly #openUrl: OpenUrl;
  readonly #seedTimeoutMs: number;

  constructor(opts: { storePath: string; openUrl?: OpenUrl; seedTimeoutMs?: number }) {
    this.#path = opts.storePath;
    this.#openUrl = opts.openUrl ?? defaultOpenUrl;
    this.#seedTimeoutMs = opts.seedTimeoutMs ?? 30_000;
  }

  /**
   * A short-lived read-only handle per use. Under WAL a connection that has
   * begun reading holds a snapshot and may not see another process's commits,
   * so a handle is never kept between calls.
   */
  #read<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.#path, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /**
   * An existing item in `table` for this place, matched as `write.ts` matches
   * favourites: a TIGHT coordinate (~1 m) when both numbers came from Maps, or
   * the NAME plus a LOOSE coordinate (~250 m) for a caller's own coordinate.
   * The name is what makes the loose radius safe: it only merges rows the
   * caller already calls the same thing.
   */
  #existing(
    table: string,
    where: string,
    q: { latitude: number; longitude: number; name?: string | undefined },
  ): StoredPlace | null {
    return this.#read((db) => {
      const select = `SELECT HEX(t."ZIDENTIFIER") AS hex FROM "${table}" t
                       WHERE ${where} AND ${named("t")}
                         AND t."ZLATITUDE" BETWEEN ? AND ? AND t."ZLONGITUDE" BETWEEN ? AND ?`;
      const { latitude: lat, longitude: lon } = q;
      const tight = db
        .prepare(`${select} LIMIT 1`)
        .get(lat - NEAR, lat + NEAR, lon - NEAR, lon + NEAR) as { hex: string } | undefined;
      const row =
        tight ??
        (q.name === undefined
          ? undefined
          : (db
              .prepare(`${select} AND t."ZMAPITEMNAME" = ? LIMIT 1`)
              .get(
                lat - SEED_TOLERANCE,
                lat + SEED_TOLERANCE,
                lon - SEED_TOLERANCE,
                lon + SEED_TOLERANCE,
                q.name,
              ) as { hex: string } | undefined));
      return row ? this.#describeIn(db, table, row.hex) : null;
    });
  }

  /** The row with this `HEX(ZIDENTIFIER)` in `table`, described, or null. */
  #describeIn(db: DatabaseSync, table: string, hex: string): StoredPlace | null {
    const id = uuidOfHex(hex);
    if (!id) return null;
    const row = db
      .prepare(
        `SELECT COALESCE(t."ZCUSTOMNAME", t."ZMAPITEMNAME") AS name,
                COALESCE(t."ZLATITUDE", m."ZLATITUDE") AS lat,
                COALESCE(t."ZLONGITUDE", m."ZLONGITUDE") AS lon
           FROM "${table}" t LEFT JOIN "ZMIXINMAPITEM" m ON m."Z_PK" = t."ZMAPITEM"
          WHERE HEX(t."ZIDENTIFIER") = ? LIMIT 1`,
      )
      .get(hex.toUpperCase()) as { name: unknown; lat: unknown; lon: unknown } | undefined;
    if (!row) return null;
    return { id, name: str(row.name), latitude: num(row.lat), longitude: num(row.lon) };
  }

  /**
   * Read back a favourite or saved place by the identifier the lane answered
   * with, so a tool reports the item as it stands rather than what was asked
   * for. Null when no such row is in the store (yet), or `id` is not a uuid.
   */
  describe(kind: "favorite" | "collection-item", id: string): StoredPlace | null {
    const hex = id.replaceAll("-", "").toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(hex)) return null;
    return this.#read((db) => this.#describeIn(db, TABLE_OF[kind], hex));
  }

  /** An existing favourite for this place. Idempotence for `add_favorite`. */
  existingFavorite(q: { latitude: number; longitude: number; name?: string }): StoredPlace | null {
    return this.#existing("ZFAVORITEITEM", "1 = 1", q);
  }

  /** An existing saved place (a `CollectionPlaceItem`) for this place. */
  existingSavedPlace(q: {
    latitude: number;
    longitude: number;
    name?: string;
  }): StoredPlace | null {
    return this.#existing("ZCOLLECTIONITEM", entityIs("t", "CollectionPlaceItem"), q);
  }

  /**
   * A record already in the store within ~1 m, with an owner the lane can be
   * given. Favourites first, then saved places, then recents: the record is the
   * same object whichever row points at it, so the order only makes the answer
   * deterministic.
   */
  #donorNear(db: DatabaseSync, lat: number, lon: number): SourceRow | null {
    const row = db
      .prepare(
        `WITH near AS (
           SELECT m."Z_PK" AS pk, m."ZLATITUDE" AS lat, m."ZLONGITUDE" AS lon
             FROM "ZMIXINMAPITEM" m
            WHERE m."ZMAPITEMSTORAGE" IS NOT NULL
              AND m."ZLATITUDE" BETWEEN ? AND ? AND m."ZLONGITUDE" BETWEEN ? AND ?
         )
         SELECT kind, hex, lat, lon FROM (
           SELECT 0 AS rank, 'favorite' AS kind, HEX(f."ZIDENTIFIER") AS hex, n.lat, n.lon
             FROM near n JOIN "ZFAVORITEITEM" f ON f."ZMAPITEM" = n.pk
            WHERE ${named("f")}
           UNION ALL
           SELECT 1, 'savedPlace', HEX(ci."ZIDENTIFIER"), n.lat, n.lon
             FROM near n JOIN "ZCOLLECTIONITEM" ci ON ci."ZMAPITEM" = n.pk
            WHERE ${named("ci")} AND ${entityIs("ci", "CollectionPlaceItem")}
           UNION ALL
           SELECT 2, 'recent', HEX(h."ZIDENTIFIER"), n.lat, n.lon
             FROM near n JOIN "ZHISTORYITEM" h ON h."ZMAPITEM" = n.pk
            WHERE ${named("h")} AND ${entityIs("h", "HistoryPlaceItem")}
         )
         ORDER BY rank LIMIT 1`,
      )
      .get(lat - NEAR, lat + NEAR, lon - NEAR, lon + NEAR) as SourceRow | undefined;
    return row ?? null;
  }

  /** The newest recent place carrying a record, above a watermark. */
  #seededDonor(db: DatabaseSync, sinceHistoryPk: number): SourceRow | null {
    const row = db
      .prepare(
        `SELECT 'recent' AS kind, HEX(h."ZIDENTIFIER") AS hex,
                m."ZLATITUDE" AS lat, m."ZLONGITUDE" AS lon
           FROM "ZHISTORYITEM" h
           JOIN "ZMIXINMAPITEM" m ON m."Z_PK" = h."ZMAPITEM"
          WHERE h."Z_PK" > ? AND m."ZMAPITEMSTORAGE" IS NOT NULL
            AND ${named("h")} AND ${entityIs("h", "HistoryPlaceItem")}
          ORDER BY h."Z_PK" DESC LIMIT 1`,
      )
      .get(sinceHistoryPk) as SourceRow | undefined;
    return row ?? null;
  }

  #maxHistory(db: DatabaseSync): number {
    const row = db.prepare(`SELECT MAX(Z_PK) AS m FROM ZHISTORYITEM`).get() as
      | { m: number | bigint | null }
      | undefined;
    return Number(row?.m ?? 0);
  }

  #toSource(row: SourceRow, seeded: boolean): PlaceSource {
    const id = uuidOfHex(row.hex);
    // The SQL admits only 16-byte identifiers, so this cannot fail; the check
    // keeps a malformed row from ever being named to the lane as "".
    if (!id) throw new MapsWriteError("A place record's owner has no usable identifier.");
    return {
      kind: row.kind,
      id,
      latitude: Number(row.lat),
      longitude: Number(row.lon),
      seeded,
    };
  }

  /**
   * A place record for `query`: one already in the store near the coordinate,
   * else one Maps mints on being asked. Refuses a resolution more than ~250 m
   * from the coordinate given, and a seed that produces nothing in time.
   *
   * Async because the seed can take thirty seconds, and a blocking wait would
   * leave this single-threaded stdio server unable to answer anything.
   */
  async find(q: { query: string; latitude?: number; longitude?: number }): Promise<PlaceSource> {
    const hasCoords = q.latitude !== undefined && q.longitude !== undefined;
    const lat = q.latitude ?? 0;
    const lon = q.longitude ?? 0;

    // ── 1. read ──────────────────────────────────────────────────────────────
    progress(`finding a place record for ${JSON.stringify(q.query)}: reading the store`);
    const { donor, watermark } = this.#read((db) => ({
      donor: hasCoords ? this.#donorNear(db, lat, lon) : null,
      watermark: this.#maxHistory(db),
    }));
    if (donor) return this.#toSource(donor, false);

    // ── 2. seed, holding nothing ─────────────────────────────────────────────
    // No coordinate in the URL: `?q=<name>` is the form measured to make Maps
    // file a recent with a record; with `&ll=` it files nothing. See `write.ts`.
    const url = `maps://?q=${encodeURIComponent(q.query)}`;
    progress(`asking Maps to resolve ${JSON.stringify(q.query)}…`);
    await this.#openUrl(url);
    progress(`opened, waiting up to ${Math.round(this.#seedTimeoutMs / 1000)}s for a record`);
    const deadline = Date.now() + this.#seedTimeoutMs;
    let seeded: SourceRow | null = null;
    let polls = 0;
    while (Date.now() < deadline && !seeded) {
      seeded = this.#read((db) => this.#seededDonor(db, watermark));
      if (!seeded) await sleep(STORAGE_POLL_MS);
      polls += 1;
      if (polls % 8 === 0) progress(`still waiting (${polls * (STORAGE_POLL_MS / 1000)}s)…`);
    }

    if (!seeded) {
      throw new MapsWriteError(
        `Maps did not produce a place record for "${q.query}" within ` +
          `${Math.round(this.#seedTimeoutMs / 1000)}s. Maps must be RUNNING for this to work — ` +
          `it is the only thing that can create a place record. It may also have resolved the ` +
          `query to a search rather than a place, since searches get no record. Try a more ` +
          `specific name, or pass latitude and longitude.`,
        { query: q.query },
      );
    }
    if (hasCoords && !near(Number(seeded.lat), Number(seeded.lon), lat, lon)) {
      // Maps resolved SOMETHING, but not the place asked for. Copying its record
      // would save the wrong place to every device, so this refuses.
      throw new MapsWriteError(
        `Maps resolved ${JSON.stringify(q.query)} to a place about ` +
          `${Math.round(haversineMetres(Number(seeded.lat), Number(seeded.lon), lat, lon))}m from the coordinate ` +
          `given, so it is probably not the place meant. Nothing was saved — try a more ` +
          `specific name.`,
        { query: q.query },
      );
    }
    progress(`got a place record after ${polls} polls`);
    return this.#toSource(seeded, true);
  }

  /**
   * The `ZIDENTIFIER` of the row a read tool's ref names, or null when the row
   * is not there or has no identifier — a row-id-only ref the lane, which
   * fetches by uuid, cannot be given.
   */
  identifierOf(kind: "favorite" | "collection-item" | "history", key: EntityKey): string | null {
    const table = TABLE_OF[kind];
    const [where, param] =
      "uuid" in key
        ? [`HEX("ZIDENTIFIER") = ?`, key.uuid.replaceAll("-", "").toUpperCase()]
        : [`"Z_PK" = ?`, key.rowId];
    return this.#read((db) => {
      const row = db
        .prepare(`SELECT HEX("ZIDENTIFIER") AS hex FROM "${table}" WHERE ${where} LIMIT 1`)
        .get(param) as { hex: string | null } | undefined;
      return uuidOfHex(row?.hex);
    });
  }
}
