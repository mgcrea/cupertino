import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * `apple_calendar_find_availability`, end to end through a real McpServer
 * against a real SQLite file.
 *
 * Two things make this file different from `events.tools.test.ts`.
 *
 * Everything is built in LOCAL components rather than from UTC instants,
 * because working hours are local and a fixture written in UTC would pass on
 * the author's machine and drift on a runner in another zone.
 *
 * And most of the assertions are about REFUSALS. The tool's whole claim is that
 * an empty `slots` list means booked and `degraded` means unknown; a test suite
 * that only checked the happy path would let the two collapse into each other,
 * which is the bug the tool exists to prevent.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "calendar-store.sql");

const EPOCH = 978_307_200;
/** Local wall clock -> Apple seconds, so the fixture means the same everywhere. */
const at = (y: number, mo: number, d: number, hh = 0, mm = 0): number =>
  Math.round(new Date(y, mo - 1, d, hh, mm, 0, 0).getTime() / 1000) - EPOCH;

/** Monday, 08:00 local. Every relative window in this file resolves against it. */
const NOW = new Date(2026, 7, 24, 8, 0, 0, 0);

let storePath: string;
let bareStorePath: string;
let crowdedStorePath: string;

const schema = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(FIXTURE, "utf8"));
  db.exec(`INSERT INTO Store (ROWID, name, type) VALUES (1, 'iCloud', 0)`);
  db.exec(
    `INSERT INTO Calendar (ROWID, store_id, title, UUID, color, type, display_order)
     VALUES (1, 1, 'Work', 'CAL-1', '#f00', 'CalDAV', 0),
            (2, 1, 'Personal', 'CAL-2', '#0f0', 'CalDAV', 1)`,
  );
  return db;
};

const insertItem = (db: DatabaseSync) =>
  db.prepare(
    `INSERT INTO CalendarItem
       (ROWID, UUID, summary, start_date, end_date, all_day, start_tz, calendar_id,
        entity_type, has_recurrences, status, invitation_status, availability)
     VALUES (?,?,?,?,?,?,?,?,2,?,?,?,?)`,
  );

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-apple-calendar-avail-"));

  // ── the ordinary store ────────────────────────────────────────────────────
  storePath = join(dir, "Calendar.sqlitedb");
  const db = schema(storePath);
  const item = insertItem(db);
  // Monday: two meetings, leaving 10:30-14:00 and 15:00-18:00 open.
  item.run(
    1,
    "E-REVIEW",
    "Design review",
    at(2026, 8, 24, 9),
    at(2026, 8, 24, 10, 30),
    0,
    "_float",
    1,
    0,
    1,
    2,
    0,
  );
  item.run(
    2,
    "E-ONEONE",
    "1:1",
    at(2026, 8, 24, 14),
    at(2026, 8, 24, 15),
    0,
    "_float",
    1,
    0,
    1,
    2,
    0,
  );
  // A weekly standup: the series row sits on the first Tuesday, and the cache
  // carries the rest. The second Tuesday is what proves expansion is used.
  item.run(
    3,
    "E-STANDUP",
    "Standup",
    at(2026, 8, 25, 9),
    at(2026, 8, 25, 9, 30),
    0,
    "_float",
    1,
    1,
    1,
    2,
    0,
  );
  // Wednesday: an all-day event that is a birthday, not a day off.
  item.run(
    4,
    "E-BIRTHDAY",
    "Ana's birthday",
    at(2026, 8, 26),
    at(2026, 8, 27),
    1,
    "_float",
    2,
    0,
    1,
    2,
    0,
  );
  // Thursday morning, declined — you are free then.
  item.run(
    5,
    "E-DECLINED",
    "Optional sync",
    at(2026, 8, 27, 9),
    at(2026, 8, 27, 11),
    0,
    "_float",
    1,
    0,
    1,
    3,
    0,
  );
  // Friday morning, cancelled by the organiser — likewise.
  item.run(
    6,
    "E-CANCELLED",
    "Scrapped",
    at(2026, 8, 28, 9),
    at(2026, 8, 28, 11),
    0,
    "_float",
    1,
    0,
    3,
    2,
    0,
  );
  // Monday the 31st, marked "free" rather than busy.
  item.run(
    7,
    "E-FREE",
    "Focus block",
    at(2026, 8, 31, 9),
    at(2026, 8, 31, 12),
    0,
    "_float",
    1,
    0,
    1,
    2,
    1,
  );

  const occ = db.prepare(
    `INSERT INTO OccurrenceCache (event_id, calendar_id, store_id, day, occurrence_date,
       occurrence_start_date, occurrence_end_date) VALUES (3, 1, 1, ?, ?, ?, ?)`,
  );
  for (const week of [0, 1]) {
    const t = at(2026, 8, 25 + week * 7, 9);
    occ.run(t, t, t, t + 1800);
  }
  // Coverage has to reach past every window these tests ask for, or the tool
  // would (correctly) refuse instead of answering.
  const edge = db.prepare(
    `INSERT INTO OccurrenceCache (event_id, calendar_id, store_id, day, occurrence_date,
       occurrence_start_date, occurrence_end_date) VALUES (1, 1, 1, ?, ?, ?, ?)`,
  );
  for (const [y, mo, d] of [
    [2026, 6, 1],
    [2026, 12, 1],
  ] as const) {
    const t = at(y, mo, d, 9);
    edge.run(t, t, t, t + 3600);
  }
  db.close();

  // ── a store with no expansion at all ──────────────────────────────────────
  bareStorePath = join(dir, "Bare.sqlitedb");
  const bare = schema(bareStorePath);
  insertItem(bare).run(
    1,
    "E-REVIEW",
    "Design review",
    at(2026, 8, 24, 9),
    at(2026, 8, 24, 10, 30),
    0,
    "_float",
    1,
    0,
    1,
    2,
    0,
  );
  bare.exec("DROP TABLE OccurrenceCache");
  bare.close();

  // ── a store holding more events than the scan bound ───────────────────────
  crowdedStorePath = join(dir, "Crowded.sqlitedb");
  const crowded = schema(crowdedStorePath);
  const many = insertItem(crowded);
  crowded.exec("BEGIN");
  for (let i = 0; i < 5_001; i += 1) {
    const start = at(2026, 8, 24, 0) + i * 60;
    many.run(i + 1, `E-${i}`, "Busy", start, start + 30, 0, "_float", 1, 0, 1, 2, 0);
  }
  crowded.exec("COMMIT");
  const covered = crowded.prepare(
    `INSERT INTO OccurrenceCache (event_id, calendar_id, store_id, day, occurrence_date,
       occurrence_start_date, occurrence_end_date) VALUES (1, 1, 1, ?, ?, ?, ?)`,
  );
  for (const [y, mo, d] of [
    [2026, 6, 1],
    [2026, 12, 1],
  ] as const) {
    const t = at(y, mo, d, 9);
    covered.run(t, t, t, t + 3600);
  }
  crowded.close();
});

const connect = async (env: NodeJS.ProcessEnv = {}, now: Date = NOW) => {
  const config = loadConfig({ APPLE_CALENDAR_STORE: storePath, ...env });
  const { server } = createServer({ config, now: () => now });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

type Slot = { start: string; end: string; day: string; minutes: number };
type Answer = {
  slots: Slot[];
  degraded?: true;
  capability?: string;
  reason?: string;
  hint?: string;
  note?: string;
  window: { from: string; to: string; startedAtNow: boolean };
  busy: { blocking: number; intervals: number };
  allDayEvents: { day: string; summary: string }[];
  truncated?: { reason: string; requestedTo?: string };
  coverage: { from: string; to: string } | null;
};

const find = async (
  args: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  now: Date = NOW,
): Promise<Answer> => {
  const res = (await (
    await connect(env, now)
  ).callTool({
    name: "apple_calendar_find_availability",
    arguments: { durationMinutes: 60, ...args },
  })) as { content: { text: string }[] };
  return JSON.parse(res.content.map((c) => c.text).join("")) as Answer;
};

/** "2026-08-24T10:30:00+02:00" -> "2026-08-24 10:30", zone-independent. */
const wall = (s: Slot): string => `${s.start.slice(0, 10)} ${s.start.slice(11, 16)}`;
const range = (s: Slot): string => `${wall(s)}-${s.end.slice(11, 16)}`;

describe("apple_calendar_find_availability", () => {
  it("returns the gaps between meetings, inside working hours", async () => {
    const out = await find({ to: "2026-08-24" });
    expect(out.slots.map(range)).toEqual(["2026-08-24 10:30-14:00", "2026-08-24 15:00-18:00"]);
    expect(out.slots[0]!.minutes).toBe(210);
  });

  /** A gap shorter than the meeting is not a slot: 15:00-18:00 is only 180. */
  it("drops a gap that cannot hold the requested duration", async () => {
    const out = await find({ to: "2026-08-24", durationMinutes: 200 });
    expect(out.slots.map(range)).toEqual(["2026-08-24 10:30-14:00"]);
  });

  it("never offers time before the working day or after it", async () => {
    const out = await find({ to: "2026-08-24", durationMinutes: 15 });
    for (const s of out.slots) {
      expect(s.start.slice(11, 16) >= "09:00").toBe(true);
      expect(s.end.slice(11, 16) <= "18:00").toBe(true);
    }
  });

  it("honours dayStart, dayEnd and weekdays", async () => {
    const out = await find({
      from: "2026-08-29",
      to: "2026-08-30",
      dayStart: "10:00",
      dayEnd: "12:00",
      weekdays: ["sat", "sun"],
    });
    expect(out.slots.map(range)).toEqual(["2026-08-29 10:00-12:00", "2026-08-30 10:00-12:00"]);
  });

  it("skips the weekend by default", async () => {
    const out = await find({ from: "2026-08-29", to: "2026-08-30" });
    expect(out.slots).toEqual([]);
  });

  /**
   * The reason this tool exists rather than "list events and look for gaps".
   * The standup has ONE row in CalendarItem and lives on the second Tuesday
   * only in OccurrenceCache.
   */
  it("blocks an occurrence of a repeating event a week out", async () => {
    const out = await find({ from: "2026-09-01", to: "2026-09-01", durationMinutes: 30 });
    expect(out.slots.map(range)).toEqual(["2026-09-01 09:30-18:00"]);
  });

  /** Declined and cancelled events are not on your schedule. */
  it("does not let a declined or cancelled event block time", async () => {
    const thursday = await find({ from: "2026-08-27", to: "2026-08-27" });
    expect(thursday.slots.map(range)).toEqual(["2026-08-27 09:00-18:00"]);
    const friday = await find({ from: "2026-08-28", to: "2026-08-28" });
    expect(friday.slots.map(range)).toEqual(["2026-08-28 09:00-18:00"]);
  });

  it("blocks a declined event once you ask for it", async () => {
    const out = await find({ from: "2026-08-27", to: "2026-08-27", includeDeclined: true });
    expect(out.slots.map(range)).toEqual(["2026-08-27 11:00-18:00"]);
  });

  // ── all-day events ─────────────────────────────────────────────────────────

  /**
   * The birthday case. Blocking on every all-day event would delete a working
   * day; ignoring them silently would book over a holiday. So the day stays
   * open and the event is reported next to it.
   */
  it("leaves an all-day event's day open but reports the event", async () => {
    const out = await find({ from: "2026-08-26", to: "2026-08-26" });
    expect(out.slots.map(range)).toEqual(["2026-08-26 09:00-18:00"]);
    expect(out.allDayEvents).toEqual([
      { day: "2026-08-26", summary: "Ana's birthday", calendar: "Personal" },
    ]);
  });

  it("blocks the whole day when allDayBusy is on", async () => {
    const out = await find({ from: "2026-08-26", to: "2026-08-26", allDayBusy: true });
    expect(out.slots).toEqual([]);
    expect(out.busy.blocking).toBe(1);
  });

  // ── the free/busy marking ──────────────────────────────────────────────────

  /** Off by default, because the constant behind it has never been measured. */
  it('treats an event marked "free" as busy unless asked not to', async () => {
    const blocking = await find({ from: "2026-08-31", to: "2026-08-31", durationMinutes: 30 });
    expect(blocking.slots.map(range)).toEqual(["2026-08-31 12:00-18:00"]);

    const respected = await find({
      from: "2026-08-31",
      to: "2026-08-31",
      durationMinutes: 30,
      respectFreeMarking: true,
    });
    expect(respected.slots.map(range)).toEqual(["2026-08-31 09:00-18:00"]);
  });

  // ── the clock ──────────────────────────────────────────────────────────────

  it("does not offer time that has already passed today", async () => {
    const out = await find({ to: "2026-08-24" }, {}, new Date(2026, 7, 24, 11, 20, 0, 0));
    expect(out.window.startedAtNow).toBe(true);
    // 10:30 is gone; the first bookable boundary after 11:20 is 11:30.
    expect(out.slots.map(range)).toEqual(["2026-08-24 11:30-14:00", "2026-08-24 15:00-18:00"]);
  });

  it("rounds a slot start up to the granularity boundary", async () => {
    const out = await find(
      { to: "2026-08-24", granularityMinutes: 30 },
      {},
      new Date(2026, 7, 24, 11, 20, 0, 0),
    );
    expect(out.slots[0]!.start.slice(11, 16)).toBe("11:30");
  });

  it("reports an all-past window as unchecked rather than as fully booked", async () => {
    const out = await find({ from: "2026-08-01", to: "2026-08-10" });
    expect(out.slots).toEqual([]);
    expect(out.note).toMatch(/already passed/);
    expect(out.degraded).toBeUndefined();
  });

  // ── refusals ───────────────────────────────────────────────────────────────

  /**
   * The distinction the whole tool rests on: three of these return no slots and
   * only one of them means "you are busy".
   */
  it("refuses when the store expands no repeating events", async () => {
    const out = await find({ to: "2026-08-24" }, { APPLE_CALENDAR_STORE: bareStorePath });
    expect(out.degraded).toBe(true);
    expect(out.capability).toBe("occurrence-expansion");
    expect(out.slots).toBeUndefined();
    expect(out.hint).toMatch(/list_events/);
  });

  it("refuses when the window holds more events than it will read", async () => {
    const out = await find({ to: "2026-08-28" }, { APPLE_CALENDAR_STORE: crowdedStorePath });
    expect(out.degraded).toBe(true);
    expect(out.capability).toBe("busy-set");
    expect(out.reason).toMatch(/no answer at all/);
  });

  it("refuses a window that lies entirely past the expansion", async () => {
    const out = await find({ from: "2027-06-01", to: "2027-06-05" });
    expect(out.degraded).toBe(true);
    expect(out.capability).toBe("occurrence-coverage");
    expect(out.hint).toMatch(/list_events/);
  });

  /** Partly covered is answerable — for the covered part, and it says so. */
  it("cuts the window back to the coverage edge rather than inventing free time", async () => {
    const out = await find({ from: "2026-11-30", to: "2027-01-15" });
    expect(out.degraded).toBeUndefined();
    expect(out.truncated?.requestedTo).toMatch(/^2027-01-15/);
    expect(out.window.to.slice(0, 10)).toBe("2026-12-01");
    for (const s of out.slots) expect(s.day <= "2026-12-01").toBe(true);
  });

  it("distinguishes a booked day from an unreadable one", async () => {
    const booked = await find({ from: "2026-08-26", to: "2026-08-26", allDayBusy: true });
    expect(booked.slots).toEqual([]);
    expect(booked.degraded).toBeUndefined();
    expect(booked.busy.blocking).toBe(1);
  });

  // ── the shape of the answer ────────────────────────────────────────────────

  it("reports the working hours and window it actually used", async () => {
    const out = (await find({ to: "2026-08-24" })) as Answer & {
      workingHours: { dayStart: string; dayEnd: string; weekdays: string[]; timeZone: string };
    };
    expect(out.workingHours.dayStart).toBe("09:00");
    expect(out.workingHours.weekdays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(out.workingHours.timeZone).toBeTruthy();
    expect(out.coverage).not.toBeNull();
  });

  it("takes its default working hours from the environment", async () => {
    const out = await find(
      { to: "2026-08-24", durationMinutes: 30 },
      { APPLE_CALENDAR_WORKDAY_START: "08:00", APPLE_CALENDAR_WORKDAY_END: "12:00" },
    );
    expect(out.slots.map(range)).toEqual(["2026-08-24 08:00-09:00", "2026-08-24 10:30-12:00"]);
  });

  it("caps the number of slots at limit", async () => {
    const out = await find({ from: "2026-09-07", to: "2026-09-30", limit: 3 });
    expect(out.slots).toHaveLength(3);
  });

  it("scopes to one calendar when asked", async () => {
    const out = await find({ from: "2026-08-26", to: "2026-08-26", calendar: "Work" });
    expect(out.allDayEvents).toEqual([]);
  });

  it("rejects a granularity that does not divide an hour", async () => {
    const res = (await (
      await connect()
    ).callTool({
      name: "apple_calendar_find_availability",
      arguments: { durationMinutes: 60, granularityMinutes: 7 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join("")).toMatch(/divide 60/);
  });

  it("names the argument when a working-hours value is not a time", async () => {
    const res = (await (
      await connect()
    ).callTool({
      name: "apple_calendar_find_availability",
      arguments: { durationMinutes: 60, dayStart: "morning" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join("")).toMatch(/dayStart/);
  });
});
