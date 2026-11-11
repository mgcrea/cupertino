import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PlaceSourceFinder } from "../src/client/place-source.js";
import { MapsWriteError } from "../src/client/write.js";

/**
 * Finding a place record for the store lane, read-only.
 *
 * Moved and adapted from `write.test.ts`'s seeding and de-duplication cases.
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

const recent = (pk: number, mapPk: number, lat: number, lon: number, id: string | null) => `
  ${mapItem(mapPk, lat, lon)}
  INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1, ZIDENTIFIER)
    VALUES (${pk}, ${ENT.historyPlaceItem}, 1, ${mapPk}, ${lat}, ${lon}, ${id ? blob(id) : "NULL"});
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
  it("opens the query and polls Recents above the watermark", async () => {
    const path = emptyStore();
    // An older recent elsewhere, below the watermark: never the answer.
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
    const count = () =>
      Number(
        (before.prepare(`SELECT COUNT(*) AS c FROM ZMIXINMAPITEM`).get() as { c: number | bigint })
          .c,
      );
    const rows = count();
    await new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled }).find({
      query: "Test Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(count()).toBe(rows);
    before.close();
  });
});

describe("existingFavorite / existingSavedPlace", () => {
  it("finds a favourite within a metre", () => {
    const path = emptyStore();
    exec(path, favorite(1, 1, 48.1, 2.2, "Test Café", FAV_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.existingFavorite({ latitude: 48.100004, longitude: 2.200004 })).toEqual({
      id: FAV_ID,
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
    ).toEqual({ id: FAV_ID });
    expect(
      finder.existingFavorite({ latitude: 48.1001, longitude: 2.2001, name: "Other Café" }),
    ).toBeNull();
  });

  it("finds a saved place the same two ways", () => {
    const path = emptyStore();
    exec(path, collectionItem(1, ENT.collectionPlaceItem, 1, 48.1, 2.2, "Test Café", SAVED_ID));
    const finder = new PlaceSourceFinder({ storePath: path, openUrl: failIfCalled });
    expect(finder.existingSavedPlace({ latitude: 48.1, longitude: 2.2 })).toEqual({ id: SAVED_ID });
    expect(
      finder.existingSavedPlace({ latitude: 48.1001, longitude: 2.2001, name: "Test Café" }),
    ).toEqual({ id: SAVED_ID });
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
