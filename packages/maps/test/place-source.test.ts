import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { MapsWriteError } from "../src/client/errors.js";
import { PlaceSourceFinder } from "../src/client/place-source.js";

/**
 * Finding a place record for the store lane, read-only.
 *
 * Moved and adapted from the retired SQL route's seeding and de-duplication
 * cases (its `write.test.ts`, deleted 2026-11-11).
 * The difference is what comes back: not the record to copy, but the OWNING
 * item's `ZIDENTIFIER` and its kind, which is all the Swift lane needs to fetch
 * the record through Maps' own model.
 *
 * Every place here is synthetic.
 */
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "maps-store.sql"),
  "utf8",
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/*
 * Entity numbers as a real store lays them out: `CollectionItem` and
 * `HistoryItem` are abstract parents, and the rows carry a SUB-entity's Z_ENT.
 * `ZCOLLECTIONITEM` also holds transit items, which are not saved places.
 */
const ENT = {
  collectionItem: 7,
  collectionPlaceItem: 8,
  collectionTransitItem: 9,
  favoriteItem: 13,
  historyItem: 14,
  historyPlaceItem: 16,
  mixinMapItem: 25,
} as const;

const FAV_ID = "11111111-2222-4333-8444-555555555555";
const SAVED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TRANSIT_ID = "99999999-8888-4777-8666-555555555555";
const RECENT_ID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const SEEDED_ID = "12345678-9abc-4def-8123-456789abcdef";

/** A uuid as a SQLite blob literal. */
const blob = (uuid: string): string => `X'${uuid.replaceAll("-", "")}'`;

/** An empty store with the real schema, in WAL like the real one. */
const emptyStore = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "maps-place-source-test-"));
  dirs.push(dir);
  const path = join(dir, "MapsSync_0.0.1");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(FIXTURE);
  db.exec(`
    INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES
      (${ENT.collectionItem}, 'CollectionItem', 0, 0),
      (${ENT.collectionPlaceItem}, 'CollectionPlaceItem', ${ENT.collectionItem}, 0),
      (${ENT.collectionTransitItem}, 'CollectionTransitItem', ${ENT.collectionItem}, 0),
      (${ENT.favoriteItem}, 'FavoriteItem', 0, 0),
      (${ENT.historyItem}, 'HistoryItem', 0, 0),
      (${ENT.historyPlaceItem}, 'HistoryPlaceItem', ${ENT.historyItem}, 0),
      (${ENT.mixinMapItem}, 'MixinMapItem', 0, 0);
  `);
  db.close();
  return path;
};

const exec = (path: string, sql: string): void => {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
};

/** A map item carrying a place record, at a coordinate. */
const mapItem = (pk: number, lat: number, lon: number): string => `
  INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
    VALUES (${pk}, ${ENT.mixinMapItem}, 1, ${lat}, ${lon}, X'0a0b53796e746865746963');
`;

const favorite = (
  pk: number,
  mapPk: number,
  lat: number,
  lon: number,
  name: string,
  id: string | null,
) => `
  ${mapItem(mapPk, lat, lon)}
  INSERT INTO ZFAVORITEITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZIDENTIFIER)
    VALUES (${pk}, ${ENT.favoriteItem}, 1, ${mapPk}, ${lat}, ${lon}, '${name}', ${id ? blob(id) : "NULL"});
`;

const collectionItem = (
  pk: number,
  ent: number,
  mapPk: number,
  lat: number,
  lon: number,
  name: string,
  id: string | null,
) => `
  ${mapItem(mapPk, lat, lon)}
  INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZIDENTIFIER)
    VALUES (${pk}, ${ent}, 1, ${mapPk}, ${lat}, ${lon}, '${name}', ${id ? blob(id) : "NULL"});
`;

/** A recent; `ent` other than `HistoryPlaceItem` makes a history row that is not a place. */
const recent = (
  pk: number,
  mapPk: number,
  lat: number,
  lon: number,
  id: string | null,
  ent: number = ENT.historyPlaceItem,
) => `
  ${mapItem(mapPk, lat, lon)}
  INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1, ZIDENTIFIER)
    VALUES (${pk}, ${ent}, 1, ${mapPk}, ${lat}, ${lon}, ${id ? blob(id) : "NULL"});
`;

/** Stands in for Maps: never called when a donor is already in the store. */
const failIfCalled = () => {
  throw new Error("openUrl must not be called when the place is already known");
};

/*
 * A stand-in for Maps that resolves a query to ITS OWN coordinate, as the real
 * app does, and files it in Recents with a record attached.
 */
const seedsAt = (path: string, lat: number, lon: number, opened: string[] = []) => {
  return (url: string) => {
    opened.push(url);
    const db = new DatabaseSync(path);
    const next = (t: string) =>
      Number((db.prepare(`SELECT COALESCE(MAX(Z_PK),0) AS m FROM ${t}`).get() as { m: number }).m) +
      1;
    db.exec(recent(next("ZHISTORYITEM"), next("ZMIXINMAPITEM"), lat, lon, SEEDED_ID));
    db.close();
  };
};

describe("find: a record already in the store", () => {
  it("takes a saved place near the coordinate without seeding", async () => {
    const path = emptyStore();
    exec(path, collectionItem(1, ENT.collectionPlaceItem, 1, 48.1, 2.2, "Test Café", SAVED_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    const source = await finder.find({ query: "Test Café", latitude: 48.1, longitude: 2.2 });
    expect(source).toEqual({
      kind: "savedPlace",
      id: SAVED_ID,
      latitude: 48.1,
      longitude: 2.2,
      seeded: false,
    });
  });

  it("names a favourite donor as a favourite", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const source = await new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled }).find({
      query: "Test Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(source.kind).toBe("favorite");
    expect(source.id).toBe(FAV_ID);
  });

  it("names a recent donor as a recent", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const source = await new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled }).find({
      query: "Test Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(source.kind).toBe("recent");
    expect(source.id).toBe(RECENT_ID);
  });

  /* Coordinates never compare exactly across sources; a metre is the same door. */
  it("treats a coordinate a metre away as the same place", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const source = await new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled }).find({
      query: "Test Café",
      latitude: 48.100004,
      longitude: 2.200004,
    });
    expect(source.id).toBe(FAV_ID);
  });

  /*
   * The lane fetches by uuid, so an owner without one cannot be named to it.
   * Seeding is the honest fallback; handing over a row id would be a guess.
   */
  it("skips a donor whose owner has no identifier, and seeds instead", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", null));
    const opened: string[] = [];
    const source = await new PlaceSourceFinder({
      storePath: path,
      openUrl: seedsAt(path, 48.1001, 2.2001, opened),
      seedTimeoutMs: 2000,
    }).find({ query: "Test Café", latitude: 48.1, longitude: 2.2 });
    expect(opened).toHaveLength(1);
    expect(source).toMatchObject({ kind: "recent", id: SEEDED_ID, seeded: true });
  });

  it("prefers a named donor over one with no identifier at the same spot", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", null));
    exec(path, collectionItem(1, ENT.collectionPlaceItem, 2, 48.1, 2.2, "Test Café", SAVED_ID));
    const source = await new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled }).find({
      query: "Test Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(source).toMatchObject({ kind: "savedPlace", id: SAVED_ID });
  });

  /* The order is favourite, saved place, recent; pinned so the answer is deterministic. */
  it("ranks a favourite above a saved place and a recent at the same spot", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    exec(path, collectionItem(1, ENT.collectionPlaceItem, 2, 48.1, 2.2, "Test Café", SAVED_ID));
    exec(path, favorite(1, 3, 48.1, 2.2, "Test Café", FAV_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    const q = { query: "Test Café", latitude: 48.1, longitude: 2.2 };
    expect(await finder.find(q)).toMatchObject({ kind: "favorite", id: FAV_ID });
    exec(path, `DELETE FROM ZFAVORITEITEM`);
    expect(await finder.find(q)).toMatchObject({ kind: "savedPlace", id: SAVED_ID });
  });

  /* A history row that is not a place (a search, a route) is not a recent the lane can copy. */
  it("does not take a non-place history row as a recent", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID, ENT.historyItem));
    const opened: string[] = [];
    const source = await new PlaceSourceFinder({
      storePath: path,
      openUrl: seedsAt(path, 48.1001, 2.2001, opened),
      seedTimeoutMs: 2000,
    }).find({ query: "Test Café", latitude: 48.1, longitude: 2.2 });
    expect(opened).toHaveLength(1);
    expect(source.id).toBe(SEEDED_ID);
  });

  /* A transit line filed in a guide is not a saved place; the lane would not find it. */
  it("does not take a transit item as a saved place", async () => {
    const path = emptyStore();
    exec(path, collectionItem(1, ENT.collectionTransitItem, 1, 48.1, 2.2, "Line 0", TRANSIT_ID));
    const opened: string[] = [];
    const source = await new PlaceSourceFinder({
      storePath: path,
      openUrl: seedsAt(path, 48.1001, 2.2001, opened),
      seedTimeoutMs: 2000,
    }).find({ query: "Test Café", latitude: 48.1, longitude: 2.2 });
    expect(opened).toHaveLength(1);
    expect(source.id).toBe(SEEDED_ID);
  });
});

describe("find: seeding", () => {
  it("opens the query and polls Recents", async () => {
    const path = emptyStore();
    // An older recent elsewhere. Not what this test guards: see the next one.
    exec(path, recent(1, 1, 10.0, 10.0, RECENT_ID));
    const opened: string[] = [];
    const source = await new PlaceSourceFinder({
      storePath: path,
      openUrl: seedsAt(path, 51.500769, -0.124623, opened),
      seedTimeoutMs: 2000,
    }).find({ query: "Test Tower", latitude: 51.5007, longitude: -0.1246 });

    expect(source).toEqual({
      kind: "recent",
      id: SEEDED_ID,
      // Maps' coordinate, not the caller's: it is the canonical one.
      latitude: 51.500769,
      longitude: -0.124623,
      seeded: true,
    });
    expect(opened).toEqual(["maps://?q=Test%20Tower"]);
    // No coordinate in the seed URL: with one, Maps files no recent.
    expect(opened[0]).not.toContain("ll=");
  });

  /*
   * The watermark is the only guard on a query with no coordinate: that path has
   * no 250 m check, so without it a recent the user made last week would be
   * returned as what Maps just resolved.
   */
  it("never returns a recent that was there before the seed", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const attempt = new PlaceSourceFinder({
      storePath: path,
      openUrl: () => {},
      seedTimeoutMs: 300,
    }).find({ query: "Test Tower" });
    await expect(attempt).rejects.toThrow(/^Maps did not produce a place record for "Test Tower"/);
  });

  /* Maps filing a non-place history row (a search) is not a seeded place. */
  it("does not take a non-place history row as the seeded recent", async () => {
    const path = emptyStore();
    const openUrl = () => exec(path, recent(1, 1, 51.5007, -0.1246, SEEDED_ID, ENT.historyItem));
    const attempt = new PlaceSourceFinder({ storePath: path, openUrl, seedTimeoutMs: 300 }).find({
      query: "Test Tower",
      latitude: 51.5007,
      longitude: -0.1246,
    });
    await expect(attempt).rejects.toThrow(/^Maps did not produce a place record for "Test Tower"/);
  });

  /*
   * The newest recent above the watermark is the seed's only when it is the
   * only one: a second place opened in Maps meanwhile could be either.
   */
  it("refuses when two places land in Recents during the wait", async () => {
    for (const coords of [{}, { latitude: 51.5007, longitude: -0.1246 }]) {
      const path = emptyStore();
      const openUrl = () =>
        exec(
          path,
          recent(1, 1, 51.5007, -0.1246, SEEDED_ID) +
            recent(2, 2, 51.5008, -0.1247, "22222222-3333-4444-8555-666666666666"),
        );
      const attempt = new PlaceSourceFinder({ storePath: path, openUrl, seedTimeoutMs: 2000 }).find(
        { query: "Test Tower", ...coords },
      );
      await expect(attempt).rejects.toThrow(MapsWriteError);
      const error = (await attempt.catch((err: unknown) => err)) as MapsWriteError;
      expect(error.message).toBe(
        'While Maps resolved "Test Tower", another place was opened in Maps too, so which ' +
          "record is this one's cannot be told. Nothing was saved — try again.",
      );
      expect(error.details).toMatchObject({ reason: "invalid" });
    }
  });

  it("seeds with no coordinate at all, and accepts what Maps resolved", async () => {
    const path = emptyStore();
    const source = await new PlaceSourceFinder({
      storePath: path,
      openUrl: seedsAt(path, 40.0, -70.0),
      seedTimeoutMs: 2000,
    }).find({ query: "Test Tower" });
    expect(source).toMatchObject({ kind: "recent", id: SEEDED_ID, seeded: true });
  });

  it("accepts a place a couple of hundred metres off", async () => {
    const path = emptyStore();
    const source = await new PlaceSourceFinder({
      storePath: path,
      openUrl: seedsAt(path, 51.5017, -0.1256),
      seedTimeoutMs: 2000,
    }).find({ query: "Test Tower", latitude: 51.5007, longitude: -0.1246 });
    expect(source.seeded).toBe(true);
  });

  it("refuses a place Maps resolved far from the coordinate given", async () => {
    const path = emptyStore();
    const finder = new PlaceSourceFinder({
      storePath: path,
      // Asked for one city; Maps answered another.
      openUrl: seedsAt(path, 40.7, -74.0),
      seedTimeoutMs: 2000,
    });
    const attempt = finder.find({ query: "Test Tower", latitude: 51.5007, longitude: -0.1246 });
    await expect(attempt).rejects.toThrow(MapsWriteError);
    await expect(attempt).rejects.toThrow(
      /^Maps resolved "Test Tower" to a place about \d+m from the coordinate given, so it is probably not the place meant\. Nothing was saved — try a more specific name\.$/,
    );
  });

  it("refuses rather than inventing a record when Maps produces nothing", async () => {
    const path = emptyStore();
    const attempt = new PlaceSourceFinder({
      storePath: path,
      openUrl: () => {},
      seedTimeoutMs: 300,
    }).find({ query: "Nowhere At All" });
    await expect(attempt).rejects.toThrow(MapsWriteError);
    await expect(attempt).rejects.toThrow(
      `Maps did not produce a place record for "Nowhere At All" within 0s. Maps must be ` +
        `RUNNING for this to work — it is the only thing that can create a place record.`,
    );
  });

  it("writes nothing to the store", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const before = new DatabaseSync(path, { readOnly: true });
    try {
      const count = () =>
        Number(
          (
            before.prepare(`SELECT COUNT(*) AS c FROM ZMIXINMAPITEM`).get() as {
              c: number | bigint;
            }
          ).c,
        );
      const rows = count();
      await new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled }).find({
        query: "Test Café",
        latitude: 48.1,
        longitude: 2.2,
      });
      expect(count()).toBe(rows);
    } finally {
      before.close();
    }
  });
});

describe("existingFavorite / existingSavedPlace", () => {
  it("finds a favourite within a metre", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    // The row's own name and coordinate, not the caller's: the tool reports them.
    expect(finder.existingFavorite({ latitude: 48.100004, longitude: 2.200004 })).toEqual({
      id: FAV_ID,
      name: "Test Café",
      latitude: 48.1,
      longitude: 2.2,
    });
  });

  /* The caller's coordinate differs from Apple's by a building's width. */
  it("finds a favourite by name within the loose radius", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.existingFavorite({ latitude: 48.1001, longitude: 2.2001 })).toBeNull();
    expect(
      finder.existingFavorite({ latitude: 48.1001, longitude: 2.2001, name: "Test Café" }),
    ).toMatchObject({ id: FAV_ID, latitude: 48.1, longitude: 2.2 });
    expect(
      finder.existingFavorite({ latitude: 48.1001, longitude: 2.2001, name: "Other Café" }),
    ).toBeNull();
  });

  it("finds a saved place the same two ways", () => {
    const path = emptyStore();
    exec(path, collectionItem(1, ENT.collectionPlaceItem, 1, 48.1, 2.2, "Test Café", SAVED_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.existingSavedPlace({ latitude: 48.1, longitude: 2.2 })).toEqual({
      id: SAVED_ID,
      name: "Test Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(
      finder.existingSavedPlace({ latitude: 48.1001, longitude: 2.2001, name: "Test Café" }),
    ).toMatchObject({ id: SAVED_ID });
    // A saved place is not a favourite, and the other way round.
    expect(finder.existingFavorite({ latitude: 48.1, longitude: 2.2 })).toBeNull();
  });

  it("does not count a transit item as a saved place", () => {
    const path = emptyStore();
    exec(path, collectionItem(1, ENT.collectionTransitItem, 1, 48.1, 2.2, "Line 0", TRANSIT_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.existingSavedPlace({ latitude: 48.1, longitude: 2.2 })).toBeNull();
  });
});

describe("identifierOf", () => {
  it("names a row by row id or by uuid", () => {
    const path = emptyStore();
    exec(path, favorite(3, 1, 48.1, 2.2, "Test Café", FAV_ID));
    exec(path, collectionItem(4, ENT.collectionPlaceItem, 2, 48.2, 2.3, "Test Shop", SAVED_ID));
    exec(path, recent(5, 3, 48.3, 2.4, RECENT_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.identifierOf("favorite", { rowId: 3 })).toBe(FAV_ID);
    expect(finder.identifierOf("collection-item", { rowId: 4 })).toBe(SAVED_ID);
    expect(finder.identifierOf("history", { rowId: 5 })).toBe(RECENT_ID);
    expect(finder.identifierOf("favorite", { uuid: FAV_ID.toUpperCase() })).toBe(FAV_ID);
  });

  it("returns null for a row whose ZIDENTIFIER is null", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", null));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.identifierOf("favorite", { rowId: 1 })).toBeNull();
  });

  it("returns null for a row that is not there", () => {
    const path = emptyStore();
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.identifierOf("history", { rowId: 42 })).toBeNull();
    expect(finder.identifierOf("collection-item", { uuid: SAVED_ID })).toBeNull();
  });
});

describe("describe", () => {
  it("reads an item back by its identifier, the label winning over the place's name", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    exec(path, `UPDATE ZFAVORITEITEM SET ZCUSTOMNAME = 'My Café' WHERE Z_PK = 1`);
    exec(path, collectionItem(2, ENT.collectionPlaceItem, 2, 48.2, 2.3, "Test Shop", SAVED_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.describe("favorite", FAV_ID.toUpperCase())).toEqual({
      id: FAV_ID,
      name: "My Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(finder.describe("collection-item", SAVED_ID)).toEqual({
      id: SAVED_ID,
      name: "Test Shop",
      latitude: 48.2,
      longitude: 2.3,
    });
  });

  /* A new item may carry its coordinate only on its own map item. */
  it("falls back to the map item's coordinate", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    exec(path, `UPDATE ZFAVORITEITEM SET ZLATITUDE = NULL, ZLONGITUDE = NULL WHERE Z_PK = 1`);
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.describe("favorite", FAV_ID)).toMatchObject({ latitude: 48.1, longitude: 2.2 });
  });

  it("returns null for an id that is not there, or not a uuid", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.describe("collection-item", FAV_ID)).toBeNull();
    expect(finder.describe("favorite", SAVED_ID)).toBeNull();
    expect(finder.describe("favorite", "not-a-uuid")).toBeNull();
  });
});
