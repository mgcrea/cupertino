import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { legacySchema, trimToolListing, withTrimmedListing } from "../src/listing.js";

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

  it("leaves every other tool key alone", () => {
    const tool = {
      name: "apple_widget_list",
      description: "List widgets.",
      inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "forbidden" },
    };
    expect(toolsOf(trimToolListing(listing(tool)))[0]).toEqual({
      ...tool,
      inputSchema: { type: "object" },
    });
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

const widget = () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "apple_widget_list",
    {
      description: "List widgets.",
      inputSchema: z.object({ limit: z.number().optional().describe("How many.") }),
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: "text" as const, text: "{}" }] }),
  );
  server.registerTool("apple_widget_diagnostics", { description: "Report." }, () => ({
    content: [{ type: "text" as const, text: "{}" }],
  }));
  return server;
};

describe("legacySchema", () => {
  it("writes a nullable field as the anyOf a 2025-era listing carried", () => {
    const wire = z.toJSONSchema(z.object({ name: z.string().nullable().optional() }));
    // Measured: if zod goes back to anyOf, the rewrite has nothing to do and
    // listing.ts's header needs rewriting.
    expect(wire.properties).toEqual({ name: { type: ["string", "null"] } });
    expect(legacySchema(wire)).toEqual({
      type: "object",
      properties: { name: { anyOf: [{ type: "string" }, { type: "null" }] } },
      additionalProperties: false,
    });
  });

  it("keeps a description outside the anyOf and a constraint inside it", () => {
    const wire = z.toJSONSchema(
      z.object({ name: z.string().min(1).nullable().describe("Who it is.") }),
    );
    expect(legacySchema(wire)).toMatchObject({
      properties: {
        name: {
          description: "Who it is.",
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        },
      },
    });
  });

  it("finds a nullable field inside an array's items", () => {
    const wire = z.toJSONSchema(
      z.object({ rows: z.array(z.object({ a: z.number().nullable() })) }),
    );
    expect(JSON.stringify(legacySchema(wire))).toContain(
      '"a":{"anyOf":[{"type":"number"},{"type":"null"}]}',
    );
  });

  it("leaves other type arrays, and schemas with nothing to do, by identity", () => {
    const plain = { type: "object", properties: { n: { type: "string" } } };
    expect(legacySchema(plain)).toBe(plain);
    const several = { type: ["string", "number", "null"] };
    expect(legacySchema(several)).toBe(several);
    const only = { type: ["string", "number"] };
    expect(legacySchema(only)).toBe(only);
  });

  it("does not walk into a default or a const", () => {
    const schema = { type: "object", properties: { x: { default: { type: ["string", "null"] } } } };
    expect(legacySchema(schema)).toBe(schema);
  });

  it("is what trimToolListing puts on the wire", () => {
    const trimmed = trimToolListing(
      listing({
        name: "apple_widget_create",
        inputSchema: { type: "object", properties: { a: { type: ["string", "null"] } } },
      }),
    );
    expect(toolsOf(trimmed)[0]?.["inputSchema"]).toEqual({
      type: "object",
      properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } },
    });
  });
});

describe("withTrimmedListing", () => {
  /** The `tools/list` frame as the server's transport sent it, before any client parsing. */
  const wire = async (trim: boolean): Promise<Record<string, unknown>[]> => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    const send = st.send.bind(st);
    st.send = (message, options) => {
      sent.push(message);
      return send(message, options);
    };
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([widget().connect(trim ? withTrimmedListing(st) : st), client.connect(ct)]);
    await client.listTools();
    const frame = sent.find((m) => "result" in m && "tools" in (m.result as object));
    return toolsOf(frame as JSONRPCMessage);
  };

  it("has something to trim: the SDK stamps the 2020-12 dialect and no task support", async () => {
    // Measured, not assumed: if a later SDK stops stamping, or starts emitting
    // `execution`, this fails and listing.ts's header needs rewriting.
    const [list, diagnostics] = await wire(false);
    expect(list?.["inputSchema"]).toHaveProperty(
      "$schema",
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(diagnostics?.["inputSchema"]).not.toHaveProperty("$schema");
    expect(list?.["execution"]).toBeUndefined();
  });

  it("trims what a real server puts on the wire, and keeps the rest intact", async () => {
    const [list] = await wire(true);
    const schema = list?.["inputSchema"] as Record<string, unknown>;
    expect(list?.["name"]).toBe("apple_widget_list");
    expect(schema).not.toHaveProperty("$schema");
    // The properties the schema exists for must survive the trim.
    expect(schema).toHaveProperty("type", "object");
    expect(schema["properties"]).toHaveProperty("limit");
    expect(list?.["description"]).toBe("List widgets.");
    expect(list?.["annotations"]).toEqual({ readOnlyHint: true });
  });
});
