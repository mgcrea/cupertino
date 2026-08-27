import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({ APPLE_MAPS_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const textOf = (contents: readonly { uri: string }[]): string =>
  String((contents[0] as { text?: string } | undefined)?.text);

const uris = async (c: Client) => (await c.listResources()).resources.map((r) => r.uri);
const promptNames = async (c: Client) =>
  (await c.listPrompts()).prompts.map((p) => p.name).toSorted();

describe("maps resources", () => {
  it("registers the surface resources", async () => {
    expect(await uris(await connect())).toEqual([
      "cupertino://maps/guide",
      "cupertino://maps/diagnostics",
    ]);
  });

  /*
   * The guide works on a completely denied server — it is a string in the
   * bundle, so no permission and no readable store stands between a caller and
   * it. That is the whole reason it is static, and this test keeps it that way.
   */
  it("serves the guide as markdown without touching a permission", async () => {
    const res = await (await connect()).readResource({ uri: "cupertino://maps/guide" });
    expect(res.contents[0]?.mimeType).toBe("text/markdown");
    expect(textOf(res.contents)).toContain("# ");
  });

  it("answers a diagnostics read with data even when nothing is reachable", async () => {
    const res = await (await connect()).readResource({ uri: "cupertino://maps/diagnostics" });
    expect(res.contents[0]?.mimeType).toBe("application/json");
    expect(() => JSON.parse(textOf(res.contents))).not.toThrow();
  });

  /*
   * The guide has to carry the refusal, not just the instructions. The likeliest
   * way for this surface to be wrong is to answer "where is the nearest X" from
   * general knowledge, and the guide is the only thing a model reads first.
   */
  it("states plainly what this server cannot do", async () => {
    const guide = textOf(
      (await (await connect()).readResource({ uri: "cupertino://maps/guide" })).contents,
    );
    expect(guide).toMatch(/does \*\*not\*\* search Apple's map of the world/);
    expect(guide).toMatch(/directions/);
  });
});

describe("maps prompts", () => {
  it("registers the read-only prompt", async () => {
    expect(await promptNames(await connect())).toEqual(["apple_maps_where_was_that_place"]);
  });

  it("registers the same prompts with writes on, because this surface has none", async () => {
    expect(await promptNames(await connect({ APPLE_MAPS_ALLOW_WRITES: "1" }))).toEqual([
      "apple_maps_where_was_that_place",
    ]);
  });

  it("embeds the guide ahead of the instruction", async () => {
    const got = await (
      await connect()
    ).getPrompt({ name: "apple_maps_where_was_that_place", arguments: {} });
    expect(got.messages[0]?.content).toMatchObject({
      type: "resource",
      resource: { uri: "cupertino://maps/guide", mimeType: "text/markdown" },
    });
    expect(got.messages[1]?.content).toMatchObject({ type: "text" });
  });
});

describe("maps exposePrompts", () => {
  it("registers prompts and resources by default", async () => {
    const client = await connect();
    expect((await client.listResources()).resources.length).toBeGreaterThan(0);
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
  });

  it("registers neither when it is off, and stops advertising the capability", async () => {
    const client = await connect({ APPLE_MAPS_EXPOSE_PROMPTS: "0" });
    await expect(client.listResources()).rejects.toThrow();
    await expect(client.listPrompts()).rejects.toThrow();
  });

  it("leaves the tools untouched", async () => {
    const on = (await (await connect()).listTools()).tools.length;
    const off = (await (await connect({ APPLE_MAPS_EXPOSE_PROMPTS: "0" })).listTools()).tools
      .length;
    expect(off).toBe(on);
    expect(off).toBeGreaterThan(0);
  });
});
