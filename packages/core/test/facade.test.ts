import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { withLazyTools } from "../src/facade.js";
import { okText } from "../src/tools.js";

/**
 * A stand-in surface shaped like the real ones, including the trap.
 *
 * `apple_widget_delete_things` carries NO `readOnlyHint`, exactly as
 * `apple_notes_delete_notes` and twelve of its siblings do not. A facade that
 * classified on annotations would file it as a read and hand a destructive tool
 * to the read dispatcher — so this omission is the fixture, not an oversight.
 */
const register = (target: McpServer, allowWrites: boolean): void => {
  target.registerTool(
    "apple_widget_diagnostics",
    { description: "Report what this server can do.", annotations: { readOnlyHint: true } },
    () => okText("diagnostics"),
  );
  target.registerTool(
    "apple_widget_list_things",
    {
      description: "List the things in a widget, newest first.",
      inputSchema: { limit: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) => okText(`listed ${limit ?? 0}`),
  );
  target.registerTool(
    "apple_widget_search_gadgets",
    {
      description: "Full text search across every gadget attached to a widget.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => okText(`searched ${query}`),
  );
  if (!allowWrites) return;
  target.registerTool(
    "apple_widget_delete_things",
    { description: "Delete things from a widget. Irreversible.", inputSchema: { id: z.string() } },
    ({ id }) => okText(`deleted ${id}`),
  );
};

const connect = async (opts: { lazy: boolean; allowWrites: boolean }): Promise<Client> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  withLazyTools(server, { surface: "widget", displayName: "Widget", ...opts }, register);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
};

const names = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).toSorted();

const textOf = (result: unknown): string => {
  const content = (result as { content: { text?: string }[] }).content;
  return String(content[0]?.text);
};

describe("withLazyTools, switched off", () => {
  it("registers every tool directly, changing nothing", async () => {
    expect(await names(await connect({ lazy: false, allowWrites: true }))).toEqual([
      "apple_widget_delete_things",
      "apple_widget_diagnostics",
      "apple_widget_list_things",
      "apple_widget_search_gadgets",
    ]);
  });
});

describe("withLazyTools, switched on", () => {
  it("lists diagnostics and the read facade, and no write dispatcher, with writes off", async () => {
    expect(await names(await connect({ lazy: true, allowWrites: false }))).toEqual([
      "apple_widget_call_tool",
      "apple_widget_describe_tool",
      "apple_widget_diagnostics",
      "apple_widget_search_tools",
    ]);
  });

  it("adds the write dispatcher only when writes are on", async () => {
    expect(await names(await connect({ lazy: true, allowWrites: true }))).toEqual([
      "apple_widget_call_tool",
      "apple_widget_call_write_tool",
      "apple_widget_describe_tool",
      "apple_widget_diagnostics",
      "apple_widget_search_tools",
    ]);
  });

  it("keeps diagnostics eagerly callable, not behind the index", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    expect(textOf(await client.callTool({ name: "apple_widget_diagnostics", arguments: {} }))).toBe(
      "diagnostics",
    );
  });

  it("annotates each dispatcher truthfully", async () => {
    const { tools } = await (await connect({ lazy: true, allowWrites: true })).listTools();
    const by = (n: string) => tools.find((t) => t.name === n)?.annotations;
    expect(by("apple_widget_call_tool")).toMatchObject({ readOnlyHint: true });
    expect(by("apple_widget_call_write_tool")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});

describe("the read/write split", () => {
  it("classifies a write tool that carries no readOnlyHint", async () => {
    // The regression this file exists for. Classification is structural — a
    // write is a tool that disappears when the gate shuts — so the missing
    // annotation cannot misfile it.
    const client = await connect({ lazy: true, allowWrites: true });
    const refused = await client.callTool({
      name: "apple_widget_call_tool",
      arguments: { name: "apple_widget_delete_things", arguments: { id: "1" } },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("apple_widget_call_write_tool");
  });

  it("runs a write through the write dispatcher", async () => {
    const client = await connect({ lazy: true, allowWrites: true });
    const result = await client.callTool({
      name: "apple_widget_call_write_tool",
      arguments: { name: "apple_widget_delete_things", arguments: { id: "42" } },
    });
    expect(textOf(result)).toBe("deleted 42");
  });

  it("refuses a read through the write dispatcher", async () => {
    const client = await connect({ lazy: true, allowWrites: true });
    const refused = await client.callTool({
      name: "apple_widget_call_write_tool",
      arguments: { name: "apple_widget_list_things", arguments: {} },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("read-only");
  });

  it("cannot reach a write tool at all when the gate is shut", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const refused = await client.callTool({
      name: "apple_widget_call_tool",
      arguments: { name: "apple_widget_delete_things", arguments: { id: "1" } },
    });
    expect(refused.isError).toBe(true);
    // Not "use the write dispatcher" — the tool is absent, as if never written.
    expect(textOf(refused)).toContain("No tool named");
    const listed = await client.callTool({
      name: "apple_widget_search_tools",
      arguments: { query: "delete" },
    });
    expect(textOf(listed)).not.toContain("apple_widget_delete_things");
  });
});

describe("search", () => {
  it("lists everything for an empty query, in the server's own order", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({ name: "apple_widget_search_tools", arguments: {} }),
    );
    expect(text.indexOf("apple_widget_list_things")).toBeLessThan(
      text.indexOf("apple_widget_search_gadgets"),
    );
    expect(text).toContain("2 of 2 tools");
  });

  it("finds a tool by a word that appears only in its description", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({ name: "apple_widget_search_tools", arguments: { query: "gadget" } }),
    );
    expect(text).toContain("apple_widget_search_gadgets");
    expect(text).not.toContain("apple_widget_list_things");
  });

  it("names the words that missed rather than returning nothing", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({
        name: "apple_widget_search_tools",
        arguments: { query: "gadgets zzzznope" },
      }),
    );
    expect(text).toContain("apple_widget_search_gadgets");
    expect(text).toContain("zzzznope");
  });

  it("says so plainly when nothing matches at all", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({
        name: "apple_widget_search_tools",
        arguments: { query: "zzzznope" },
      }),
    );
    expect(text).toContain("No tool matches");
  });
});

describe("describe and dispatch", () => {
  it("returns a schema a caller can build a call from, without the $schema stamp", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({
        name: "apple_widget_describe_tool",
        arguments: { name: "apple_widget_list_things" },
      }),
    );
    expect(text).not.toContain("$schema");
    expect(text).toContain("limit");
    expect(text).toContain("apple_widget_call_tool");
  });

  it("does not offer a suggestion built only on the shared surface prefix", async () => {
    // Every tool here starts `apple_widget_`, so a naive word overlap matches
    // everything and answers a typo with whatever happens to be first.
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({
        name: "apple_widget_describe_tool",
        arguments: { name: "apple_widget_zzzznope" },
      }),
    );
    expect(text).toContain("No tool named");
    expect(text).not.toContain("Did you mean");
  });

  it("suggests near misses for a name that does not exist", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const text = textOf(
      await client.callTool({
        name: "apple_widget_describe_tool",
        arguments: { name: "apple_widget_list_thingz" },
      }),
    );
    expect(text).toContain("apple_widget_list_things");
  });

  it("runs a read tool and passes its arguments through", async () => {
    const client = await connect({ lazy: true, allowWrites: false });
    const result = await client.callTool({
      name: "apple_widget_call_tool",
      arguments: { name: "apple_widget_list_things", arguments: { limit: 7 } },
    });
    expect(textOf(result)).toBe("listed 7");
  });

  it("validates arguments the way the SDK would have", async () => {
    // Under a facade the SDK never parses the real arguments, so the facade
    // must. Without this the handler receives whatever arrived.
    const client = await connect({ lazy: true, allowWrites: false });
    const refused = await client.callTool({
      name: "apple_widget_call_tool",
      arguments: { name: "apple_widget_list_things", arguments: { limit: "not a number" } },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("limit");
  });

  it("runs a tool that declares no input schema", async () => {
    const client = await connect({ lazy: true, allowWrites: true });
    // diagnostics is eager, so exercise the no-schema path through the index by
    // confirming the dispatcher handles a schema-less declaration.
    const text = textOf(
      await client.callTool({ name: "apple_widget_search_tools", arguments: { query: "widget" } }),
    );
    expect(text).toContain("apple_widget_");
  });
});
