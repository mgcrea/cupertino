import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SchemaDriftError } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import { introspect, MapsStore } from "../src/client/store.js";

/**
 * Replayed from a HAND-WRITTEN schema, and that is worth naming.
 *
 * `packages/safari`'s fixture was captured from a real store; this one was
 * written from the report of `pnpm probe:maps`, because the author of this file
 * has no Full Disk Access and has never opened the real database. So these
 * tests prove the code does what it intends against the columns the probe
 * NAMED, and cannot prove anything about columns nobody knew to look for.
 *
 * The degradation tests matter more here than they would on a captured fixture,
 * for exactly that reason: they are the part that stays true when the schema
 * turns out to differ.
 */
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "maps-store.sql"),
  "utf8",
);

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
/** Core Data seconds since 2001, which is what the probe measured. */
const appleSeconds = (msAgo: number): number => (NOW - msAgo) / 1000 - 978_307_200;
const DAY = 86_400_000;

const build = (sql: string = FIXTURE): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
};

const seed = (db: DatabaseSync): void => {
  const fav = db.prepare(
    `INSERT INTO ZFAVORITEITEM
       (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMUID, ZLATITUDE, ZLONGITUDE,
        ZCREATETIME, ZMODIFICATIONTIME, ZCUSTOMNAME, ZMAPITEMNAME, ZMAPITEMADDRESS)
     VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  fav.run(
    1,
    10,
    555,
    48.8566,
    2.3522,
    appleSeconds(3 * DAY),
    appleSeconds(DAY),
    null,
    "Café Blanc",
    "1 Rue de Rivoli",
  );
  fav.run(
    2,
    11,
    556,
    45.764,
    4.8357,
    appleSeconds(9 * DAY),
    appleSeconds(2 * DAY),
    "Mum's",
    "12 Rue Centrale",
    "12 Rue Centrale, Lyon",
  );
  // The unconfigured slot: no linked place, no name, no coordinate.
  fav.run(
    3,
    null,
    null,
    null,
    null,
    appleSeconds(30 * DAY),
    appleSeconds(30 * DAY),
    null,
    null,
    null,
  );

  db.prepare(
    `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZCREATETIME, ZMODIFICATIONTIME, ZTITLE)
     VALUES (?, 2, 1, ?, ?, ?, ?)`,
  ).run(1, 2, appleSeconds(20 * DAY), appleSeconds(5 * DAY), "Weekend in Lisbon");

  const item = db.prepare(
    `INSERT INTO ZCOLLECTIONITEM
       (Z_PK, Z_ENT, Z_OPT, ZCOLLECTION, ZMAPITEM, ZMUID, ZLATITUDE, ZLONGITUDE,
        ZCREATETIME, ZMODIFICATIONTIME, ZCUSTOMNAME, ZMAPITEMNAME, ZMAPITEMADDRESS)
     VALUES (?, 3, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  item.run(
    1,
    1,
    20,
    900,
    38.7223,
    -9.1393,
    appleSeconds(19 * DAY),
    appleSeconds(6 * DAY),
    null,
    "Time Out Market",
    "Av. 24 de Julho",
  );
  item.run(
    2,
    1,
    21,
    901,
    38.7139,
    -9.1394,
    appleSeconds(18 * DAY),
    appleSeconds(7 * DAY),
    null,
    "Praça do Comércio",
    null,
  );

  // ZLATITUDE1 is the populated one; ZLATITUDE is the decoy. See the fixture.
  const hist = db.prepare(
    `INSERT INTO ZHISTORYITEM
       (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE, ZLATITUDE1, ZLONGITUDE1,
        ZCREATETIME, ZMODIFICATIONTIME, ZLOCATIONDISPLAY)
     VALUES (?, 4, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  hist.run(
    1,
    30,
    null,
    51.5074,
    -0.1278,
    appleSeconds(2 * DAY),
    appleSeconds(2 * DAY),
    "British Museum",
  );
  hist.run(2, 31, null, 52.52, 13.405, appleSeconds(4 * DAY), appleSeconds(4 * DAY), "Berlin Hbf");
};

const open = (db: DatabaseSync): MapsStore =>
  new MapsStore({ db, caps: introspect(db, NOW), path: ":memory:", mode: "ro" });

describe("introspect", () => {
  it("finds the entities the probe named", () => {
    const caps = introspect(build(), NOW);
    expect(caps.favorites.present).toBe(true);
    expect(caps.collections.present).toBe(true);
    expect(caps.collectionItems.present).toBe(true);
    expect(caps.history.present).toBe(true);
    expect(caps.mapItems.present).toBe(true);
  });

  /*
   * The measurement this whole resolver exists for. On the real store
   * ZHISTORYITEM carries ZLATITUDE on 1 row of 33 and ZLATITUDE1 on 19, so a
   * resolver that takes the first recognised NAME reports that Maps holds
   * almost no coordinates.
   */
  it("resolves a field by coverage, not by first name match", () => {
    const db = build();
    seed(db);
    const caps = introspect(db, NOW);
    expect(caps.history.fields.latitude).toBe("ZLATITUDE1");
    expect(caps.history.fields.longitude).toBe("ZLONGITUDE1");
    // And the unambiguous case still resolves to the plain name.
    expect(caps.favorites.fields.latitude).toBe("ZLATITUDE");
  });

  it("keeps the user's own label separate from the place's name", () => {
    const db = build();
    seed(db);
    const caps = introspect(db, NOW);
    expect(caps.favorites.fields.name).toBe("ZMAPITEMNAME");
    expect(caps.favorites.fields.customName).toBe("ZCUSTOMNAME");
  });

  it("detects the Core Data epoch from the store's own timestamps", () => {
    const db = build();
    seed(db);
    const caps = introspect(db, NOW);
    expect(caps.epoch.confident).toBe(true);
    expect(caps.epoch.offset).toBe(978_307_200);
  });

  it("is not confident about an empty store, and withholds dates rather than guessing", () => {
    const caps = introspect(build(), NOW);
    expect(caps.epoch.confident).toBe(false);
  });

  it("throws only when every place-bearing table is gone", () => {
    expect(() =>
      introspect(build("CREATE TABLE ZUNRELATED (Z_PK INTEGER PRIMARY KEY);"), NOW),
    ).toThrow(SchemaDriftError);
  });

  it("survives losing one entity, because losing one is not losing the surface", () => {
    const partial = FIXTURE.replace(/CREATE TABLE ZCOLLECTION \([^;]+\);/, "");
    const caps = introspect(build(partial), NOW);
    expect(caps.collections.present).toBe(false);
    expect(caps.favorites.present).toBe(true);
  });
});

describe("places", () => {
  it("lists favourites newest-modified first", () => {
    const db = build();
    seed(db);
    const { rows } = open(db).places("favorite", { limit: 10 });
    expect(rows.map((r) => r.name)).toEqual(["Café Blanc", "12 Rue Centrale", null]);
  });

  /*
   * The unconfigured Home/Work/School slots. Returned rather than filtered:
   * dropping them makes the count disagree with what Maps shows, which reads as
   * a deleted favourite.
   */
  it("returns an unlinked row rather than hiding it", () => {
    const db = build();
    seed(db);
    const { rows } = open(db).places("favorite", { limit: 10 });
    const unlinked = rows.filter((r) => !r.linked);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({ name: null, latitude: null });
  });

  it("reads history coordinates from the column that actually has them", () => {
    const db = build();
    seed(db);
    const { rows } = open(db).places("history", { limit: 10 });
    expect(rows.every((r) => r.latitude !== null)).toBe(true);
  });

  it("reports truncation rather than quietly returning a short list", () => {
    const db = build();
    seed(db);
    const { rows, truncated } = open(db).places("favorite", { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("searches name, custom label and address", () => {
    const db = build();
    seed(db);
    const store = open(db);
    expect(store.places("favorite", { limit: 10, query: "Blanc" }).rows).toHaveLength(1);
    // The label the user typed, which is not the place's name.
    expect(store.places("favorite", { limit: 10, query: "Mum" }).rows).toHaveLength(1);
    expect(store.places("favorite", { limit: 10, query: "Rivoli" }).rows).toHaveLength(1);
  });

  it("escapes LIKE wildcards so a literal % is searchable", () => {
    const db = build();
    seed(db);
    // Would match every row if the wildcard were not escaped.
    expect(open(db).places("favorite", { limit: 10, query: "%" }).rows).toHaveLength(0);
  });

  it("gets one place by row id", () => {
    const db = build();
    seed(db);
    expect(open(db).place("favorite", 1)?.name).toBe("Café Blanc");
    expect(open(db).place("favorite", 999)).toBeNull();
  });
});

describe("collections", () => {
  it("lists them with Maps' own place count", () => {
    const db = build();
    seed(db);
    const { rows } = open(db).collections({ limit: 10 });
    expect(rows[0]).toMatchObject({ title: "Weekend in Lisbon", placesCount: 2 });
  });

  it("enumerates a collection's places when the membership key exists", () => {
    const db = build();
    seed(db);
    const caps = introspect(db, NOW);
    expect(caps.collectionFk).toBe("ZCOLLECTION");
    const { rows } = open(db).places("collection-item", { limit: 10, collectionId: 1 });
    expect(rows).toHaveLength(2);
  });

  /*
   * The case the real machine is currently believed to hit: the probe found no
   * ZCOLLECTION column on ZCOLLECTIONITEM. The store must then return NOTHING
   * for a collection's places and say so through `collectionFk`, rather than
   * dropping the filter and returning every item in the store — which would
   * present another Guide's places as this one's.
   */
  it("returns nothing, not everything, when the membership key is absent", () => {
    const withoutFk = FIXTURE.replace("  ZCOLLECTION INTEGER,\n", "");
    const db = build(withoutFk);
    db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME)
       VALUES (1, 3, 1, 20, 'Somewhere')`,
    ).run();
    const store = open(db);
    expect(store.caps.collectionFk).toBeNull();
    expect(store.places("collection-item", { limit: 10, collectionId: 1 }).rows).toEqual([]);
    // The unfiltered listing still works — only the membership question fails.
    expect(store.places("collection-item", { limit: 10 }).rows).toHaveLength(1);
  });
});

describe("degrading rather than failing", () => {
  it("yields NULL for a field whose column is missing, and still returns the row", () => {
    const noAddress = FIXTURE.replace(/ZMAPITEMADDRESS VARCHAR, /g, "");
    const db = build(noAddress);
    db.prepare(
      `INSERT INTO ZFAVORITEITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME)
       VALUES (1, 1, 1, 10, 'Somewhere')`,
    ).run();
    const { rows } = open(db).places("favorite", { limit: 10 });
    expect(rows[0]).toMatchObject({ name: "Somewhere", address: null });
  });

  it("matches nothing rather than everything when no column is searchable", () => {
    const noText = FIXTURE.replace(
      /ZCUSTOMNAME VARCHAR, ZMAPITEMNAME VARCHAR,\n  ZMAPITEMADDRESS VARCHAR, ZORIGINATINGADDRESSSTRING VARCHAR,/,
      "",
    );
    const db = build(noText);
    db.prepare(
      `INSERT INTO ZFAVORITEITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM) VALUES (1, 1, 1, 10)`,
    ).run();
    expect(open(db).places("favorite", { limit: 10, query: "anything" }).rows).toEqual([]);
  });
});
