import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SchemaDriftError } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import { toStoreTime } from "../src/client/dates.js";
import { introspect, SafariStore } from "../src/client/store.js";

/**
 * Replayed from the REAL schema.
 *
 * `packages/safari/test/fixtures/safari-history.sql` was captured by
 * `pnpm probe:safari --write` on macOS 26.6 (fingerprint `1d20bcd2b9a5`,
 * 16 objects across 9 tables). It is schema only — not one row of anybody's
 * browsing — which is what keeps this suite runnable with no grant.
 *
 * Before it existed, this file replayed a hand-written guess. Every guess it
 * made turned out right: the join column really is `history_item`, the primary
 * key really is `id`, and `history_items.url` really is `NOT NULL UNIQUE`. The
 * guess also MISSED things — `synthesized`, `history_tags`, `metadata` — which
 * is the argument for replaying the real DDL rather than a plausible one.
 *
 * The degradation tests below still use hand-written schemas on purpose. They
 * describe ways Apple could change this file in future, and the real fixture
 * cannot express those.
 */
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "safari-history.sql"),
  "utf8",
);

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
/** Apple-seconds, which is what docs/safari.md expects `visit_time` to hold. */
const appleSeconds = (msAgo: number): number => (NOW - msAgo) / 1000 - 978_307_200;

const seed = (db: DatabaseSync): void => {
  // The real table has three NOT NULL columns this surface never reads:
  // `daily_visit_counts` (a BLOB), `should_recompute_derived_visit_counts` and
  // `visit_count_score`. The hand-written schema this file used before the
  // fixture landed omitted all three, so the seed never had to supply them —
  // precisely the kind of gap replaying the real DDL closes.
  const item = db.prepare(
    `INSERT INTO history_items
       (url, visit_count, daily_visit_counts, should_recompute_derived_visit_counts, visit_count_score)
     VALUES (?, ?, X'', 0, 0)`,
  );
  const visit = db.prepare(
    `INSERT INTO history_visits (history_item, visit_time, title, load_successful, redirect_source)
     VALUES (?, ?, ?, ?, ?)`,
  );

  item.run("https://example.com/", 3);
  visit.run(1, appleSeconds(10 * 86_400_000), "Example, ten days ago", 1, null);
  visit.run(1, appleSeconds(1 * 86_400_000), "Example Domain", 1, null);

  item.run("https://news.example.org/article?utm_source=x", 1);
  visit.run(2, appleSeconds(2 * 86_400_000), "A News Article", 1, 1);

  // A page titled with a LIKE wildcard, the trap `escapeLike` exists for.
  item.run("https://shop.example.com/100%-cotton", 1);
  visit.run(3, appleSeconds(3 * 86_400_000), "100% cotton shirts", 1, null);

  // An item with no visit row at all: the LEFT JOIN must still return it.
  item.run("https://orphan.example.net/", 0);
};

const build = (schema = FIXTURE, withRows = true): SafariStore => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  if (withRows) seed(db);
  return new SafariStore({ db, caps: introspect(db, NOW), path: ":memory:", mode: "ro" });
};

/**
 * What the captured fixture settles, pinned so it stays settled.
 *
 * Each of these was an open question while this package was written against a
 * guess, and each one decided a design choice. Asserting them here means a
 * future macOS that changes one fails a test rather than quietly changing
 * behaviour.
 */
describe("the real schema", () => {
  it("names the visits→items foreign key `history_item`", () => {
    expect(build().caps.itemFk).toBe("history_item");
  });

  /**
   * `id INTEGER PRIMARY KEY AUTOINCREMENT` — so SQLite does NOT hand a deleted
   * row's id to the next insert. The rowid-reuse hazard that made
   * `packages/messages` reject rowids does not apply here.
   *
   * The history ref carries the URL anyway, and this is why that comment does
   * not cite reuse as its reason: the real reason is that the URL is the only
   * join key between Safari's two lanes, so it is already this surface's
   * identity. Reuse would have been a second argument; it turned out not to
   * exist, and the first one was never contingent on it.
   */
  it("declares history_items.id AUTOINCREMENT, so ids are not reused", () => {
    expect(FIXTURE).toMatch(/CREATE TABLE history_items \(id INTEGER PRIMARY KEY AUTOINCREMENT/);
  });

  /** What makes a URL a legitimate identity rather than a lookup key. */
  it("declares history_items.url NOT NULL UNIQUE", () => {
    expect(FIXTURE).toContain("url TEXT NOT NULL UNIQUE");
  });

  /** The title is per-VISIT, which is why the newest non-null one is taken. */
  it("keeps title on history_visits, not on history_items", () => {
    const s = build();
    expect(s.caps.visitColumns.has("title")).toBe(true);
    expect(s.caps.itemColumns.has("title")).toBe(false);
  });

  /**
   * A column the hand-written guess did not know about. Safari's own
   * `history_visits__last_visit` index orders by it, so it is load-bearing for
   * Safari — but what a "synthesized" visit MEANS is unmeasured here, so
   * nothing in this package filters or ranks on it. Recorded, not guessed at.
   */
  it("carries a `synthesized` flag this package deliberately does not use", () => {
    expect(build().caps.visitColumns.has("synthesized")).toBe(true);
  });
});

describe("introspection", () => {
  it("resolves the join column and the primary key", () => {
    const s = build();
    expect(s.caps.itemFk).toBe("history_item");
    expect(s.caps.itemPk).toBe("id");
    expect(s.hasVisitLeg).toBe(true);
  });

  it("counts both tables", () => {
    const s = build();
    expect(s.caps.counts).toEqual({ items: 4, visits: 4 });
  });

  it("detects apple-seconds from the data rather than assuming", () => {
    const s = build();
    expect(s.caps.epoch.confident).toBe(true);
    expect(s.caps.epoch.offset).toBe(978_307_200);
  });

  /** The one condition that is fatal. Without items there is no surface. */
  it("throws SchemaDriftError when history_items is gone", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE something_else (id INTEGER PRIMARY KEY)`);
    expect(() => introspect(db, NOW)).toThrow(SchemaDriftError);
  });
});

describe("search", () => {
  it("returns one row per URL, newest visit first", () => {
    const s = build();
    const { rows } = s.search({ limit: 10 });
    expect(rows.map((r) => r.url)).toEqual([
      "https://example.com/",
      "https://news.example.org/article?utm_source=x",
      "https://shop.example.com/100%-cotton",
      // No visit row, so no visit time — it sorts last rather than vanishing.
      "https://orphan.example.net/",
    ]);
  });

  it("takes the newest non-null title, not the first", () => {
    const s = build();
    const hit = s.search({ query: "example.com/", limit: 10 }).rows[0];
    expect(hit?.title).toBe("Example Domain");
  });

  it("reports first and last visit separately", () => {
    const s = build();
    const hit = s.get("https://example.com/");
    expect(hit?.firstVisitedRaw).toBeLessThan(hit!.lastVisitedRaw!);
  });

  it("flags a visit reached through a redirect", () => {
    const s = build();
    expect(s.get("https://news.example.org/article?utm_source=x")?.viaRedirect).toBe(true);
    expect(s.get("https://example.com/")?.viaRedirect).toBe(false);
  });

  /**
   * A URL is made of the characters LIKE treats as wildcards, which makes this
   * more dangerous here than on any other surface: unescaped, `%` matches every
   * row in the table and the caller is told it has visited everything.
   */
  it("escapes LIKE wildcards in the query", () => {
    const s = build();
    const { rows } = s.search({ query: "100%", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toContain("100%-cotton");
  });

  it("searches titles only in full scope", () => {
    const s = build();
    // "cotton" appears in the title AND the url here, so use a title-only word.
    expect(s.search({ query: "News Article", scope: "url", limit: 10 }).rows).toHaveLength(0);
    expect(s.search({ query: "News Article", scope: "full", limit: 10 }).rows).toHaveLength(1);
  });

  it("filters by visit time", () => {
    const s = build();
    const from = new Date(NOW - 4 * 86_400_000);
    const { rows, rangeApplied } = s.search({ from, limit: 10 });
    expect(rangeApplied).toBe(true);
    expect(rows.map((r) => r.url)).not.toContain("https://orphan.example.net/");
    // The ten-day-old visit is out of range, but the one-day-old one is not, so
    // the item still appears — the filter is on VISITS, not on items.
    expect(rows.map((r) => r.url)).toContain("https://example.com/");
  });

  it("reports truncation rather than a quietly short list", () => {
    const s = build();
    const { rows, truncated } = s.search({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("does not claim truncation when the results fit", () => {
    expect(build().search({ limit: 50 }).truncated).toBe(false);
  });
});

/**
 * Degradation. The schema was never read back from a real machine, so these are
 * the tests that make shipping it defensible: every one of them describes a way
 * the guess could be wrong, and asserts the server stays useful and honest.
 */
describe("schema drift", () => {
  it("survives a renamed join column by disabling the visits leg", () => {
    const s = build(
      `
      CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL, visit_count INTEGER);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY, page_ref INTEGER, visit_time REAL);
    `,
      false,
    );
    expect(s.caps.itemFk).toBeNull();
    expect(s.hasVisitLeg).toBe(false);
    // Still answers, with the visit-derived fields null rather than throwing.
    expect(() => s.search({ limit: 10 })).not.toThrow();
  });

  it("recognises an alternative join column name", () => {
    const s = build(
      `
      CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY, item_id INTEGER, visit_time REAL);
    `,
      false,
    );
    expect(s.caps.itemFk).toBe("item_id");
  });

  it("falls back to rowid when there is no id column", () => {
    const s = build(`CREATE TABLE history_items (url TEXT NOT NULL);`, false);
    expect(s.caps.itemPk).toBe("rowid");
  });

  it("works with no history_visits table at all", () => {
    const s = build(
      `
      CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL, visit_count INTEGER);
    `,
      false,
    );
    s.db.exec(`INSERT INTO history_items (url, visit_count) VALUES ('https://a.example/', 7)`);
    const { rows, rangeApplied } = s.search({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.visitCount).toBe(7);
    expect(rows[0]?.lastVisitedRaw).toBeNull();
    // The caller is TOLD the range did nothing, rather than being handed a
    // list that looks filtered.
    expect(rangeApplied).toBe(false);
  });

  it("reports rangeApplied false when a range was asked for but is impossible", () => {
    const s = build(
      `CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL);`,
      false,
    );
    expect(s.search({ from: new Date(NOW), limit: 10 }).rangeApplied).toBe(false);
  });

  it("survives a missing title column", () => {
    const s = build(
      `
      CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL);
    `,
      false,
    );
    s.db.exec(`INSERT INTO history_items (url) VALUES ('https://a.example/')`);
    s.db.exec(
      `INSERT INTO history_visits (history_item, visit_time) VALUES (1, ${toStoreTime(new Date(NOW), s.caps.epoch)})`,
    );
    expect(s.search({ limit: 10 }).rows[0]?.title).toBeNull();
  });

  it("withholds every date when the epoch cannot be placed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(FIXTURE);
    db.exec(
      `INSERT INTO history_items
         (url, visit_count, daily_visit_counts, should_recompute_derived_visit_counts, visit_count_score)
       VALUES ('https://a.example/', 1, X'', 0, 0)`,
    );
    // Nanoseconds — what the buggy probe run reported for this column.
    db.exec(`INSERT INTO history_visits (history_item, visit_time) VALUES (1, 7.9e17)`);
    const caps = introspect(db, NOW);
    expect(caps.epoch.confident).toBe(false);
  });
});

describe("get", () => {
  it("finds by exact URL", () => {
    expect(build().get("https://example.com/")?.visitCount).toBe(3);
  });

  it("returns null for a URL that is not there", () => {
    expect(build().get("https://nowhere.example/")).toBeNull();
  });

  /** No prefix matching, no normalisation. The URL is the identity, exactly. */
  it("does not match a near-miss", () => {
    expect(build().get("https://example.com")).toBeNull();
  });
});
