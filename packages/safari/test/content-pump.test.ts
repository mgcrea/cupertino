import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The command pump's rescheduling, EXECUTED.
 *
 * `content.js` polls the background for commands. After a poll that returned
 * work the next poll must be immediate, or a multi-step flow (click, then
 * read) pays the full interval between steps. After an empty poll it must go
 * back to the interval. The file's capture block runs first and touches the
 * DOM, so it is given inert stubs; the timer stub records only the pump's own
 * reschedules, identified by `cupertinoPumpNow`, which is the same function.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../apps/apple/CupertinoSafariExtension/Resources/content.js", import.meta.url),
  ),
  "utf8",
);

// Enough microtask turns for a poll, its bounded wait and the reschedule.
/** A message Safari lost: its promise neither resolves nor rejects. */
const never = () => new Promise<never>(() => {});

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe("content.js pump", () => {
  it("re-polls immediately after a command, then returns to the interval", async () => {
    const polls: Array<{ commands: Array<{ id: string }> }> = [
      { commands: [{ id: "c1" }] },
      { commands: [] },
      { commands: [] },
    ];
    const delays: number[] = [];
    const ran: string[] = [];
    const context: Record<string, any> = {
      browser: {
        runtime: {
          getManifest: () => ({ version: "1.0.0" }),
          sendMessage: async (message: { kind: string }) =>
            message.kind === "poll" ? polls.shift() : undefined,
        },
      },
      setTimeout: (fn: unknown, delay: number) => {
        if (fn === context.cupertinoPumpNow) delays.push(delay);
        return 0;
      },
      clearTimeout: () => {},
      addEventListener: () => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      document: {
        hidden: false,
        title: "",
        documentElement: { outerHTML: "" },
      },
      history: { pushState: () => {} },
      location: { href: "https://app.example.com/" },
      cupertinoRunCommand: (command: { id: string }) => {
        ran.push(command.id);
        return { ok: true };
      },
    };
    context.window = context;
    createContext(context);
    runInContext(SOURCE, context);
    await flush();
    expect(ran).toEqual(["c1"]);
    expect(delays).toEqual([0]);

    context.cupertinoPumpNow();
    await flush();
    expect(delays).toEqual([0, 1000]);
  });

  /**
   * Each poll names the page's origin, as the page itself computes it. The
   * native handler stamps a heartbeat per origin from it, and the server matches
   * a URL to it with `new URL(url).origin` — so the browser's own serialization,
   * not one rebuilt in Swift, is what keeps the two sides agreeing on default
   * ports, IPv6 hosts and punycode.
   */
  it("sends the page's origin with every poll", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const context: Record<string, any> = {
      browser: {
        runtime: {
          getManifest: () => ({ version: "1.0.0" }),
          sendMessage: async (message: Record<string, unknown>) => {
            sent.push(message);
            return message.kind === "poll" ? { commands: [] } : undefined;
          },
        },
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: () => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      document: { hidden: false, title: "", documentElement: { outerHTML: "" } },
      history: { pushState: () => {} },
      location: { href: "https://gallica.bnf.fr:443/SRU?x=1", origin: "https://gallica.bnf.fr" },
    };
    context.window = context;
    createContext(context);
    runInContext(SOURCE, context);
    await flush();
    const poll = sent.find((m) => m.kind === "poll");
    expect(poll?.origin).toBe("https://gallica.bnf.fr");
  });

  /**
   * Back/forward cache. Leaving a page fires `pagehide`, which stops the pump;
   * coming back to it from the cache fires `pageshow` with `persisted` and
   * restores the same page, script state and all. A pump left stopped then
   * answers no command again, and every command to the tab times out as if the
   * page had gone. The timer the stopped pump had scheduled is frozen with the
   * page and may fire after the restore, so a restart must not start a second
   * loop beside it.
   */
  const bfcachePage = () => {
    let polls = 0;
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    const context: Record<string, any> = {
      browser: {
        runtime: {
          getManifest: () => ({ version: "1.0.0" }),
          sendMessage: async (message: { kind: string }) => {
            if (message.kind === "poll") polls += 1;
            return { commands: [] };
          },
        },
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (listeners[type] ??= []).push(listener);
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      document: { hidden: false, title: "", documentElement: { outerHTML: "" } },
      history: { pushState: () => {} },
      location: { href: "https://app.example.com/", origin: "https://app.example.com" },
    };
    context.window = context;
    createContext(context);
    runInContext(SOURCE, context);
    const fire = (type: string, event: unknown = {}) => {
      for (const listener of listeners[type] ?? []) listener(event);
    };
    /** What the pump's scheduled timer does when it fires: call the pump. */
    const timerFires = () => context.cupertinoPumpNow();
    return { polls: () => polls, fire, timerFires };
  };

  it("polls again when the page comes back from the back/forward cache", async () => {
    const page = bfcachePage();
    await flush();
    expect(page.polls()).toBe(1);

    page.fire("pagehide", { persisted: true });
    page.timerFires();
    await flush();
    expect(page.polls()).toBe(1);

    page.fire("pageshow", { persisted: true });
    await flush();
    expect(page.polls()).toBe(2);
  });

  it("starts no second loop when the stopped pump's timer is still pending at the restore", async () => {
    const page = bfcachePage();
    await flush();

    page.fire("pagehide", { persisted: true });
    page.fire("pageshow", { persisted: true });
    await flush();
    expect(page.polls()).toBe(1);

    page.timerFires();
    await flush();
    expect(page.polls()).toBe(2);
  });

  it("ignores the pageshow of a first load", async () => {
    const page = bfcachePage();
    await flush();
    page.fire("pageshow", { persisted: false });
    await flush();
    expect(page.polls()).toBe(1);
  });
});

/**
 * A message that never settles. Safari can lose a content script's
 * `sendMessage` when the background worker is terminated or starting at the
 * wrong moment, and the promise then neither resolves nor rejects. Measured
 * 2026-11-07: polling stopped for up to 1 h 43 min with the page visible, and
 * came back only when Safari restarted the worker or the page reloaded. An
 * unbounded await there stops the tab's loop for good, so every wait on the
 * background is bounded, and a wait that runs out counts as a failed poll.
 */
describe("content.js pump, when a message never settles", () => {
  type Timer = { fn: () => void; delay: number; cleared: boolean };

  /**
   * `reply` answers each message; `poll` numbers the pump's polls from 1, and
   * is 0 for anything else. The capture block also sends and sets its own
   * settle timers at load, so only timers set from the first poll on are the
   * pump's waits.
   */
  const hangingPage = (reply: (message: { kind: string }, poll: number) => Promise<unknown>) => {
    const timers: Timer[] = [];
    const sent: Array<{ kind: string }> = [];
    const ran: string[] = [];
    let firstPollTimer = -1;
    let pollCount = 0;
    const context: Record<string, any> = {
      browser: {
        runtime: {
          getManifest: () => ({ version: "1.0.0" }),
          sendMessage: (message: { kind: string }) => {
            sent.push(message);
            if (message.kind !== "poll") return reply(message, 0);
            pollCount += 1;
            if (firstPollTimer < 0) firstPollTimer = timers.length;
            return reply(message, pollCount);
          },
        },
      },
      setTimeout: (fn: () => void, delay: number) => {
        timers.push({ fn, delay, cleared: false });
        return timers.length;
      },
      clearTimeout: (id: number) => {
        const timer = timers[id - 1];
        if (timer) timer.cleared = true;
      },
      addEventListener: () => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      document: { hidden: false, title: "", documentElement: { outerHTML: "" } },
      history: { pushState: () => {} },
      location: { href: "https://app.example.com/", origin: "https://app.example.com" },
      cupertinoRunCommand: (command: { id: string }) => {
        ran.push(command.id);
        return { ok: true };
      },
    };
    context.window = context;
    createContext(context);
    runInContext(SOURCE, context);
    const isWait = (timer: Timer, index: number) =>
      !timer.cleared &&
      firstPollTimer >= 0 &&
      index >= firstPollTimer &&
      timer.fn !== context.cupertinoPumpNow;
    /** Run out every wait the pump has pending. */
    const expireWaits = () => {
      timers.forEach((timer, index) => {
        if (!isWait(timer, index)) return;
        timer.cleared = true;
        timer.fn();
      });
    };
    const waits = () => timers.filter(isWait).length;
    const pumpDelays = () =>
      timers.filter((t) => !t.cleared && t.fn === context.cupertinoPumpNow).map((t) => t.delay);
    const polls = () => pollCount;
    return { context, expireWaits, pumpDelays, polls, ran, sent, waits };
  };

  it("polls again after a poll that never settles", async () => {
    const page = hangingPage((_message, poll) =>
      poll === 1 ? never() : Promise.resolve({ commands: [] }),
    );
    await flush();
    expect(page.polls()).toBe(1);
    expect(page.pumpDelays()).toEqual([]);

    page.expireWaits();
    await flush();
    expect(page.pumpDelays()).toEqual([1000]);

    page.context.cupertinoPumpNow();
    await flush();
    expect(page.polls()).toBe(2);
  });

  it("never runs the commands of a reply that came after its wait ran out", async () => {
    const late: { resolve?: (value: unknown) => void } = {};
    const page = hangingPage((_message, poll) =>
      poll === 1
        ? new Promise((resolve) => {
            late.resolve = resolve;
          })
        : Promise.resolve({ commands: [] }),
    );
    await flush();
    page.expireWaits();
    await flush();

    late.resolve?.({ commands: [{ id: "c-late" }] });
    await flush();
    expect(page.ran).toEqual([]);
    expect(page.sent.filter((m) => m.kind === "result")).toEqual([]);
  });

  it("keeps polling when filing a result never settles", async () => {
    const page = hangingPage((message) =>
      message.kind === "poll"
        ? Promise.resolve({ commands: [{ id: "c1" }] })
        : message.kind === "result"
          ? never()
          : Promise.resolve(undefined),
    );
    await flush();
    expect(page.ran).toEqual(["c1"]);
    expect(page.pumpDelays()).toEqual([]);

    page.expireWaits();
    await flush();
    // The poll carried work, so the next one is immediate, as after any command.
    expect(page.pumpDelays()).toEqual([0]);
  });

  it("still runs the next command when filing a result never settles", async () => {
    const page = hangingPage((message) =>
      message.kind === "poll"
        ? Promise.resolve({ commands: [{ id: "c1" }, { id: "c2" }] })
        : message.kind === "result"
          ? never()
          : Promise.resolve(undefined),
    );
    await flush();
    expect(page.ran).toEqual(["c1"]);
    page.expireWaits();
    await flush();
    expect(page.ran).toEqual(["c1", "c2"]);
  });

  it("clears the wait's timer once the reply is in", async () => {
    const page = hangingPage(() => Promise.resolve({ commands: [] }));
    await flush();
    expect(page.pumpDelays()).toEqual([1000]);
    // Only the pump's reschedule is left: no timeout piles up per poll.
    expect(page.waits()).toBe(0);
  });
});
