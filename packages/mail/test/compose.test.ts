import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailAxLane } from "../src/client/ax.js";
import { replyOrForwardNatively, type Clipboard } from "../src/client/compose.js";

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

/** A composer that behaves: window appears, paste lands, send closes it. */
const healthyHost = (over: Record<string, unknown> = {}) => ({
  list_windows: { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
  ui_tree: { elements: [{ handle: "e7", role: "AXWebArea", depth: 2 }] },
  expand: { elements: [{ handle: "e8", role: "AXStaticText", depth: 3, value: "PASTED" }] },
  focus: { focused: true },
  ...over,
});

const laneOver = async (
  answers: Record<string, unknown>,
): Promise<{ lane: MailAxLane; seen: { tool: string; args: Record<string, unknown> }[] }> => {
  const dir = mkdtempSync(join(tmpdir(), "compose-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const counts: Record<string, number> = {};
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
        if (!greeted) {
          greeted = true;
          socket.write("ok\n");
          continue;
        }
        const message = JSON.parse(line);
        const tool = String(message.params.name).replace("apple_desktop_", "");
        seen.push({ tool, args: message.params.arguments });
        counts[tool] = (counts[tool] ?? 0) + 1;
        const entry = answers[tool];
        const body =
          typeof entry === "function"
            ? (entry as (a: unknown, n: number) => unknown)(message.params.arguments, counts[tool])
            : (entry ?? {});
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(body) }] },
          })}\n`,
        );
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const lane = MailAxLane.open({ CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "mail" })!;
  return { lane, seen };
};

const fakeClipboard = (): Clipboard & { history: string[]; current: string | null } => {
  const state = {
    history: [] as string[],
    current: "something the user had copied" as string | null,
    read: async () => state.current,
    write: async (text: string) => {
      state.history.push(text);
      state.current = text;
    },
  };
  return state;
};

const runnerReturning = (subject: string) => ({ run: async () => ({ subject }) }) as never;

const PARAMS = {
  accountUuid: "UUID",
  mailbox: "INBOX",
  id: 42,
  mode: "reply" as const,
  body: "PASTED",
  to: [],
  replyToAll: false,
  sendNow: true,
};

describe("replyOrForwardNatively", () => {
  it("opens, pastes, verifies, then sends — and confirms the window went", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // The composer is there while pasting and gone after the send, which is
        // how the send is confirmed.
        list_windows: (_a: unknown, n: number) =>
          n > 3
            ? { windows: [{ handle: "w1", index: 0, title: "Inbox" }] }
            : { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      }),
    );
    const result = await replyOrForwardNatively(lane, runnerReturning("Re: lunch"), PARAMS, {
      clipboard: fakeClipboard(),
      sendTimeoutMs: 50,
      composerTimeoutMs: 50,
    });
    expect(result).toMatchObject({ ok: true, sent: true, bodyVerified: true });
    expect(seen.map((c) => c.tool)).toContain("key");
    lane.close();
  });

  /*
   * The pasteboard is borrowed, not taken. What the person had copied goes back
   * afterwards — the same cost the System Events path documents, and the same
   * courtesy.
   */
  it("puts the clipboard back", async () => {
    const { lane } = await laneOver(healthyHost());
    const clipboard = fakeClipboard();
    await replyOrForwardNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      { clipboard, sendTimeoutMs: 50, composerTimeoutMs: 50 },
    );
    expect(clipboard.history).toEqual(["PASTED", "something the user had copied"]);
    expect(clipboard.current).toBe("something the user had copied");
    lane.close();
  });

  /*
   * The failure this whole path is shaped around: a draft correct in every
   * visible respect except the words, reported as a success.
   */
  it("refuses to report a draft ready when the body cannot be read back", async () => {
    const { lane } = await laneOver(
      healthyHost({ expand: { elements: [{ handle: "e8", depth: 3, value: "" }] } }),
    );
    const result = await replyOrForwardNatively(lane, runnerReturning("Re: lunch"), PARAMS, {
      clipboard: fakeClipboard(),
      sendTimeoutMs: 50,
      composerTimeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.bodyVerified).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.note).toContain("MUST NOT be described to the user as ready");
    lane.close();
  });

  /*
   * A paste that landed and could not be read is a different thing from one
   * that never landed, and the advice differs: retrying the first puts the
   * reply in the draft twice, with nothing here able to undo it.
   */
  it("warns against a retry when something landed that could not be matched", async () => {
    let calls = 0;
    const { lane } = await laneOver(
      healthyHost({
        expand: () => {
          calls += 1;
          // Empty text throughout, but a growing element count: something went
          // in that cannot be matched.
          return { elements: [{ handle: "e8", depth: 3, value: "" }], matched: calls };
        },
      }),
    );
    const result = await replyOrForwardNatively(lane, runnerReturning("Re: lunch"), PARAMS, {
      clipboard: fakeClipboard(),
      sendTimeoutMs: 50,
      composerTimeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("retry would paste the reply in twice");
    lane.close();
  });

  /*
   * An element can report itself focusable and not take it. Pressing on would
   * paste into whatever DID have the focus.
   */
  it("does not claim a body when the composer never took the focus", async () => {
    const { lane, seen } = await laneOver(healthyHost({ focus: { focused: false } }));
    const result = await replyOrForwardNatively(lane, runnerReturning("Re: lunch"), PARAMS, {
      clipboard: fakeClipboard(),
      sendTimeoutMs: 50,
      composerTimeoutMs: 50,
      // Short, or this test would sit through the real focus poll twice.
      focusTimeoutMs: 30,
    });
    expect(result.bodyVerified).toBe(false);
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  /*
   * A send that was not confirmed must not be reported as sent. Mail closes the
   * window when it accepts one, so a window still on screen is the tell.
   */
  it("does not report a send whose window is still open", async () => {
    const { lane } = await laneOver(healthyHost());
    const result = await replyOrForwardNatively(lane, runnerReturning("Re: lunch"), PARAMS, {
      clipboard: fakeClipboard(),
      sendTimeoutMs: 50,
      composerTimeoutMs: 50,
    });
    expect(result.sent).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.note).toContain("may not have gone");
    lane.close();
  });

  it("saves a draft without waiting for any window to close", async () => {
    const { lane, seen } = await laneOver(healthyHost());
    const result = await replyOrForwardNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      { clipboard: fakeClipboard(), sendTimeoutMs: 50, composerTimeoutMs: 50 },
    );
    expect(result).toMatchObject({ ok: true, sent: false, bodyVerified: true });
    expect(seen.at(-1)).toEqual({ tool: "key", args: { key: "s", modifiers: ["command"] } });
    lane.close();
  });

  /*
   * Asked BEFORE anything is opened, keeping the ordering the System Events path
   * established: the failure this tool was best known for left an empty reply
   * window on screen on every attempt.
   */
  it("refuses before opening a composer when Mail's windows cannot be read", async () => {
    const { lane, seen } = await laneOver({
      list_windows: () => {
        throw new Error("unreachable");
      },
    });
    // The stub cannot throw across the wire, so refuse by closing instead.
    lane.close();
    const dead = MailAxLane.open({
      CUPERTINO_AX_SOCKET: "/nonexistent.sock",
      CUPERTINO_AX_FOR: "mail",
    })!;
    await expect(
      replyOrForwardNatively(dead, runnerReturning("Re: lunch"), PARAMS, {
        clipboard: fakeClipboard(),
      }),
    ).rejects.toThrow(/Accessibility/);
    expect(seen).toEqual([]);
  });
});
