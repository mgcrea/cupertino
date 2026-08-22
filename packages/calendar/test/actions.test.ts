import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "calendar-store.sql");
const EPOCH = 978_307_200;
const apple = (iso: string) => Math.round(new Date(iso).getTime() / 1000) - EPOCH;
const NOW = new Date("2026-08-21T12:00:00Z");
const START = apple("2026-08-22T09:00:00Z");

let storePath: string;

beforeAll(() => {
  storePath = join(mkdtempSync(join(tmpdir(), "mcp-apple-calendar-w-")), "Calendar.sqlitedb");
  const db = new DatabaseSync(storePath);
  db.exec(readFileSync(FIXTURE, "utf8"));
  db.exec(`INSERT INTO Store (ROWID, name, type) VALUES (1, 'iCloud', 0)`);
  db.exec(
    `INSERT INTO Calendar (ROWID, store_id, title, UUID, type, display_order, subcal_url)
     VALUES (1, 1, 'Work', 'CAL-1', 'CalDAV', 0, NULL),
            (2, 1, 'Holidays', 'CAL-2', 'Subscribed', 1, 'https://example.test/ics')`,
  );
  db.prepare(
    `INSERT INTO CalendarItem (ROWID, UUID, summary, start_date, end_date, all_day, start_tz,
       calendar_id, entity_type, has_recurrences, status, invitation_status)
     VALUES (1,'E-ONE','Design review',?,?,0,'Europe/Paris',1,2,0,1,2)`,
  ).run(START, START + 3600);
  db.close();
});

/** The readback shape the JXA scripts return. */
const READBACK = {
  uid: "E-NEW",
  summary: "Design review",
  startDate: "2026-08-22T09:00:00.000Z",
  endDate: "2026-08-22T10:00:00.000Z",
  alldayEvent: false,
  location: null,
  description: null,
  url: null,
  stampDate: "2026-08-21T12:00:00.000Z",
  calendarUid: "CAL-1",
  calendarName: "Work",
};

/**
 * Dispatches on a marker unique to each script.
 *
 * Order matters: CREATE and UPDATE both call `applyFields`, so matching on that
 * first would silently route creates into the update branch — the assertions
 * would still pass, for the wrong reason.
 */
const fakeRunner = (overrides: Record<string, unknown> = {}) => {
  const run = vi.fn(async (source: string, params?: unknown) => {
    if (source.includes("cal.events.push(ev)")) return overrides.created ?? READBACK;
    if (source.includes("p.uids.length")) {
      const uids = (params as { uids: string[] }).uids;
      return (
        overrides.deleted ?? {
          results: uids.map((u) => ({ uid: u, found: true, deleted: true, repeats: false })),
        }
      );
    }
    if (source.includes("EXCLUSION_NOT_APPLIED")) {
      return (
        overrides.excluded ?? { uid: "E-ONE", excluded: true, alreadyExcluded: false, count: 1 }
      );
    }
    if (source.includes("applyFields(ev, p)")) return overrides.updated ?? READBACK;
    throw new Error(`unexpected script: ${source.slice(0, 80)}`);
  });
  return { runner: { run } as unknown as OsascriptRunner, run };
};

const connect = async (env: NodeJS.ProcessEnv = {}, overrides: Record<string, unknown> = {}) => {
  const config = loadConfig({
    APPLE_CALENDAR_STORE: storePath,
    APPLE_CALENDAR_ALLOW_WRITES: "1",
    ...env,
  });
  const { runner, run } = fakeRunner(overrides);
  const { server } = createServer({ config, osascript: runner, now: () => NOW });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, run };
};

const call = async (name: string, args: Record<string, unknown> = {}, env = {}, overrides = {}) => {
  const { client, run } = await connect(env, overrides);
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const t = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text: t, json: () => JSON.parse(t) as never, run };
};

const refFor = async (summary: string) => {
  const { client } = await connect();
  const res = (await client.callTool({
    name: "apple_calendar_list_events",
    arguments: { from: "2026-08-21", to: "2026-08-28" },
  })) as { content: { text: string }[] };
  const page = JSON.parse(res.content.map((c) => c.text).join("")) as {
    events: { ref: string; summary: string }[];
  };
  return page.events.find((e) => e.summary === summary)!.ref;
};

describe("the write gate", () => {
  it("registers nine tools when writes are on", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "apple_calendar_create_event",
      "apple_calendar_delete_events",
      "apple_calendar_diagnostics",
      "apple_calendar_get_event",
      "apple_calendar_list_accounts",
      "apple_calendar_list_calendars",
      "apple_calendar_list_events",
      "apple_calendar_search_events",
      "apple_calendar_update_event",
    ]);
  });

  /**
   * Adding an attendee emails a person, so it is absent from the schema rather
   * than validated away. Asserted on the LISTED schema, so removing the guard
   * fails a test instead of quietly shipping.
   */
  it("offers no way to add an attendee", async () => {
    const { client } = await connect();
    const create = (await client.listTools()).tools.find(
      (t) => t.name === "apple_calendar_create_event",
    )!;
    const keys = Object.keys(
      (create.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(keys).not.toContain("attendees");
    expect(JSON.stringify(create.inputSchema)).not.toMatch(/attendee/i);
  });
});

describe("apple_calendar_create_event", () => {
  it("creates an event and reports what Calendar stored", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "Design review",
      calendar: "Work",
      start: "2026-08-22T09:00",
    });
    expect(out.isError).toBe(false);
    const got = out.json() as { uid: string; calendar: string; source: string };
    expect(got.uid).toBe("E-NEW");
    expect(got.calendar).toBe("Work");
    expect(got.source).toBe("apple-events");
  });

  it("defaults the length when given neither end nor duration", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "Quick sync",
      start: "2026-08-22T09:00",
    });
    const params = out.run.mock.calls[0]![1] as { startDate: string; endDate: string };
    const mins = (Date.parse(params.endDate) - Date.parse(params.startDate)) / 60000;
    expect(mins).toBe(60);
  });

  it("honours durationMinutes", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "Long one",
      start: "2026-08-22T09:00",
      durationMinutes: 90,
    });
    const p = out.run.mock.calls[0]![1] as { startDate: string; endDate: string };
    expect((Date.parse(p.endDate) - Date.parse(p.startDate)) / 60000).toBe(90);
  });

  /** A bare day names a day, so it makes an all-day event without being told. */
  it("infers all-day from a bare day", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "Offsite",
      start: "2026-08-22",
    });
    expect((out.run.mock.calls[0]![1] as { allDay: boolean }).allDay).toBe(true);
  });

  /**
   * `list_events` documents a bare `to` as running through that EVENING, and
   * create used to read the same word as midnight — so the natural way to say
   * "a one-day event" was refused as ending before it began.
   */
  it("accepts the same bare day for start and end as one whole day", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "One day",
      start: "2026-09-21",
      end: "2026-09-21",
    });
    expect(out.isError).toBe(false);
    const p = out.run.mock.calls[0]![1] as { startDate: string; endDate: string; allDay: boolean };
    expect(p.allDay).toBe(true);
    expect(Date.parse(p.endDate)).toBeGreaterThan(Date.parse(p.startDate));
  });

  it("refuses a read-only subscribed calendar, naming the cause", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "Nope",
      calendar: "Holidays",
      start: "2026-08-22T09:00",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/read-only/);
    expect(out.text).toMatch(/CalendarNotWritableError/);
  });

  /**
   * The store-side writability check is derived from `subcal_url` and misses
   * calendars that are read-only for other reasons — measured: Birthdays and
   * Siri Suggestions both report writable()===false with no subscription URL.
   * The JXA lane catches those, and its bare code is re-inflated so the caller
   * still gets the explanation rather than just the calendar's name.
   */
  it("re-inflates a JXA writability refusal into a named error", async () => {
    const ref = await refFor("Design review");
    const { client } = await connect({}, {});
    void ref;
    const failing = {
      run: async () => {
        const e = new Error("Birthdays") as Error & { details?: { code?: string } };
        e.details = { code: "CALENDAR_NOT_WRITABLE" };
        throw e;
      },
    };
    void client;
    const { createServer: mk } = await import("../src/server.js");
    const { loadConfig: lc } = await import("../src/config.js");
    const { server } = mk({
      config: lc({ APPLE_CALENDAR_STORE: storePath, APPLE_CALENDAR_ALLOW_WRITES: "1" }),
      osascript: failing as never,
      now: () => NOW,
    });
    const c = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), c.connect(b)]);
    const res = (await c.callTool({
      name: "apple_calendar_create_event",
      arguments: { summary: "x", calendar: "Work", start: "2026-09-15T10:00" },
    })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((x) => x.text).join("");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/read-only/);
    expect(text).toMatch(/CalendarNotWritableError/);
  });

  it("refuses an end that is before its start", async () => {
    const out = await call("apple_calendar_create_event", {
      summary: "Backwards",
      start: "2026-08-22T09:00",
      end: "2026-08-22T08:00",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/cannot finish before it begins/);
  });
});

describe("apple_calendar_update_event", () => {
  it("updates a whole event", async () => {
    const ref = await refFor("Design review");
    const out = await call("apple_calendar_update_event", { ref, summary: "Renamed" });
    expect(out.isError).toBe(false);
  });

  /**
   * THE REFUSAL THAT MATTERS. Calendar cannot detach one occurrence, so applying
   * the edit to the series would move every future standup because someone asked
   * to move one lunch — data loss wearing a success message.
   */
  it("refuses an occurrence ref instead of silently editing the series", async () => {
    const ref = await refFor("Design review");
    const decoded = ref.split("/");
    const occurrenceRef = [decoded[0], "20260822T090000+0200", decoded[2]].join("/");
    const out = await call("apple_calendar_update_event", {
      ref: occurrenceRef,
      summary: "Moved",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/cannot edit a single occurrence/);
    // The message has to say what to do instead, not merely refuse.
    expect(out.text).toMatch(/delete it with apple_calendar_delete_events/);
    expect(out.run).not.toHaveBeenCalled();
  });
});

describe("apple_calendar_delete_events", () => {
  it("refuses without confirm", async () => {
    const ref = await refFor("Design review");
    const out = await call("apple_calendar_delete_events", { refs: [ref] });
    expect(out.isError).toBe(true);
    expect(out.run).not.toHaveBeenCalled();
  });

  it("deletes a whole event", async () => {
    const ref = await refFor("Design review");
    const out = await call("apple_calendar_delete_events", { refs: [ref], confirm: true });
    expect(out.isError).toBe(false);
    expect(out.run.mock.calls[0]![0]).toContain("p.uids.length");
  });

  /**
   * MEASURED, macOS 26.6: `C.delete(ev)` on a REPEATING event neither throws nor
   * deletes, so trusting "it did not throw" reported success for an event still
   * sitting on the calendar. The script re-reads the uid list and decides by
   * absence; this pins that a false result survives to the caller intact rather
   * than being smoothed into a success.
   */
  it("passes a verified failure through instead of reporting success", async () => {
    const ref = await refFor("Design review");
    const out = await call(
      "apple_calendar_delete_events",
      { refs: [ref], confirm: true },
      {},
      {
        deleted: {
          results: [
            {
              uid: "E-ONE",
              found: true,
              deleted: false,
              repeats: true,
              reason: "Calendar did not delete it and reported no error",
            },
          ],
        },
      },
    );
    expect(out.isError).toBe(false);
    const doc = out.json() as { results: { deleted: boolean; reason: string }[] };
    expect(doc.results[0]!.deleted).toBe(false);
    expect(doc.results[0]!.reason).toMatch(/did not delete/);
  });

  /**
   * Calendar cannot delete one occurrence — `excludedDates` is not writable —
   * so an occurrence ref is refused rather than taking the whole series with it.
   */
  it("refuses an occurrence ref instead of deleting the series", async () => {
    const ref = await refFor("Design review");
    const parts = ref.split("/");
    const occurrenceRef = [parts[0], "20260822T090000+0200", parts[2]].join("/");
    const out = await call("apple_calendar_delete_events", {
      refs: [occurrenceRef],
      confirm: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/cannot delete a single occurrence/);
    expect(out.text).toMatch(/Calendar.app/);
    expect(out.run).not.toHaveBeenCalled();
  });
});
