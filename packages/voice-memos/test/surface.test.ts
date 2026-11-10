import { readFileSync } from "node:fs";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { insertRecording, type Library, makeLibrary } from "./helpers/store.js";

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config = loadConfig({ APPLE_VOICE_MEMOS_INDEX_MODE: "off", ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const textOf = (contents: readonly { uri: string }[]): string =>
  String((contents[0] as { text?: string } | undefined)?.text);

describe("voice-memos resources", () => {
  it("registers exactly the guide and diagnostics", async () => {
    const uris = (await (await connect()).listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(["cupertino://voice-memos/guide", "cupertino://voice-memos/diagnostics"]);
  });

  it("answers a diagnostics read with JSON even when nothing is reachable", async () => {
    const res = await (
      await connect()
    ).readResource({ uri: "cupertino://voice-memos/diagnostics" });
    expect(res.contents[0]?.mimeType).toBe("application/json");
    expect(() => JSON.parse(textOf(res.contents))).not.toThrow();
  });

  it("states that it transcribes nothing, and edits only through Cupertino", async () => {
    const res = await (await connect()).readResource({ uri: "cupertino://voice-memos/guide" });
    expect(res.contents[0]?.mimeType).toBe("text/markdown");
    const guide = textOf(res.contents);
    expect(guide).toMatch(/does \*\*not\*\* transcribe/);
    expect(guide).not.toMatch(/cannot rename/);
    expect(guide).toMatch(/exist only when Cupertino hosts this server with\s+writes on/);
    for (const tool of [
      "rename_recording",
      "move_recording",
      "set_favorite",
      "delete_recording",
      "restore_recording",
    ]) {
      expect(guide).toContain(`apple_voice_memos_${tool}`);
    }
    expect(guide).toMatch(/syncs when Voice Memos next runs/);
    expect(guide).toMatch(/trimmed, then must be 1 to 500 characters with no line break inside/);
  });

  it("ships no prompts", async () => {
    const client = await connect();
    expect((await client.listPrompts()).prompts).toEqual([]);
  });
});

describe("diagnostics", () => {
  let lib: Library | null = null;
  afterEach(() => {
    lib?.cleanup();
    lib = null;
  });

  type Report = {
    store: { opened: boolean; mode: string | null; exists: boolean };
    schema: { fingerprint: string | null; verified: boolean };
    counts: { recordings: number; deleted: number; favorites: number; folders: number } | null;
    transcripts: { checked: number } | null;
    lanes: { writes: { enabled: boolean; tools: string[] } };
  };
  const report = async (env: NodeJS.ProcessEnv): Promise<Report> => {
    const res = (await (
      await connect(env)
    ).callTool({ name: "apple_voice_memos_diagnostics", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.content.map((c) => c.text).join("")) as Report;
  };

  it("reports schema.verified false for the fixture, whose triggers were dropped", async () => {
    lib = makeLibrary();
    insertRecording(lib.db, { pk: 1, id: "a", date: 1, shared: 1 });
    insertRecording(lib.db, { pk: 2, id: "b", date: 2, evicted: 3 });
    const r = await report({
      APPLE_VOICE_MEMOS_STORE: lib.storePath,
      APPLE_VOICE_MEMOS_INDEX_MODE: "auto",
    });
    expect(r.store).toMatchObject({ opened: true, mode: "ro", exists: true });
    expect(r.schema.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(r.schema.verified).toBe(false);
    expect(r.counts).toEqual({ recordings: 2, deleted: 1, favorites: 1, folders: 0 });
  });

  it("explains the missing grant rather than failing", async () => {
    const r = await report({});
    expect(r.store.opened).toBe(false);
    expect(r.counts).toBeNull();
    expect(JSON.stringify(r)).toContain("Full Disk Access");
  });

  it("reports the write gate it was started with", async () => {
    expect((await report({})).lanes.writes).toMatchObject({ enabled: false, tools: [] });
    expect((await report({ APPLE_VOICE_MEMOS_ALLOW_WRITES: "1" })).lanes.writes.enabled).toBe(true);
  });
});

describe("startup banner", () => {
  it("reports the write gate rather than claiming read-only", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).not.toContain("read-only");
    expect(cli).toContain('writes=${config.allowWrites ? "ENABLED" : "disabled"}');
  });
});
