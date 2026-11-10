import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The tool contract, over a real client and a real transport. `home` points discovery at a
 * directory that does not exist, so nothing here can reach anyone's real recordings.
 */
const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config = loadConfig({ APPLE_VOICE_MEMOS_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).toSorted();

const EXPECTED = ["apple_voice_memos_diagnostics"];

describe("voice-memos tools", () => {
  it("registers exactly the read tools", async () => {
    expect(await toolNames(await connect())).toEqual(EXPECTED);
  });

  /*
   * MCP clients cache the tool list, so one that shrank without Full Disk Access would stay
   * shrunk after the grant was given. Every tool is registered with no store at all.
   */
  it("registers every tool with no readable store at all", async () => {
    expect(await toolNames(await connect({ APPLE_VOICE_MEMOS_STORE: "/nope.db" }))).toEqual(
      EXPECTED,
    );
  });

  it("marks every read tool read-only", async () => {
    for (const t of (await (await connect()).listTools()).tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});
