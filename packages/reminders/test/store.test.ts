import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { SchemaDriftError } from "@mgcrea/mcp-apple-core";
import { beforeEach, describe, expect, it } from "vitest";

import { introspect, ReminderStore } from "../src/client/store.js";

/**
 * The schema is REAL — captured from a live store by
 * `scripts/probe-reminders.mjs --write` (macOS 26.6, fingerprint 278b001e3c55,
 * 26 tables, 122 indexes). Only the rows are synthetic.
 *
 * That is the point: if Apple renames a column, these tests fail here rather
 * than in production against someone's actual reminders.
 */
const DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/reminders-store.sql", import.meta.url)),
  "utf8",
);

/** Core Data counts seconds from 2001-01-01. */
const EPOCH = 978_307_200;
const coreData = (iso: string): number => new Date(iso).getTime() / 1000 - EPOCH;

/** Local wall-clock, because all-day means midnight where the person is. */
const localMidnight = (y: number, m: number, d: number) =>
  coreData(new Date(y, m - 1, d, 0, 0, 0, 0).toISOString());
const localAt = (y: number, m: number, d: number, h: number, min = 0) =>
  coreData(new Date(y, m - 1, d, h, min, 0, 0).toISOString());

const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`.toUpperCase();

let db: DatabaseSync;
let store: ReminderStore;

const insertList = (pk: number, name: string, opts: Record<string, unknown> = {}) => {
  db.prepare(
    `INSERT INTO ZREMCDBASELIST (Z_PK, ZNAME, ZCKIDENTIFIER, ZISGROUP, ZPARENTLIST,
       ZSMARTLISTTYPE, ZMARKEDFORDELETION) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    pk,
    name,
    (opts.uuid as string) ?? uuid(pk),
    (opts.isGroup as number) ?? 0,
    (opts.parentList as number) ?? null,
    (opts.smartListType as string) ?? null,
    (opts.deleted as number) ?? 0,
  );
};

const insertReminder = (pk: number, title: string, opts: Record<string, unknown> = {}) => {
  db.prepare(
    `INSERT INTO ZREMCDREMINDER (Z_PK, ZCKIDENTIFIER, ZTITLE, ZNOTES, ZCOMPLETED, ZALLDAY,
       ZDUEDATE, ZCOMPLETIONDATE, ZCREATIONDATE, ZLASTMODIFIEDDATE, ZPRIORITY, ZFLAGGED,
       ZLIST, ZPARENTREMINDER, ZCKPARENTREMINDERIDENTIFIER, ZMARKEDFORDELETION)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    pk,
    (opts.uuid as string) ?? uuid(pk),
    title,
    (opts.notes as string) ?? null,
    (opts.completed as number) ?? 0,
    (opts.allDay as number) ?? 0,
    (opts.due as number) ?? null,
    (opts.completionDate as number) ?? null,
    (opts.created as number) ?? localAt(2026, 8, 1, 10),
    (opts.modified as number) ?? localAt(2026, 8, 19, 10),
    (opts.priority as number) ?? 0,
    (opts.flagged as number) ?? 0,
    (opts.list as number) ?? 1,
    (opts.parent as number) ?? null,
    (opts.parentUuid as string) ?? null,
    (opts.deleted as number) ?? 0,
  );
};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(DDL);
  insertList(1, "Reminders");
  insertList(2, "Groceries", { parentList: 1 });
  store = new ReminderStore(db, "ro", introspect(db));
});

describe("introspect", () => {
  it("reads the captured schema", () => {
    const caps = introspect(db);
    expect(caps.reminderColumns.has("ZALLDAY")).toBe(true);
    expect(caps.reminderColumns.has("ZCKIDENTIFIER")).toBe(true);
    expect(caps.reminderColumns.has("ZPARENTREMINDER")).toBe(true);
    expect(caps.hasAttachments).toBe(true);
    expect(caps.hasObjects).toBe(true);
  });

  /** The fingerprint is what tells you the store changed under you. */
  it("fingerprints the schema stably", () => {
    expect(introspect(db).fingerprint).toBe(introspect(db).fingerprint);
    expect(introspect(db).fingerprint).toHaveLength(12);
  });

  it("refuses a database that is not a Reminders store", () => {
    const other = new DatabaseSync(":memory:");
    other.exec("CREATE TABLE nope (a INTEGER)");
    expect(() => introspect(other)).toThrow(SchemaDriftError);
  });
});

/**
 * THE reason the index lane improves correctness and not just speed.
 *
 * Apple Events populates both `due date` and `allday due date` for every dated
 * reminder — 144 of 144 measured — so it cannot answer this question at all.
 * `ZALLDAY` can, and these two cases are the ones a midnight heuristic gets
 * wrong in each direction.
 */
describe("ZALLDAY is authoritative", () => {
  it("reports an all-day reminder as all-day", () => {
    insertReminder(10, "Bin day", { allDay: 1, due: localMidnight(2026, 8, 21) });
    expect(store.search({ limit: 10 })[0]?.allDay).toBe(true);
  });

  /** A reminder deliberately set to 00:00 defeats the midnight heuristic. */
  it("reports a timed reminder due at midnight as NOT all-day", () => {
    insertReminder(11, "Deploy at midnight", { allDay: 0, due: localMidnight(2026, 8, 21) });
    const got = store.search({ limit: 10 })[0];
    expect(got?.allDay).toBe(false);
    expect(got?.due).not.toBeNull();
  });

  /** And the reverse: an all-day reminder whose stored time is not midnight. */
  it("reports an all-day reminder as all-day even when its time is not midnight", () => {
    insertReminder(12, "Holiday", { allDay: 1, due: localAt(2026, 8, 21, 9) });
    expect(store.search({ limit: 10 })[0]?.allDay).toBe(true);
  });
});

/**
 * The predicate, verified against Apple Events by comparing ID SETS: all rows
 * gave 338 with 21 extra, `ZMARKEDFORDELETION` falsy gave exactly 317 with 0
 * missing and 0 extra. A matching count is not a matching set — that is how the
 * Notes body decoder passed while being 49% wrong.
 */
describe("the live predicate", () => {
  it("hides rows Reminders has tombstoned", () => {
    insertReminder(20, "Real");
    insertReminder(21, "Deleted", { deleted: 1 });
    expect(store.search({ limit: 10 }).map((r) => r.title)).toEqual(["Real"]);
  });

  it("hides completed reminders unless asked", () => {
    insertReminder(22, "Open");
    insertReminder(23, "Done", { completed: 1 });
    expect(store.search({ limit: 10 }).map((r) => r.title)).toEqual(["Open"]);
    expect(store.search({ limit: 10, includeCompleted: true }).map((r) => r.title)).toContain(
      "Done",
    );
  });

  it("still hides tombstoned rows when completed ones are included", () => {
    insertReminder(24, "Deleted and done", { deleted: 1, completed: 1 });
    expect(store.search({ limit: 10, includeCompleted: true })).toEqual([]);
  });
});

describe("ordering", () => {
  /**
   * NULL sorts first in SQLite, so the naive ORDER BY buries every reminder
   * that actually has a deadline under every one that does not.
   */
  it("puts undated reminders last, not first", () => {
    insertReminder(30, "No date");
    insertReminder(31, "Soon", { due: localAt(2026, 8, 21, 9) });
    insertReminder(32, "Later", { due: localAt(2026, 9, 30, 9) });
    expect(store.search({ limit: 10 }).map((r) => r.title)).toEqual(["Soon", "Later", "No date"]);
  });
});

describe("search", () => {
  beforeEach(() => {
    insertReminder(40, "Buy milk", { notes: "semi-skimmed" });
    insertReminder(41, "Call dentist");
    insertReminder(42, "100% rye bread");
  });

  it("matches the title", () => {
    expect(store.search({ query: "milk", limit: 10 }).map((r) => r.title)).toEqual(["Buy milk"]);
  });

  it("matches the notes in full scope", () => {
    expect(store.search({ query: "skimmed", scope: "full", limit: 10 })).toHaveLength(1);
  });

  it("does not match the notes in title scope", () => {
    expect(store.search({ query: "skimmed", scope: "title", limit: 10 })).toEqual([]);
  });

  /**
   * Without ESCAPE, a query containing % matches everything. The fixture holds
   * a reminder whose title genuinely contains a percent sign, so a wildcard
   * search still finds exactly that one — not the whole table.
   */
  it("treats a percent sign as a literal", () => {
    const hits = store.search({ query: "%", limit: 10 });
    expect(hits.map((r) => r.title)).toEqual(["100% rye bread"]);
  });

  it("treats an underscore as a literal", () => {
    expect(store.search({ query: "_", limit: 10 })).toEqual([]);
  });

  it("pages with limit and offset", () => {
    expect(store.search({ limit: 2 })).toHaveLength(2);
    expect(store.search({ limit: 2, offset: 2 })).toHaveLength(1);
  });

  it("filters to one list", () => {
    insertReminder(43, "In groceries", { list: 2 });
    expect(store.search({ listPk: 2, limit: 10 }).map((r) => r.title)).toEqual(["In groceries"]);
  });

  it("carries the list name through the join", () => {
    insertReminder(44, "Somewhere", { list: 2 });
    expect(store.search({ listPk: 2, limit: 10 })[0]?.listName).toBe("Groceries");
  });
});

describe("the id bridge", () => {
  it("finds a reminder by the uuid inside its Apple Events id", () => {
    insertReminder(50, "Findable", { uuid: uuid(5) });
    expect(store.byUuid(uuid(5))?.title).toBe("Findable");
  });

  /** Stored case is not guaranteed to match what Apple Events hands out. */
  it("matches regardless of case", () => {
    insertReminder(51, "Findable", { uuid: uuid(5) });
    expect(store.byUuid(uuid(5).toLowerCase())?.title).toBe("Findable");
  });

  it("returns null for an unknown uuid", () => {
    expect(store.byUuid(uuid(9))).toBeNull();
  });

  it("does not resolve a tombstoned reminder", () => {
    insertReminder(52, "Gone", { uuid: uuid(6), deleted: 1 });
    expect(store.byUuid(uuid(6))).toBeNull();
  });
});

/**
 * Subtasks exist ONLY here. `reminder.container()` threw on 60 of 60 attempts
 * over Apple Events, so `ZPARENTREMINDER` is the only way to know a reminder
 * has a parent.
 */
describe("subtasks", () => {
  beforeEach(() => {
    insertReminder(60, "Call dentist", { uuid: uuid(6) });
    insertReminder(61, "Find the number", { parent: 60, parentUuid: uuid(6) });
    insertReminder(62, "Check insurance", { parent: 60, parentUuid: uuid(6) });
    insertReminder(63, "Unrelated");
  });

  it("finds a reminder's children", () => {
    expect(store.subtasksOf(60).map((r) => r.title)).toEqual([
      "Check insurance",
      "Find the number",
    ]);
  });

  it("carries the parent uuid, so a ref can be built for it", () => {
    expect(store.subtasksOf(60)[0]?.parentUuid).toBe(uuid(6));
  });

  it("returns nothing for a reminder with no children", () => {
    expect(store.subtasksOf(63)).toEqual([]);
  });

  /** Subtasks are still ordinary reminders and must not vanish from listings. */
  it("still lists subtasks in the main query", () => {
    expect(store.search({ limit: 10 }).map((r) => r.title)).toContain("Find the number");
  });
});

describe("lists", () => {
  it("reads names and nesting", () => {
    const lists = store.lists();
    expect(lists.map((l) => l.name)).toEqual(["Groceries", "Reminders"]);
    expect(lists.find((l) => l.name === "Groceries")?.parentListPk).toBe(1);
  });

  it("hides tombstoned lists", () => {
    insertList(3, "Old list", { deleted: 1 });
    expect(store.lists().map((l) => l.name)).not.toContain("Old list");
  });

  it("reports a smart list as one", () => {
    insertList(4, "Today", { smartListType: "today" });
    expect(store.lists().find((l) => l.name === "Today")?.smartListType).toBe("today");
  });
});

describe("attachments", () => {
  it("reads a reminder's attachments", () => {
    insertReminder(70, "With a file");
    db.prepare(
      `INSERT INTO ZREMCDSAVEDATTACHMENT (Z_PK, ZREMINDER, ZFILENAME, ZUTI, ZCKIDENTIFIER,
         ZMARKEDFORDELETION) VALUES (?,?,?,?,?,?)`,
    ).run(1, 70, "receipt.pdf", "com.adobe.pdf", uuid(7), 0);
    const got = store.attachmentsOf(70);
    expect(got).toHaveLength(1);
    expect(got[0]?.filename).toBe("receipt.pdf");
    expect(got[0]?.uti).toBe("com.adobe.pdf");
  });

  it("returns nothing for a reminder with none", () => {
    insertReminder(71, "Bare");
    expect(store.attachmentsOf(71)).toEqual([]);
  });
});

/**
 * `ZREMCDOBJECT` is polymorphic — alarms and recurrence rules share it and are
 * told apart by which columns are populated. So this reports presence rather
 * than pretending to reconstruct an RFC 5545 rule from undocumented columns.
 */
describe("enrichment", () => {
  const insertObject = (pk: number, reminder: number, cols: Record<string, unknown>) => {
    db.prepare(
      `INSERT INTO ZREMCDOBJECT (Z_PK, ZREMINDER, ZALARMUID, ZFREQUENCY, ZLATITUDE, ZLONGITUDE,
         ZPROXIMITY) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      pk,
      reminder,
      (cols.alarmUid as string) ?? null,
      (cols.frequency as number) ?? null,
      (cols.latitude as number) ?? null,
      (cols.longitude as number) ?? null,
      (cols.proximity as number) ?? null,
    );
  };

  it("counts alarms", () => {
    insertReminder(80, "Alarmed");
    insertObject(1, 80, { alarmUid: "alarm-1" });
    insertObject(2, 80, { alarmUid: "alarm-2" });
    expect(store.enrichmentOf(80).alarmCount).toBe(2);
  });

  it("notices a recurrence rule", () => {
    insertReminder(81, "Weekly");
    insertObject(3, 81, { frequency: 2 });
    expect(store.enrichmentOf(81).hasRecurrence).toBe(true);
  });

  it("reads a location alarm", () => {
    insertReminder(82, "At the shop");
    insertObject(4, 82, { alarmUid: "a", latitude: 48.8566, longitude: 2.3522, proximity: 1 });
    expect(store.enrichmentOf(82).location).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
      proximity: 1,
    });
  });

  it("reports nothing for a plain reminder", () => {
    insertReminder(83, "Plain");
    expect(store.enrichmentOf(83)).toEqual({
      alarmCount: 0,
      hasRecurrence: false,
      location: null,
    });
  });
});

/** Being 31 years out is the classic Core Data date mistake. */
describe("dates", () => {
  it("reads Core Data seconds as the right instant", () => {
    const due = localAt(2026, 8, 21, 9, 30);
    insertReminder(90, "Dated", { due });
    const got = store.search({ limit: 10 })[0];
    expect(new Date(got?.due as string).getFullYear()).toBe(2026);
    expect(new Date(got?.due as string).getTime()).toBe((due + EPOCH) * 1000);
  });

  it("leaves a missing date null rather than 2001", () => {
    insertReminder(91, "Undated");
    expect(store.search({ limit: 10 })[0]?.due).toBeNull();
  });
});
