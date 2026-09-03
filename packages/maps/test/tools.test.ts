import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The tool contract, over a real client and a real transport.
 *
 * One seam does all the work: `home` points discovery at a directory that does
 * not exist, so nothing here can reach the developer's own saved places. There
 * is no `osascript` seam, unlike every other surface's suite — this server
 * never spawns one, because Maps is not scriptable.
 */
const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({ APPLE_MAPS_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).toSorted();

const EXPECTED = [
  "apple_maps_diagnostics",
  "apple_maps_get_place",
  "apple_maps_list_collection_places",
  "apple_maps_list_collections",
  "apple_maps_list_favorites",
  "apple_maps_list_recents",
  "apple_maps_list_unfiled_places",
  "apple_maps_search_places",
];

describe("maps tools", () => {
  it("registers exactly the read tools", async () => {
    expect(await toolNames(await connect())).toEqual(EXPECTED);
  });

  /*
   * This assertion used to demand an IDENTICAL list with writes enabled — the
   * guard that made "read-only" a decision rather than an omission. It has been
   * changed, and the justification it was there to force is on the record:
   * `docs/maps.md` measures the whole lane, and the rule that keeps it safe is
   * that a place record is NEVER fabricated, only copied from one Maps wrote
   * itself. The blast radius is the reason it took that much proving — this
   * store is mirrored, so a bad row reaches every device on the account.
   *
   * The guard is not gone, only narrowed: the read tools must still be exactly
   * the same set with writes on, so a write flag can never disturb them.
   */
  const WRITE_TOOLS = ["apple_maps_add_favorite", "apple_maps_remove_favorite"];

  it("adds exactly the write tools when writes are enabled", async () => {
    expect(await toolNames(await connect({ APPLE_MAPS_ALLOW_WRITES: "1" }))).toEqual(
      [...EXPECTED, ...WRITE_TOOLS].toSorted(),
    );
  });

  it("registers no mutating tool by default", async () => {
    const names = await toolNames(await connect());
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
  });

  /*
   * The tool list must not depend on whether the store opened. MCP clients
   * cache it, so a list that shrank without Full Disk Access would stay shrunk
   * after the grant was given — the user would grant the permission and see no
   * change, which is the worst possible feedback.
   */
  it("registers every tool with no readable store at all", async () => {
    expect(await toolNames(await connect())).toHaveLength(EXPECTED.length);
  });

  it("marks every tool read-only", async () => {
    const tools = (await (await connect()).listTools()).tools;
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
});

describe("with no readable store", () => {
  /*
   * The failure mode this surface is most prone to. Without the grant a listing
   * would naturally come back `[]`, and an empty `favorites` reads exactly like
   * a person who has saved no places. Maps has no second lane, so the error
   * must be explicit — and it must say WHY.
   */
  it("fails a listing rather than returning an empty list", async () => {
    const res = await (
      await connect()
    ).callTool({
      name: "apple_maps_list_favorites",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(
      /Full Disk Access|could not be opened|No Maps store/,
    );
  });

  it("still answers diagnostics, because that is what explains the failure", async () => {
    const res = await (
      await connect()
    ).callTool({
      name: "apple_maps_diagnostics",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("Full Disk Access");
  });

  it("rejects a malformed ref before it reaches the store", async () => {
    const res = await (
      await connect()
    ).callTool({
      name: "apple_maps_get_place",
      arguments: { ref: "not-a-ref" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not a place ref/);
  });
});

/*
 * Diagnostics said this server registers no mutating tool, long after two had
 * shipped — from the one tool whose whole job is to not lie. It now derives
 * the answer from the gate, and reports the seed timeout that bounds the
 * longest call it makes.
 */
describe("diagnostics and the write gate", () => {
  type Report = {
    settings: { seedTimeoutMs: number };
    lanes: { writes: { enabled: boolean; tools: string[] } };
  };
  const report = async (env: NodeJS.ProcessEnv = {}) => {
    const res = (await (
      await connect(env)
    ).callTool({ name: "apple_maps_diagnostics", arguments: {} })) as {
      content: { text: string }[];
    };
    return JSON.parse(res.content.map((c) => c.text).join("")) as Report;
  };

  it("reports the write gate it was started with", async () => {
    const off = await report();
    expect(off.lanes.writes.enabled).toBe(false);
    expect(off.lanes.writes.tools).toEqual([]);
    const on = await report({ APPLE_MAPS_ALLOW_WRITES: "1" });
    expect(on.lanes.writes.enabled).toBe(true);
    expect(on.lanes.writes.tools).toContain("apple_maps_remove_favorite");
  });

  it("reports the seed timeout, which is now a setting", async () => {
    expect((await report()).settings.seedTimeoutMs).toBe(30_000);
    const slow = await report({ APPLE_MAPS_SEED_TIMEOUT_MS: "90000" });
    expect(slow.settings.seedTimeoutMs).toBe(90_000);
  });

  it("never claims to register no mutating tool", async () => {
    expect(JSON.stringify(await report())).not.toContain("registers no mutating tool");
  });
});
