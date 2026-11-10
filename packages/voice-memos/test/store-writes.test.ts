import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VoiceMemosClient } from "../src/client/voice-memos.js";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/tools/index.js";
import { STORE_WRITE_TOOLS } from "../src/tools/names.js";
import { insertRecording, type Library, makeLibrary } from "./helpers/store.js";

type Request = { id: number; method: string; params: Record<string, unknown> };

const sockets = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of sockets) server.close();
  sockets.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

/**
 * A stand-in for the app's store verb on `cupertino.sock`, as in core's store-lane test.
 * `reply` answers each JSON-RPC line with a result object, or with `{ error }` for a refusal.
 * `seen` holds every line the server under test wrote, handshake first.
 */
const hostStub = async (
  reply: (message: Request) => { result: unknown } | { error: Record<string, unknown> },
): Promise<{ env: NodeJS.ProcessEnv; seen: string[]; connections: () => number }> => {
  const dir = mkdtempSync(join(tmpdir(), "vm-store-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: string[] = [];
  let connections = 0;
  const server = createServer((socket: Socket) => {
    connections += 1;
    let buffer = "";
    let greeted = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        seen.push(line);
        if (!greeted) {
          greeted = true;
          socket.write("ok\n");
          continue;
        }
        const message = JSON.parse(line) as Request;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply(message) })}\n`);
      }
    });
  });
  sockets.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    env: { CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "voice-memos" },
    seen,
    connections: () => connections,
  };
};

const write = (
  id: string,
  changed: string[],
  modelVersion: string | null = "VoiceMemos14",
  syncMeasured = true,
) => ({ result: { id, changed, modelVersion, syncMeasured } });

/** Answers every write with a measured save that changed one field. */
const saves = (message: Request) =>
  message.method === "voiceMemos.status"
    ? {
        result: {
          compatible: true,
          modelVersion: "VoiceMemos14",
          syncMeasured: true,
          refusal: null,
        },
      }
    : write(String(message.params.id), ["title"]);

let lib: Library;
beforeEach(() => {
  lib = makeLibrary();
  insertRecording(lib.db, { pk: 1, id: "R-1", title: "Synthetic memo", date: 1 });
});
afterEach(() => lib.cleanup());

/** The server with a synthetic library, writes as given, and the lane env as given. */
const connect = async (opts: { writes: boolean; lane: NodeJS.ProcessEnv }) => {
  const config = loadConfig({
    APPLE_VOICE_MEMOS_STORE: lib.storePath,
    APPLE_VOICE_MEMOS_INDEX_MODE: "auto",
    ...(opts.writes ? { APPLE_VOICE_MEMOS_ALLOW_WRITES: "1" } : {}),
  });
  const vm = new VoiceMemosClient({ config, home: "/nonexistent-home", env: opts.lane });
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, vm, { allowWrites: config.allowWrites });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

type Result = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const res = (await c.callTool({ name, arguments: args })) as Result;
  return {
    isError: res.isError === true,
    body: JSON.parse(res.content.map((x) => x.text).join("")) as Record<string, unknown>,
  };
};

const MEASURED =
  "Saved the way Voice Memos saves it. It reaches your other devices through iCloud, once " +
  "Voice Memos is running.";

describe("store lane tools", () => {
  it("registers the five lane tools when hosted and writes are on", async () => {
    const { env, connections } = await hostStub(saves);
    const names = await toolNames(await connect({ writes: true, lane: env }));
    expect(STORE_WRITE_TOOLS).toEqual([
      "apple_voice_memos_rename_recording",
      "apple_voice_memos_move_recording",
      "apple_voice_memos_set_favorite",
      "apple_voice_memos_delete_recording",
      "apple_voice_memos_restore_recording",
    ]);
    for (const name of STORE_WRITE_TOOLS) expect(names).toContain(name);
    expect(names).toContain("apple_voice_memos_save_recording");
    // Cupertino lists a server's tools by spawning it with the lane env: that must not connect.
    expect(connections()).toBe(0);
  });

  it("registers none of them without the host's env", async () => {
    const names = await toolNames(await connect({ writes: true, lane: {} }));
    expect(names).toContain("apple_voice_memos_save_recording");
    for (const name of STORE_WRITE_TOOLS) expect(names).not.toContain(name);
  });

  it("registers none of them with writes off", async () => {
    const { env } = await hostStub(saves);
    const names = await toolNames(await connect({ writes: false, lane: env }));
    for (const name of STORE_WRITE_TOOLS) expect(names).not.toContain(name);
  });

  it("annotates every lane tool idempotent, and only delete destructive", async () => {
    const { env } = await hostStub(saves);
    const tools = (await (await connect({ writes: true, lane: env })).listTools()).tools;
    for (const name of STORE_WRITE_TOOLS) {
      expect(tools.find((t) => t.name === name)?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: name === "apple_voice_memos_delete_recording",
        idempotentHint: true,
      });
    }
  });

  it("rename_recording sends voiceMemos.rename with id and title", async () => {
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    const res = await call(c, "apple_voice_memos_rename_recording", {
      id: "R-1",
      title: "Synthetic renamed",
    });
    expect(seen[0]).toBe("cupertino/1 store for=voice-memos");
    expect(JSON.parse(seen[1] ?? "")).toMatchObject({
      method: "voiceMemos.rename",
      params: { id: "R-1", title: "Synthetic renamed" },
    });
    expect(res).toEqual({
      isError: false,
      body: {
        id: "R-1",
        changed: ["title"],
        modelVersion: "VoiceMemos14",
        syncMeasured: true,
        sync: MEASURED,
      },
    });
  });

  it("sends each other write as its lane method", async () => {
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    await call(c, "apple_voice_memos_set_favorite", { id: "R-1", favorite: true });
    await call(c, "apple_voice_memos_move_recording", { id: "R-1", folderId: "F-1" });
    await call(c, "apple_voice_memos_move_recording", { id: "R-1", folderId: null });
    await call(c, "apple_voice_memos_delete_recording", { id: "R-1" });
    await call(c, "apple_voice_memos_restore_recording", { id: "R-1" });
    const sent = seen.slice(1).map((line) => {
      const { method, params } = JSON.parse(line) as Request;
      return { method, params };
    });
    expect(sent).toEqual([
      { method: "voiceMemos.setFavorite", params: { id: "R-1", favorite: true } },
      { method: "voiceMemos.move", params: { id: "R-1", folderId: "F-1" } },
      // The key is present: null is "leave every folder", not "no folder given".
      { method: "voiceMemos.move", params: { id: "R-1", folderId: null } },
      { method: "voiceMemos.delete", params: { id: "R-1" } },
      { method: "voiceMemos.restore", params: { id: "R-1" } },
    ]);
  });

  it("a lane refusal comes back as a tool error naming the reason", async () => {
    const { env } = await hostStub(() => ({
      error: {
        code: -32000,
        message: 'No recording with id "R-9".',
        data: { reason: "notFound" },
      },
    }));
    const c = await connect({ writes: true, lane: env });
    const res = await call(c, "apple_voice_memos_rename_recording", {
      id: "R-9",
      title: "Synthetic",
    });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe('Voice Memos: No recording with id "R-9".');
    expect(res.body.details).toMatchObject({ reason: "notFound" });
  });

  it("says sync is not yet measured when the lane says so", async () => {
    const { env } = await hostStub((m) =>
      write(String(m.params.id), ["favorite"], "VoiceMemos15", false),
    );
    const c = await connect({ writes: true, lane: env });
    const res = await call(c, "apple_voice_memos_set_favorite", { id: "R-1", favorite: false });
    expect(res.body.sync).toBe(
      "Saved, but sync is not yet measured on this macOS (model VoiceMemos15): check the " +
        "recording on another device.",
    );
  });

  it("says there was nothing to change when the lane changed nothing", async () => {
    const { env } = await hostStub((m) => write(String(m.params.id), []));
    const c = await connect({ writes: true, lane: env });
    const res = await call(c, "apple_voice_memos_restore_recording", { id: "R-1" });
    expect(res.body).toMatchObject({ changed: [], sync: "Nothing to change." });
  });

  it("diagnostics reports writeLane null without the host, and the lane status with it", async () => {
    const without = await call(
      await connect({ writes: true, lane: {} }),
      "apple_voice_memos_diagnostics",
      {},
    );
    const lanes = without.body.lanes as Record<string, unknown>;
    expect(lanes.writeLane).toBeNull();
    expect(JSON.stringify(lanes)).toContain(
      "not hosted by Cupertino: rename, move, favourite and delete need the app",
    );
    expect(lanes.writes).toMatchObject({ storeTools: [] });

    const { env } = await hostStub(saves);
    const hosted = await call(
      await connect({ writes: true, lane: env }),
      "apple_voice_memos_diagnostics",
      {},
    );
    const hostedLanes = hosted.body.lanes as Record<string, unknown>;
    expect(hostedLanes.writeLane).toEqual({
      compatible: true,
      modelVersion: "VoiceMemos14",
      syncMeasured: true,
      refusal: null,
    });
    expect(hostedLanes.writes).toMatchObject({ storeTools: [...STORE_WRITE_TOOLS] });
  });

  it("diagnostics reports a lane that cannot answer as an error, not a failure", async () => {
    const { env } = await hostStub(() => ({
      error: {
        code: -32000,
        message: "writes are off in Cupertino",
        data: { reason: "writesOff" },
      },
    }));
    const res = await call(
      await connect({ writes: true, lane: env }),
      "apple_voice_memos_diagnostics",
      {},
    );
    expect(res.isError).toBe(false);
    expect((res.body.lanes as Record<string, unknown>).writeLane).toEqual({
      error: "Voice Memos: writes are off in Cupertino",
    });
  });
});
