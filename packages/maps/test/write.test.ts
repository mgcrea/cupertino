import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { introspect, MapsStore } from "../src/client/store.js";
import { MapsWriteError, MapsWriter } from "../src/client/write.js";

/**
 * The write half, exercised against a real SQLite file.
 *
 * `MapsWriter` opens by PATH rather than taking a handle, because the live store
 * is held open by Maps and `mapssyncd` and the writer has to set its own
 * `busy_timeout`. So these tests write a temp file rather than using `:memory:`.
 *
 * What they cannot cover: that Maps ACCEPTS what is written. That was measured by
 * hand — `docs/maps.md` — and no offline test can stand in for it. What they do
 * cover is every rule that keeps the row well-formed, and those are the rules
 * whose violation would reach the user's other devices through iCloud.
 */
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "maps-store.sql"),
  "utf8",
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A store with one collection item whose map item carries a place record. */
const storeWithDonor = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "maps-write-test-"));
  dirs.push(dir);
  const path = join(dir, "MapsSync_0.0.1");
  const db = new DatabaseSync(path);
  /*
   * WAL, because the real store is in WAL and a fresh SQLite file is not.
   *
   * Fidelity, NOT a regression test. It was added believing it would reproduce a
   * hang seen against the live store, and it does not — the suite passes with the
   * bug present. The stand-in for Maps writes and returns BEFORE polling starts,
   * so the poll never has to observe a commit made after its connection began
   * reading, and reproducing that needs a genuinely concurrent writer this
   * synchronous suite cannot host.
   *
   * Kept because matching production's concurrency model is worth having, and
   * recorded as not-a-guard so nobody later mistakes it for one.
   */
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(FIXTURE);
  db.exec(`
    INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES
      (13, 'FavoriteItem', -1, 0), (25, 'MixinMapItem', -1, 1),
      (7, 'CollectionItem', -1, 1), (14, 'HistoryItem', -1, 0);
    INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
      VALUES (1, 25, 1, 48.8600, 2.3266, X'0a0b48656c6c6f20776f726c64');
    INSERT INTO ZCOLLECTIONITEM
      (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZMAPITEMADDRESS, ZMUID)
      VALUES (1, 7, 1, 1, 48.8600, 2.3266, 'Musée d''Orsay', '1 Rue de la Légion', 4242);
  `);
  db.close();
  return path;
};

const read = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const store = new MapsStore({ db, caps: introspect(db), path, mode: "ro" });
  const rows = store.places("favorite", { limit: 100 }).rows;
  store.close();
  return rows;
};

const scalar = (path: string, sql: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  const v = Number((db.prepare(sql).get() as { v: number | bigint }).v);
  db.close();
  return v;
};

/** Stands in for Maps: never called when a donor is already in the store. */
const failIfCalled = () => {
  throw new Error("openUrl must not be called when the place is already known");
};

describe("addFavorite", () => {
  it("copies an existing place record rather than seeding", () => {
    const path = storeWithDonor();
    const writer = new MapsWriter({ storePath: path, openUrl: failIfCalled });
    const result = writer.addFavorite({
      query: "Musée d'Orsay",
      latitude: 48.86,
      longitude: 2.3266,
    });

    expect(result.created).toBe(true);
    // The whole point: no Recents entry when the store already knows the place.
    expect(result.seeded).toBe(false);

    const favorites = read(path);
    expect(favorites).toHaveLength(1);
    expect(favorites[0]?.name).toBe("Musée d'Orsay");
    expect(favorites[0]?.linked).toBe(true);
  });

  /*
   * The copied record is the ONE thing that cannot be fabricated, so a test that
   * only counted rows would miss the bug that matters: a favourite with a bogus
   * or absent record displays as a husk in Maps and syncs that way to every
   * device.
   */
  it("copies the place record BYTE FOR BYTE", () => {
    const path = storeWithDonor();
    new MapsWriter({ storePath: path, openUrl: failIfCalled }).addFavorite({
      query: "Musée d'Orsay",
      latitude: 48.86,
      longitude: 2.3266,
    });
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(`SELECT HEX(ZMAPITEMSTORAGE) AS hex FROM ZMIXINMAPITEM ORDER BY Z_PK`)
      .all() as { hex: string }[];
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.hex).toBe(rows[0]?.hex);
  });

  it("bumps Z_MAX for both entities", () => {
    const path = storeWithDonor();
    new MapsWriter({ storePath: path, openUrl: failIfCalled }).addFavorite({
      query: "Musée d'Orsay",
      latitude: 48.86,
      longitude: 2.3266,
    });
    expect(scalar(path, `SELECT Z_MAX AS v FROM Z_PRIMARYKEY WHERE Z_NAME='FavoriteItem'`)).toBe(1);
    expect(scalar(path, `SELECT Z_MAX AS v FROM Z_PRIMARYKEY WHERE Z_NAME='MixinMapItem'`)).toBe(2);
  });

  /*
   * A model that retries must not produce two favourites for one place. Maps
   * HIDES the duplicate in its own UI, so the store would disagree with the app
   * invisibly — the failure nobody would report.
   */
  it("is idempotent, and says so rather than silently doing nothing", () => {
    const path = storeWithDonor();
    const writer = new MapsWriter({ storePath: path, openUrl: failIfCalled });
    const input = { query: "Musée d'Orsay", latitude: 48.86, longitude: 2.3266 };
    const first = writer.addFavorite(input);
    const second = writer.addFavorite(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.uuid).toBe(first.uuid);
    expect(read(path)).toHaveLength(1);
  });

  /* Coordinates never compare exactly across sources; a metre is the same door. */
  it("treats a coordinate a metre away as the same place", () => {
    const path = storeWithDonor();
    const writer = new MapsWriter({ storePath: path, openUrl: failIfCalled });
    writer.addFavorite({ query: "Musée d'Orsay", latitude: 48.86, longitude: 2.3266 });
    const again = writer.addFavorite({
      query: "Musée d'Orsay",
      latitude: 48.860004,
      longitude: 2.32660_4,
    });
    expect(again.created).toBe(false);
    expect(read(path)).toHaveLength(1);
  });

  /*
   * The retry case, with a stand-in that behaves like Maps: it resolves to its
   * OWN coordinate rather than the caller's. Asking twice with the same input
   * must not produce two favourites — this failed against the real store because
   * the caller's coordinate was being compared with a canonical one.
   */
  it("is idempotent even when Maps resolves to its own coordinate", () => {
    const path = storeWithDonor();
    let seeds = 0;
    const openUrl = () => {
      seeds += 1;
      const db = new DatabaseSync(path);
      // Next ids read from the store, not computed: the writer inserts its own
      // map item between seeds, so any arithmetic here goes stale immediately.
      const next = (t: string) =>
        Number(
          (db.prepare(`SELECT COALESCE(MAX(Z_PK),0) AS m FROM ${t}`).get() as { m: number }).m,
        ) + 1;
      const mixPk = next("ZMIXINMAPITEM");
      const histPk = next("ZHISTORYITEM");
      db.exec(`
        INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
          VALUES (${mixPk}, 25, 1, 51.500769, -0.124623, X'0a05426967426e');
        INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1)
          VALUES (${histPk}, 14, 1, ${mixPk}, 51.500769, -0.124623);
        UPDATE Z_PRIMARYKEY SET Z_MAX = ${mixPk} WHERE Z_NAME = 'MixinMapItem';
        UPDATE Z_PRIMARYKEY SET Z_MAX = ${histPk} WHERE Z_NAME = 'HistoryItem';
      `);
      db.close();
    };
    const writer = new MapsWriter({ storePath: path, openUrl, seedTimeoutMs: 2000 });
    const input = { query: "Big Ben", latitude: 51.5007, longitude: -0.1246 };
    expect(writer.addFavorite(input).created).toBe(true);
    expect(writer.addFavorite(input).created).toBe(false);
    expect(read(path)).toHaveLength(1);
  });

  /*
   * A repeat call must not re-seed. Seeding leaves a Recents entry, so a tool
   * that seeds before noticing the duplicate pollutes the user's Recents once
   * per retry for a favourite it does not create.
   */
  it("does not seed again on a repeat call", () => {
    const path = storeWithDonor();
    let seeds = 0;
    const openUrl = () => {
      seeds += 1;
      const db = new DatabaseSync(path);
      const next = (t: string) =>
        Number(
          (db.prepare(`SELECT COALESCE(MAX(Z_PK),0) AS m FROM ${t}`).get() as { m: number }).m,
        ) + 1;
      const mixPk = next("ZMIXINMAPITEM");
      const histPk = next("ZHISTORYITEM");
      db.exec(`
        INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
          VALUES (${mixPk}, 25, 1, 51.500769, -0.124623, X'0a05426967426e');
        INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1)
          VALUES (${histPk}, 14, 1, ${mixPk}, 51.500769, -0.124623);
        UPDATE Z_PRIMARYKEY SET Z_MAX = ${mixPk} WHERE Z_NAME = 'MixinMapItem';
        UPDATE Z_PRIMARYKEY SET Z_MAX = ${histPk} WHERE Z_NAME = 'HistoryItem';
      `);
      db.close();
    };
    const writer = new MapsWriter({ storePath: path, openUrl, seedTimeoutMs: 2000 });
    const input = { query: "Big Ben", latitude: 51.5007, longitude: -0.1246 };
    writer.addFavorite(input);
    const second = writer.addFavorite(input);
    expect(second.created).toBe(false);
    expect(second.seeded).toBe(false);
    expect(seeds).toBe(1);
  });

  it("seeds through the URL scheme when the place is unknown", () => {
    const path = storeWithDonor();
    const opened: string[] = [];
    // Stands in for Maps: resolves the place and files it in Recents with a
    // record attached, which is exactly what the real app does.
    const openUrl = (url: string) => {
      opened.push(url);
      const db = new DatabaseSync(path);
      /*
       * NOT the coordinate the caller asked for. Maps resolves a place to ITS
       * coordinate, which differs from the caller's by a building's width —
       * measured at 6.9e-5 for Sagrada Família. A stand-in that echoed the input
       * hid a real duplicate bug, because every comparison then matched exactly.
       */
      db.exec(`
        INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
          VALUES (2, 25, 1, 51.500769, -0.124623, X'0a05426967426e');
        INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1)
          VALUES (1, 14, 1, 2, 51.500769, -0.124623);
        UPDATE Z_PRIMARYKEY SET Z_MAX = 2 WHERE Z_NAME = 'MixinMapItem';
        UPDATE Z_PRIMARYKEY SET Z_MAX = 1 WHERE Z_NAME = 'HistoryItem';
      `);
      db.close();
    };

    const result = new MapsWriter({ storePath: path, openUrl, seedTimeoutMs: 2000 }).addFavorite({
      query: "Big Ben",
      latitude: 51.5007,
      longitude: -0.1246,
    });

    expect(result.seeded).toBe(true);
    expect(result.created).toBe(true);
    expect(opened[0]).toContain("maps://?q=Big%20Ben");
    /*
     * NO COORDINATE IN THE SEED URL. This assertion used to demand the opposite
     * and was pinning a bug: `?q=<name>` is the form proved to make Maps file a
     * place in Recents, while `?q=<name>&ll=<lat>,<lon>` was carried over from an
     * Accessibility measurement about place CARDS. With the coordinate present
     * Maps writes no recent, so the poll ran to its timeout every time and looked
     * exactly like a hang.
     */
    expect(opened[0]).not.toContain("ll=");
  });

  /*
   * The counter and the rows can disagree — Maps mid-write, a crash, or a
   * foreign writer that forgot to bump it. An insert trusting the counter alone
   * collides with a row that already exists, which is how a first version of
   * this file failed.
   */
  it("survives a stale Z_MAX rather than colliding", () => {
    const path = storeWithDonor();
    const db = new DatabaseSync(path);
    db.exec(`UPDATE Z_PRIMARYKEY SET Z_MAX = 0 WHERE Z_NAME = 'MixinMapItem'`);
    db.close();

    const result = new MapsWriter({ storePath: path, openUrl: failIfCalled }).addFavorite({
      query: "Musée d'Orsay",
      latitude: 48.86,
      longitude: 2.3266,
    });
    expect(result.created).toBe(true);
    expect(scalar(path, `SELECT COUNT(*) AS v FROM ZMIXINMAPITEM`)).toBe(2);
  });

  /*
   * Failing loudly matters more here than usual: the alternative is a favourite
   * built on a record Maps never made, which is the one thing this design says
   * must never happen.
   */
  it("refuses rather than inventing a record when Maps produces nothing", () => {
    const path = storeWithDonor();
    const writer = new MapsWriter({
      storePath: path,
      openUrl: () => {},
      seedTimeoutMs: 300,
    });
    expect(() => writer.addFavorite({ query: "Nowhere At All" })).toThrow(MapsWriteError);
    expect(read(path)).toHaveLength(0);
  });
});

/*
 * Seeding can resolve to the WRONG place — a name is ambiguous, and the record
 * copied from it would produce a favourite for somewhere the caller never asked
 * about, which then syncs to every device on the account.
 */
describe("seed sanity", () => {
  it("refuses a place Maps resolved far from the coordinate given", () => {
    const path = storeWithDonor();
    const openUrl = () => {
      const db = new DatabaseSync(path);
      db.exec(`
        INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
          VALUES (2, 25, 1, 40.7128, -74.0060, X'0a054e5943');
        INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1)
          VALUES (1, 14, 1, 2, 40.7128, -74.0060);
        UPDATE Z_PRIMARYKEY SET Z_MAX = 2 WHERE Z_NAME = 'MixinMapItem';
      `);
      db.close();
    };
    const writer = new MapsWriter({ storePath: path, openUrl, seedTimeoutMs: 2000 });
    expect(() =>
      // Asked for London; Maps answered New York.
      writer.addFavorite({ query: "Big Ben", latitude: 51.5007, longitude: -0.1246 }),
    ).toThrow(MapsWriteError);
    expect(read(path)).toHaveLength(0);
  });

  it("accepts a coordinate a couple of hundred metres off", () => {
    const path = storeWithDonor();
    const openUrl = () => {
      const db = new DatabaseSync(path);
      db.exec(`
        INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
          VALUES (2, 25, 1, 51.5017, -0.1256, X'0a05426967426e');
        INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1)
          VALUES (1, 14, 1, 2, 51.5017, -0.1256);
        UPDATE Z_PRIMARYKEY SET Z_MAX = 2 WHERE Z_NAME = 'MixinMapItem';
      `);
      db.close();
    };
    const writer = new MapsWriter({ storePath: path, openUrl, seedTimeoutMs: 2000 });
    // An entrance versus a pin, which is the normal case rather than an error.
    expect(
      writer.addFavorite({ query: "Big Ben", latitude: 51.5007, longitude: -0.1246 }).created,
    ).toBe(true);
  });
});

describe("removeFavorite", () => {
  const seeded = () => {
    const path = storeWithDonor();
    const writer = new MapsWriter({ storePath: path, openUrl: failIfCalled });
    const added = writer.addFavorite({
      query: "Musée d'Orsay",
      latitude: 48.86,
      longitude: 2.3266,
    });
    return { path, writer, added };
  };

  it("removes the favourite and the record it owns", () => {
    const { path, writer, added } = seeded();
    expect(writer.removeFavorite({ uuid: added.uuid })).toBe(true);
    expect(read(path)).toHaveLength(0);
    // Its own map item goes; the donor's stays, because another row owns it.
    expect(scalar(path, `SELECT COUNT(*) AS v FROM ZMIXINMAPITEM`)).toBe(1);
  });

  /*
   * Core Data never reuses a primary key. Decrementing the counter would hand
   * the next insert — possibly one by MAPS — a key that is already spoken for.
   */
  it("leaves Z_MAX alone, so no later insert collides", () => {
    const { path, writer, added } = seeded();
    writer.removeFavorite({ uuid: added.uuid });
    expect(scalar(path, `SELECT Z_MAX AS v FROM Z_PRIMARYKEY WHERE Z_NAME='FavoriteItem'`)).toBe(1);
  });

  it("reports a miss rather than pretending to have removed something", () => {
    const { writer } = seeded();
    expect(writer.removeFavorite({ uuid: "00000000-0000-0000-0000-000000000000" })).toBe(false);
  });
});
