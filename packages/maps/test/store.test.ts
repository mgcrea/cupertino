import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SchemaDriftError } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import { introspect, MapsStore } from "../src/client/store.js";

/**
 * Replayed from the REAL schema, captured by `pnpm probe:maps --write` — 146
 * objects, fingerprint `2bbc03143125`. It carries no rows: schema only, so the
 * suite runs on a machine with no Full Disk Access and nobody's real data.
 *
 * That split is what these tests can and cannot prove. Every COLUMN is the one
 * Maps really has, so a query built against a name that does not exist fails
 * here. But every resolver on this surface decides on DATA rather than on names
 * — column choice by coverage, identifier adoption by totality, collection
 * membership by scoring the join — and the data below is seeded by this file.
 * So these prove the RULES are right, never that they pick what a real store
 * would pick.
 *
 * Two bugs got through exactly there and were caught only against real data: a
 * `ZMUID` that overflowed a JS number, and a `ZMUID` of 0 used as a sentinel.
 * The degradation tests are the part that stays true regardless.
 */
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "maps-store.sql"),
  "utf8",
);

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
/** Core Data seconds since 2001, which is what the probe measured. */
const appleSeconds = (msAgo: number): number => (NOW - msAgo) / 1000 - 978_307_200;
const DAY = 86_400_000;

/**
 * A real ZMUID, copied from a real store.
 *
 * It matters that this is not a small number. `node:sqlite` THROWS on an
 * INTEGER past Number.MAX_SAFE_INTEGER rather than truncating, so the first
 * version of this suite — which seeded `555` — passed while
 * `apple_maps_list_favorites` failed on the real store with "Value is too large
 * to be represented as a JavaScript number", taking every favourite down with
 * it. A fixture whose values are all comfortable is a fixture that cannot catch
 * this class of bug.
 */
const REAL_MUID = -2_679_868_148_951_248_105n;

const build = (sql: string = FIXTURE): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
};

/**
 * Drop one table from the captured schema, and every index that names it.
 *
 * Deleting only the CREATE TABLE leaves its indexes behind, and replaying those
 * fails with "no such table" — which reads as a broken fixture rather than as
 * the deliberate amputation the test is making. The word boundary matters:
 * `ZCOLLECTION` is a prefix of `ZCOLLECTIONITEM`.
 */
const withoutTable = (sql: string, table: string): string =>
  sql
    .split("\n")
    .filter(
      (line) =>
        !new RegExp(`^CREATE TABLE ${table}\\b`).test(line) &&
        !new RegExp(`^CREATE INDEX \\S+ ON ${table}\\b`).test(line),
    )
    .join("\n");

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
    REAL_MUID,
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
    -8_100_000_000_000_000_001n,
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
     VALUES (?, 6, 1, ?, ?, ?, ?)`,
  ).run(1, 2, appleSeconds(20 * DAY), appleSeconds(5 * DAY), "Weekend in Lisbon");

  /*
   * Membership goes through Z_6PLACES, NOT a column on ZCOLLECTIONITEM.
   *
   * This helper used to insert into `ZCOLLECTION INTEGER` on ZCOLLECTIONITEM, a
   * column the hand-written fixture declared and the real store has never had.
   * The suite was green the whole time membership was broken against the real
   * store, which is the reason the fixture is now captured rather than written.
   */
  const item = db.prepare(
    `INSERT INTO ZCOLLECTIONITEM
       (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMUID, ZLATITUDE, ZLONGITUDE,
        ZCREATETIME, ZMODIFICATIONTIME, ZCUSTOMNAME, ZMAPITEMNAME, ZMAPITEMADDRESS)
     VALUES (?, 7, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  item.run(
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
  const link = db.prepare(`INSERT INTO Z_6PLACES (Z_6COLLECTIONS, Z_7PLACES) VALUES (?, ?)`);
  link.run(1, 1);
  link.run(1, 2);

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
    const partial = withoutTable(FIXTURE, "ZCOLLECTION");
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

  /*
   * The regression. See REAL_MUID above: this is the one column in the store
   * that can exceed a JS double, and reading it as a number fails the entire
   * listing rather than that one field.
   */
  it("survives a 64-bit place id by carrying it as text", () => {
    const db = build();
    seed(db);
    const { rows } = open(db).places("favorite", { limit: 10 });
    expect(rows[0]?.muid).toBe(String(REAL_MUID));
    // Exact, not rounded: the whole point of not going through a double.
    expect(rows[0]?.muid).toBe("-2679868148951248105");
  });

  /*
   * MEASURED: 12 of 20 linked favourites on a real store carry ZMUID = 0. It is
   * a sentinel for "no Apple place id", and reporting it as one would let a
   * caller treat two unrelated places as the same place.
   */
  it("reports a zero place id as absent rather than as an id", () => {
    const db = build();
    seed(db);
    db.prepare(
      `INSERT INTO ZFAVORITEITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMUID, ZMAPITEMNAME, ZMODIFICATIONTIME)
       VALUES (9, 1, 1, 90, 0, 'Sentinel', ?)`,
    ).run(appleSeconds(0));
    const row = open(db).place("favorite", { rowId: 9 });
    expect(row?.name).toBe("Sentinel");
    expect(row?.muid).toBeNull();
  });

  it("gets one place by row id", () => {
    const db = build();
    seed(db);
    expect(open(db).place("favorite", { rowId: 1 })?.name).toBe("Café Blanc");
    expect(open(db).place("favorite", { rowId: 999 })).toBeNull();
  });
});

/*
 * Stable identifiers.
 *
 * `ZIDENTIFIER` is a 16-byte Core Data UUID that the read probe never reported —
 * it was found by diffing the store while Maps saved a place. On a real store it
 * is set and distinct on every row of all four entities, which is what lets a
 * ref outlive an iCloud re-sync.
 *
 * The fixture leaves it NULL by default, so every test above exercises the
 * row-id fallback. These seed it deliberately.
 */
const uuidBytes = (n: number): Uint8Array =>
  Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : i));
const uuidOf = (n: number): string =>
  Buffer.from(uuidBytes(n))
    .toString("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

describe("stable identifiers", () => {
  const withIdentifiers = (db: DatabaseSync): DatabaseSync => {
    for (const pk of [1, 2, 3]) {
      db.prepare(`UPDATE ZFAVORITEITEM SET ZIDENTIFIER = ? WHERE Z_PK = ?`).run(uuidBytes(pk), pk);
    }
    return db;
  };

  it("uses the uuid when it is set and distinct on every row", () => {
    const db = build();
    seed(db);
    withIdentifiers(db);
    const store = open(db);
    expect(store.caps.favorites.fields.identifier).toBe("ZIDENTIFIER");
    const row = store.place("favorite", { uuid: uuidOf(1) });
    expect(row?.name).toBe("Café Blanc");
    expect(row?.uuid).toBe(uuidOf(1));
  });

  /*
   * The whole point of the total-coverage bar. A column populated only on rows
   * Maps wrote lately would give durable refs for new places and silently fail
   * for everything the user already had — and the older entries are the ones a
   * person is most likely to ask about.
   */
  it("refuses a partially populated column and falls back to row ids", () => {
    const db = build();
    seed(db);
    db.prepare(`UPDATE ZFAVORITEITEM SET ZIDENTIFIER = ? WHERE Z_PK = 1`).run(uuidBytes(1));
    const store = open(db);
    expect(store.caps.favorites.fields.identifier).toBeNull();
    expect(store.place("favorite", { rowId: 1 })?.name).toBe("Café Blanc");
  });

  it("refuses a column that repeats a value", () => {
    const db = build();
    seed(db);
    for (const pk of [1, 2, 3]) {
      db.prepare(`UPDATE ZFAVORITEITEM SET ZIDENTIFIER = ? WHERE Z_PK = ?`).run(uuidBytes(7), pk);
    }
    expect(open(db).caps.favorites.fields.identifier).toBeNull();
  });

  /*
   * A uuid ref against a store with no identifier column must find NOTHING. The
   * two key spaces are unrelated, so falling back to the row id would resolve to
   * a real but wrong place — worse than an error.
   */
  it("never resolves a uuid key against a store without identifiers", () => {
    const db = build();
    seed(db);
    expect(open(db).place("favorite", { uuid: uuidOf(1) })).toBeNull();
  });

  it("resolves a collection uuid to the row id its items point at", () => {
    const db = build();
    seed(db);
    const store0 = open(db);
    const collections = store0.collections({ limit: 10 }).rows;
    for (const c of collections) {
      db.prepare(`UPDATE ZCOLLECTION SET ZIDENTIFIER = ? WHERE Z_PK = ?`).run(
        uuidBytes(c.id),
        c.id,
      );
    }
    const store = open(db);
    const first = collections[0];
    expect(first).toBeDefined();
    expect(store.collectionRowId({ uuid: uuidOf(first!.id) })).toBe(first!.id);
    expect(store.collectionRowId({ uuid: uuidOf(200) })).toBeNull();
  });
});

describe("collections", () => {
  it("lists them with Maps' own place count", () => {
    const db = build();
    seed(db);
    const { rows } = open(db).collections({ limit: 10 });
    expect(rows[0]).toMatchObject({ title: "Weekend in Lisbon", placesCount: 2 });
  });

  it("enumerates a collection's places through the proved membership table", () => {
    const db = build();
    seed(db);
    const caps = introspect(db, NOW);
    expect(caps.membership).toEqual({
      kind: "joinTable",
      table: "Z_6PLACES",
      collectionColumn: "Z_6COLLECTIONS",
      itemColumn: "Z_7PLACES",
    });
    expect(caps.collectionFk).toBe("Z_6PLACES(Z_6COLLECTIONS, Z_7PLACES)");
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
    const db = build(withoutTable(FIXTURE, "Z_6PLACES"));
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (1, 6, 1, 1, 'A')`,
    ).run();
    db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME)
       VALUES (1, 7, 1, 20, 'Somewhere')`,
    ).run();
    const store = open(db);
    expect(store.caps.membership).toBeNull();
    expect(store.caps.collectionFk).toBeNull();
    expect(store.places("collection-item", { limit: 10, collectionId: 1 }).rows).toEqual([]);
    // The unfiltered listing still works — only the membership question fails.
    expect(store.places("collection-item", { limit: 10 }).rows).toHaveLength(1);
  });
  /*
   * THE SHAPE THE REAL STORE ACTUALLY USES, and the one the hand-written
   * fixture could not express.
   *
   * Membership is `Z_6PLACES(Z_6COLLECTIONS, Z_7PLACES)`, a Core Data
   * many-to-many. It leaves NO column on either entity, which is why four
   * guessed column names — ZCOLLECTION, ZCOLLECTION1, ZPARENTCOLLECTION,
   * ZOWNINGCOLLECTION — all missed it and every guide listed empty against the
   * real store while this suite was green.
   */
  const withJoinTable = (): DatabaseSync => {
    const db = build();
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (1, 6, 1, 2, 'A')`,
    ).run();
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (2, 6, 1, 1, 'B')`,
    ).run();
    const item = db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME) VALUES (?, 7, 1, ?, ?)`,
    );
    item.run(1, 20, "Time Out Market");
    item.run(2, 21, "Pastéis de Belém");
    item.run(3, 22, "Somewhere else");
    // Items 1 and 2 in guide A, item 3 in guide B.
    const link = db.prepare(`INSERT INTO Z_6PLACES VALUES (?, ?)`);
    link.run(1, 1);
    link.run(1, 2);
    link.run(2, 3);
    return db;
  };

  it("finds a many-to-many join table and reads the right orientation", () => {
    const store = open(withJoinTable());
    expect(store.caps.membership).toEqual({
      kind: "joinTable",
      table: "Z_6PLACES",
      collectionColumn: "Z_6COLLECTIONS",
      itemColumn: "Z_7PLACES",
    });
    expect(store.places("collection-item", { limit: 10, collectionId: 1 }).rows).toHaveLength(2);
    expect(
      store.places("collection-item", { limit: 10, collectionId: 2 }).rows.map((r) => r.name),
    ).toEqual(["Somewhere else"]);
  });

  /*
   * The orientation follows the DATA, never the column names.
   *
   * `Z_6COLLECTIONS` reads like the collection side, and on the real store it
   * is — but that is an inference from a name, and the resolver is not allowed
   * to make it. Here the same table is populated the other way round, and the
   * counts are what decide. On the real store the reversed reading scores 3 of
   * 10, close enough to be chosen by anything short of an exact match.
   */
  it("follows the data, not the column names, when choosing the orientation", () => {
    const db = build();
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (1, 6, 1, 1, 'A')`,
    ).run();
    db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME)
       VALUES (7, 7, 1, 20, 'Only')`,
    ).run();
    // Populated against the names: the ITEM row id sits in Z_6COLLECTIONS and
    // the COLLECTION row id in Z_7PLACES.
    db.prepare(`INSERT INTO Z_6PLACES VALUES (?, ?)`).run(7, 1);
    const store = open(db);
    expect(store.caps.membership).toEqual({
      kind: "joinTable",
      table: "Z_6PLACES",
      collectionColumn: "Z_7PLACES",
      itemColumn: "Z_6COLLECTIONS",
    });
    expect(
      store.places("collection-item", { limit: 10, collectionId: 1 }).rows.map((r) => r.name),
    ).toEqual(["Only"]);
  });

  /*
   * The near-miss that makes coverage-based resolution wrong here.
   *
   * MEASURED on the real store: `ZCOLLECTIONITEM.ZMAPITEM` joins ZCOLLECTION
   * for 3 of 10 collections purely because map-item row ids and collection row
   * ids are both small integers. A resolver that accepted the best-covered
   * joinable column would file places under the wrong guides and look like it
   * worked.
   */
  it("rejects a column that joins by coincidence without reproducing the counts", () => {
    const db = build();
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (1, 6, 1, 5, 'A')`,
    ).run();
    // ZMAPITEM = 1 joins collection 1, but one item is not the five it declares.
    // Z_6PLACES is left empty, so the join table cannot answer either.
    db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME)
       VALUES (1, 7, 1, 1, 'Coincidence')`,
    ).run();
    const store = open(db);
    expect(store.caps.membership).toBeNull();
    expect(store.places("collection-item", { limit: 10, collectionId: 1 }).rows).toEqual([]);
  });

  /*
   * Places filed in NO guide.
   *
   * MEASURED: 30 collection items, 18 in a guide, 12 in none — and Core Data
   * has deleted nothing, so they are not leftovers from removed guides. 7 of
   * the 12 exist nowhere else in the store, which is what made them worth a
   * tool: no other query in this package can reach them.
   */
  const withOrphans = (): DatabaseSync => {
    const db = withJoinTable();
    const item = db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME) VALUES (?, 7, 1, ?, ?)`,
    );
    item.run(4, 23, "Filed nowhere");
    item.run(5, 24, "Also filed nowhere");
    return db;
  };

  it("lists only the places that are in no collection", () => {
    const store = open(withOrphans());
    expect(store.unfiledCount()).toBe(2);
    // Sorted: these rows carry no timestamps, so the store's ORDER BY has
    // nothing to sort on and the order is not part of the contract here.
    expect(
      store
        .places("collection-item", { limit: 10, unfiled: true })
        .rows.map((r) => r.name)
        .toSorted(),
    ).toEqual(["Also filed nowhere", "Filed nowhere"]);
    // The guides are unaffected by the new filter.
    expect(store.places("collection-item", { limit: 10, collectionId: 1 }).rows).toHaveLength(2);
  });

  /*
   * THE NULL TRAP, and the reason `#unfiledClause` guards the subquery.
   *
   * `x NOT IN (SELECT y ...)` is false for EVERY row as soon as one y is NULL,
   * because SQL cannot prove x differs from an unknown. Without the guard this
   * filter would return an empty list and read as "you have no unfiled places"
   * — a wrong answer that looks like a correct one, which is the failure this
   * surface keeps having to design against.
   */
  it("still finds unfiled places when the join table holds a NULL", () => {
    const db = withOrphans();
    db.prepare(`INSERT INTO Z_6PLACES (Z_6COLLECTIONS, Z_7PLACES) VALUES (?, NULL)`).run(2);
    const store = open(db);
    expect(store.unfiledCount()).toBe(2);
    expect(store.places("collection-item", { limit: 10, unfiled: true }).rows).toHaveLength(2);
  });

  it("reads unfiled as a null membership column when membership is a column", () => {
    const db = build(`${withoutTable(FIXTURE, "Z_6PLACES")}
      ALTER TABLE ZCOLLECTIONITEM ADD COLUMN ZPARENT INTEGER;`);
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (1, 6, 1, 1, 'A')`,
    ).run();
    const item = db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME, ZPARENT)
       VALUES (?, 7, 1, ?, ?, ?)`,
    );
    item.run(1, 20, "In the guide", 1);
    item.run(2, 21, "Filed nowhere", null);
    const store = open(db);
    expect(store.caps.membership).toEqual({ kind: "column", column: "ZPARENT" });
    expect(
      store.places("collection-item", { limit: 10, unfiled: true }).rows.map((r) => r.name),
    ).toEqual(["Filed nowhere"]);
  });

  /* Unanswerable is not the same as none, and must not read as none. */
  it("returns nothing and no count when membership is unresolved", () => {
    const db = build(withoutTable(FIXTURE, "Z_6PLACES"));
    db.prepare(
      `INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZPLACESCOUNT, ZTITLE) VALUES (1, 6, 1, 1, 'A')`,
    ).run();
    db.prepare(
      `INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZMAPITEMNAME)
       VALUES (1, 7, 1, 20, 'Somewhere')`,
    ).run();
    const store = open(db);
    expect(store.caps.membership).toBeNull();
    expect(store.unfiledCount()).toBeNull();
    expect(store.places("collection-item", { limit: 10, unfiled: true }).rows).toEqual([]);
  });

  /* A place filed in two guides is returned by each of them, exactly once. */
  it("returns a place in two guides once from each", () => {
    const db = withJoinTable();
    db.prepare(`UPDATE ZCOLLECTION SET ZPLACESCOUNT = 2 WHERE Z_PK = 2`).run();
    db.prepare(`INSERT INTO Z_6PLACES VALUES (?, ?)`).run(2, 1);
    const store = open(db);
    expect(store.caps.membership?.kind).toBe("joinTable");
    const a = store.places("collection-item", { limit: 10, collectionId: 1 }).rows;
    const b = store.places("collection-item", { limit: 10, collectionId: 2 }).rows;
    expect(a.filter((r) => r.name === "Time Out Market")).toHaveLength(1);
    expect(b.filter((r) => r.name === "Time Out Market")).toHaveLength(1);
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
