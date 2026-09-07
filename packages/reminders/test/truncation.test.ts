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
 * What a short list means.
 *
 * Both lanes truncate and neither could admit it, because both returned a bare
 * array. The two do it for different reasons and only one of them is the
 * caller's fault:
 *
 * - Apple Events reads every reminder and then cuts to a cap that is independent
 *   of `limit`, because the bulk read costs ~700ms per property whatever the
 *   library size. Ask for 500, get 200, learn nothing.
 * - The index over-fetches from SQL and applies the date, flag and priority
 *   predicates afterwards in JS. The over-fetch is a multiple of `limit`, which
 *   assumes those predicates reject a minority — when they reject nearly
 *   everything, the window runs out before the page fills and the answer comes
 *   back short. That one is invisible even to somebody reading the code.
 */
const DDL = readFileSync(
  fileURLToPath(new URL("./fixtures/reminders-store.sql", import.meta.url)),
  "utf8",
);

/**
 * Enough rows to exhaust the over-fetch window at `limit: 1`, which asks SQL
 * for 1 * 4 + 50 = 54. Sixty leaves the window genuinely full.
 */
const SEEDED = 60;

let dir: string;
let storePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-reminders-truncation-"));
  storePath = join(dir, "Data-TEST.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(DDL);
  db.prepare(
    `INSERT INTO ZREMCDBASELIST (Z_PK, ZNAME, ZMARKEDFORDELETION) VALUES (1,'Work',0)`,
  ).run();
  // Undated on purpose: `hasDueDate: true` is applied after SQL, so it rejects
  // every row the query returns and leaves the page empty with the window full.
  for (let i = 1; i <= SEEDED; i++) {
    db.prepare(
      `INSERT INTO ZREMCDREMINDER (Z_PK, ZCKIDENTIFIER, ZTITLE, ZCOMPLETED, ZALLDAY, ZDUEDATE,
         ZLIST, ZMARKEDFORDELETION) VALUES (?,?,?,0,0,NULL,1,0)`,
    ).run(i, `0000000${i}-0000-4000-8000-000000000001`.toUpperCase(), `Undated ${i}`);
  }
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AE_ROWS = [1, 2, 3].map((i) => ({
  id: `x-apple-reminder://0000000${i}-0000-4000-8000-000000000009`,
  name: `Apple Events ${i}`,
  body: null,
  completed: false,
  completionDate: null,
  dueDate: null,
  alldayDueDate: null,
  allDayGuess: false,
  dueDay: null,
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
}));

const runner = (): OsascriptRunner =>
  ({
    run: vi.fn(async (script: string) => {
      if (script.includes("membershipVia")) {
        return {
          count: AE_ROWS.length,
          reminders: AE_ROWS,
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

const appleEvents = (env: NodeJS.ProcessEnv = {}) =>
  client({ APPLE_REMINDERS_INDEX_MODE: "off", ...env });

describe("the index lane", () => {
  /**
   * The invisible one. SQL returns its full 54 rows, the post-SQL `hasDueDate`
   * filter rejects all of them, and the caller is handed an empty list that
   * reads as "no reminders have a due date" — which is a claim about the whole
   * library made from a window over part of it.
   */
  it("says when the over-fetch window ran out before the page filled", async () => {
    const out = await client().listReminders({ hasDueDate: true, limit: 1 });
    expect(out.source).toBe("index");
    expect(out.reminders).toHaveLength(0);
    expect(out.hasMore).toBe(true);
    expect(out.note).toMatch(/read 54 rows and the filters applied after SQL left 0/);
  });

  /**
   * The control: a page cut by `limit` alone, with the window never exhausted.
   * `hasMore` is still true — there genuinely are more — but nothing went wrong,
   * so there is nothing to explain.
   */
  it("stays quiet when the limit alone ended the page", async () => {
    const out = await client().listReminders({ limit: 20 });
    expect(out.reminders).toHaveLength(20);
    expect(out.hasMore).toBe(true);
    expect(out.note).toBeUndefined();
  });

  it("says there is no more when everything fits", async () => {
    const out = await client().listReminders({ limit: 100 });
    expect(out.reminders).toHaveLength(SEEDED);
    expect(out.hasMore).toBe(false);
    expect(out.note).toBeUndefined();
  });
});

describe("the Apple Events lane", () => {
  it("says so when its own cap, not the limit, ended the list", async () => {
    const out = await appleEvents({
      APPLE_REMINDERS_DEGRADED_MAX_REMINDERS: "1",
    }).listReminders({ limit: 50 });
    expect(out.source).toBe("apple-events");
    expect(out.reminders).toHaveLength(1);
    expect(out.hasMore).toBe(true);
    expect(out.note).toMatch(/capped at 1 reminders and you asked for 50/);
    expect(out.note).toMatch(/APPLE_REMINDERS_DEGRADED_MAX_REMINDERS/);
  });

  it("applies the same accounting to search", async () => {
    const out = await appleEvents({
      APPLE_REMINDERS_DEGRADED_MAX_REMINDERS: "1",
    }).searchReminders("Apple", { limit: 50 });
    expect(out.reminders).toHaveLength(1);
    expect(out.hasMore).toBe(true);
    expect(out.note).toMatch(/capped at 1 reminders/);
  });

  it("stays quiet when the caller's own limit ended the list", async () => {
    const out = await appleEvents().listReminders({ limit: 1 });
    expect(out.reminders).toHaveLength(1);
    expect(out.hasMore).toBe(true);
    expect(out.note).toBeUndefined();
  });

  it("stays quiet when nothing was left behind at all", async () => {
    const out = await appleEvents().listReminders({ limit: 50 });
    expect(out.reminders).toHaveLength(AE_ROWS.length);
    expect(out.hasMore).toBe(false);
    expect(out.note).toBeUndefined();
  });
});
