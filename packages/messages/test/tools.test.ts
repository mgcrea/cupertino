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
  it("registers six read tools", async () => {
    expect(await toolNames(await connect())).toEqual([
      "apple_messages_count_messages",
      "apple_messages_diagnostics",
      "apple_messages_get_message",
      "apple_messages_list_chats",
      "apple_messages_list_messages",
      "apple_messages_search_messages",
    ]);
  });

  /**
   * Writes add exactly two tools, and the pair is deliberate rather than
   * incidental — a third appearing here is a decision, and it has to break this
   * test first.
   *
   * `send_message` is the only one that speaks to Messages.app, because the
   * dictionary has exactly one usable mutating command: `login` and `logout` are
   * the other two and are not exposed, and there is no edit, delete,
   * mark-as-read or reaction verb at all. `save_attachment` sends no Apple Event
   * and changes nothing in Messages; it is gated because it creates a file on
   * the user's disk, which is how Mail and Notes treat the same operation.
   */
  it("adds exactly two tools with writes enabled", async () => {
    const off = await toolNames(await connect());
    const on = await toolNames(await connect({ APPLE_MESSAGES_ALLOW_WRITES: "1" }));
    expect(on.filter((n) => !off.includes(n))).toEqual([
      "apple_messages_save_attachment",
      "apple_messages_send_message",
    ]);
    expect(off.filter((n) => !on.includes(n))).toEqual([]);
  });

  /**
   * The permission claim, stated as an assertion rather than as prose: only the
   * send tool is destructive, so `save_attachment` joining the write gate does
   * not widen what this server can do to the user's conversations.
   */
  it("keeps the send tool the only destructive one", async () => {
    const { tools } = await (await connect({ APPLE_MESSAGES_ALLOW_WRITES: "1" })).listTools();
    expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)).toEqual([
      "apple_messages_send_message",
    ]);
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

  /**
   * `find_codes` is gated on its own flag, and these three assertions are the
   * whole reason it is not folded into `allowWrites`.
   *
   * It is a READ of live authentication codes. Reaching it through the write
   * gate would mean granting the right to send a message in order to get it,
   * and — the part that actually matters — this server already holds the
   * conversation history while a sibling holds Mail. That is the password-reset
   * channel; adding live codes to it completes an account-takeover primitive
   * out of individually reasonable parts. So: off by default, orthogonal to
   * writes, and absent rather than refused when off.
   */
  it("adds only find_codes when APPLE_MESSAGES_ALLOW_CODES is set", async () => {
    const off = await toolNames(await connect());
    const on = await toolNames(await connect({ APPLE_MESSAGES_ALLOW_CODES: "1" }));
    expect(on.filter((n) => !off.includes(n))).toEqual(["apple_messages_find_codes"]);
    expect(off.filter((n) => !on.includes(n))).toEqual([]);
  });

  it("hides find_codes completely when the flag is off", async () => {
    expect(await toolNames(await connect())).not.toContain("apple_messages_find_codes");
  });

  /**
   * `allowFileSend` is the first flag that changes a tool's SCHEMA rather than
   * the registered set, and the invariant in `src/tools/index.ts` covers that
   * too: an MCP client caches the shape as well as the list, so a parameter that
   * appeared and disappeared with runtime state would stay wrong.
   *
   * Absent rather than refused, for the reason `src/tools/actions.ts` gives one
   * level up: a parameter that exists and always says no is a parameter the
   * model will keep filling in. `attachmentId` is on the other side of that line
   * — it is bounded by construction, so it needs no flag and is always there.
   */
  const sendSchema = async (env: NodeJS.ProcessEnv) => {
    const { tools } = await (await connect(env)).listTools();
    const send = tools.find((t) => t.name === "apple_messages_send_message");
    return Object.keys(send?.inputSchema.properties ?? {});
  };

  it("hides the filePath parameter unless APPLE_MESSAGES_ALLOW_FILE_SEND is set", async () => {
    const off = await sendSchema({ APPLE_MESSAGES_ALLOW_WRITES: "1" });
    expect(off).not.toContain("filePath");
    expect(off).toContain("attachmentId");

    const on = await sendSchema({
      APPLE_MESSAGES_ALLOW_WRITES: "1",
      APPLE_MESSAGES_ALLOW_FILE_SEND: "1",
    });
    expect(on).toContain("filePath");
    expect(on.filter((k) => !off.includes(k))).toEqual(["filePath"]);
  });

  /**
   * The file-send flag is a SUB-gate of writes, not a third independent switch:
   * it widens a tool that only exists when writes are on, so on its own it must
   * do nothing at all.
   */
  it("keeps allowFileSend inert without writes", async () => {
    const names = await toolNames(await connect({ APPLE_MESSAGES_ALLOW_FILE_SEND: "1" }));
    expect(names).not.toContain("apple_messages_send_message");
    expect(names).toEqual(await toolNames(await connect()));
  });

  /**
   * The two gates are independent in both directions. Turning writes on must
   * not smuggle in the codes tool, and turning codes on must not smuggle in the
   * ability to send.
   */
  it("keeps the two gates orthogonal", async () => {
    const writes = await toolNames(await connect({ APPLE_MESSAGES_ALLOW_WRITES: "1" }));
    expect(writes).not.toContain("apple_messages_find_codes");

    const codes = await toolNames(await connect({ APPLE_MESSAGES_ALLOW_CODES: "1" }));
    expect(codes).not.toContain("apple_messages_send_message");
    expect(codes).not.toContain("apple_messages_save_attachment");

    const both = await toolNames(
      await connect({ APPLE_MESSAGES_ALLOW_WRITES: "1", APPLE_MESSAGES_ALLOW_CODES: "1" }),
    );
    expect(both).toContain("apple_messages_find_codes");
    expect(both).toContain("apple_messages_send_message");
  });

  /**
   * `find_codes` reads; it must never be marked destructive, and it must not
   * displace the send tool as the only destructive one.
   */
  it("registers find_codes as a read-only tool", async () => {
    const { tools } = await (await connect({ APPLE_MESSAGES_ALLOW_CODES: "1" })).listTools();
    const codes = tools.find((t) => t.name === "apple_messages_find_codes");
    expect(codes?.annotations?.readOnlyHint).toBe(true);
    expect(tools.filter((t) => t.annotations?.destructiveHint)).toEqual([]);
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
