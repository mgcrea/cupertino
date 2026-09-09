import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailAxLane } from "../src/client/ax.js";
import { replyOrForwardNatively, type Clipboard } from "../src/client/compose.js";
import { SENT_SINCE } from "../src/client/jxa/read.js";

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
        // A dead element handle is not a value the driver returns, it is a
        // REFUSAL — `Failure.staleHandle`, "Element 'e7' no longer exists". A
        // stub that can only answer with documents cannot reach the paths that
        // matter most here, because every one of them is downstream of a throw.
        socket.write(
          `${JSON.stringify(
            body !== null && typeof body === "object" && "refusal" in body
              ? { jsonrpc: "2.0", id: message.id, error: { message: (body as never)["refusal"] } }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { content: [{ type: "text", text: JSON.stringify(body) }] },
                },
          )}\n`,
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

/**
 * A runner that answers the Sent check too.
 *
 * `replyOrForwardNatively` reaches Apple Events twice now: once to open the
 * composer, and once more — only when the composer has GONE — to ask whether
 * what was in it went out.
 */
const runnerWithSent = (subject: string, sent: Record<string, unknown>) =>
  ({
    run: async (s: string) => (s === SENT_SINCE ? sent : { subject }),
  }) as never;

/** Present while the body is pasted, gone by the time anything is read back. */
const composerThatVanishes = (over: Record<string, unknown> = {}) =>
  healthyHost({
    // Found, raised and focused; gone from the window list once the paste has
    // been posted — which is what a person pressing command-shift-D looks like.
    // Calls 1 and 2 are the pre-flight reach and findComposer; the third is the
    // presence check in the failure branch.
    list_windows: (_a: unknown, n: number) =>
      n > 2
        ? { windows: [{ handle: "w1", index: 0, title: "All Sent" }] }
        : { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
    // The handle died with the window.
    expand: (_a: unknown, n: number) =>
      n === 1 ? { elements: [], matched: 40 } : { refusal: "Element 'e7' no longer exists" },
    ...over,
  });

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
   * The incident this path was rebuilt around, 2026-09-09.
   *
   * A reply was composed correctly and sent by hand while the call was still
   * running. The composer closed, its element handle died with it, and every
   * read after that came back as a refusal — which the lane reported as -1 and
   * the caller compared as a count. The tool said the body had not gone in and
   * warned against a retry on the grounds that it would paste twice. All of it
   * was wrong, and the one true sentence — the composer is gone, so someone
   * took it — was never said.
   */
  it("reports a composer that vanished mid-paste as gone, not as a body that failed", async () => {
    const { lane } = await laneOver(composerThatVanishes());
    const result = await replyOrForwardNatively(
      lane,
      runnerWithSent("Re: lunch", { checked: true, mailbox: "Sent", found: false, scanned: 25 }),
      PARAMS,
      { clipboard: fakeClipboard(), sendTimeoutMs: 50, composerTimeoutMs: 50 },
    );
    expect(result.note).toContain("is GONE");
    // The two claims that sent the last investigation the wrong way.
    expect(result.note).not.toContain("the body did not go in");
    expect(result.note).not.toContain("paste the reply in twice");
    // Unknown, NOT false: nothing here established that the body was wrong.
    expect(result.bodyVerified).toBeNull();
    lane.close();
  });

  /*
   * Sent and discarded leave exactly the same empty screen, and only Mail can
   * tell them apart. Getting it wrong either way is expensive: a sent reply
   * called a failure invites a retry that sends it twice.
   */
  it("says the reply went when Sent holds it, and does not invite a retry", async () => {
    const { lane } = await laneOver(composerThatVanishes());
    const result = await replyOrForwardNatively(
      lane,
      runnerWithSent("Re: lunch", {
        checked: true,
        mailbox: "Sent Items",
        found: true,
        scanned: 25,
        messages: [{ dateSent: "2026-09-09T20:56:54.000Z" }],
      }),
      PARAMS,
      { clipboard: fakeClipboard(), sendTimeoutMs: 50, composerTimeoutMs: 50 },
    );
    expect(result.sent).toBe(true);
    expect(result.note).toContain("WAS SENT");
    expect(result.note).toContain("2026-09-09T20:56:54.000Z");
    expect(result.note).toContain("Do NOT send it again");
    lane.close();
  });

  /*
   * `found: false` is only evidence if the listing was showing recent mail at
   * all. A newest older than the call means it never did, and "not sent" would
   * be a false negative on the dangerous side.
   */
  it("refuses to call it unsent when Sent's newest entry predates the call", async () => {
    const { lane } = await laneOver(composerThatVanishes());
    const result = await replyOrForwardNatively(
      lane,
      runnerWithSent("Re: lunch", {
        checked: true,
        mailbox: "Sent",
        found: false,
        scanned: 25,
        newest: "2019-01-01T00:00:00.000Z",
      }),
      PARAMS,
      { clipboard: fakeClipboard(), sendTimeoutMs: 50, composerTimeoutMs: 50 },
    );
    expect(result.sent).toBeNull();
    expect(result.note).toContain("could NOT be told");
    lane.close();
  });

  /*
   * The same vanishing, one step later: the body verified, and the window gone
   * before the send. Nothing may be pressed into an unknown foreground.
   */
  it("does not press send into whatever replaced a composer that went", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({ raise_window: (_a: unknown, n: number) => (n > 1 ? { refusal: "gone" } : {}) }),
    );
    const result = await replyOrForwardNatively(
      lane,
      runnerWithSent("Re: lunch", { checked: true, mailbox: "Sent", found: false, scanned: 25 }),
      PARAMS,
      { clipboard: fakeClipboard(), sendTimeoutMs: 50, composerTimeoutMs: 50 },
    );
    expect(result.note).toContain("is GONE");
    expect(seen.filter((c) => c.tool === "key" && c.args["key"] === "d")).toEqual([]);
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
