import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { qtaWithTranscript } from "./helpers/audio.js";
import { insertFolder, insertRecording, type Library, makeLibrary } from "./helpers/store.js";

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

const EXPECTED = [
  "apple_voice_memos_diagnostics",
  "apple_voice_memos_get_recording",
  "apple_voice_memos_list_folders",
  "apple_voice_memos_list_recordings",
  "apple_voice_memos_search_recordings",
];

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

  it("registers save_recording only with writes allowed", async () => {
    expect(await toolNames(await connect())).not.toContain("apple_voice_memos_save_recording");
    expect(await toolNames(await connect({ APPLE_VOICE_MEMOS_ALLOW_WRITES: "1" }))).toEqual(
      [...EXPECTED, "apple_voice_memos_save_recording"].toSorted(),
    );
  });

  it("annotates save_recording as a non-destructive write", async () => {
    const tools = (await (await connect({ APPLE_VOICE_MEMOS_ALLOW_WRITES: "1" })).listTools())
      .tools;
    expect(tools.find((t) => t.name === "apple_voice_memos_save_recording")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("marks every read tool read-only", async () => {
    for (const t of (await (await connect()).listTools()).tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("with no readable store", () => {
  it("fails a listing rather than returning an empty list, naming the grant", async () => {
    const res = await (
      await connect()
    ).callTool({ name: "apple_voice_memos_list_recordings", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Full Disk Access/);
  });
});

describe("over a library", () => {
  let lib: Library;
  beforeEach(() => {
    lib = makeLibrary();
    insertFolder(lib.db, { pk: 1, uuid: "F-1", name: "Work", rank: 0, count: 1 });
    const path = lib.addAudio(
      "a.qta",
      qtaWithTranscript({
        attributedString: { runs: ["Budget review.", 0], attributeTable: [{ timeRange: [2, 4] }] },
      }),
    );
    insertRecording(lib.db, { pk: 1, id: "R-1", title: "Monday", date: 1, folder: 1, path });
  });
  afterEach(() => lib.cleanup());

  const libraryEnv = (): NodeJS.ProcessEnv => ({
    APPLE_VOICE_MEMOS_STORE: lib.storePath,
    APPLE_VOICE_MEMOS_INDEX_MODE: "auto",
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await (await connect(libraryEnv())).callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    return JSON.parse(res.content.map((c) => c.text).join("")) as Record<string, unknown>;
  };

  it("answers each read tool", async () => {
    expect(await call("apple_voice_memos_list_folders", {})).toMatchObject({
      folders: [{ id: "F-1", name: "Work" }],
    });
    expect(await call("apple_voice_memos_list_recordings", { folderId: "F-1" })).toMatchObject({
      recordings: [{ id: "R-1", title: "Monday" }],
      total: 1,
    });
    expect(
      await call("apple_voice_memos_get_recording", { id: "R-1", format: "segments" }),
    ).toMatchObject({ transcript: { status: "ok", segments: [{ start: 2, end: 4 }] } });
    expect(await call("apple_voice_memos_search_recordings", { query: "budget" })).toMatchObject({
      hits: [{ recording: { id: "R-1" }, segments: [{ start: 2 }] }],
    });
  });

  it("rejects a since that is not a date, rather than matching nothing", async () => {
    const res = await (
      await connect(libraryEnv())
    ).callTool({ name: "apple_voice_memos_list_recordings", arguments: { since: "soon" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/since/);
  });
});
