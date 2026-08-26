import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * Prompts and resources for the Contacts surface.
 *
 * The seams are the same ones tools.test.ts uses, and for the same reason: with
 * discovery pointed at a real home these would read the developer's own data.
 * Everything asserted below is registration and shape, which is exactly what a
 * host sees before it has permission to read anything.
 */
const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({ APPLE_CONTACTS_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

/** `contents` is a text-or-blob union; every resource here is text. */
const textOf = (contents: readonly { uri: string }[]): string =>
  String((contents[0] as { text?: string } | undefined)?.text);

const uris = async (c: Client) => (await c.listResources()).resources.map((r) => r.uri);
const promptNames = async (c: Client) =>
  (await c.listPrompts()).prompts.map((p) => p.name).toSorted();

describe("contacts resources", () => {
  it("registers the surface resources", async () => {
    expect(await uris(await connect())).toEqual([
      "cupertino://contacts/guide",
      "cupertino://contacts/diagnostics",
    ]);
  });

  /*
   * The guide is the one thing here that works on a completely denied server —
   * it is a string in the bundle, so no permission, no running app and no
   * readable store stands between a caller and it. That is the whole reason it
   * is static, and this test is what keeps it that way.
   */
  it("serves the guide as markdown without touching a permission", async () => {
    const res = await (await connect()).readResource({ uri: "cupertino://contacts/guide" });
    expect(res.contents[0]?.mimeType).toBe("text/markdown");
    expect(textOf(res.contents)).toContain("# ");
  });

  it("answers a diagnostics read with data even when nothing is reachable", async () => {
    const res = await (await connect()).readResource({ uri: "cupertino://contacts/diagnostics" });
    expect(res.contents[0]?.mimeType).toBe("application/json");
    expect(() => JSON.parse(textOf(res.contents))).not.toThrow();
  });
});

describe("contacts prompts", () => {
  it("registers the read-only prompts", async () => {
    expect(await promptNames(await connect())).toEqual(["apple_contacts_who_is"]);
  });

  /*
   * This surface registers no mutating tool at all, so enabling writes must
   * change nothing here either — a write prompt with no write tool behind it
   * would be an offer nothing can keep.
   */
  it("registers the same prompts with writes on, because this surface has none", async () => {
    expect(await promptNames(await connect({ APPLE_CONTACTS_ALLOW_WRITES: "1" }))).toEqual([
      "apple_contacts_who_is",
    ]);
  });

  it("embeds the guide ahead of the instruction", async () => {
    const got = await (
      await connect()
    ).getPrompt({ name: "apple_contacts_who_is", arguments: { who: "+33612345678" } });
    expect(got.messages[0]?.content).toMatchObject({
      type: "resource",
      resource: { uri: "cupertino://contacts/guide", mimeType: "text/markdown" },
    });
    expect(got.messages[1]?.content).toMatchObject({ type: "text" });
  });
});

/*
 * The cost knob, not the safety gate. `exposePrompts` defaults ON — the write
 * gate defaults OFF — because one decides whether a mutation can be reached at
 * all and the other only decides what a listing weighs. Turning it off must
 * take BOTH primitives with it: a prompt embeds its surface guide, so prompts
 * without resources would name a `cupertino://contacts/guide` that nothing serves.
 */
describe("contacts exposePrompts", () => {
  it("registers prompts and resources by default", async () => {
    const client = await connect();
    expect((await client.listResources()).resources.length).toBeGreaterThan(0);
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
  });

  it("registers neither when it is off, and stops advertising the capability", async () => {
    const client = await connect({ APPLE_CONTACTS_EXPOSE_PROMPTS: "0" });
    // Not an empty list — the capability is never declared, so a client asking
    // gets "method not found". That is the same shape as the write gate: the
    // thing is absent rather than present-and-empty.
    await expect(client.listResources()).rejects.toThrow();
    await expect(client.listPrompts()).rejects.toThrow();
  });

  it("leaves the tools untouched", async () => {
    const on = (await (await connect()).listTools()).tools.length;
    const off = (await (await connect({ APPLE_CONTACTS_EXPOSE_PROMPTS: "0" })).listTools()).tools
      .length;
    expect(off).toBe(on);
    expect(off).toBeGreaterThan(0);
  });
});
