import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AxChannelError, interferenceNote, openAxChannel, watchInterference } from "../src/ax.js";
import type { SurfaceContext } from "../src/errors.js";

const SURFACE: SurfaceContext = { appName: "Mail", envPrefix: "APPLE_MAIL" };

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  // The socket lives in the directory, so it goes with it. Left behind, each
  // run of this file would leak a directory into the system temp.
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

/**
 * A stand-in for `ServerHost`, speaking its half of the wire.
 *
 * `handshake` decides what the first line is answered with; `reply` builds the
 * JSON-RPC answer to each subsequent line. Both are functions so a test can
 * refuse, hang up, or answer nonsense without a second harness.
 */
const hostStub = async (opts: {
  handshake?: (line: string) => string;
  reply?: (message: {
    id: number;
    params: { name: string };
  }) => Promise<string | null> | string | null;
}): Promise<{ path: string; server: Server; seen: string[] }> => {
  const dir = mkdtempSync(join(tmpdir(), "ax-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let greeted = false;
    socket.setEncoding("utf8");
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
          const answer = (opts.handshake ?? (() => "ok"))(line);
          if (answer === "__hangup__") {
            socket.destroy();
            return;
          }
          socket.write(`${answer}\n`);
          continue;
        }
        void Promise.resolve((opts.reply ?? (() => null))(JSON.parse(line))).then((answer) => {
          if (answer === null) {
            socket.destroy();
            return;
          }
          socket.write(`${answer}\n`);
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, server, seen };
};

const envFor = (path: string) => ({ CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "mail" });

const okReply = (id: number, body: unknown) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(body) }] },
  });

describe("openAxChannel", () => {
  /*
   * The fallback signal, and the reason it is null rather than a throw. The npm
   * packages are published artifacts: run by hand with no Cupertino on the
   * machine, a surface must keep whatever lane it already had. If this returned
   * a channel that failed on first use, every caller would have to tell "no app"
   * apart from "the app refused" by reading an error string.
   */
  it("returns null when the host set no socket", () => {
    expect(openAxChannel(SURFACE, {})).toBeNull();
    expect(openAxChannel(SURFACE, { CUPERTINO_AX_SOCKET: "/tmp/x" })).toBeNull();
    expect(openAxChannel(SURFACE, { CUPERTINO_AX_FOR: "mail" })).toBeNull();
  });

  it("nothing is connected until the first call", async () => {
    const { path, server } = await hostStub({});
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    expect(channel).not.toBeNull();
    // A probe of what a server registers must not depend on the host answering.
    expect(existsSync(path)).toBe(true);
    channel?.close();
  });

  it("sends the lent handshake naming the surface it is acting for", async () => {
    const { path, server, seen } = await hostStub({
      reply: (message) => okReply(message.id, { ok: true }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    await channel?.call({
      tool: "apple_desktop_list_windows",
      args: { bundleId: "com.apple.mail" },
    });
    expect(seen[0]).toBe("cupertino/1 desktop for=mail");
    channel?.close();
  });

  it("unwraps the MCP content envelope into the tool's own document", async () => {
    const { path, server } = await hostStub({
      reply: (message) => okReply(message.id, { windows: [{ handle: "e1" }] }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    const result = await channel?.call({ tool: "apple_desktop_list_windows", args: {} });
    expect(result).toEqual({ windows: [{ handle: "e1" }] });
    channel?.close();
  });

  /*
   * A refusal from the host is a throw, never a null. The host refuses for
   * reasons the caller must surface rather than silently route around — the
   * surface is switched off, the peer is not who it claimed to be, the licence
   * gate closed.
   */
  it("throws, naming the refusal, when the host rejects the handshake", async () => {
    const { path, server } = await hostStub({
      handshake: () => "err this connection is not a mail server",
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    await expect(channel?.call({ tool: "apple_desktop_press", args: {} })).rejects.toThrow(
      /not a mail server/,
    );
  });

  it("throws when the host hangs up mid-call", async () => {
    const { path, server } = await hostStub({ reply: () => null });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    await expect(channel?.call({ tool: "apple_desktop_press", args: {} })).rejects.toBeInstanceOf(
      AxChannelError,
    );
  });

  it("reports a JSON-RPC error as a failure rather than a result", async () => {
    const { path, server } = await hostStub({
      reply: (message) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "unknown method" },
        }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    await expect(channel?.call({ tool: "apple_desktop_nope", args: {} })).rejects.toThrow(
      /unknown method/,
    );
  });

  /*
   * The handle store on the other end is shared mutable state and the wire is
   * one socket, so two overlapping walks would interleave. Calls are chained;
   * this pins that the second waits for the first rather than racing it.
   */
  it("serialises calls onto one connection", async () => {
    let inFlight = 0;
    let overlapped = false;
    const { path, server } = await hostStub({
      reply: async (message) => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return okReply(message.id, { name: message.params.name });
      },
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    const results = await Promise.all([
      channel?.call({ tool: "apple_desktop_ui_tree", args: {} }),
      channel?.call({ tool: "apple_desktop_find_elements", args: {} }),
      channel?.call({ tool: "apple_desktop_press", args: {} }),
    ]);
    expect(overlapped).toBe(false);
    expect(results.map((r) => (r as { name: string }).name)).toEqual([
      "apple_desktop_ui_tree",
      "apple_desktop_find_elements",
      "apple_desktop_press",
    ]);
    channel?.close();
  });

  /*
   * One failure must not wedge the queue. The chain is advanced with a promise
   * that settles either way, so a caller that recovers from a refused press can
   * still read afterwards.
   */
  it("keeps serving after a failed call", async () => {
    const { path, server } = await hostStub({
      reply: (message) =>
        message.params.name === "apple_desktop_press"
          ? JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "refused" } })
          : okReply(message.id, { fine: true }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    await expect(channel?.call({ tool: "apple_desktop_press", args: {} })).rejects.toThrow(
      /refused/,
    );
    await expect(channel?.call({ tool: "apple_desktop_ui_tree", args: {} })).resolves.toEqual({
      fine: true,
    });
    channel?.close();
  });
});

describe("a refused tool", () => {
  /*
   * A refusal is NOT a JSON-RPC error. The desktop server answers with a normal
   * result carrying `isError: true` and the reason as plain text, so a caller
   * that only inspects `message.error` reads it as a success value.
   *
   * That shipped and cost an afternoon: every press through this channel was
   * being refused for want of a write gate, and the lane above reported "the
   * naming sheet did not appear" — a sentence about Maps rather than about
   * permission, which sent the debugging in entirely the wrong direction.
   */
  it("is a rejection, not a value, even though it arrives as a result", async () => {
    const { path, server } = await hostStub({
      reply: (message) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "Driving Desktop is switched off." }],
            isError: true,
          },
        }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path));
    await expect(channel?.call({ tool: "apple_desktop_press", args: {} })).rejects.toThrow(
      /switched off/,
    );
  });
});

describe("watchInterference", () => {
  /*
   * The comparison is the whole mechanism. `secondsSinceInput` alone cannot
   * tell "they typed just before we started" from "they typed into the middle
   * of it"; measured against how long the sequence actually took, it can.
   */
  it("is disturbed when the last input is more recent than the sequence", async () => {
    // 0.01s since input, against a sequence that ran for ~0.06s: the input
    // landed inside it.
    const { path, server } = await hostStub({
      reply: (m) => okReply(m.id, { secondsSinceInput: 0.01 }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path))!;
    const watch = watchInterference(channel);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const found = await watch.check();
    expect(found?.disturbed).toBe(true);
    channel.close();
  });

  /*
   * The host's reading counts Cupertino's own synthetic events, so a sequence
   * that posts a key finds "input" a moment ago on every run. A native Mail
   * reply reported "Someone used this Mac 0.2s ago" for its own ⌘V.
   */
  it("is undisturbed when the latest input was Cupertino's own", async () => {
    const { path, server } = await hostStub({
      reply: (m) => okReply(m.id, { secondsSinceInput: 0.01, secondsSinceOwnInput: 0.008 }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path))!;
    const watch = watchInterference(channel);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const found = await watch.check();
    expect(found?.disturbed).toBe(false);
    channel.close();
  });

  it("is still disturbed when a person's input came after Cupertino's", async () => {
    const { path, server } = await hostStub({
      reply: (m) => okReply(m.id, { secondsSinceInput: 0.01, secondsSinceOwnInput: 0.9 }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path))!;
    const watch = watchInterference(channel);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const found = await watch.check();
    expect(found?.disturbed).toBe(true);
    channel.close();
  });

  it("is undisturbed when nobody has touched it since well before the start", async () => {
    const { path, server } = await hostStub({
      reply: (m) => okReply(m.id, { secondsSinceInput: 600 }),
    });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path))!;
    const watch = watchInterference(channel);
    const found = await watch.check();
    expect(found?.disturbed).toBe(false);
    channel.close();
  });

  /*
   * "Could not ask" is not "undisturbed", and collapsing them would let a
   * failure claim the machine was quiet when nothing ever answered.
   */
  it("is null, not undisturbed, when the question cannot be asked", async () => {
    const { path, server } = await hostStub({ reply: () => null });
    open.add(server);
    const channel = openAxChannel(SURFACE, envFor(path))!;
    const watch = watchInterference(channel);
    await expect(watch.check()).resolves.toBeNull();
  });
});

describe("interferenceNote", () => {
  it("says nothing when the machine was quiet", () => {
    expect(interferenceNote(null)).toBe("");
    expect(interferenceNote({ disturbed: false, secondsSinceInput: 600, elapsedSeconds: 3 })).toBe(
      "",
    );
  });

  /*
   * Silence on a quiet machine is deliberate. A failure that reads "nobody
   * touched it" invites the reader to stop looking, and the point of this is to
   * send them to the right place rather than to reassure them.
   */
  it("names the timing when it was not", () => {
    const note = interferenceNote({ disturbed: true, secondsSinceInput: 1.2, elapsedSeconds: 5.4 });
    expect(note).toContain("1.2s ago");
    expect(note).toContain("5.4s");
  });
});
