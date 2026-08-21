import { readFileSync, mkdtempSync } from "node:fs";
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
 * End-to-end through a real McpServer, against a real SQLite file built from
 * the captured DDL.
 *
 * The store is written to a temp path and handed over with APPLE_CALENDAR_STORE
 * so nothing ever discovers the developer's own calendar — on a machine with
 * Full Disk Access these tests would otherwise pass or fail on data nobody wrote.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "calendar-store.sql");

const EPOCH = 978_307_200;
const apple = (iso: string) => Math.round(new Date(iso).getTime() / 1000) - EPOCH;
const DAY = 86_400;

/** Frozen: a relative range must resolve against this, not the wall clock. */
const NOW = new Date("2026-08-21T12:00:00Z");
const START = apple("2026-08-22T09:00:00Z");

let storePath: string;

beforeAll(() => {
  storePath = join(mkdtempSync(join(tmpdir(), "mcp-apple-calendar-")), "Calendar.sqlitedb");
  const db = new DatabaseSync(storePath);
  db.exec(readFileSync(FIXTURE, "utf8"));
  db.exec(`INSERT INTO Store (ROWID, name, type) VALUES (1, 'iCloud', 0)`);
  db.exec(
    `INSERT INTO Calendar (ROWID, store_id, title, UUID, color, type, display_order, subcal_url)
     VALUES (1, 1, 'Work', 'CAL-1', '#f00', 'CalDAV', 0, NULL),
            (2, 1, 'Holidays', 'CAL-2', '#0f0', 'Subscribed', 1, 'https://example.test/ics')`,
  );
  const item = db.prepare(
    `INSERT INTO CalendarItem
       (ROWID, UUID, summary, description, start_date, end_date, all_day, start_tz,
        calendar_id, entity_type, has_recurrences, status, invitation_status)
     VALUES (?,?,?,?,?,?,?,?,?,2,?,?,?)`,
  );
  // A one-shot meeting, a weekly series, an all-day holiday, a declined invite
  // and a cancelled event — one row per behaviour the tools have to distinguish.
  item.run(
    1,
    "E-ONE",
    "Design review",
    "in the big room",
    START,
    START + 3600,
    0,
    "Europe/Paris",
    1,
    0,
    1,
    2,
  );
  item.run(
    2,
    "E-SERIES",
    "Standup",
    null,
    START + 1800,
    START + 3600,
    0,
    "Europe/Paris",
    1,
    1,
    1,
    2,
  );
  item.run(
    3,
    "E-ALLDAY",
    "Bank holiday",
    null,
    apple("2026-08-24T00:00:00Z"),
    apple("2026-08-25T00:00:00Z"),
    1,
    "_float",
    2,
    0,
    1,
    2,
  );
  item.run(
    4,
    "E-DECLINED",
    "Optional sync",
    null,
    START + 7200,
    START + 9000,
    0,
    "Europe/Paris",
    1,
    0,
    1,
    3,
  );
  item.run(
    5,
    "E-CANCELLED",
    "Scrapped",
    null,
    START + 10800,
    START + 12600,
    0,
    "Europe/Paris",
    1,
    0,
    3,
    2,
  );
  const occ = db.prepare(
    `INSERT INTO OccurrenceCache (event_id, calendar_id, store_id, day, occurrence_date,
       occurrence_start_date, occurrence_end_date) VALUES (2, 1, 1, ?, ?, ?, ?)`,
  );
  for (const w of [0, 1, 2]) {
    const t = START + 1800 + w * 7 * DAY;
    occ.run(t, t, t, t + 1800);
  }
  db.close();
});

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config = loadConfig({ APPLE_CALENDAR_STORE: storePath, ...env });
  const { server } = createServer({ config, now: () => NOW });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const call = async (name: string, args: Record<string, unknown> = {}, env = {}) => {
  const res = (await (await connect(env)).callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: JSON.parse(text) as never };
};

type Page = {
  events: {
    ref: string;
    summary: string;
    allDay: boolean;
    start: { day?: string; iso?: string; timeZone: string | null };
    isOccurrence: boolean;
    seriesRef?: string;
    calendar: string;
  }[];
  expansion: string;
  coverage: { from: string; to: string } | null;
  truncated?: { affects: string; uncoveredTo?: string };
  window: { clamped: boolean };
};

describe("apple_calendar_list_calendars", () => {
  it("lists calendars with their account and marks a subscribed one read-only", async () => {
    const cals = (await call("apple_calendar_list_calendars")).json as {
      title: string;
      accountName: string;
      isSubscribed: boolean;
    }[];
    expect(cals.map((c) => c.title)).toEqual(["Work", "Holidays"]);
    expect(cals[0]!.accountName).toBe("iCloud");
    expect(cals.find((c) => c.title === "Holidays")!.isSubscribed).toBe(true);
    expect(cals.find((c) => c.title === "Work")!.isSubscribed).toBe(false);
  });
});

describe("apple_calendar_list_events", () => {
  it("returns events in the window, earliest first", async () => {
    const p = (await call("apple_calendar_list_events")).json as Page;
    expect(p.events.map((e) => e.summary)).toContain("Design review");
    const starts = p.events.map((e) => e.start.iso ?? e.start.day ?? "");
    expect(starts).toEqual([...starts].toSorted());
  });

  /** The whole point of leg 2: a weekly series must not appear once. */
  it("expands a repeating event into one row per occurrence", async () => {
    const p = (await call("apple_calendar_list_events", { from: "2026-08-21", to: "2026-09-10" }))
      .json as Page;
    const standups = p.events.filter((e) => e.summary === "Standup");
    expect(standups).toHaveLength(3);
    expect(standups.every((e) => e.isOccurrence)).toBe(true);
    // Each instance is separately addressable, and points back at the series.
    expect(new Set(standups.map((e) => e.ref)).size).toBe(3);
    expect(new Set(standups.map((e) => e.seriesRef)).size).toBe(1);
    expect(p.expansion).toBe("expanded");
  });

  it("renders a timed event in its own zone", async () => {
    const p = (await call("apple_calendar_list_events")).json as Page;
    const one = p.events.find((e) => e.summary === "Design review")!;
    expect(one.allDay).toBe(false);
    expect(one.start.timeZone).toBe("Europe/Paris");
    expect(one.start.iso).toBe("2026-08-22T11:00:00+02:00");
  });

  /** An all-day event names a day and carries no instant, in any zone. */
  it("renders an all-day event as a bare day with no zone", async () => {
    const p = (await call("apple_calendar_list_events", { from: "2026-08-24", to: "2026-08-24" }))
      .json as Page;
    const holiday = p.events.find((e) => e.summary === "Bank holiday")!;
    expect(holiday.allDay).toBe(true);
    expect(holiday.start.day).toBe("2026-08-24");
    expect(holiday.start.timeZone).toBeNull();
    expect(holiday.start.iso).toBeUndefined();
  });

  it("hides declined and cancelled events by default, and shows them on request", async () => {
    const hidden = (await call("apple_calendar_list_events")).json as Page;
    expect(hidden.events.map((e) => e.summary)).not.toContain("Optional sync");
    expect(hidden.events.map((e) => e.summary)).not.toContain("Scrapped");

    const shown = (
      await call("apple_calendar_list_events", { includeDeclined: true, includeCancelled: true })
    ).json as Page;
    expect(shown.events.map((e) => e.summary)).toContain("Optional sync");
    expect(shown.events.map((e) => e.summary)).toContain("Scrapped");
  });

  it("scopes to one calendar", async () => {
    const p = (
      await call("apple_calendar_list_events", {
        calendar: "Holidays",
        from: "2026-08-24",
        to: "2026-08-24",
      })
    ).json as Page;
    expect(p.events.every((e) => e.calendar === "Holidays")).toBe(true);
  });

  it("refuses a calendar that does not exist, naming what does", async () => {
    const out = await call("apple_calendar_list_events", { calendar: "Nope" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/No calendar named .*Nope/);
    expect(out.text).toMatch(/Available: Work, Holidays/);
  });

  /**
   * A short list of events is indistinguishable from a free afternoon, so a
   * window past the expansion must SAY so rather than quietly return less.
   */
  it("flags a range that runs past the expanded window", async () => {
    const p = (await call("apple_calendar_list_events", { from: "2026-08-21", to: "2028-08-21" }))
      .json as Page;
    expect(p.truncated?.affects).toMatch(/repeating events only/);
    expect(p.coverage).not.toBeNull();
  });

  it("clamps an absurd range instead of scanning a decade", async () => {
    const p = (await call("apple_calendar_list_events", { from: "2026-01-01", to: "2036-01-01" }))
      .json as Page;
    expect(p.window.clamped).toBe(true);
  });
});

describe("apple_calendar_search_events", () => {
  it("finds an event by title", async () => {
    const p = (await call("apple_calendar_search_events", { query: "design" })).json as Page;
    expect(p.events.map((e) => e.summary)).toEqual(["Design review"]);
  });

  it("searches notes only when asked", async () => {
    const summaryOnly = (await call("apple_calendar_search_events", { query: "big room" }))
      .json as Page;
    expect(summaryOnly.events).toHaveLength(0);
    const full = (await call("apple_calendar_search_events", { query: "big room", scope: "full" }))
      .json as Page;
    expect(full.events.map((e) => e.summary)).toEqual(["Design review"]);
  });

  /** Matching a series once is what a search result should be, and it says so. */
  it("returns a repeating event once and discloses that it did not expand", async () => {
    const p = (await call("apple_calendar_search_events", { query: "standup" })).json as Page;
    expect(p.events).toHaveLength(1);
    expect(p.expansion).toBe("unavailable");
  });
});

describe("apple_calendar_get_event", () => {
  it("returns full detail for a single event", async () => {
    const list = (await call("apple_calendar_list_events")).json as Page;
    const ref = list.events.find((e) => e.summary === "Design review")!.ref;
    const got = (await call("apple_calendar_get_event", { ref })).json as {
      summary: string;
      description: string;
      timeZone: string;
    };
    expect(got.summary).toBe("Design review");
    expect(got.description).toBe("in the big room");
    expect(got.timeZone).toBe("Europe/Paris");
  });

  /** An occurrence ref names an instant the master row does not carry. */
  it("reports the occurrence's own time, not the series start", async () => {
    const list = (
      await call("apple_calendar_list_events", {
        from: "2026-08-21",
        to: "2026-09-10",
      })
    ).json as Page;
    const third = list.events.filter((e) => e.summary === "Standup")[2]!;
    const got = (await call("apple_calendar_get_event", { ref: third.ref })).json as {
      start: { iso: string };
      isOccurrence: boolean;
      seriesRef: string;
    };
    expect(got.isOccurrence).toBe(true);
    expect(got.start.iso).toBe(third.start.iso);
    expect(got.seriesRef).toBe(third.seriesRef);
  });

  it("refuses a ref from another surface with a message that says so", async () => {
    const out = await call("apple_calendar_get_event", { ref: "r1:x-apple-reminder://abc" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/another surface/);
  });
});

describe("no store", () => {
  /**
   * Calendar has no Apple Events read lane to fall back to, so an unreachable
   * store must be an ERROR. An empty array would read as an empty calendar,
   * which is the one answer this surface must never invent.
   */
  it("errors rather than returning an empty calendar", async () => {
    const out = await call(
      "apple_calendar_list_events",
      {},
      {
        APPLE_CALENDAR_STORE: "/nope/missing.sqlitedb",
      },
    );
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/\[\]/);
  });
});
