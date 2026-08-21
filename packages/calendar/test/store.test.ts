import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SchemaDriftError } from "../src/client/errors.js";
import { introspect } from "../src/client/store.js";

/**
 * Built from the DDL a real store handed `pnpm probe:calendar --write`.
 *
 * Schema only, never a row — which is what lets this suite run on a machine
 * with no Full Disk Access and nobody's real calendar in it.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "calendar-store.sql");

const store = (mutate?: (db: DatabaseSync) => void): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(FIXTURE, "utf8"));
  mutate?.(db);
  return db;
};

describe("introspect", () => {
  it("reads the tables the range query needs", () => {
    const caps = introspect(store());
    expect(caps.hasOccurrenceCache).toBe(true);
    expect(caps.hasRecurrence).toBe(true);
    expect(caps.hasExceptionDates).toBe(true);
  });

  /**
   * The columns the two-leg query names. Pinned against the captured DDL so a
   * rename in a future macOS fails here, offline, rather than at a caller.
   */
  it("finds the occurrence columns the expansion joins on", () => {
    const caps = introspect(store());
    expect([...caps.occurrenceColumns]).toEqual(
      expect.arrayContaining(["event_id", "occurrence_date", "occurrence_end_date"]),
    );
  });

  it("sees a wide CalendarItem — 84 columns on the probed schema", () => {
    const caps = introspect(store());
    expect(caps.itemColumns.size).toBeGreaterThan(50);
    expect(caps.itemColumns.has("UUID")).toBe(true);
    expect(caps.itemColumns.has("start_date")).toBe(true);
    expect(caps.itemColumns.has("start_tz")).toBe(true);
  });

  /**
   * The reminder half of the shared schema. Present as columns, empty as data
   * (measured: 0 rows carry either), so leg 1 needs no type predicate — but if
   * these ever vanish, the assumption behind that decision has changed.
   */
  it("still carries the reminder columns Calendar and Reminders share", () => {
    const caps = introspect(store());
    expect(caps.itemColumns.has("due_date")).toBe(true);
    expect(caps.itemColumns.has("completion_date")).toBe(true);
  });

  /**
   * `OccurrenceCacheDays` is NOT an index into `OccurrenceCache` — it is
   * (calendar_id, store_id, day, count), a per-day count for badging a month
   * view, with no row-level link to anything. Pinned so nobody tries to prune a
   * range query with it.
   */
  it("does not mistake OccurrenceCacheDays for an occurrence index", () => {
    const db = store();
    const cols = (
      db.prepare(`PRAGMA table_info("OccurrenceCacheDays")`).all() as { name: string }[]
    )
      .map((c) => c.name)
      .toSorted();
    expect(cols).toEqual(["calendar_id", "count", "day", "store_id"]);
  });

  /**
   * The foreign keys, taken from the DDL rather than from a name that looks
   * right. `Recurrence` and `ExceptionDate` both link through `owner_id`; the
   * probe's first attempt reported `ROWID` at a 100% resolve rate because both
   * tables are dense autoincrement keys landing inside CalendarItem's own.
   */
  it("links recurrence through owner_id, not through a coincidence of rowids", () => {
    const db = store();
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("Recurrence")).toContain("owner_id");
    expect(cols("ExceptionDate")).toContain("owner_id");
    expect(cols("OccurrenceCache")).toContain("event_id");
  });

  // ─── degradation ──────────────────────────────────────────────────────────

  /**
   * Losing the cache costs the expansion, not the lane. Leg 1 stays correct at
   * any horizon, so the honest answer is a capability downgrade — never a throw,
   * and above all never a quietly shorter list.
   */
  it("survives an OccurrenceCache that is gone", () => {
    const caps = introspect(store((db) => db.exec("DROP TABLE OccurrenceCache")));
    expect(caps.hasOccurrenceCache).toBe(false);
    expect(caps.itemColumns.size).toBeGreaterThan(0);
  });

  it.each([["CalendarItem"], ["Calendar"]])("raises SchemaDrift when %s is gone", (table) => {
    expect(() => introspect(store((db) => db.exec(`DROP TABLE ${table}`)))).toThrow(
      SchemaDriftError,
    );
  });

  it("names the probe in the drift error, so the fix is discoverable", () => {
    try {
      introspect(store((db) => db.exec("DROP TABLE CalendarItem")));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/pnpm probe:calendar/);
    }
  });

  /**
   * REGRESSION GUARD, and the reason this assertion is worth its weight: the
   * runtime fingerprint and the probe's are computed over different orderings
   * of sqlite_master, so they disagree about an identical schema. This value is
   * the RUNTIME one, and it matched what the live server reported through the
   * bridge on the machine the fixture came from.
   */
  it("fingerprints the captured schema to the value the running server reports", () => {
    expect(introspect(store()).fingerprint).toBe("cd2424fea732");
  });
});
