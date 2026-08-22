import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * Two seams, both load-bearing.
 *
 * `INDEX_MODE=off` keeps discovery away from the real `~/Library/Messages`, and
 * `contacts: null` keeps the resolver away from the developer's real address
 * book. On a machine that has both grants — which is the machine this is
 * developed on — either would mean the suite passed or failed on somebody's
 * actual conversations.
 */
const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({ APPLE_MESSAGES_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home", contacts: null });
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
      "apple_messages_diagnostics",
      "apple_messages_get_message",
      "apple_messages_list_chats",
      "apple_messages_list_messages",
      "apple_messages_search_messages",
    ]);
  });

  /**
   * Writes add exactly one tool, because the dictionary has exactly one usable
   * mutating command. `login` and `logout` are the other two and are not
   * exposed; there is no edit, delete, mark-as-read or reaction verb at all.
   * A second one appearing here is a decision, and it has to break this first.
   */
  it("adds exactly one tool with writes enabled", async () => {
    const off = await toolNames(await connect());
    const on = await toolNames(await connect({ APPLE_MESSAGES_ALLOW_WRITES: "1" }));
    expect(on.filter((n) => !off.includes(n))).toEqual(["apple_messages_send_message"]);
    expect(off.filter((n) => !on.includes(n))).toEqual([]);
  });

  /**
   * The write gate is the product's central claim, and on this surface it is a
   * permission claim too: sending is the only thing Apple Events can do here, so
   * with writes off no Apple Event is ever sent and no Automation grant is ever
   * requested. See `surfaces.json`.
   */
  it("hides the send tool completely when writes are off", async () => {
    expect(await toolNames(await connect())).not.toContain("apple_messages_send_message");
  });

  /** MCP clients cache the tool list, so it must not vary with a runtime condition. */
  it("registers the same tools when the store cannot be found", async () => {
    expect(
      await toolNames(
        await connect({
          APPLE_MESSAGES_INDEX_MODE: "auto",
          APPLE_MESSAGES_STORE: "/nope/missing.db",
        }),
      ),
    ).toEqual(await toolNames(await connect()));
  });

  it("never announces a tool that could write when writes are off", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("marks the send tool as neither read-only nor idempotent", async () => {
    const { tools } = await (await connect({ APPLE_MESSAGES_ALLOW_WRITES: "1" })).listTools();
    const send = tools.find((t) => t.name === "apple_messages_send_message");
    expect(send?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});

describe("without a readable store", () => {
  /**
   * Never `[]`. This surface has no second lane, so an empty list would be
   * indistinguishable from "you have no messages" — and the fix is a permission,
   * which the caller can only act on if it is told.
   */
  it("fails with a reason rather than returning an empty list", async () => {
    const client = await connect({
      APPLE_MESSAGES_INDEX_MODE: "auto",
      APPLE_MESSAGES_STORE: "/nope/missing.db",
    });
    const res = await call(client, "apple_messages_list_chats");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/APPLE_MESSAGES_STORE points at nothing/);
  });

  it("says the index is disabled when it is", async () => {
    const res = await call(await connect(), "apple_messages_search_messages", { query: "hi" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/APPLE_MESSAGES_INDEX_MODE=off/);
  });

  it("still answers diagnostics", async () => {
    const res = await call(await connect(), "apple_messages_diagnostics");
    expect(res.isError).toBe(false);
    const body = res.json() as { lane: { appleEvents: string }; caveats: string[] };
    // The finding that shaped this whole surface.
    expect(body.lane.appleEvents).toMatch(/no read path exists/);
    expect(body.caveats.join(" ")).toMatch(/Full Disk Access is MANDATORY/);
    expect(body.caveats.join(" ")).toMatch(/cannot send/);
  });
});

describe("argument handling", () => {
  it("refuses a ref from another surface with a message naming it", async () => {
    const res = await call(await connect(), "apple_messages_get_message", { ref: "c1:x/-/y" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Calendar/);
  });

  it("refuses an unparseable date rather than silently ignoring it", async () => {
    const res = await call(
      await connect({ APPLE_MESSAGES_INDEX_MODE: "off" }),
      "apple_messages_list_messages",
      {
        from: "last tuesday",
      },
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/ISO-8601/);
  });

  it("rejects an empty search at the schema", async () => {
    const res = await call(await connect(), "apple_messages_search_messages", { query: "" });
    expect(res.isError).toBe(true);
  });
});

describe("tool descriptions carry the measurements", () => {
  /**
   * These are load-bearing, not documentation. A caller that treats `unknown` as
   * an error is wrong about one correspondent in six, and a caller that turns
   * reactions on gets `Liked "see you at 8"` rendered as a message.
   */
  it("warns that an unresolved name is normal", async () => {
    const { tools } = await (await connect()).listTools();
    const list = tools.find((t) => t.name === "apple_messages_list_messages");
    expect(list?.description).toMatch(/COMMON AND NOT AN ERROR/);
  });

  it("explains why reactions are filtered out", async () => {
    const { tools } = await (await connect()).listTools();
    const list = tools.find((t) => t.name === "apple_messages_list_messages");
    expect(list?.description).toMatch(/nobody typed/);
  });

  it("says search covers the blob-only messages", async () => {
    const { tools } = await (await connect()).listTools();
    const search = tools.find((t) => t.name === "apple_messages_search_messages");
    expect(search?.description).toMatch(/archived blob/);
  });
});
