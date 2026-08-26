import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The index lane is forced off by default. Without it the client would call
 * locateStore() against the REAL home directory, and on a machine that has Full
 * Disk Access these tests would quietly read the user's own calendar — passing
 * or failing on data nobody wrote.
 */
const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({ APPLE_CALENDAR_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).toSorted();

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
   * which can change while the process lives — MCP clients cache the tool list,
   * so a tool that comes and goes leaves them calling names that are not there.
   */
  it("registers the read tools regardless of whether the store is reachable", async () => {
    const withIndexOff = await connect();
    const withMissingStore = await connect({
      APPLE_CALENDAR_INDEX_MODE: "auto",
      APPLE_CALENDAR_STORE: "/nope/missing.sqlitedb",
    });
    expect(await toolNames(withIndexOff)).toEqual(await toolNames(withMissingStore));
  });

  it("registers only read tools by default", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "apple_calendar_diagnostics",
      "apple_calendar_find_availability",
      "apple_calendar_get_event",
      "apple_calendar_list_accounts",
      "apple_calendar_list_calendars",
      "apple_calendar_list_events",
      "apple_calendar_search_events",
    ]);
  });

  /**
   * Pinned even though the write set is currently empty. The assertion that
   * matters is that turning the flag on cannot REMOVE a tool, and that whatever
   * appears here appeared because of this flag and nothing else.
   */
  it("never hides a read tool when writes are enabled", async () => {
    const read = (await (await connect()).listTools()).tools.map((t) => t.name);
    const written = (
      await (await connect({ APPLE_CALENDAR_ALLOW_WRITES: "1" })).listTools()
    ).tools.map((t) => t.name);
    expect(written).toEqual(expect.arrayContaining(read));
  });
});

describe("apple_calendar_diagnostics", () => {
  it("answers without a store rather than failing", async () => {
    const out = await call(await connect(), "apple_calendar_diagnostics");
    expect(out.isError).toBe(false);
    const doc = out.json() as { server: { lanes: { index: string } } };
    expect(doc.server.lanes.index).toBe("disabled");
  });

  /**
   * Calendar has no Apple Events read lane by design, so diagnostics must not
   * imply one is merely switched off. `docs/calendar.md` measured 3.4s for a
   * single range query, which is not a slower fallback, it is no fallback.
   */
  it("says plainly that there is no Apple Events read lane", async () => {
    const out = await call(await connect(), "apple_calendar_diagnostics");
    const doc = out.json() as {
      server: { lanes: { applescript: string } };
      permissions: { automation: string };
    };
    expect(doc.server.lanes.applescript).toBe("not-used");
    expect(doc.permissions.automation).toMatch(/reads never send an Apple Event/);
  });

  /**
   * The three-valued answer. A store that is missing and a store that is
   * present-but-unreadable need different fixes, and only the second one is
   * about Full Disk Access.
   */
  it("distinguishes a missing store from a denied grant", async () => {
    const out = await call(
      await connect({
        APPLE_CALENDAR_INDEX_MODE: "auto",
        APPLE_CALENDAR_STORE: "/nope/x.sqlitedb",
      }),
      "apple_calendar_diagnostics",
    );
    const doc = out.json() as { permissions: { fullDiskAccess: string } };
    expect(doc.permissions.fullDiskAccess).toMatch(/^unknown/);
  });

  /**
   * Forces the unreadable store rather than inheriting the machine's own, the
   * way the test above it does. `howToGrant` is emitted only when the store is
   * unreadable, so a bare connect() asserts on whatever the host happens to be:
   * it passed on a developer Mac and failed on a CI runner, where the path is
   * absent and reads as readable.
   */
  it("names the System Settings pane when the store cannot be read", async () => {
    const out = await call(
      await connect({
        APPLE_CALENDAR_INDEX_MODE: "auto",
        APPLE_CALENDAR_STORE: "/nope/x.sqlitedb",
      }),
      "apple_calendar_diagnostics",
    );
    const doc = out.json() as { permissions: { howToGrant?: string[] } };
    expect(doc.permissions.howToGrant?.join(" ")).toMatch(/Full Disk Access/);
  });

  /**
   * The surface is deliberately incomplete: recurrence is unmeasured, and a
   * listing tool built on a guess would show a weekly meeting once. Diagnostics
   * has to say so, because the failure it guards against is invisible.
   */
  it("discloses that the event tools are not registered yet, and why", async () => {
    const out = await call(await connect(), "apple_calendar_diagnostics");
    const doc = out.json() as { caveats: string[] };
    expect(doc.caveats.join(" ")).toMatch(/real side effects/);
    expect(doc.caveats.join(" ")).toMatch(/OccurrenceCache/);
  });

  it("reports the settings a caller can change", async () => {
    const out = await call(
      await connect({ APPLE_CALENDAR_CALENDARS: "Work" }),
      "apple_calendar_diagnostics",
    );
    const doc = out.json() as { settings: { calendarAllowlist: string[]; allowWrites: boolean } };
    expect(doc.settings.calendarAllowlist).toEqual(["Work"]);
    expect(doc.settings.allowWrites).toBe(false);
  });
});
