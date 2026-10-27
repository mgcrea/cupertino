import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { refFromUuid } from "../src/client/ref.js";
import { AppleRemindersClient } from "../src/client/reminders.js";
import { loadConfig } from "../src/config.js";

/**
 * Per-list counts from the store, not from Reminders.
 *
 * Measured on a live Reminders (2026-10-27): the store's GROUP BY took 1 ms
 * and agreed with Apple Events on all 12 lists, where counting over Apple
 * Events cost one event per list inside a list_lists call that took 17-29 s.
 */

const DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/reminders-store.sql", import.meta.url)),
  "utf8",
);

const U = (n: number) =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`.toUpperCase();

let dir: string;
let storePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-reminders-counts-"));
  storePath = join(dir, "Data-test.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(DDL);
  const list = db.prepare(
    `INSERT INTO ZREMCDBASELIST (Z_PK, ZNAME, ZCKIDENTIFIER, ZMARKEDFORDELETION) VALUES (?,?,?,0)`,
  );
  list.run(1, "Groceries", U(1));
  list.run(2, "Empty", U(2));
  const reminder = db.prepare(
    `INSERT INTO ZREMCDREMINDER (Z_PK, ZCKIDENTIFIER, ZTITLE, ZCOMPLETED, ZLIST, ZMARKEDFORDELETION)
     VALUES (?,?,?,?,?,?)`,
  );
  reminder.run(10, U(10), "Milk", 0, 1, 0);
  reminder.run(11, U(11), "Bread", 1, 1, 0);
  reminder.run(12, U(12), "Eggs", 0, 1, 0);
  // A tombstone the user deleted and cannot see: never counted.
  reminder.run(13, U(13), "Gone", 0, 1, 1);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LISTS = [U(1), U(2), "NOT-IN-STORE"].map((id, i) => ({
  id,
  name: `List ${i}`,
  accountId: "acct-1",
  accountName: "iCloud",
  depth: 1,
  color: "#FF0000",
  emblem: "null",
  isDefault: i === 0,
  // What LIST_LISTS answers when it was asked to count: deliberately wrong,
  // so a test can tell which lane the counts came from.
  reminderCount: 99,
  incompleteCount: 99,
}));

const recordingRunner = () => {
  const calls: { script: string; params: Record<string, unknown> }[] = [];
  const runner: OsascriptRunner = {
    run: vi.fn(async (script: string, params?: unknown) => {
      calls.push({ script, params: (params ?? {}) as Record<string, unknown> });
      if (script.includes("out[o].incompleteCount")) {
        const withCounts = Boolean((params as { withCounts?: boolean })?.withCounts);
        return LISTS.map((l) =>
          withCounts ? l : { ...l, reminderCount: null, incompleteCount: null },
        );
      }
      if (script.includes("all.remindMeDate")) {
        return [
          {
            id: refFromUuid(U(10)).replace(/^r1:/, ""),
            found: true,
            name: "Milk",
            body: null,
            completed: false,
            completionDate: null,
            dueDate: null,
            alldayDueDate: null,
            remindMeDate: "2026-10-29T18:00:00.000Z",
            priority: 0,
            flagged: false,
            created: null,
            modified: null,
          },
        ];
      }
      return [];
    }) as OsascriptRunner["run"],
  };
  return { runner, calls };
};

const client = (env: Record<string, string> = {}) => {
  const recorder = recordingRunner();
  const c = new AppleRemindersClient({
    config: loadConfig({ APPLE_REMINDERS_STORE: storePath, ...env }),
    osascript: recorder.runner,
  });
  return { c, ...recorder };
};

describe("list counts", () => {
  it("counts from the store and does not ask Reminders to", async () => {
    const { c, calls } = client();
    const lists = await c.lists();

    expect(calls.map((x) => x.params)).toEqual([{ withCounts: false }]);
    expect(lists.map((l) => [l.reminderCount, l.incompleteCount])).toEqual([
      [3, 2],
      // Held by the store with nothing in it: a real zero.
      [0, 0],
      // Not in the store at all: unknown, not zero.
      [null, null],
    ]);
  });

  it("asks Reminders to count when the store is off", async () => {
    const { c, calls } = client({ APPLE_REMINDERS_INDEX_MODE: "off" });
    const lists = await c.lists();

    expect(calls.map((x) => x.params)).toEqual([{ withCounts: true }]);
    expect(lists[0]).toMatchObject({ reminderCount: 99, incompleteCount: 99 });
  });
});

describe("get_reminder", () => {
  /*
   * GET_REMINDERS reads the reminder's own properties, which name no list;
   * the store does.
   */
  it("names the reminder's list from the store", async () => {
    const { c } = client();
    const detail = await c.getReminder(refFromUuid(U(10)));

    expect(detail).toMatchObject({
      name: "Milk",
      list: "Groceries",
      remindMe: "2026-10-29T18:00:00.000Z",
    });
  });
});
