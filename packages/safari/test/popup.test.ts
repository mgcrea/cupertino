import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * The toolbar popover, EXECUTED: what it says about the tab in front, and whom
 * it asks.
 *
 * It asks the tab's own content script with `tabs.sendMessage` and never the
 * background worker, because the case it exists for is the tab whose polls
 * stopped getting through when Safari stopped that worker (2026-11-20). The
 * view is a pure function of the page's answer and the clock, so it is tested
 * here without a DOM; the renderer only copies it into nodes with
 * `textContent`.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../apps/apple/CupertinoSafariExtension/Resources/popup.js", import.meta.url),
  ),
  "utf8",
);

type View = {
  version: string;
  host: string | null;
  state: "ready" | "connecting" | "stalled" | "not-here" | "no-tab";
  headline: string;
  detail: string | null;
  reload: boolean;
  network: null | { line: string; stop: boolean; clear: boolean };
  recent: string[];
};

const NOW = Date.parse("2026-11-20T08:42:00Z");

const pad = (n: number) => String(n).padStart(2, "0");
/** Local HH:MM, as the popover writes it. */
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type Tabs = {
  query?: (q: unknown) => Promise<unknown>;
  sendMessage?: (id: number, m: unknown) => Promise<unknown>;
  reload?: (id: number) => Promise<unknown>;
};

/** popup.js with no document, so nothing renders, and timers the test fires. */
const load = (tabs: Tabs = {}) => {
  const timers: Array<{ fn: () => void; delay: number; live: boolean }> = [];
  const runtimeSend = vi.fn(async () => undefined);
  const close = vi.fn();
  const context: Record<string, any> = {
    browser: {
      runtime: { getManifest: () => ({ version: "1.42.0" }), sendMessage: runtimeSend },
      tabs: {
        query: vi.fn(tabs.query ?? (async () => [{ id: 7 }])),
        sendMessage: vi.fn(tabs.sendMessage ?? (async () => ({ ok: true }))),
        reload: vi.fn(tabs.reload ?? (async () => undefined)),
      },
    },
    setTimeout: (fn: () => void, delay: number) => timers.push({ fn, delay, live: true }),
    clearTimeout: (id: number) => {
      const timer = timers[id - 1];
      if (timer) timer.live = false;
    },
    close,
  };
  context.window = context;
  createContext(context);
  runInContext(SOURCE, context);
  const elapse = (delay: number) => {
    for (const timer of timers) {
      if (!timer.live || timer.delay !== delay) continue;
      timer.live = false;
      timer.fn();
    }
  };
  return {
    context,
    tabs: context.browser.tabs,
    runtimeSend,
    close,
    elapse,
    view: (input: { answer?: unknown; error?: string | null; now?: number }) =>
      context.cupertinoPopupView({ answer: null, error: null, now: NOW, ...input }) as View,
    load: () => context.cupertinoPopupLoad() as Promise<View>,
    network: (op: string) => context.cupertinoPopupNetwork(op) as Promise<View>,
    reload: () => context.cupertinoPopupReload() as Promise<void>,
  };
};

const answer = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  host: "en.geneanet.org",
  page: "3f9a2c1d",
  extensionVersion: "1.42.0",
  startedAt: NOW - 600_000,
  lastPollOkAt: NOW - 1_000,
  failedPolls: 0,
  network: null,
  recent: [],
  ...extra,
});

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe("what the popover says about the tab in front", () => {
  it("is Ready within 15 s of a successful poll", () => {
    const v = load().view({ answer: answer({ lastPollOkAt: NOW - 15_000 }) });
    expect(v.state).toBe("ready");
    expect(v.headline).toBe("Agents can read and act on this page.");
    expect(v.reload).toBe(false);
    expect(v.host).toBe("en.geneanet.org");
    expect(v.version).toBe("1.42.0");
  });

  it("is Stalled past 15 s, with how long since the last check-in", () => {
    const v = load().view({ answer: answer({ lastPollOkAt: NOW - 120_000, failedPolls: 110 }) });
    expect(v.state).toBe("stalled");
    expect(v.headline.startsWith("This page can't reach Cupertino")).toBe(true);
    expect(v.detail).toContain("2 min ago");
    expect(v.reload).toBe(true);
  });

  it("says seconds under a minute", () => {
    const v = load().view({ answer: answer({ lastPollOkAt: NOW - 40_000 }) });
    expect(v.detail).toContain("40 s ago");
  });

  it("is Connecting before the first poll, then Stalled", () => {
    const p = load();
    const early = p.view({ answer: answer({ lastPollOkAt: null, startedAt: NOW - 5_000 }) });
    expect(early.state).toBe("connecting");
    expect(early.reload).toBe(false);

    const late = p.view({ answer: answer({ lastPollOkAt: null, startedAt: NOW - 15_000 }) });
    expect(late.state).toBe("stalled");
    expect(late.detail).toContain("never");
  });

  it("is Not here when the page did not answer, and names the three reasons", () => {
    const v = load().view({ error: "not-here" });
    expect(v.state).toBe("not-here");
    expect(v.reload).toBe(true);
    expect(v.detail).toContain("Settings");
    expect(v.detail).toContain("updated");
    expect(v.detail).toContain("no extensions");
    expect(v.network).toBeNull();
    expect(v.recent).toEqual([]);
  });

  it("is No tab with nothing to do", () => {
    const v = load().view({ error: "no-tab" });
    expect(v.state).toBe("no-tab");
    expect(v.headline).toBe("No page is open in this window.");
    expect(v.reload).toBe(false);
  });

  it("shows an armed recording with Stop and Clear", () => {
    const expiresAt = NOW + 16 * 60_000;
    const v = load().view({
      answer: answer({
        network: {
          recording: true,
          counts: { records: 33 },
          expiresAt: new Date(expiresAt).toISOString(),
        },
      }),
    });
    expect(v.network?.line).toContain("33 requests");
    expect(v.network?.line).toContain(`stops at ${hhmm(expiresAt)}`);
    expect(v.network?.stop).toBe(true);
    expect(v.network?.clear).toBe(true);
  });

  it("keeps a stopped recording with records, with Clear only", () => {
    const v = load().view({
      answer: answer({ network: { recording: false, counts: { records: 33 }, expiresAt: null } }),
    });
    expect(v.network).toEqual({ line: "Stopped · 33 requests kept", stop: false, clear: true });
  });

  it("hides the recording section when there is nothing recorded", () => {
    const v = load().view({
      answer: answer({ network: { recording: false, counts: { records: 0 }, expiresAt: null } }),
    });
    expect(v.network).toBeNull();
  });

  it("words each command as a verb, with its label, and marks failures", () => {
    const at = NOW - 180_000;
    const v = load().view({
      answer: answer({
        recent: [
          { at, action: "fill", ok: true, label: "Nom" },
          { at, action: "cookies", ok: true },
          { at, action: "netRecord", op: "start", ok: false },
          { at, action: "elements", ok: true },
        ],
      }),
    });
    expect(v.recent).toEqual([
      `${hhmm(at)} filled "Nom"`,
      `${hhmm(at)} read cookies`,
      `${hhmm(at)} started recording (failed)`,
      `${hhmm(at)} listed elements`,
    ]);
  });

  it("says how many times a repeated command ran", () => {
    const v = load().view({
      answer: answer({ recent: [{ at: NOW, action: "find", ok: true, times: 12 }] }),
    });
    expect(v.recent).toEqual([`${hhmm(NOW)} searched the page ×12`]);
  });

  it("never shows anything but verbs and labels", () => {
    const v = load().view({
      answer: answer({
        recent: [
          { at: NOW, action: "fill", ok: true, label: "Nom", text: "hunter2", url: "https://x" },
        ],
      }),
    });
    expect(v.recent.join(" ")).not.toContain("hunter2");
    expect(v.recent.join(" ")).not.toContain("https://x");
  });
});

describe("whom the popover asks", () => {
  // These go through `cupertinoPopupLoad`, which reads the real clock.
  const live = (extra: Record<string, unknown> = {}) =>
    answer({ lastPollOkAt: Date.now(), startedAt: Date.now() - 600_000, ...extra });

  it("asks the tab in front, not the background", async () => {
    const p = load({ sendMessage: async () => live() });
    const v = await p.load();
    expect(p.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(p.tabs.sendMessage).toHaveBeenCalledWith(7, { kind: "popupStatus" });
    expect(p.runtimeSend).not.toHaveBeenCalled();
    expect(v.state).toBe("ready");
  });

  it("gives a page 1.5 s and then says Not here", async () => {
    const p = load({ sendMessage: () => new Promise(() => {}) });
    const pending = p.load();
    await flush();
    p.elapse(1_500);
    expect((await pending).state).toBe("not-here");
  });

  it("says Not here when sendMessage rejects", async () => {
    const p = load({
      sendMessage: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
    });
    expect((await p.load()).state).toBe("not-here");
  });

  it("says Not here when the page answers something else", async () => {
    const p = load({ sendMessage: async () => undefined });
    expect((await p.load()).state).toBe("not-here");
  });

  it("says No tab when the window has none", async () => {
    const p = load({ query: async () => [] });
    expect((await p.load()).state).toBe("no-tab");
    expect(p.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("asks the page again after Stop, rather than redraw what it said when the popover opened", async () => {
    // The first answer is the page as it was when the popover opened; a Stop
    // twenty seconds later redrawn from it would call a healthy tab stalled.
    const statuses = [
      live({
        host: "a.example",
        network: { recording: true, counts: { records: 33 }, expiresAt: null },
      }),
      live({
        host: "b.example",
        network: { recording: false, counts: { records: 33 }, expiresAt: null },
      }),
    ];
    const p = load({
      sendMessage: async (_id, m) =>
        (m as { kind: string }).kind === "popupStatus"
          ? statuses.shift()
          : { ok: true, network: { recording: false, counts: { records: 33 }, expiresAt: null } },
    });
    await p.load();
    const v = await p.network("stop");
    expect(p.tabs.sendMessage).toHaveBeenCalledWith(7, { kind: "popupNetwork", op: "stop" });
    expect(p.tabs.sendMessage).toHaveBeenLastCalledWith(7, { kind: "popupStatus" });
    expect(v.host).toBe("b.example");
    expect(v.network).toEqual({ line: "Stopped · 33 requests kept", stop: false, clear: true });
    expect(v.state).toBe("ready");
  });

  it("shows Not here when the page has gone since the popover opened", async () => {
    let gone = false;
    const p = load({
      sendMessage: async () => {
        if (gone) throw new Error("Receiving end does not exist.");
        return live({ network: { recording: true, counts: { records: 3 }, expiresAt: null } });
      },
    });
    await p.load();
    gone = true;
    const v = await p.network("stop");
    expect(v.state).toBe("not-here");
    expect(v.network).toBeNull();
  });

  it("shows Not here rather than a blank popover when the answer cannot be read", async () => {
    const broken = live();
    Object.defineProperty(broken, "recent", {
      get: () => {
        throw new Error("unreadable");
      },
    });
    const p = load({ sendMessage: async () => broken });
    const v = (await p.context.cupertinoPopupShow()) as View;
    expect(v.state).toBe("not-here");
  });

  it("skips an entry in the list that is not one", () => {
    const v = load().view({
      answer: answer({ recent: [null, { at: NOW, action: "scroll", ok: true }] }),
    });
    expect(v.recent).toEqual([`${hhmm(NOW)} scrolled`]);
  });

  it("reloads the tab and closes", async () => {
    const p = load({ sendMessage: async () => live() });
    await p.load();
    await p.reload();
    expect(p.tabs.reload).toHaveBeenCalledWith(7);
    expect(p.close).toHaveBeenCalled();
  });
});
