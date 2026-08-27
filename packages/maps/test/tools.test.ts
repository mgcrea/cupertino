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
  "apple_maps_search_places",
];

describe("maps tools", () => {
  it("registers exactly the read tools", async () => {
    expect(await toolNames(await connect())).toEqual(EXPECTED);
  });

  /*
   * The guard that makes "read-only" a decision rather than an omission.
   * `packages/safari` carries the same assertion for the same reason: a
   * mutating tool cannot appear here without this test being changed, and
   * changing it is the moment somebody has to justify writing into a store that
   * iCloud is concurrently syncing.
   */
  it("registers an IDENTICAL list with writes enabled", async () => {
    expect(await toolNames(await connect({ APPLE_MAPS_ALLOW_WRITES: "1" }))).toEqual(EXPECTED);
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
