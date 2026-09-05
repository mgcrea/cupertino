import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { trimToolListing, withTrimmedListing } from "../src/listing.js";

const listing = (tool: Record<string, unknown>): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id: 1, result: { tools: [tool] } }) as JSONRPCMessage;

const toolsOf = (message: JSONRPCMessage): Record<string, unknown>[] =>
  (message as unknown as { result: { tools: Record<string, unknown>[] } }).result.tools;

describe("trimToolListing", () => {
  it("drops the generated $schema stamp from an input schema", () => {
    const trimmed = trimToolListing(
      listing({
        name: "apple_widget_list",
        inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
      }),
    );
    expect(toolsOf(trimmed)[0]?.["inputSchema"]).toEqual({ type: "object" });
  });

  it("keeps execution, which is boilerplate but not free to remove", () => {
    // Pinned deliberately. `taskSupport` is optional with no default, so an
    // absent `execution` means "unspecified" to a client rather than
    // "forbidden" — see the header of listing.ts. This assertion exists so the
    // remaining 3.5% is not reclaimed by someone who only counted the bytes.
    const trimmed = trimToolListing(
      listing({
        name: "apple_widget_list",
        inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
        execution: { taskSupport: "forbidden" },
      }),
    );
    expect(toolsOf(trimmed)[0]?.["execution"]).toEqual({ taskSupport: "forbidden" });
  });

  it("never edits the message it was handed", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
    const original = listing({ name: "apple_widget_list", inputSchema: schema });
    trimToolListing(original);
    expect(schema).toHaveProperty("$schema");
    expect(toolsOf(original)[0]?.["inputSchema"]).toBe(schema);
  });

  it("returns anything that is not a tool listing by identity", () => {
    // Every frame a server sends goes through this, so the non-matching case
    // has to cost a type check and nothing else.
    const notAListing = { jsonrpc: "2.0", id: 1, result: { contents: [] } } as JSONRPCMessage;
    expect(trimToolListing(notAListing)).toBe(notAListing);
    const request = { jsonrpc: "2.0", id: 1, method: "ping" } as JSONRPCMessage;
    expect(trimToolListing(request)).toBe(request);
  });

  it("leaves a listing alone when nothing was stamped", () => {
    const clean = listing({ name: "apple_widget_list", inputSchema: { type: "object" } });
    expect(trimToolListing(clean)).toBe(clean);
  });
});

describe("withTrimmedListing", () => {
  it("trims what a real server puts on the wire, and keeps the rest intact", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool(
      "apple_widget_list",
      {
        description: "List widgets.",
        inputSchema: { limit: z.number().optional().describe("How many.") },
        annotations: { readOnlyHint: true },
      },
      () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    );

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(withTrimmedListing(st)), client.connect(ct)]);

    const { tools } = await client.listTools();
    const listed = tools[0];
    expect(listed?.name).toBe("apple_widget_list");
    expect(listed?.inputSchema).not.toHaveProperty("$schema");
    // The properties the schema exists for must survive the trim.
    expect(listed?.inputSchema).toHaveProperty("type", "object");
    expect(listed?.inputSchema.properties).toHaveProperty("limit");
    expect(listed?.description).toBe("List widgets.");
    expect(listed?.annotations).toEqual({ readOnlyHint: true });
  });
});
