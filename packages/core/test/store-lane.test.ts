import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SurfaceContext } from "../src/errors.js";
import { openStoreLane, StoreLaneError } from "../src/store-lane.js";

const SURFACE: SurfaceContext = { appName: "Voice Memos", envPrefix: "APPLE_VOICE_MEMOS" };

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

type Request = { id: number; method: string; params: Record<string, unknown> };

/**
 * A stand-in for the app's store verb on `cupertino.sock`.
 *
 * `handshake` answers the first line; `reply` answers each JSON-RPC line after
 * it, and `null` hangs up instead. `connections` counts how many times a client
 * connected, which is what the one-connection rule is about.
 */
const hostStub = async (opts: {
  handshake?: (line: string) => string;
  reply?: (message: Request) => Promise<string | null | undefined> | string | null | undefined;
}): Promise<{ path: string; seen: string[]; connections: () => number }> => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
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
          socket.write(`${(opts.handshake ?? (() => "ok"))(line)}\n`);
          continue;
        }
        void Promise.resolve((opts.reply ?? (() => null))(JSON.parse(line))).then((answer) => {
          // undefined: never answer, to exercise the timeout.
          if (answer === undefined) return;
          if (answer === null) {
            socket.destroy();
            return;
          }
          socket.write(`${answer}\n`);
        });
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, seen, connections: () => connections };
};

const envFor = (path: string) => ({
  CUPERTINO_AX_SOCKET: path,
  CUPERTINO_AX_FOR: "voice-memos",
});

const okReply = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

const errorReply = (id: number, code: number, message: string, reason?: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(reason === undefined ? {} : { data: { reason } }) },
  });

const rejection = async (promise: Promise<unknown> | undefined): Promise<StoreLaneError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StoreLaneError);
    return error as StoreLaneError;
  }
  throw new Error("expected the call to reject");
};

describe("openStoreLane", () => {
  /*
   * The npm packages run with no app on the machine. Null is "no app here, keep
   * the other lane"; a throw would make every caller read error strings to tell
   * that apart from "the app said no".
   */
  it("returns null without the host's env", () => {
    expect(openStoreLane(SURFACE, {})).toBeNull();
    expect(openStoreLane(SURFACE, { CUPERTINO_AX_SOCKET: "/tmp/x" })).toBeNull();
    expect(openStoreLane(SURFACE, { CUPERTINO_AX_FOR: "voice-memos" })).toBeNull();
    expect(openStoreLane(SURFACE, { CUPERTINO_AX_SOCKET: " ", CUPERTINO_AX_FOR: " " })).toBeNull();
  });

  it("does not connect until the first call", async () => {
    const { path, connections } = await hostStub({
      reply: (message) => okReply(message.id, {}),
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    expect(lane).not.toBeNull();
    // Give a connect, had one been made, the time to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connections()).toBe(0);
    await lane?.call("voiceMemos.rename", {});
    expect(connections()).toBe(1);
    lane?.close();
  });

  it("sends the store handshake for the surface", async () => {
    const { path, seen } = await hostStub({
      reply: (message) => okReply(message.id, { ok: true }),
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    await lane?.call("voiceMemos.rename", { id: "rec-1", title: "Synthetic" });
    expect(seen[0]).toBe("cupertino/1 store for=voice-memos");
    expect(JSON.parse(seen[1] ?? "")).toMatchObject({
      jsonrpc: "2.0",
      method: "voiceMemos.rename",
      params: { id: "rec-1", title: "Synthetic" },
    });
    lane?.close();
  });

  /* The lane answers with its own object, not MCP's content envelope. */
  it("returns the result of a call", async () => {
    const { path } = await hostStub({
      reply: (message) => okReply(message.id, { id: "rec-1", title: "Synthetic", saved: true }),
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    await expect(lane?.call("voiceMemos.rename", { id: "rec-1" })).resolves.toEqual({
      id: "rec-1",
      title: "Synthetic",
      saved: true,
    });
    lane?.close();
  });

  it("throws StoreLaneError with the reply's reason", async () => {
    const { path } = await hostStub({
      reply: (message) =>
        errorReply(message.id, -32000, "no recording with id 'rec-9'", "notFound"),
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    const error = await rejection(lane?.call("voiceMemos.rename", { id: "rec-9" }));
    expect(error.reason).toBe("notFound");
    expect(error.message).toContain("no recording with id 'rec-9'");
    lane?.close();
  });

  /* A protocol error carries `data.reason` too; only its absence is "protocol". */
  it("takes the reason of a protocol error from its data, and protocol when there is none", async () => {
    const { path } = await hostStub({
      reply: (message) =>
        message.method === "voiceMemos.nope"
          ? errorReply(message.id, -32601, "unknown method 'voiceMemos.nope'", "invalid")
          : errorReply(message.id, -32000, "something odd"),
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    expect((await rejection(lane?.call("voiceMemos.nope", {}))).reason).toBe("invalid");
    expect((await rejection(lane?.call("voiceMemos.rename", {}))).reason).toBe("protocol");
    lane?.close();
  });

  /*
   * A refusal is a throw, never a null: the app is there and said no, which the
   * caller must report rather than route around.
   */
  it("reports a refused handshake as reason refused with the host's text", async () => {
    const { path } = await hostStub({
      handshake: () => "err this connection is not a voice-memos server",
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    const error = await rejection(lane?.call("voiceMemos.rename", {}));
    expect(error.reason).toBe("refused");
    expect(error.message).toContain("this connection is not a voice-memos server");
  });

  it("reports a socket nobody listens on as unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    scratch.add(dir);
    const lane = openStoreLane(SURFACE, envFor(join(dir, "absent.sock")));
    expect((await rejection(lane?.call("voiceMemos.rename", {}))).reason).toBe("unreachable");
  });

  /*
   * The store on the other end opens a coordinator per call and saves once, so
   * two overlapping writes would race each other. Calls are chained.
   */
  it("serialises overlapping calls", async () => {
    let inFlight = 0;
    let overlapped = false;
    const { path, connections } = await hostStub({
      reply: async (message) => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return okReply(message.id, { method: message.method });
      },
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    const results = await Promise.all([
      lane?.call("voiceMemos.rename", {}),
      lane?.call("voiceMemos.move", {}),
      lane?.call("voiceMemos.delete", {}),
    ]);
    expect(overlapped).toBe(false);
    expect(results.map((r) => (r as { method: string }).method)).toEqual([
      "voiceMemos.rename",
      "voiceMemos.move",
      "voiceMemos.delete",
    ]);
    // One handshake for all three: each new connection costs the app a log line.
    expect(connections()).toBe(1);
    lane?.close();
  });

  it("keeps serving after a failed call, on the same connection", async () => {
    const { path, connections } = await hostStub({
      reply: (message) =>
        message.method === "voiceMemos.delete"
          ? errorReply(message.id, -32000, "writes are off", "writesOff")
          : okReply(message.id, { fine: true }),
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    expect((await rejection(lane?.call("voiceMemos.delete", {}))).reason).toBe("writesOff");
    await expect(lane?.call("voiceMemos.rename", {})).resolves.toEqual({ fine: true });
    expect(connections()).toBe(1);
    lane?.close();
  });

  it("reconnects on the next call after the host hangs up", async () => {
    let calls = 0;
    const { path, connections } = await hostStub({
      reply: (message) => {
        calls += 1;
        return calls === 1 ? null : okReply(message.id, { again: true });
      },
    });
    const lane = openStoreLane(SURFACE, envFor(path));
    expect((await rejection(lane?.call("voiceMemos.rename", {}))).reason).toBe("closed");
    await expect(lane?.call("voiceMemos.rename", {})).resolves.toEqual({ again: true });
    expect(connections()).toBe(2);
    lane?.close();
  });

  it("reports an unparseable reply as protocol", async () => {
    const { path } = await hostStub({ reply: () => "not json" });
    const lane = openStoreLane(SURFACE, envFor(path));
    expect((await rejection(lane?.call("voiceMemos.rename", {}))).reason).toBe("protocol");
    lane?.close();
  });

  it("times out a call that is never answered", async () => {
    let calls = 0;
    let secondArrived: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      secondArrived = resolve;
    });
    const { path } = await hostStub({
      // The first call is answered only once the second has reached the host:
      // past its 200 ms budget, so after the lane dropped its connection. The
      // second is answered ~20 ms later, well inside its own 200 ms.
      reply: async (message) => {
        calls += 1;
        const late = calls === 1;
        if (late) await second;
        else {
          secondArrived?.();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return okReply(message.id, { late });
      },
    });
    const lane = openStoreLane(SURFACE, envFor(path), { timeoutMs: 200 });
    const error = await rejection(lane?.call("voiceMemos.rename", {}));
    expect(error.reason).toBe("timeout");
    // The timed-out call's answer is written to the dropped connection, so it
    // never reaches the second one, whose call gets its own answer. Were the
    // connection kept, that late line would arrive while the second call waits.
    await expect(lane?.call("voiceMemos.rename", {})).resolves.toEqual({ late: false });
    lane?.close();
  });
});
