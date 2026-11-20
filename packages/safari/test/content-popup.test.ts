import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * What the content script tells the toolbar popover, EXECUTED.
 *
 * The popover exists for the tab whose polls stopped getting through: on
 * 2026-11-20 Safari stopped the extension's background worker and every page
 * command timed out while the tab sat open in front. So the popover asks the
 * page itself, through `tabs.sendMessage`, which does not go through that
 * worker, and the page answers from its own bookkeeping: when a poll last came
 * back, how many failed since, and when the pump started.
 *
 * It answers the extension's own popover and nothing else. A message from
 * another extension, or from anything in a tab, could otherwise stop a
 * recording or read the list of what agents did.
 */

const resource = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../apps/apple/CupertinoSafariExtension/Resources/${name}`, import.meta.url),
    ),
    "utf8",
  );
const CONTENT = resource("content.js");
const ACTIONS = resource("actions.js");

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const POPOVER = { id: "ext" };

type Listener = (message: unknown, sender: unknown) => unknown;

/**
 * content.js in a stub page. `replies` answers each poll in turn; a function
 * there is called for its promise, so a test can hand back one that never
 * settles. `actions: true` loads the real actions.js first, as the manifest
 * does, for the ring.
 */
const page = (
  opts: {
    replies?: Array<unknown | (() => Promise<unknown>)>;
    network?: { run: (command: Record<string, unknown>) => unknown } | null;
    actions?: boolean;
  } = {},
) => {
  const replies = [...(opts.replies ?? [])];
  const timers: Array<{ fn: () => void; delay: number; live: boolean }> = [];
  const listeners: Listener[] = [];
  const pageListeners: Record<string, Array<(event: unknown) => void>> = {};
  const context: Record<string, any> = {
    crypto: webcrypto,
    browser: {
      runtime: {
        id: "ext",
        getManifest: () => ({ version: "1.42.0" }),
        sendMessage: (message: { kind: string }) => {
          if (message.kind !== "poll") return Promise.resolve(undefined);
          const next = replies.shift();
          return typeof next === "function"
            ? (next as () => Promise<unknown>)()
            : Promise.resolve(next);
        },
        onMessage: { addListener: (fn: Listener) => void listeners.push(fn) },
      },
    },
    setTimeout: (fn: () => void, delay: number) => timers.push({ fn, delay, live: true }),
    clearTimeout: (id: number) => {
      const timer = timers[id - 1];
      if (timer) timer.live = false;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (pageListeners[type] ??= []).push(listener);
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      hidden: false,
      title: "",
      documentElement: { outerHTML: "" },
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    history: { pushState: () => {} },
    location: {
      href: "https://en.geneanet.org/fonds/individus/",
      host: "en.geneanet.org",
      origin: "https://en.geneanet.org",
    },
    innerHeight: 800,
    innerWidth: 1200,
  };
  if (opts.network) context.cupertinoNetwork = opts.network;
  context.window = context;
  createContext(context);
  if (opts.actions) runInContext(ACTIONS, context);
  runInContext(CONTENT, context);
  const ask = (message: unknown, sender: unknown = POPOVER) => {
    expect(listeners).toHaveLength(1);
    return Promise.resolve(listeners[0]!(message, sender));
  };
  /** Run out every live timer of exactly this delay, as time passing would. */
  const elapse = (delay: number) => {
    for (const timer of timers) {
      if (!timer.live || timer.delay !== delay) continue;
      timer.live = false;
      timer.fn();
    }
  };
  const fire = (type: string, event: unknown = {}) => {
    for (const listener of pageListeners[type] ?? []) listener(event);
  };
  return { context, ask, elapse, fire, pumpNow: () => context.cupertinoPumpNow() };
};

type Status = {
  ok: boolean;
  host: string;
  page: string | null;
  extensionVersion: string | null;
  startedAt: number;
  lastPollOkAt: number | null;
  failedPolls: number;
  network: unknown;
  recent: Array<Record<string, unknown>>;
};

const status = async (p: ReturnType<typeof page>) =>
  (await p.ask({ kind: "popupStatus" })) as Status;

describe("what the page tells the popover", () => {
  it("counts a poll that came back with a reply as a successful check-in", async () => {
    const p = page({ replies: [{ commands: [] }] });
    await flush();

    const s = await status(p);
    expect(s.ok).toBe(true);
    expect(s.host).toBe("en.geneanet.org");
    expect(s.extensionVersion).toBe("1.42.0");
    expect(typeof s.lastPollOkAt).toBe("number");
    expect(s.failedPolls).toBe(0);
    expect(s.startedAt).toBeLessThanOrEqual(s.lastPollOkAt!);
  });

  it("does not count a poll the background answered with nothing", async () => {
    const p = page({ replies: [undefined, undefined] });
    await flush();
    p.pumpNow();
    await flush();

    const s = await status(p);
    expect(s.lastPollOkAt).toBeNull();
    expect(s.failedPolls).toBe(2);
    expect(typeof s.startedAt).toBe("number");
  });

  it("does not count a poll whose message was lost", async () => {
    const p = page({ replies: [() => new Promise(() => {})] });
    await flush();
    p.elapse(10_000);
    await flush();

    const s = await status(p);
    expect(s.lastPollOkAt).toBeNull();
    expect(s.failedPolls).toBe(1);
  });

  it("starts counting failures again after a poll that worked", async () => {
    const p = page({ replies: [undefined, { commands: [] }] });
    await flush();
    p.pumpNow();
    await flush();

    expect((await status(p)).failedPolls).toBe(0);
  });

  it("starts its check-ins over when the page comes back from the back/forward cache", async () => {
    // The restored page's first poll may wait on a cold worker; until it comes
    // back it is connecting, not stalled since before the person left.
    const p = page({ replies: [{ commands: [] }, () => new Promise(() => {})] });
    await flush();
    const before = await status(p);
    expect(before.lastPollOkAt).not.toBeNull();

    p.fire("pagehide", { persisted: true });
    p.fire("pageshow", { persisted: true });
    await flush();

    const after = await status(p);
    expect(after.lastPollOkAt).toBeNull();
    expect(after.failedPolls).toBe(0);
    expect(after.startedAt).toBeGreaterThanOrEqual(before.lastPollOkAt!);
  });

  it("adds the background's cookie notes to the page's list", async () => {
    const p = page({
      actions: true,
      replies: [{ commands: [], ran: [{ action: "cookies", ok: true }] }],
    });
    await flush();

    const s = await status(p);
    expect(s.recent[0]).toMatchObject({ action: "cookies", ok: true });
  });

  it("reports the recording through the recorder's own status", async () => {
    const run = vi.fn((command: Record<string, unknown>) =>
      command.op === "status" ? { ok: true, data: { recording: true } } : { ok: false },
    );
    const p = page({ network: { run } });

    expect((await status(p)).network).toEqual({ recording: true });
    expect(run).toHaveBeenCalledWith({ action: "netRecord", op: "status" });
  });

  it("stops and clears the recording for the popover", async () => {
    const run = vi.fn((command: Record<string, unknown>) => ({
      ok: true,
      data: { recording: false, op: command.op },
    }));
    const p = page({ network: { run } });

    expect(await p.ask({ kind: "popupNetwork", op: "stop" })).toEqual({
      ok: true,
      network: { recording: false, op: "stop" },
    });
    expect(await p.ask({ kind: "popupNetwork", op: "clear" })).toEqual({
      ok: true,
      network: { recording: false, op: "clear" },
    });
    expect(run).toHaveBeenCalledWith({ action: "netRecord", op: "stop" });
  });

  it("refuses any other op on the recording", async () => {
    const run = vi.fn(() => ({ ok: true, data: {} }));
    const p = page({ network: { run } });

    const answer = (await p.ask({ kind: "popupNetwork", op: "start" })) as { ok: boolean };
    expect(answer.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("answers network null, and refuses to stop, when the recorder did not load", async () => {
    const p = page({ network: null });

    expect((await status(p)).network).toBeNull();
    const answer = (await p.ask({ kind: "popupNetwork", op: "stop" })) as {
      ok: boolean;
      error?: string;
    };
    expect(answer.ok).toBe(false);
    expect(typeof answer.error).toBe("string");
  });

  it("answers no one but the extension's own popover", async () => {
    const run = vi.fn(() => ({ ok: true, data: {} }));
    const p = page({ network: { run } });

    for (const sender of [{ id: "other" }, { id: "ext", tab: { id: 1 } }, null]) {
      expect(await p.ask({ kind: "popupStatus" }, sender)).toBeUndefined();
      expect(await p.ask({ kind: "popupNetwork", op: "stop" }, sender)).toBeUndefined();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves every other message alone", async () => {
    const p = page();

    expect(await p.ask({ kind: "poll" })).toBeUndefined();
    expect(await p.ask(null)).toBeUndefined();
  });

  it("does not list the person's own Stop as something an agent did", async () => {
    const p = page({ actions: true, network: { run: () => ({ ok: true, data: {} }) } });
    const before = (await status(p)).recent.length;

    await p.ask({ kind: "popupNetwork", op: "stop" });

    expect((await status(p)).recent).toHaveLength(before);
  });
});
