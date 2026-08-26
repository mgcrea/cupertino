import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerSurfaceResources, surfaceUri } from "../src/resources.js";

const connect = async (server: McpServer): Promise<Client> => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
};

const withResources = async (
  opts: Partial<Parameters<typeof registerSurfaceResources>[1]> = {},
): Promise<Client> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerSurfaceResources(server, {
    surface: "widget",
    displayName: "Widget",
    guide: "# Widget\n\nStatic.",
    diagnostics: async () => ({ ok: true }),
    ...opts,
  });
  return connect(server);
};

/**
 * The first content's text. `contents` is a union of text and blob entries, and
 * every resource this package registers is text — so narrowing here keeps the
 * cast in one place rather than at each assertion.
 */
const textOf = (contents: readonly { uri: string }[]): string =>
  String((contents[0] as { text?: string } | undefined)?.text);

const bodyOf = async (client: Client, uri: string): Promise<string> =>
  textOf((await client.readResource({ uri })).contents);

describe("surfaceUri", () => {
  it("builds the one URI shape, under the project's own scheme", () => {
    // Not `apple://` — see the note in resources.ts. A scheme is a namespace
    // claim, and this project spends a README line disclaiming that one.
    expect(surfaceUri("mail", "guide")).toBe("cupertino://mail/guide");
  });
});

describe("registerSurfaceResources", () => {
  it("registers guide and diagnostics, and inventory only when the surface has one", async () => {
    const without = await withResources();
    expect((await without.listResources()).resources.map((r) => r.uri)).toEqual([
      "cupertino://widget/guide",
      "cupertino://widget/diagnostics",
    ]);

    const withInventory = await withResources({
      inventory: { describes: "accounts", read: async () => [{ name: "iCloud" }] },
    });
    expect((await withInventory.listResources()).resources.map((r) => r.uri)).toContain(
      "cupertino://widget/inventory",
    );
  });

  it("serves the guide as markdown", async () => {
    const client = await withResources();
    const res = await client.readResource({ uri: "cupertino://widget/guide" });
    expect(res.contents[0]?.mimeType).toBe("text/markdown");
    expect(textOf(res.contents)).toContain("# Widget");
  });

  /*
   * The reason guardedRead exists. A tool that throws still returns its text
   * under `isError`; a resource read that throws returns a JSON-RPC error and
   * keeps nothing — which would delete the diagnostics report at the exact
   * moment someone is reading it to find out why everything is broken.
   */
  it("turns a failed read into data rather than a protocol error", async () => {
    const client = await withResources({
      diagnostics: async () => {
        throw Object.assign(new Error("Full Disk Access denied"), {
          name: "TccDeniedError",
          details: { pane: "Privacy & Security" },
        });
      },
    });

    const body = JSON.parse(await bodyOf(client, "cupertino://widget/diagnostics"));
    expect(body).toMatchObject({
      degraded: true,
      error: "Full Disk Access denied",
      kind: "TccDeniedError",
      details: { pane: "Privacy & Security" },
    });
    expect(body.hint).toContain("cupertino://widget/diagnostics");
  });

  it("does the same for a failing inventory, naming the surface it belongs to", async () => {
    const client = await withResources({
      inventory: {
        describes: "accounts",
        read: async () => {
          throw new Error("Mail is not running");
        },
      },
    });
    const body = JSON.parse(await bodyOf(client, "cupertino://widget/inventory"));
    expect(body.degraded).toBe(true);
    expect(body.hint).toContain("cupertino://widget/diagnostics");
  });
});
