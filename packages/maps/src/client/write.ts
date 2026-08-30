import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { AppleAutomationError } from "@mgcrea/mcp-apple-core";

import { CORE_DATA_EPOCH_OFFSET } from "./dates.js";
import type { EntityKey } from "./store.js";

/**
 * Writing to Maps' store.
 *
 * ## Why this is SQL and not the app's own API
 *
 * Maps ships no scripting dictionary and registers no App Intents on macOS, so
 * there is no lane where the app performs the write on our behalf. Every other
 * surface in this repo writes through an Apple Event; this one cannot, and the
 * alternatives were measured rather than assumed — see `docs/maps.md`.
 *
 * ## The one thing that cannot be synthesised, and how it is obtained anyway
 *
 * A place is only real to Maps if it has a `ZMAPITEMSTORAGE` — a GEO protobuf of
 * one to four kilobytes that this repo has never decoded and cannot generate.
 *
 * It does not have to. **Opening a place makes Maps write one.**
 * `maps://?q=<name>&ll=<lat>,<lon>` goes through LaunchServices — not Apple
 * Events, not Accessibility — and Maps resolves the place and records it in
 * Recents with a full record attached. That record is then copied into the new
 * favourite. The blob is always minted by Maps, which is the only thing that can
 * mint one correctly.
 *
 * MEASURED consequences of that design, all of them in `docs/maps.md`:
 *
 *   * The insert needs THREE tables — the favourite, its map item, and the two
 *     `Z_PRIMARYKEY` counters. Not the eight the app touches.
 *   * No persistent history and no `NSCK*` metadata is written. Core Data
 *     reconciles unregistered objects on the app's next save and mirrors them to
 *     iCloud by itself; a favourite written this way reached another device.
 *   * It works with Maps RUNNING, and survives a subsequent save by the app.
 *     There is no need to quit anything.
 *
 * ## The cost the caller must be told about
 *
 * Seeding leaves the place in the user's **Recents**, whether or not the
 * favourite is kept. That is unavoidable — it is the mechanism — so every tool
 * built on this says so in its description rather than springing it on somebody.
 *
 * ## Why writes are dangerous here in a way the other surfaces are not
 *
 * The store is mirrored by `NSPersistentCloudKitContainer`, and mirroring does
 * not wait to be told. A malformed row is not a local mistake: it reaches every
 * device on the account as soon as Maps next runs. There is no such thing as a
 * local-only insert here — that was believed for a while and measured false.
 * Hence: never fabricate a place record, only ever copy one Maps wrote.
 */

const STORAGE_POLL_MS = 250;

/**
 * Progress, on stderr.
 *
 * Adding a favourite can take tens of seconds — Maps has to resolve a place over
 * the network before there is anything to copy — and the first version said
 * NOTHING for the whole of it. That is indistinguishable from a hang, and was
 * reported as one three times while three different theories were tried. A long
 * operation that reports nothing cannot be diagnosed, only guessed at.
 *
 * stderr because this is an MCP stdio server: stdout carries the protocol, and
 * the server already writes its banner here.
 */
const progress = (message: string): void => {
  process.stderr.write(`[apple-maps-mcp] ${message}\n`);
};

export class MapsWriteError extends AppleAutomationError {
  override readonly name = "MapsWriteError";
}

/** Injected so tests never launch an application. */
export type OpenUrl = (url: string) => void;

export const defaultOpenUrl: OpenUrl = (url) => {
  // `-g` so the user's foreground app is not stolen. `timeout` because a wedged
  // LaunchServices would otherwise block forever, and this runs inside a tool
  // call somebody is waiting on.
  execFileSync("/usr/bin/open", ["-g", url], { timeout: 10_000, stdio: "ignore" });
};

export type AddFavoriteInput = {
  /** What to search for. A name; a bare coordinate does NOT open a place card. */
  query: string;
  latitude?: number | undefined;
  longitude?: number | undefined;
  /** The label to store. Defaults to `query`. */
  name?: string | undefined;
};

export type AddFavoriteResult = {
  rowId: number;
  uuid: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  /** False when an equivalent favourite already existed and was returned as-is. */
  created: boolean;
  /** True when Maps had to be asked to resolve the place, leaving a Recents entry. */
  seeded: boolean;
};

/** The columns needed to return an existing favourite without re-reading it. */
type ExistingFavorite = {
  pk: number;
  hex: string;
  name: string | null;
  lat: number;
  lon: number;
};

type Donor = {
  mapPk: number;
  lat: number;
  lon: number;
  name: string | null;
  address: string | null;
  category: string | null;
  muid: string | null;
  storage: Uint8Array;
};

const uuidBytes = (): Uint8Array =>
  Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));

const uuidOf = (bytes: Uint8Array): string => {
  const h = Buffer.from(bytes).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * Coordinates are floats and never compare exactly across sources, so identity
 * is "within about a metre" rather than equality. 1e-5 degrees is ~1.1 m of
 * latitude — close enough that two rows are the same doorway, far enough apart
 * that neighbouring shops are not merged.
 */
const NEAR = 1e-5;

/** Same doorway, within about a metre. */
const near = (aLat: number, aLon: number, bLat: number, bLon: number): boolean =>
  Math.abs(aLat - bLat) <= SEED_TOLERANCE && Math.abs(aLon - bLon) <= SEED_TOLERANCE;

/**
 * How far a seeded place may sit from the coordinate the caller gave.
 *
 * Far looser than `NEAR`: the caller's coordinate and Apple's for the same place
 * routinely differ by a building's width, and a search resolves to the entrance
 * rather than the pin. ~250 m accepts that and still rejects a different town.
 */
const SEED_TOLERANCE = 2.5e-3;

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

export class MapsWriter {
  readonly #path: string;
  readonly #openUrl: OpenUrl;
  readonly #seedTimeoutMs: number;

  constructor(opts: { storePath: string; openUrl?: OpenUrl; seedTimeoutMs?: number }) {
    this.#path = opts.storePath;
    this.#openUrl = opts.openUrl ?? defaultOpenUrl;
    this.#seedTimeoutMs = opts.seedTimeoutMs ?? 30_000;
  }

  /**
   * A read-write handle.
   *
   * `busy_timeout` is not optional: Maps and `mapssyncd` hold this store open,
   * and without it a write during ordinary use is refused outright rather than
   * waiting for the lock the way any other SQLite client would.
   */
  #open(): DatabaseSync {
    const db = new DatabaseSync(this.#path);
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  #entity(db: DatabaseSync, name: string): number {
    const row = db.prepare(`SELECT Z_ENT AS e FROM Z_PRIMARYKEY WHERE Z_NAME = ?`).get(name) as
      | { e: number | bigint }
      | undefined;
    if (!row)
      throw new MapsWriteError(`This store has no "${name}" entity, so it cannot be written.`);
    return Number(row.e);
  }

  /**
   * The next primary key: one past whichever is HIGHER, the counter or the
   * highest row actually present.
   *
   * `Z_PRIMARYKEY.Z_MAX` is the counter Core Data maintains, and trusting it
   * alone is what a first version did. It is not always current — Maps can be
   * mid-write, a crash can leave it behind, and a foreign writer that forgot to
   * bump it (a mistake this very file guards against making) leaves it stale
   * forever. Taking `MAX(Z_PK)` as well costs one indexed lookup and makes a
   * collision impossible rather than unlikely.
   *
   * Found by a test whose stand-in for Maps inserted a row without bumping the
   * counter. The stand-in was unfaithful; the bug it exposed was not.
   */
  #nextPk(db: DatabaseSync, name: string, table: string): number {
    const counter = db.prepare(`SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE Z_NAME = ?`).get(name) as
      | { m: number | bigint }
      | undefined;
    const highest = db.prepare(`SELECT MAX(Z_PK) AS m FROM "${table}"`).get() as
      | { m: number | bigint | null }
      | undefined;
    return Math.max(Number(counter?.m ?? 0), Number(highest?.m ?? 0)) + 1;
  }

  /**
   * An existing favourite for this place.
   *
   * Two ways to match, because a coordinate alone is not enough in either
   * direction. TIGHT coordinate (~1 m) catches the canonical case, where both
   * numbers came from Maps. NAME plus a LOOSE coordinate (~250 m) catches the
   * case that matters to a caller: it passed its own coordinate, which differs
   * from Apple's by a building's width — measured at 6.9e-5 for Sagrada Família.
   *
   * Without the second, every repeated call re-seeded before discovering the
   * duplicate, leaving a Recents entry each time for a favourite it then did not
   * create. Loosening the coordinate ALONE was the wrong fix: two different shops
   * 200 m apart would merge. Requiring the name as well makes the loose radius
   * safe, because it only ever merges rows the caller already calls the same
   * thing.
   */
  #existingFavorite(db: DatabaseSync, lat: number, lon: number, name?: string) {
    const tight = db
      .prepare(
        `SELECT Z_PK AS pk, HEX(ZIDENTIFIER) AS hex, ZMAPITEMNAME AS name,
                ZLATITUDE AS lat, ZLONGITUDE AS lon
           FROM ZFAVORITEITEM
          WHERE ZLATITUDE BETWEEN ? AND ? AND ZLONGITUDE BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(lat - NEAR, lat + NEAR, lon - NEAR, lon + NEAR) as ExistingFavorite | undefined;
    if (tight || !name) return tight;

    return db
      .prepare(
        `SELECT Z_PK AS pk, HEX(ZIDENTIFIER) AS hex, ZMAPITEMNAME AS name,
                ZLATITUDE AS lat, ZLONGITUDE AS lon
           FROM ZFAVORITEITEM
          WHERE ZMAPITEMNAME = ?
            AND ZLATITUDE BETWEEN ? AND ? AND ZLONGITUDE BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(
        name,
        lat - SEED_TOLERANCE,
        lat + SEED_TOLERANCE,
        lon - SEED_TOLERANCE,
        lon + SEED_TOLERANCE,
      ) as ExistingFavorite | undefined;
  }

  /**
   * A place record already in the store for this coordinate.
   *
   * Checked before seeding, so asking for somewhere the user has already looked
   * at costs no Recents entry and no network round trip. Recents, collection
   * items and other favourites are all valid sources — the record is the same
   * object whichever row points at it.
   */
  #donorNear(db: DatabaseSync, lat: number, lon: number): Donor | null {
    const row = db
      .prepare(
        `SELECT m."Z_PK" AS mapPk, m."ZLATITUDE" AS lat, m."ZLONGITUDE" AS lon,
                m."ZMAPITEMSTORAGE" AS storage,
                COALESCE(f."ZMAPITEMNAME", ci."ZMAPITEMNAME") AS name,
                COALESCE(f."ZMAPITEMADDRESS", ci."ZMAPITEMADDRESS") AS address,
                COALESCE(f."ZMAPITEMCATEGORY", ci."ZMAPITEMCATEGORY") AS category,
                CAST(COALESCE(f."ZMUID", ci."ZMUID") AS TEXT) AS muid
           FROM "ZMIXINMAPITEM" m
           LEFT JOIN "ZFAVORITEITEM" f ON f."ZMAPITEM" = m."Z_PK"
           LEFT JOIN "ZCOLLECTIONITEM" ci ON ci."ZMAPITEM" = m."Z_PK"
          WHERE m."ZMAPITEMSTORAGE" IS NOT NULL
            AND m."ZLATITUDE" BETWEEN ? AND ? AND m."ZLONGITUDE" BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(lat - NEAR, lat + NEAR, lon - NEAR, lon + NEAR) as Donor | undefined;
    return row ?? null;
  }

  /** The newest recent carrying a place record, above a watermark. */
  #seededDonor(db: DatabaseSync, sinceHistoryPk: number): Donor | null {
    const row = db
      .prepare(
        `SELECT m."Z_PK" AS mapPk, m."ZLATITUDE" AS lat, m."ZLONGITUDE" AS lon,
                m."ZMAPITEMSTORAGE" AS storage,
                h."ZCUSTOMNAME" AS name, NULL AS address, NULL AS category,
                CAST(h."ZMUID" AS TEXT) AS muid
           FROM "ZHISTORYITEM" h
           JOIN "ZMIXINMAPITEM" m ON m."Z_PK" = h."ZMAPITEM"
          WHERE h."Z_PK" > ? AND m."ZMAPITEMSTORAGE" IS NOT NULL
          ORDER BY h."Z_PK" DESC LIMIT 1`,
      )
      .get(sinceHistoryPk) as Donor | undefined;
    return row ?? null;
  }

  #maxHistory(db: DatabaseSync): number {
    const row = db.prepare(`SELECT MAX(Z_PK) AS m FROM ZHISTORYITEM`).get() as
      | { m: number | bigint | null }
      | undefined;
    return Number(row?.m ?? 0);
  }

  /**
   * Add a favourite, in three phases with a connection open for as little of it
   * as possible.
   *
   * THE PHASES ARE THE POINT. A first version opened one read-write handle at the
   * top and held it across the whole seed — including the wait for Maps to
   * resolve a place, which can run to tens of seconds. That hung: Maps is being
   * asked to WRITE the very record being waited for, into a store this process is
   * holding open for writing. Whatever the precise interaction, the shape was a
   * departure from the sequence that had been proven by hand, and the proven
   * sequence never holds a write handle while waiting on the app.
   *
   *   1. READ  — look for an existing favourite and an existing place record.
   *   2. SEED  — ask Maps to mint a record, holding NO connection at all, and
   *              poll with a short-lived read-only handle each time.
   *   3. WRITE — open read-write, insert, close.
   */
  addFavorite(input: AddFavoriteInput): AddFavoriteResult {
    const hasCoords = input.latitude !== undefined && input.longitude !== undefined;
    const lat = input.latitude ?? 0;
    const lon = input.longitude ?? 0;

    // ── 1. read ──────────────────────────────────────────────────────────────
    progress(`add_favorite ${JSON.stringify(input.query)}: reading the store`);
    const ro = new DatabaseSync(this.#path, { readOnly: true });
    let existing: {
      pk: number;
      hex: string;
      name: string | null;
      lat: number;
      lon: number;
    } | null = null;
    let donor: Donor | null = null;
    let watermark = 0;
    try {
      if (hasCoords) {
        existing = this.#existingFavorite(ro, lat, lon, input.name ?? input.query) ?? null;
        donor = this.#donorNear(ro, lat, lon);
      }
      watermark = this.#maxHistory(ro);
    } finally {
      ro.close();
    }

    if (existing) {
      // Idempotent on purpose. A model that retries must not produce two
      // favourites for one place — and Maps HIDES the duplicate in its own UI,
      // so the store would disagree with the app invisibly.
      return {
        rowId: Number(existing.pk),
        uuid: uuidOf(Buffer.from(existing.hex, "hex")),
        name: existing.name,
        latitude: Number(existing.lat),
        longitude: Number(existing.lon),
        created: false,
        seeded: false,
      };
    }

    // ── 2. seed, holding nothing ─────────────────────────────────────────────
    let seeded = false;
    if (!donor) {
      /*
       * THE SEED URL CARRIES NO COORDINATE, and that is measured rather than
       * stylistic.
       *
       * `maps://?q=<name>` is the form proved to make Maps file the place in
       * Recents with a record attached. An earlier version appended
       * `&ll=<lat>,<lon>` on the strength of an Accessibility measurement where
       * that form opened a place CARD — but a card is not a Recents entry, and
       * with the coordinate present Maps appears to treat the URL as "show this
       * location" rather than a search worth recording. Nothing was ever written,
       * so the poll ran to its timeout every time.
       *
       * The coordinate is still used, for de-duplication and for checking that
       * what Maps resolved is the place that was asked for. It just does not go
       * into the URL.
       */
      const url = `maps://?q=${encodeURIComponent(input.query)}`;
      progress(`asking Maps to resolve ${JSON.stringify(input.query)}…`);
      this.#openUrl(url);
      seeded = true;
      progress(`opened, waiting up to ${Math.round(this.#seedTimeoutMs / 1000)}s for a record`);
      const deadline = Date.now() + this.#seedTimeoutMs;
      let polls = 0;
      while (Date.now() < deadline && !donor) {
        // A fresh handle per poll: under WAL a connection that has begun reading
        // holds a snapshot and may not see another process's commits.
        const probe = new DatabaseSync(this.#path, { readOnly: true });
        try {
          donor = this.#seededDonor(probe, watermark);
        } finally {
          probe.close();
        }
        if (!donor) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STORAGE_POLL_MS);
        polls += 1;
        if (polls % 8 === 0) progress(`still waiting (${polls * (STORAGE_POLL_MS / 1000)}s)…`);
      }
      if (donor && hasCoords && !near(donor.lat, donor.lon, lat, lon)) {
        // Maps resolved SOMETHING, but not the place that was asked for. Copying
        // its record would make a favourite for the wrong place — which then
        // syncs to every device on the account — so this refuses rather than
        // guesses.
        throw new MapsWriteError(
          `Maps resolved ${JSON.stringify(input.query)} to a place about ` +
            `${Math.round(haversineMetres(donor.lat, donor.lon, lat, lon))}m from the coordinate ` +
            `given, so it is probably not the place meant. Nothing was saved — try a more ` +
            `specific name.`,
          { query: input.query },
        );
      }
      if (donor)
        progress(`got a place record (${donor.storage?.length ?? 0} bytes) after ${polls} polls`);
      if (!donor) {
        throw new MapsWriteError(
          `Maps did not produce a place record for "${input.query}" within ` +
            `${Math.round(this.#seedTimeoutMs / 1000)}s. Maps must be RUNNING for this to work — ` +
            `it is the only thing that can create a place record. It may also have resolved the ` +
            `query to a search rather than a place, since searches get no record. Try a more ` +
            `specific name, or pass latitude and longitude.`,
          { query: input.query },
        );
      }
    }

    /*
     * DE-DUPLICATE AGAIN, against the RESOLVED coordinate.
     *
     * The check in phase 1 uses the coordinate the CALLER supplied, and that is
     * the wrong kind of number to compare with. MEASURED: asked to save Sagrada
     * Família at longitude 2.1744, Maps resolved and stored 2.1743308 — 6.9e-5
     * away, seven times the ~1 m tolerance. So a caller repeating its own request
     * verbatim did not match the row its first call had created, and a second
     * favourite appeared.
     *
     * Maps' own coordinate is canonical: whatever it resolved this time, it
     * resolved last time too. Comparing that against what is stored is comparing
     * like with like, and it is exact enough for the tight tolerance.
     *
     * The phase-1 check still earns its place — when it hits, no seeding happens
     * and no Recents entry appears. This one is what makes the tool correct.
     */
    const canonical = new DatabaseSync(this.#path, { readOnly: true });
    let duplicate: ExistingFavorite | null = null;
    try {
      duplicate = this.#existingFavorite(canonical, donor.lat, donor.lon) ?? null;
    } finally {
      canonical.close();
    }
    if (duplicate) {
      progress("already a favourite; nothing written");
      return {
        rowId: Number(duplicate.pk),
        uuid: uuidOf(Buffer.from(duplicate.hex, "hex")),
        name: duplicate.name,
        latitude: Number(duplicate.lat),
        longitude: Number(duplicate.lon),
        created: false,
        seeded,
      };
    }

    // ── 3. write ─────────────────────────────────────────────────────────────
    progress("writing the favourite");
    const db = this.#open();
    try {
      const favEnt = this.#entity(db, "FavoriteItem");
      const mixEnt = this.#entity(db, "MixinMapItem");
      const favPk = this.#nextPk(db, "FavoriteItem", "ZFAVORITEITEM");
      const mixPk = this.#nextPk(db, "MixinMapItem", "ZMIXINMAPITEM");
      const now = Date.now() / 1000 - CORE_DATA_EPOCH_OFFSET;
      const id = uuidBytes();
      const label = input.name ?? donor.name ?? input.query;
      const position = Number(
        (db.prepare(`SELECT COUNT(*) AS c FROM ZFAVORITEITEM`).get() as { c: number | bigint }).c,
      );

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO "ZFAVORITEITEM"
             (Z_PK, Z_ENT, Z_OPT, ZHIDDEN, ZPOSITIONINDEX, ZSOURCE, ZTYPE, ZVERSION,
              ZMAPITEM, ZMUID, ZCREATETIME, ZMODIFICATIONTIME, ZMAPITEMLASTREFRESHED,
              ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZMAPITEMADDRESS, ZMAPITEMCATEGORY,
              ZIDENTIFIER)
           VALUES (?, ?, 1, 0, ?, 0, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          favPk,
          favEnt,
          position,
          mixPk,
          donor.muid === null ? null : Number(donor.muid),
          now,
          now,
          now,
          donor.lat,
          donor.lon,
          label,
          donor.address,
          donor.category,
          id,
        );
        db.prepare(
          `INSERT INTO "ZMIXINMAPITEM"
             (Z_PK, Z_ENT, Z_OPT, ZFAVORITEITEM, ZCREATETIME, ZMODIFICATIONTIME,
              ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        ).run(mixPk, mixEnt, favPk, now, now, donor.lat, donor.lon, donor.storage);
        // Not bumping these hands the next insert BY MAPS a duplicate primary
        // key, which is a corruption of the app's data by our omission.
        db.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME = 'FavoriteItem'`).run(favPk);
        db.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME = 'MixinMapItem'`).run(mixPk);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Already resolved; the throw below is the report.
        }
        throw err;
      }

      return {
        rowId: favPk,
        uuid: uuidOf(id),
        name: label,
        latitude: Number(donor.lat),
        longitude: Number(donor.lon),
        created: true,
        seeded,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Remove a favourite and the place record it owns.
   *
   * `Z_MAX` is deliberately NOT rolled back. Core Data never reuses a primary
   * key, and decrementing the counter would hand the next insert one that is
   * already spoken for by a row still referenced elsewhere.
   */
  removeFavorite(key: EntityKey): boolean {
    const db = this.#open();
    try {
      const where = "uuid" in key ? `HEX(ZIDENTIFIER) = ?` : `Z_PK = ?`;
      const param = "uuid" in key ? key.uuid.replaceAll("-", "").toUpperCase() : key.rowId;
      const row = db
        .prepare(`SELECT Z_PK AS pk, ZMAPITEM AS mapPk FROM ZFAVORITEITEM WHERE ${where} LIMIT 1`)
        .get(param) as { pk: number; mapPk: number | null } | undefined;
      if (!row) return false;

      db.exec("BEGIN IMMEDIATE");
      try {
        if (row.mapPk !== null) {
          db.prepare(`DELETE FROM ZMIXINMAPITEM WHERE Z_PK = ?`).run(row.mapPk);
        }
        db.prepare(`DELETE FROM ZFAVORITEITEM WHERE Z_PK = ?`).run(row.pk);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Already resolved.
        }
        throw err;
      }
      return true;
    } finally {
      db.close();
    }
  }
}
