import { describe, expect, it } from "vitest";

import { GET_REMINDERS, LIST_ACCOUNTS, LIST_LISTS } from "../src/client/jxa/read.js";

/**
 * The read scripts, run for real against a fake Reminders that counts Apple
 * Events.
 *
 * Measured on macOS 27 against a live Reminders (2026-10-27): every event on a
 * reminder costs about one second, because each re-resolves `byId` across the
 * application, so get_reminder's sixteen per-property reads ran past the 30 s
 * timeout on every call, while `properties()` returned every field in one
 * event of 1.1 s. list_lists sent five events per list plus one count each and
 * took 17-29 s for twelve lists. So the assertions here are on HOW MANY events
 * a script sends: that is the cost, and it is invisible to every other test.
 */

type Fake = { events: string[] };

/** A collection specifier: callable for its elements, with bulk property reads. */
const collection = <T extends Record<string, any>>(fake: Fake, label: string, items: T[]) => {
  const bulk = (prop: string) => () => {
    fake.events.push(`${label}.${prop}()`);
    return items.map((i) => i[prop]);
  };
  const fn: any = () => {
    fake.events.push(`${label}()`);
    return items.map((i) => i.specifier);
  };
  for (const prop of ["id", "name", "color", "emblem"]) {
    Object.defineProperty(fn, prop, { value: bulk(prop) });
  }
  fn.byId = (id: string) => items.find((i) => i.id === id)?.specifier;
  return fn;
};

type ListSpec = {
  id: string;
  name: string;
  color: string;
  emblem: string | null;
  children?: ListSpec[];
  done?: boolean[];
};

const buildList = (fake: Fake, spec: ListSpec): any => {
  const children = (spec.children ?? []).map((c) => buildList(fake, c));
  const item: any = { ...spec, kids: children };
  const lists = collection(fake, `list(${spec.id}).lists`, children);
  // Chained element fetch: one array per sub-list, in one event.
  lists.lists = {
    id: () => (
      fake.events.push(`list(${spec.id}).lists.lists.id()`),
      children.map((c) => c.kids.map((k: any) => k.id))
    ),
  };
  const reminders = {
    completed: () => (fake.events.push(`list(${spec.id}).reminders.completed()`), spec.done ?? []),
  };
  item.specifier = {
    id: () => (fake.events.push(`list(${spec.id}).id()`), spec.id),
    name: () => (fake.events.push(`list(${spec.id}).name()`), spec.name),
    color: () => (fake.events.push(`list(${spec.id}).color()`), spec.color),
    emblem: () => (fake.events.push(`list(${spec.id}).emblem()`), spec.emblem),
    lists,
    reminders,
  };
  return item;
};

const flatten = (items: any[]): any[] => items.flatMap((i) => [i, ...flatten(i.kids)]);

type ReminderSpec = Record<string, unknown> & { id: string };

const buildApp = (fake: Fake, tree: ListSpec[], reminders: ReminderSpec[] = []) => {
  const top = tree.map((t) => buildList(fake, t));
  const all = flatten(top);
  const accountLists = collection(fake, "account.lists", top);
  accountLists.lists = {
    id: () => (
      fake.events.push("account.lists.lists.id()"),
      top.map((t) => t.kids.map((k: any) => k.id))
    ),
  };
  const account = {
    id: () => (fake.events.push("account.id()"), "acct-1"),
    name: () => (fake.events.push("account.name()"), "iCloud"),
    lists: accountLists,
    reminders: () => {
      fake.events.push("account.reminders()");
      throw new Error("Can't get object.");
    },
  };
  const appLists = collection(fake, "app.lists", all);
  appLists.reminders = {
    completed: () => (
      fake.events.push("app.lists.reminders.completed()"),
      all.map((l) => l.done ?? [])
    ),
  };
  const byId = (id: string) => {
    const spec = reminders.find((r) => r.id === id);
    const getter = (name: string) => () => {
      fake.events.push(`reminder.${name}()`);
      if (!spec) throw new Error("Can't get object.");
      return spec[name];
    };
    const r: any = {
      properties: () => {
        fake.events.push("reminder.properties()");
        if (!spec) throw new Error("Can't get object.");
        const { id: rid, ...rest } = spec;
        return { id: rid, container: null, ...rest };
      },
    };
    for (const name of [
      "name",
      "body",
      "completed",
      "completionDate",
      "dueDate",
      "alldayDueDate",
      "remindMeDate",
      "priority",
      "flagged",
      "creationDate",
      "modificationDate",
      "container",
      "id",
    ]) {
      r[name] = getter(name);
    }
    return r;
  };
  return {
    accounts: () => (fake.events.push("accounts()"), [account]),
    defaultAccount: { id: () => (fake.events.push("defaultAccount.id()"), "acct-1") },
    defaultList: { id: () => (fake.events.push("defaultList.id()"), tree[0]?.id ?? null) },
    lists: appLists,
    reminders: { byId },
  };
};

const run = (source: string, app: unknown, params: Record<string, unknown> = {}) => {
  const Application = (name: string) => (name === "Reminders" ? app : {});
  const ObjC = { import: () => undefined };
  const dollar: any = {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) },
  };
  const factory = new Function("ObjC", "Application", "$", `${source}\nreturn run;`);
  const main = factory(ObjC, Application, dollar) as (argv: string[]) => string;
  const envelope = JSON.parse(main([JSON.stringify(params)]));
  if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
};

const leaf = (n: number, done: boolean[] = []): ListSpec => ({
  id: `L${n}`,
  name: `List ${n}`,
  color: "#FF0000",
  emblem: null,
  done,
});

describe("GET_REMINDERS", () => {
  const due = new Date(2026, 9, 30, 0, 0, 0);
  const REMINDER = {
    id: "x-apple-reminder://AAAA",
    name: "Bin day",
    body: null,
    completed: false,
    completionDate: null,
    dueDate: due,
    alldayDueDate: due,
    remindMeDate: new Date("2026-10-29T18:00:00Z"),
    priority: 1,
    flagged: true,
    creationDate: new Date("2026-10-01T10:00:00Z"),
    modificationDate: new Date("2026-10-02T10:00:00Z"),
  };

  it("reads a reminder in one Apple Event", () => {
    const fake: Fake = { events: [] };
    const [row] = run(GET_REMINDERS, buildApp(fake, [], [REMINDER]), { ids: [REMINDER.id] });

    expect(fake.events).toEqual(["reminder.properties()"]);
    expect(row).toMatchObject({
      id: REMINDER.id,
      found: true,
      name: "Bin day",
      body: null,
      completed: false,
      dueDate: due.toISOString(),
      alldayDueDate: due.toISOString(),
      allDayGuess: true,
      dueDay: "2026-10-30",
      remindMeDate: "2026-10-29T18:00:00.000Z",
      priority: 1,
      flagged: true,
      created: "2026-10-01T10:00:00.000Z",
      modified: "2026-10-02T10:00:00.000Z",
    });
  });

  it("reports a reminder Reminders cannot find as not found", () => {
    const fake: Fake = { events: [] };
    const rows = run(GET_REMINDERS, buildApp(fake, [], []), { ids: ["x-apple-reminder://GONE"] });

    expect(rows).toEqual([{ id: "x-apple-reminder://GONE", found: false }]);
  });
});

describe("LIST_LISTS", () => {
  it("reads the tree in a number of events that does not grow with the lists", () => {
    const few: Fake = { events: [] };
    const many: Fake = { events: [] };
    run(
      LIST_LISTS,
      buildApp(
        few,
        [1, 2, 3].map((n) => leaf(n)),
      ),
      { withCounts: false },
    );
    run(
      LIST_LISTS,
      buildApp(
        many,
        Array.from({ length: 30 }, (_, n) => leaf(n)),
      ),
      { withCounts: false },
    );

    expect(many.events.length).toBe(few.events.length);
  });

  it("walks a group into its lists, depth first", () => {
    const fake: Fake = { events: [] };
    const group: ListSpec = { ...leaf(1), name: "Group", children: [leaf(2), leaf(3)] };
    const lists = run(LIST_LISTS, buildApp(fake, [group, leaf(4)]), { withCounts: false });

    expect(lists.map((l: { id: string; depth: number }) => [l.id, l.depth])).toEqual([
      ["L1", 1],
      ["L2", 2],
      ["L3", 2],
      ["L4", 1],
    ]);
    expect(lists[0]).toMatchObject({
      name: "Group",
      accountId: "acct-1",
      accountName: "iCloud",
      color: "#FF0000",
      emblem: "null",
      isDefault: true,
    });
  });

  it("sends no count event when the caller has counts of its own", () => {
    const fake: Fake = { events: [] };
    const lists = run(LIST_LISTS, buildApp(fake, [leaf(1, [true, false])]), { withCounts: false });

    expect(fake.events.filter((e) => e.includes("reminders"))).toEqual([]);
    expect(lists[0]).toMatchObject({ reminderCount: null, incompleteCount: null });
  });

  it("counts every list in one chained event when asked to", () => {
    const fake: Fake = { events: [] };
    const group: ListSpec = { ...leaf(1), children: [leaf(2, [false])] };
    const lists = run(LIST_LISTS, buildApp(fake, [group, leaf(3, [true, false, false])]), {
      withCounts: true,
    });

    expect(fake.events.filter((e) => e.includes("reminders"))).toEqual([
      "app.lists.reminders.completed()",
    ]);
    expect(
      lists.map((l: { reminderCount: number; incompleteCount: number }) => [
        l.reminderCount,
        l.incompleteCount,
      ]),
    ).toEqual([
      [0, 0],
      [1, 1],
      [3, 2],
    ]);
  });
});

describe("LIST_ACCOUNTS", () => {
  /*
   * account.reminders() answers "Can't get object." on a live Reminders, so
   * the count was a fallback 0 presented as a measurement.
   */
  it("reports an account's reminder count as unknown when Reminders cannot say", () => {
    const fake: Fake = { events: [] };
    const data = run(LIST_ACCOUNTS, buildApp(fake, [leaf(1)]));

    expect(data.accounts[0]).toMatchObject({ id: "acct-1", listCount: 1, reminderCount: null });
  });
});
