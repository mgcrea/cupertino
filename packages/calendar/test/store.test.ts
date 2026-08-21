import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SchemaDriftError } from "../src/client/errors.js";
import { CalendarStore, introspect, type RangeQuery } from "../src/client/store.js";

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

// ─── the range query ─────────────────────────────────────────────────────────

/**
 * Apple-seconds for a UTC instant, which is how the store holds them.
 * `2026-08-21T00:00:00Z` is the anchor every fixture row below hangs off.
 */
const EPOCH = 978_307_200;
const apple = (iso: string) => Math.round(new Date(iso).getTime() / 1000) - EPOCH;
const DAY = 86_400;

type Seed = {
  pk: number;
  uuid: string;
  summary?: string;
  start: number;
  end?: number;
  allDay?: 0 | 1;
  tz?: string;
  hasRecurrences?: 0 | 1;
  phantom?: 0 | 1;
  hidden?: 0 | 1;
  entity?: number;
  origItem?: number | null;
  origDate?: number | null;
  calendar?: number;
};

/** A store with one account, two calendars, and whatever rows a test needs. */
const seeded = (items: Seed[], occurrences: [number, number, number][] = []): CalendarStore => {
  const db = store();
  db.exec(`INSERT INTO Store (ROWID, name, type) VALUES (1, 'iCloud', 0)`);
  db.exec(
    `INSERT INTO Calendar (ROWID, store_id, title, UUID, color, type, display_order)
     VALUES (1, 1, 'Work', 'CAL-1', '#ff0000', 'CalDAV', 0),
            (2, 1, 'Holidays', 'CAL-2', '#00ff00', 'Subscribed', 1)`,
  );
  for (const i of items) {
    const stmt = db.prepare(
      `INSERT INTO CalendarItem
         (ROWID, UUID, summary, start_date, end_date, all_day, start_tz, calendar_id,
          entity_type, has_recurrences, phantom_master, hidden, orig_item_id, orig_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    stmt.run(
      i.pk,
      i.uuid,
      i.summary ?? `event ${i.pk}`,
      i.start,
      i.end ?? i.start + 3600,
      i.allDay ?? 0,
      i.tz ?? "_float",
      i.calendar ?? 1,
      i.entity ?? 2,
      i.hasRecurrences ?? 0,
      i.phantom ?? 0,
      i.hidden ?? 0,
      i.origItem ?? null,
      i.origDate ?? null,
    );
  }
  for (const [eventId, start, end] of occurrences) {
    db.prepare(
      `INSERT INTO OccurrenceCache (event_id, calendar_id, store_id, day,
         occurrence_date, occurrence_start_date, occurrence_end_date)
       VALUES (?, 1, 1, ?, ?, ?, ?)`,
    ).run(eventId, start, start, start, end);
  }
  return new CalendarStore(db, "ro", introspect(db));
};

const WINDOW = { fromApple: apple("2026-08-21T00:00:00Z"), toApple: apple("2026-08-28T00:00:00Z") };
const q = (over: Partial<RangeQuery> = {}) => ({ ...WINDOW, limit: 200, ...over });

describe("rangeItems", () => {
  it("returns an event inside the window", () => {
    const s = seeded([{ pk: 1, uuid: "E1", start: apple("2026-08-22T09:00:00Z") }]);
    expect(s.rangeItems(q()).map((r) => r.uuid)).toEqual(["E1"]);
  });

  it("leaves out an event outside it", () => {
    const s = seeded([{ pk: 1, uuid: "E1", start: apple("2026-09-30T09:00:00Z") }]);
    expect(s.rangeItems(q())).toEqual([]);
  });

  /**
   * OVERLAP, NOT CONTAINMENT. A naive `BETWEEN` on the start drops the all-hands
   * that began before the window and is still running inside it — which is the
   * event a caller asking "what am I in right now" most wants.
   */
  it("returns an event that straddles the start of the window", () => {
    const s = seeded([
      {
        pk: 1,
        uuid: "E1",
        start: apple("2026-08-20T09:00:00Z"),
        end: apple("2026-08-22T09:00:00Z"),
      },
    ]);
    expect(s.rangeItems(q()).map((r) => r.uuid)).toEqual(["E1"]);
  });

  it("excludes a repeating master, leaving it to the expansion", () => {
    const s = seeded([
      { pk: 1, uuid: "SERIES", start: apple("2026-08-22T09:00:00Z"), hasRecurrences: 1 },
    ]);
    expect(s.rangeItems(q())).toEqual([]);
  });

  it.each([
    ["a phantom master", { phantom: 1 as const }],
    ["a hidden row", { hidden: 1 as const }],
    ["a non-event entity", { entity: 1 }],
  ])("excludes %s", (_label, over) => {
    const s = seeded([{ pk: 1, uuid: "E1", start: apple("2026-08-22T09:00:00Z"), ...over }]);
    expect(s.rangeItems(q())).toEqual([]);
  });

  it("scopes to a calendar allowlist", () => {
    const s = seeded([
      { pk: 1, uuid: "WORK", start: apple("2026-08-22T09:00:00Z"), calendar: 1 },
      { pk: 2, uuid: "HOL", start: apple("2026-08-22T09:00:00Z"), calendar: 2 },
    ]);
    expect(s.rangeItems(q({ calendarUuids: ["CAL-1"] })).map((r) => r.uuid)).toEqual(["WORK"]);
  });

  it("carries the calendar and account through", () => {
    const s = seeded([{ pk: 1, uuid: "E1", start: apple("2026-08-22T09:00:00Z") }]);
    const row = s.rangeItems(q())[0]!;
    expect(row.calendarTitle).toBe("Work");
    expect(row.calendarUuid).toBe("CAL-1");
  });
});

describe("rangeOccurrences", () => {
  it("expands a weekly series into one row per occurrence", () => {
    const start = apple("2026-08-22T09:00:00Z");
    const s = seeded(
      [{ pk: 1, uuid: "SERIES", start, hasRecurrences: 1 }],
      [
        [1, start, start + 3600],
        [1, start + 7 * DAY, start + 7 * DAY + 3600],
        [1, start + 14 * DAY, start + 14 * DAY + 3600],
      ],
    );
    // Only the first is inside a one-week window; the point is that the query
    // reads the cache at all rather than the master's single start.
    const wide = s.rangeOccurrences(q({ toApple: apple("2026-09-30T00:00:00Z") }));
    expect(wide).toHaveLength(3);
    expect(new Set(wide.map((r) => r.uuid))).toEqual(new Set(["SERIES"]));
  });

  it("returns nothing when the cache is gone, rather than throwing", () => {
    const db = store();
    db.exec("DROP TABLE OccurrenceCache");
    const s = new CalendarStore(db, "ro", introspect(db));
    expect(s.rangeOccurrences(q())).toEqual([]);
  });
});

describe("searchItems", () => {
  it("matches a summary", () => {
    const s = seeded([
      { pk: 1, uuid: "E1", summary: "Design review", start: apple("2026-08-22T09:00:00Z") },
      { pk: 2, uuid: "E2", summary: "Lunch", start: apple("2026-08-22T12:00:00Z") },
    ]);
    const got = s.searchItems({ ...q(), text: "review", scope: "summary" });
    expect(got.map((r) => r.uuid)).toEqual(["E1"]);
  });

  /**
   * `escapeLike`, and the reason it is not optional: an event titled "100%
   * offsite" searched for "%" would otherwise match the entire calendar.
   */
  it("treats a wildcard character as a literal", () => {
    const s = seeded([
      { pk: 1, uuid: "E1", summary: "100% offsite", start: apple("2026-08-22T09:00:00Z") },
      { pk: 2, uuid: "E2", summary: "Standup", start: apple("2026-08-22T10:00:00Z") },
    ]);
    const got = s.searchItems({ ...q(), text: "%", scope: "summary" });
    expect(got.map((r) => r.uuid)).toEqual(["E1"]);
  });
});

describe("calendars and accounts", () => {
  it("lists calendars with their account", () => {
    const s = seeded([]);
    const cals = s.calendars();
    expect(cals.map((c) => c.title)).toEqual(["Work", "Holidays"]);
    expect(cals[0]!.accountName).toBe("iCloud");
  });

  it("counts calendars per account", () => {
    const s = seeded([]);
    expect(s.accounts()).toEqual([{ name: "iCloud", type: 0, calendars: 2 }]);
  });
});

describe("coverage", () => {
  it("reports the edge of the expansion", () => {
    const start = apple("2026-08-22T09:00:00Z");
    const s = seeded(
      [{ pk: 1, uuid: "SERIES", start, hasRecurrences: 1 }],
      [
        [1, start, start + 3600],
        [1, start + 30 * DAY, start + 30 * DAY + 3600],
      ],
    );
    const cov = s.coverage()!;
    expect(cov.rows).toBe(2);
    expect(cov.fromApple).toBe(start);
    expect(cov.toApple).toBe(start + 30 * DAY);
  });

  it("is null when there is nothing to expand from", () => {
    const db = store();
    db.exec("DROP TABLE OccurrenceCache");
    expect(new CalendarStore(db, "ro", introspect(db)).coverage()).toBeNull();
  });
});
