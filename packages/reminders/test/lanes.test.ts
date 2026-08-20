import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppleRemindersClient } from "../src/client/reminders.js";
import { loadConfig } from "../src/config.js";

/**
 * Which lane answers, and when.
 *
 * The other suites pin one lane each — tools.test.ts forces the index off,
 * store.test.ts talks to the store directly. This one is about the choice
 * between them, which is where a setting can be silently dropped.
 */
const DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/reminders-store.sql", import.meta.url)),
  "utf8",
);
const EPOCH = 978_307_200;
const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`.toUpperCase();

let dir: string;
let storePath: string;

beforeAll(() => {
  // A real file, because openStore takes a path and opens it with mode=ro.
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-reminders-store-"));
  storePath = join(dir, "Data-TEST.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(DDL);
  db.prepare(
    `INSERT INTO ZREMCDBASELIST (Z_PK, ZNAME, ZMARKEDFORDELETION) VALUES (1,'Work',0)`,
  ).run();
  // MEASURED: all-day reminders are floating dates stored at UTC midnight, not
  // local midnight. A real one due 9 November came back as 2025-11-09T00:00:00Z.
  db.prepare(
    `INSERT INTO ZREMCDREMINDER (Z_PK, ZCKIDENTIFIER, ZTITLE, ZCOMPLETED, ZALLDAY, ZDUEDATE,
       ZLIST, ZMARKEDFORDELETION) VALUES (1,?,'From the index',0,1,?,1,0)`,
  ).run(uuid(1), Date.parse("2026-08-21T00:00:00Z") / 1000 - EPOCH);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AE_ROW = {
  id: `x-apple-reminder://${uuid(2)}`,
  name: "From Apple Events",
  body: null,
  completed: false,
  completionDate: null,
  // MEASURED: Apple Events returns an all-day date at LOCAL midnight, while the
  // store keeps the same day at UTC midnight. Both mean 21 August 2026. The
  // fixture encodes the disagreement on purpose — it is the thing under test.
  dueDate: new Date(2026, 7, 21, 0, 0, 0, 0).toISOString(),
  alldayDueDate: new Date(2026, 7, 21, 0, 0, 0, 0).toISOString(),
  allDayGuess: true,
  dueDay: "2026-08-21",
  remindMeDate: null,
  priority: 0,
  flagged: false,
  created: null,
  modified: null,
  list: "Work",
  listId: "list-1",
  account: "iCloud",
  accountId: "acct-1",
  parentId: null,
};

const runner = (): OsascriptRunner =>
  ({
    run: vi.fn(async (script: string) => {
      if (script.includes("membershipVia")) {
        return {
          count: 1,
          reminders: [AE_ROW],
          lists: [{ id: "list-1", name: "Work", accountId: "acct-1" }],
          unmapped: 0,
          membershipVia: "nested",
        };
      }
      return [];
    }),
  }) as unknown as OsascriptRunner;

const client = (env: NodeJS.ProcessEnv = {}) =>
  new AppleRemindersClient({
    config: loadConfig({ APPLE_REMINDERS_STORE: storePath, ...env }),
    osascript: runner(),
  });

describe("lane selection", () => {
  it("prefers the index when it is readable", async () => {
    const out = await client().listReminders({ limit: 10 });
    expect(out.map((r) => r.name)).toEqual(["From the index"]);
    expect(out[0]?.source).toBe("index");
  });

  /** ZALLDAY is authoritative, and only the index has it. */
  it("reports the all-day flag as coming from the index", async () => {
    const out = await client().listReminders({ limit: 10 });
    expect(out[0]?.dueAllDay).toBe(true);
    expect(out[0]?.dueAllDaySource).toBe("index");
  });

  /**
   * An all-day reminder names a DAY, and reporting it as an instant is wrong
   * rather than merely ugly: 2026-08-21T00:00:00Z is 02:00 in Paris and
   * 20 August in New York. The day it names is the same everywhere.
   */
  it("renders an all-day due date as the day it names, not an instant", async () => {
    const out = await client().listReminders({ limit: 10 });
    expect(out[0]?.due).toBe("2026-08-21");
  });

  /** The output of an all-day reminder is valid input meaning the same thing. */
  it("round-trips: the rendered day parses back as all-day", async () => {
    const { parseDate } = await import("../src/client/dates.js");
    const out = await client().listReminders({ limit: 10 });
    const reparsed = parseDate("due", out[0]?.due as string);
    expect(reparsed.kind).toBe("allDay");
  });

  /**
   * THE invariant, and the test that catches this whole class of bug.
   *
   * The two lanes store an all-day date differently — the store at UTC
   * midnight, Apple Events at local midnight — as measured on a real reminder
   * due 9 November. Whichever lane answers, the caller must be told the same
   * date. Verifying against one lane alone is exactly how the local/UTC check
   * got inverted, and how slicing the UTC string looked correct while being
   * off by one day for everyone east of Greenwich.
   */
  it("agrees on the day whichever lane answers", async () => {
    const fromIndex = await client().listReminders({ limit: 10 });
    const fromAppleEvents = await client({ APPLE_REMINDERS_INDEX_MODE: "off" }).listReminders({
      limit: 10,
    });
    expect(fromIndex[0]?.source).toBe("index");
    expect(fromAppleEvents[0]?.source).toBe("apple-events");
    expect(fromIndex[0]?.due).toBe("2026-08-21");
    expect(fromAppleEvents[0]?.due).toBe(fromIndex[0]?.due);
  });

  it("falls back to Apple Events when the index is turned off", async () => {
    const out = await client({ APPLE_REMINDERS_INDEX_MODE: "off" }).listReminders({ limit: 10 });
    expect(out[0]?.source).toBe("apple-events");
    expect(out[0]?.dueAllDaySource).toBe("heuristic");
  });

  /**
   * The defect this file exists for.
   *
   * The store has no readable account name — ZREMCDACCOUNTLISTDATA is a blob —
   * so the index cannot apply an account allowlist. Answering from it anyway
   * would silently ignore the one setting whose job is limiting what gets read,
   * and it would do so ONLY on machines with Full Disk Access, which is exactly
   * where it matters. A configured allowlist must take the slower lane.
   */
  it("takes the Apple Events lane when an account allowlist is set", async () => {
    const out = await client({ APPLE_REMINDERS_ACCOUNTS: "iCloud" }).listReminders({ limit: 10 });
    expect(out[0]?.source).toBe("apple-events");
    expect(out.map((r) => r.name)).toEqual(["From Apple Events"]);
  });

  it("actually filters on that allowlist rather than merely switching lane", async () => {
    const out = await client({ APPLE_REMINDERS_ACCOUNTS: "SomeoneElse" }).listReminders({
      limit: 10,
    });
    expect(out).toEqual([]);
  });

  it("applies the same rule to search", async () => {
    const indexed = await client().searchReminders("index", { limit: 10 });
    expect(indexed[0]?.source).toBe("index");

    const scoped = await client({ APPLE_REMINDERS_ACCOUNTS: "iCloud" }).searchReminders("Apple", {
      limit: 10,
    });
    expect(scoped[0]?.source).toBe("apple-events");
  });

  /** A list allowlist needs no fallback: the store joins the list name itself. */
  it("keeps the index for a list allowlist, which it can honour", async () => {
    const out = await client({ APPLE_REMINDERS_LISTS: "Work" }).listReminders({ limit: 10 });
    expect(out[0]?.source).toBe("index");
  });

  it("reports the index lane as live in diagnostics", async () => {
    const lanes = await client().lanes();
    expect(lanes.index).toBe("live");
    expect(lanes.indexMode).toBe("ro");
    expect(lanes.storeFingerprint).toHaveLength(12);
  });
});
