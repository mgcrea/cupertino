import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Frozen clock, so relative dates and the TTL cache are both deterministic. */
const NOW = new Date(2026, 7, 20, 14, 30, 0, 0);
const now = () => NOW;

const ACCOUNTS = {
  accounts: [
    { id: "acct-1", name: "iCloud", isDefault: true, listCount: 2, reminderCount: 4 },
    { id: "acct-2", name: "Work", isDefault: false, listCount: 1, reminderCount: 1 },
  ],
  defaultAccountId: "acct-1",
  defaultListId: "list-1",
};

const LISTS = [
  {
    id: "list-1",
    name: "Reminders",
    accountId: "acct-1",
    accountName: "iCloud",
    depth: 1,
    color: "#FF0000",
    emblem: null,
    isDefault: true,
    reminderCount: 3,
    incompleteCount: 2,
  },
  // Nested inside list-1: Reminders calls this a group, and a flat read misses it.
  {
    id: "list-2",
    name: "Groceries",
    accountId: "acct-1",
    accountName: "iCloud",
    depth: 2,
    color: "#00FF00",
    emblem: null,
    isDefault: false,
    reminderCount: 1,
    incompleteCount: 1,
  },
  {
    id: "list-3",
    name: "Standup",
    accountId: "acct-2",
    accountName: "Work",
    depth: 1,
    color: null,
    emblem: null,
    isDefault: false,
    reminderCount: 1,
    incompleteCount: 0,
  },
];

const id = (n: number) => `x-apple-reminder://0000000${n}-0000-4000-8000-00000000000${n}`;

const REMINDERS = [
  {
    id: id(1),
    name: "Buy milk",
    body: "semi-skimmed",
    completed: false,
    completionDate: null,
    dueDate: "2026-08-21T00:00:00+02:00",
    alldayDueDate: "2026-08-21T00:00:00+02:00",
    allDayGuess: true,
    remindMeDate: null,
    priority: 1,
    flagged: true,
    created: "2026-08-01T10:00:00.000Z",
    modified: "2026-08-19T10:00:00.000Z",
    list: "Groceries",
    listId: "list-2",
    account: "iCloud",
    accountId: "acct-1",
    parentId: null,
  },
  {
    id: id(2),
    name: "Call the dentist",
    body: null,
    completed: false,
    completionDate: null,
    dueDate: "2026-08-25T09:00:00+02:00",
    alldayDueDate: "2026-08-25T09:00:00+02:00",
    allDayGuess: false,
    remindMeDate: "2026-08-25T08:30:00+02:00",
    priority: 5,
    flagged: false,
    created: "2026-08-02T10:00:00.000Z",
    modified: "2026-08-19T10:00:00.000Z",
    list: "Reminders",
    listId: "list-1",
    account: "iCloud",
    accountId: "acct-1",
    parentId: null,
  },
  {
    id: id(3),
    name: "Already done",
    body: null,
    completed: true,
    completionDate: "2026-08-10T10:00:00.000Z",
    dueDate: null,
    alldayDueDate: null,
    allDayGuess: false,
    remindMeDate: null,
    priority: 0,
    flagged: false,
    created: "2026-08-03T10:00:00.000Z",
    modified: "2026-08-10T10:00:00.000Z",
    list: "Reminders",
    listId: "list-1",
    account: "iCloud",
    accountId: "acct-1",
    parentId: null,
  },
  // A subtask: its container is reminder 2, not a list.
  {
    id: id(4),
    name: "Find the number",
    body: null,
    completed: false,
    completionDate: null,
    dueDate: null,
    alldayDueDate: null,
    allDayGuess: false,
    remindMeDate: null,
    priority: 0,
    flagged: false,
    created: "2026-08-04T10:00:00.000Z",
    modified: "2026-08-19T10:00:00.000Z",
    list: "Reminders",
    listId: "list-1",
    account: "iCloud",
    accountId: "acct-1",
    parentId: id(2),
  },
  {
    id: id(5),
    name: "Write the standup notes",
    body: null,
    completed: false,
    completionDate: null,
    dueDate: "2026-09-30T09:00:00+02:00",
    alldayDueDate: "2026-09-30T09:00:00+02:00",
    allDayGuess: false,
    remindMeDate: null,
    priority: 9,
    flagged: false,
    created: "2026-08-05T10:00:00.000Z",
    modified: "2026-08-19T10:00:00.000Z",
    list: "Standup",
    listId: "list-3",
    account: "Work",
    accountId: "acct-2",
    parentId: null,
  },
];

const BULK = {
  count: REMINDERS.length,
  reminders: REMINDERS,
  lists: LISTS,
  unmapped: 1,
  membershipVia: "nested",
};

/** A runner that answers from canned data, dispatching on a marker in the script. */
const fakeRunner = (overrides: Record<string, unknown> = {}): OsascriptRunner => ({
  run: vi.fn(async (script: string, params?: unknown) => {
    if (script.includes("defaultAccountId: defaultAccountId"))
      return overrides.accounts ?? ACCOUNTS;
    if (script.includes("l.incompleteCount = counts.incomplete")) return overrides.lists ?? LISTS;
    if (script.includes("membershipVia")) return overrides.bulk ?? BULK;
    if (script.includes("containerClass: containerClass")) {
      const ids = (params as { ids: string[] }).ids;
      return ids.map((wanted) => {
        const row = REMINDERS.find((r) => r.id === wanted);
        return row
          ? { ...row, found: true, containerClass: row.parentId ? "reminder" : "list" }
          : { id: wanted, found: false };
      });
    }
    // Dispatch on a marker UNIQUE to each script. `applyFields(r, p)` appears in
    // both create and update, so matching on it would silently route creates
    // into the update branch — the assertions still pass, for the wrong reason.
    if (script.includes("NO_DEFAULT_LIST")) return overrides.created ?? REMINDERS[0];
    if (script.includes("REMINDER_NOT_FOUND")) return overrides.updated ?? REMINDERS[0];
    if (script.includes("r.completed = p.completed")) {
      return (params as { ids: string[] }).ids.map((i) => ({
        id: i,
        found: true,
        completed: true,
      }));
    }
    if (script.includes("made.previousId = id")) {
      return (params as { ids: string[] }).ids.map((i) => ({
        id: id(9),
        previousId: i,
        found: true,
        moved: true,
      }));
    }
    if (script.includes("deleted: deleted, missing: missing")) {
      return { deleted: (params as { ids: string[] }).ids.length, missing: [] };
    }
    throw new Error(`unexpected script: ${script.slice(0, 120)}`);
  }) as OsascriptRunner["run"],
});

/** The runner is handed back so a test can assert WHICH script a tool sent. */
const connectWith = async (
  env: NodeJS.ProcessEnv = {},
  overrides: Record<string, unknown> = {},
) => {
  const config: Config = loadConfig(env);
  const osascript = fakeRunner(overrides);
  const { server } = createServer({ config, osascript, now });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, osascript };
};

const connect = async (env: NodeJS.ProcessEnv = {}, overrides: Record<string, unknown> = {}) =>
  (await connectWith(env, overrides)).client;

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) as unknown };
};

describe("tool registration", () => {
  /**
   * The invariant from tools/index.ts: the registered set depends on
   * `allowWrites` and on nothing else. It must NOT depend on Full Disk Access,
   * because clients cache the tool list and a tool that comes and goes leaves
   * them calling names the server no longer has.
   */
  it("registers only read tools by default", async () => {
    const { tools } = await (await connect()).listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "apple_reminders_diagnostics",
      "apple_reminders_get_reminder",
      "apple_reminders_list_accounts",
      "apple_reminders_list_lists",
      "apple_reminders_list_reminders",
      "apple_reminders_search_reminders",
    ]);
  });

  it("adds the mutating tools when writes are enabled", async () => {
    const { tools } = await (await connect({ APPLE_REMINDERS_ALLOW_WRITES: "1" })).listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toHaveLength(11);
    expect(names).toContain("apple_reminders_create_reminder");
    expect(names).toContain("apple_reminders_complete_reminders");
    expect(names).toContain("apple_reminders_move_reminders");
    expect(names).toContain("apple_reminders_delete_reminders");
  });

  it("marks every read tool read-only", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
});

describe("list_reminders", () => {
  it("hides completed reminders by default", async () => {
    const out = (await call(await connect(), "apple_reminders_list_reminders")).json() as {
      name: string;
    }[];
    expect(out.map((r) => r.name)).not.toContain("Already done");
  });

  it("includes them when asked", async () => {
    const out = (
      await call(await connect(), "apple_reminders_list_reminders", { includeCompleted: true })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toContain("Already done");
  });

  /** Soonest due first, undated last — not creation order, not id order. */
  it("orders by due date with undated reminders last", async () => {
    const out = (await call(await connect(), "apple_reminders_list_reminders")).json() as {
      name: string;
      due: string | null;
    }[];
    expect(out.map((r) => r.name)).toEqual([
      "Buy milk",
      "Call the dentist",
      "Write the standup notes",
      "Find the number",
    ]);
    expect(out.at(-1)?.due).toBeNull();
  });

  it("filters by list name", async () => {
    const out = (
      await call(await connect(), "apple_reminders_list_reminders", { list: "Groceries" })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Buy milk"]);
  });

  it("filters by flagged and by priority", async () => {
    const flagged = (
      await call(await connect(), "apple_reminders_list_reminders", { flagged: true })
    ).json() as { name: string }[];
    expect(flagged.map((r) => r.name)).toEqual(["Buy milk"]);

    const high = (
      await call(await connect(), "apple_reminders_list_reminders", { priority: "high" })
    ).json() as { name: string }[];
    expect(high.map((r) => r.name)).toEqual(["Buy milk"]);
  });

  it("filters by whether a due date exists at all", async () => {
    const undated = (
      await call(await connect(), "apple_reminders_list_reminders", { hasDueDate: false })
    ).json() as { name: string }[];
    expect(undated.map((r) => r.name)).toEqual(["Find the number"]);
  });

  /**
   * The bound that is wrong by default. "due before 2026-08-21" has to include
   * the all-day reminder ON the 21st — resolving a bare day to midnight would
   * quietly exclude the day the caller named.
   */
  it("treats a bare day in dueBefore as the whole day", async () => {
    const out = (
      await call(await connect(), "apple_reminders_list_reminders", { dueBefore: "2026-08-21" })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Buy milk"]);
  });

  it("accepts a relative offset as a bound", async () => {
    // NOW is 2026-08-20; +7d reaches the 27th, so it catches the 21st and 25th
    // but not the 30 September one.
    const out = (
      await call(await connect(), "apple_reminders_list_reminders", { dueBefore: "+7d" })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Buy milk", "Call the dentist"]);
  });

  it("excludes undated reminders from a range query", async () => {
    const out = (
      await call(await connect(), "apple_reminders_list_reminders", { dueAfter: "2026-01-01" })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).not.toContain("Find the number");
  });

  it("reports the account allowlist by filtering, not erroring", async () => {
    const out = (
      await call(
        await connect({ APPLE_REMINDERS_ACCOUNTS: "Work" }),
        "apple_reminders_list_reminders",
      )
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Write the standup notes"]);
  });

  it("scopes by list allowlist independently of account", async () => {
    const out = (
      await call(
        await connect({ APPLE_REMINDERS_LISTS: "Groceries" }),
        "apple_reminders_list_reminders",
      )
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Buy milk"]);
  });
});

/**
 * MEASURED on macOS 26.6: Reminders populates BOTH `due date` and
 * `allday due date` for every dated reminder — 144 of 144 carried both. So the
 * presence of `alldayDueDate` discriminates nothing, and the obvious rule
 * ("allday is set, therefore all-day") marks every dated reminder as all-day.
 * The fixture reproduces that, which is why these tests are worth having.
 */
describe("due date interpretation", () => {
  it("does not infer all-day from the property merely being present", async () => {
    const out = (await call(await connect(), "apple_reminders_list_reminders")).json() as {
      name: string;
      dueAllDay: boolean;
      due: string | null;
    }[];
    const timed = out.find((r) => r.name === "Call the dentist");
    expect(timed?.due).toBe("2026-08-25T09:00:00+02:00");
    // It has an alldayDueDate too, and is still not all-day.
    expect(timed?.dueAllDay).toBe(false);
  });

  it("reports a genuine all-day reminder as all-day", async () => {
    const out = (await call(await connect(), "apple_reminders_list_reminders")).json() as {
      name: string;
      dueAllDay: boolean;
    }[];
    expect(out.find((r) => r.name === "Buy milk")?.dueAllDay).toBe(true);
  });

  /**
   * Honesty about provenance. Without the index this is inferred from the due
   * time being local midnight, which a reminder deliberately set to 00:00 would
   * defeat. The caller is told which answer it got.
   */
  it("says the flag came from a heuristic when the index is unavailable", async () => {
    const out = (await call(await connect(), "apple_reminders_list_reminders")).json() as {
      dueAllDaySource: string;
    }[];
    expect(out.every((r) => r.dueAllDaySource === "heuristic")).toBe(true);
  });
});

describe("search_reminders", () => {
  it("matches the name", async () => {
    const out = (
      await call(await connect(), "apple_reminders_search_reminders", { query: "dentist" })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Call the dentist"]);
  });

  it("matches the notes body in full scope", async () => {
    const out = (
      await call(await connect(), "apple_reminders_search_reminders", { query: "semi-skimmed" })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Buy milk"]);
  });

  it("does not match the body in title scope", async () => {
    const out = (
      await call(await connect(), "apple_reminders_search_reminders", {
        query: "semi-skimmed",
        scope: "title",
      })
    ).json() as unknown[];
    expect(out).toEqual([]);
  });

  it("is case-insensitive", async () => {
    const out = (
      await call(await connect(), "apple_reminders_search_reminders", { query: "DENTIST" })
    ).json() as unknown[];
    expect(out).toHaveLength(1);
  });

  it("applies the same filters as list", async () => {
    const out = (
      await call(await connect(), "apple_reminders_search_reminders", {
        query: "e",
        list: "Standup",
      })
    ).json() as { name: string }[];
    expect(out.map((r) => r.name)).toEqual(["Write the standup notes"]);
  });
});

describe("get_reminder", () => {
  /**
   * Both raw properties are reported, because they are both populated and a
   * caller debugging a date needs to see that for itself rather than take the
   * combined `due` field on trust.
   */
  it("returns the body and both due-date properties separately", async () => {
    const out = (
      await call(await connect(), "apple_reminders_get_reminder", { ref: `r1:${id(1)}` })
    ).json() as Record<string, unknown>;
    expect(out.body).toBe("semi-skimmed");
    expect(out.dueDate).toBe("2026-08-21T00:00:00+02:00");
    expect(out.alldayDueDate).toBe("2026-08-21T00:00:00+02:00");
    expect(out.dueAllDay).toBe(true);
  });

  /**
   * MEASURED: `reminder.container()` threw on 60 of 60 attempts, so subtasks
   * are unreachable over Apple Events despite the dictionary typing container
   * as "list OR reminder". Without the index there is nothing to attach, and
   * the fields say "unknown" rather than "none" — see store.test.ts for the
   * index path, which is the one that actually resolves parentage.
   */
  it("reports enrichment as unknown, not empty, without the index", async () => {
    const out = (
      await call(await connect(), "apple_reminders_get_reminder", { ref: `r1:${id(2)}` })
    ).json() as { subtasks: unknown[]; attachments: unknown; alarms: unknown };
    expect(out.subtasks).toEqual([]);
    expect(out.attachments).toBeNull();
    expect(out.alarms).toBeNull();
  });

  it("errors clearly on a ref that no longer resolves", async () => {
    const res = await call(await connect(), "apple_reminders_get_reminder", {
      ref: "r1:x-apple-reminder://gone",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No reminder for ref/);
  });

  it("rejects a ref from another surface", async () => {
    const res = await call(await connect(), "apple_reminders_get_reminder", {
      ref: "n1:x-coredata://S/ICNote/p1",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Unknown reminder ref/);
  });
});

describe("writes", () => {
  const enabled = () => connect({ APPLE_REMINDERS_ALLOW_WRITES: "1" });

  it("refuses a write tool when writes are disabled", async () => {
    const res = await call(await connect(), "apple_reminders_create_reminder", { name: "x" });
    expect(res.isError).toBe(true);
  });

  it("creates a reminder and returns what Reminders stored", async () => {
    const out = (
      await call(await enabled(), "apple_reminders_create_reminder", {
        name: "Buy milk",
        list: "Groceries",
        due: "tomorrow",
      })
    ).json() as { ref: string; name: string };
    expect(out.name).toBe("Buy milk");
    expect(out.ref).toBe(`r1:${id(1)}`);
  });

  it("rejects an unparseable due date before touching Reminders", async () => {
    const res = await call(await enabled(), "apple_reminders_create_reminder", {
      name: "x",
      due: "sometime soon",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Could not read due/);
  });

  it("names the available lists when the target does not exist", async () => {
    const res = await call(await enabled(), "apple_reminders_create_reminder", {
      name: "x",
      list: "Nonexistent",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Groceries/);
  });

  it("completes several reminders in one call", async () => {
    const out = (
      await call(await enabled(), "apple_reminders_complete_reminders", {
        refs: [`r1:${id(1)}`, `r1:${id(2)}`],
      })
    ).json() as { ref: string; completed: boolean }[];
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.completed)).toBe(true);
  });

  /**
   * Move is copy-and-delete because `reminder.container` is read-only in the
   * scripting dictionary, so the caller MUST be told the ref changed.
   */
  it("returns a new ref alongside the old one after a move", async () => {
    const out = (
      await call(await enabled(), "apple_reminders_move_reminders", {
        refs: [`r1:${id(1)}`],
        list: "Standup",
        confirm: true,
      })
    ).json() as { ref: string; previousRef: string; moved: boolean }[];
    expect(out[0]?.previousRef).toBe(`r1:${id(1)}`);
    expect(out[0]?.ref).toBe(`r1:${id(9)}`);
    expect(out[0]?.moved).toBe(true);
  });

  it("says so in the tool description, since the ref change is a caller problem", async () => {
    const { tools } = await (await enabled()).listTools();
    const move = tools.find((t) => t.name === "apple_reminders_move_reminders");
    expect(move?.description).toMatch(/NEW ref/);
  });

  /**
   * Guards the test harness itself. `applyFields(r, p)` appears in both the
   * create and the update script, so a fake dispatching on it would route
   * creates into the update branch and every assertion here would still pass.
   * This pins the two to different scripts.
   */
  it("sends create and update to different scripts", async () => {
    const { client, osascript } = await connectWith({ APPLE_REMINDERS_ALLOW_WRITES: "1" });
    const sent = () =>
      (osascript.run as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);

    await call(client, "apple_reminders_create_reminder", { name: "x" });
    expect(sent().some((s) => s.includes("NO_DEFAULT_LIST"))).toBe(true);
    expect(sent().some((s) => s.includes("REMINDER_NOT_FOUND"))).toBe(false);

    await call(client, "apple_reminders_update_reminder", { ref: `r1:${id(1)}`, name: "y" });
    expect(sent().some((s) => s.includes("REMINDER_NOT_FOUND"))).toBe(true);
  });

  it("requires confirmation to delete", async () => {
    const res = await call(await enabled(), "apple_reminders_delete_reminders", {
      refs: [`r1:${id(1)}`],
    });
    expect(res.isError).toBe(true);
  });

  it("deletes when confirmed", async () => {
    const out = (
      await call(await enabled(), "apple_reminders_delete_reminders", {
        refs: [`r1:${id(1)}`],
        confirm: true,
      })
    ).json() as { deleted: number };
    expect(out.deleted).toBe(1);
  });
});

describe("diagnostics", () => {
  it("reports both lanes and names the settings in force", async () => {
    const out = (await call(await connect(), "apple_reminders_diagnostics")).json() as {
      server: { lanes: { applescript: string; index: string } };
      settings: { includeCompleted: boolean; allowWrites: boolean };
      caveats: string[];
    };
    expect(out.server.lanes.applescript).toBe("live");
    expect(out.settings.allowWrites).toBe(false);
    expect(out.settings.includeCompleted).toBe(false);
  });

  /** The caveat that stops someone filing "move lost my ref" as a bug. */
  it("warns that a move changes the ref", async () => {
    const out = (await call(await connect(), "apple_reminders_diagnostics")).json() as {
      caveats: string[];
    };
    expect(out.caveats.join(" ")).toMatch(/copy-and-delete/);
  });
});
