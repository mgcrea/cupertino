import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The index lane is forced off by default. Without it the client would run
 * discovery against the REAL home directory, and on a machine that has answered
 * the Contacts prompt these tests would quietly read the developer's own address
 * book — passing or failing on data nobody wrote.
 */
const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({ APPLE_CONTACTS_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
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
  it("registers five read tools", async () => {
    expect(await toolNames(await connect())).toEqual([
      "apple_contacts_diagnostics",
      "apple_contacts_get_contact",
      "apple_contacts_list_contacts",
      "apple_contacts_resolve_handles",
      "apple_contacts_search_contacts",
    ]);
  });

  /**
   * The write gate, which is the product's central claim: with writes off the
   * mutating tools are not refused, they are never registered, so the host is
   * never told they exist.
   *
   * This test used to assert the two lists were IDENTICAL — Contacts shipped
   * read-only on purpose. That assertion was the tripwire for exactly this
   * change, and replacing it was a deliberate decision, not an accident.
   */
  it("adds exactly two write tools when writes are enabled", async () => {
    const withWrites = await toolNames(await connect({ APPLE_CONTACTS_ALLOW_WRITES: "1" }));
    const readOnly = await toolNames(await connect());
    expect(withWrites.filter((n) => !readOnly.includes(n))).toEqual([
      "apple_contacts_create_contact",
      "apple_contacts_update_contact",
    ]);
    expect(readOnly.filter((n) => !withWrites.includes(n))).toEqual([]);
  });

  /**
   * Contacts' scripting dictionary has NO delete command — `sdef` contains the
   * string zero times, and the whole command list is make, add, remove and save.
   * Writes go through Apple Events because the store is `PRAGMA query_only`, so
   * no verb means no capability. A tool named for it would be a promise the
   * dictionary cannot keep.
   */
  it("never registers a delete tool, because there is no way to honour one", async () => {
    const names = await toolNames(await connect({ APPLE_CONTACTS_ALLOW_WRITES: "1" }));
    expect(names.filter((n) => /delete|remove/.test(n))).toEqual([]);
  });

  /**
   * The registered set must not vary with whether the store can be read: that is
   * a runtime condition, and MCP clients cache the tool list.
   */
  it("registers the same tools when no store can be found", async () => {
    expect(
      await toolNames(
        await connect({
          APPLE_CONTACTS_INDEX_MODE: "auto",
          APPLE_CONTACTS_STORE: "/nope/missing.abcddb",
        }),
      ),
    ).toEqual(await toolNames(await connect()));
  });

  it("marks every read tool read-only, and every write tool not", async () => {
    const { tools } = await (await connect({ APPLE_CONTACTS_ALLOW_WRITES: "1" })).listTools();
    for (const t of tools) {
      const isWrite = /create|update/.test(t.name);
      expect(t.annotations?.readOnlyHint).toBe(!isWrite);
    }
  });

  /**
   * With writes off, nothing in this server can send an Apple Event — which is
   * what keeps the "a read-only surface needs no Automation grant" property
   * true for anyone who never turns writes on.
   */
  it("registers no tool that reaches Apple Events when writes are off", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
});

describe("without a readable store", () => {
  /**
   * Never `[]`. An empty list is a valid answer to "you have no contacts", and
   * this surface has a specific way of producing it wrongly — reading the root
   * store, which holds one person. A caller must get a reason instead.
   */
  it("fails with a reason rather than returning an empty list", async () => {
    const client = await connect({
      APPLE_CONTACTS_INDEX_MODE: "auto",
      APPLE_CONTACTS_STORE: "/nope/missing.abcddb",
    });
    const res = await call(client, "apple_contacts_list_contacts");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/APPLE_CONTACTS_STORE points at nothing/);
  });

  it("says the index is disabled when it is", async () => {
    const res = await call(await connect(), "apple_contacts_search_contacts", { query: "a" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/APPLE_CONTACTS_INDEX_MODE=off/);
  });

  /** Diagnostics has to work when nothing else does — that is what it is for. */
  it("still answers diagnostics", async () => {
    const res = await call(await connect(), "apple_contacts_diagnostics");
    expect(res.isError).toBe(false);
    const body = res.json() as { lane: { appleEvents: string }; caveats: string[] };
    expect(body.lane.appleEvents).toMatch(/no Automation grant/);
    expect(body.caveats.join(" ")).toMatch(/NOT by Full Disk Access/);
  });
});

describe("resolve_handles", () => {
  it("rejects an empty batch at the schema", async () => {
    const res = await call(await connect(), "apple_contacts_resolve_handles", { handles: [] });
    expect(res.isError).toBe(true);
  });

  /**
   * The description is load-bearing: a caller that treats "unknown" as an error
   * will be wrong on roughly one in six of even the busiest correspondents.
   */
  it("documents unknown as an expected outcome", async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find((t) => t.name === "apple_contacts_resolve_handles");
    expect(tool?.description).toMatch(/COMMON AND NOT AN ERROR/);
    expect(tool?.description).toMatch(/ambiguous/);
  });
});
