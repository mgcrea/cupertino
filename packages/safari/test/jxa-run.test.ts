import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { LIVE_TABS } from "../src/client/jxa/tabs.js";
import { CLOSE_TABS } from "../src/client/jxa/writes.js";

/**
 * The tab scripts RUN, against a fake Safari, rather than only being searched.
 *
 * `jxa.test.ts` checks what the scripts contain; that cannot catch an
 * off-by-one in a position or a guard whose `continue` went missing, and
 * either would close the wrong tab. So these execute the script text in a VM
 * with an `Application` that models what JXA does: `tabs()` hands back
 * specifiers by position, resolved again when a command is sent, so a tab that
 * slides into a freed position is the one a stale specifier now names.
 *
 * What it does NOT model is Safari itself — Tab Groups, tabs that throw while
 * loading in ways not listed here. That is the live check docs/safari.md owes.
 */

type FakeTab = { url: string | null; throws?: boolean; title?: string | null };
type FakeWindow = { id: number; tabs: FakeTab[]; tabsThrow?: boolean };

const fakeSafari = (windows: FakeWindow[], opts: { running?: boolean } = {}) => {
  const closed: string[] = [];
  const tabSpecifier = (w: FakeWindow, i: number) => ({
    url: () => {
      const t = w.tabs[i];
      if (!t || t.throws) throw new Error("Can't get tab.");
      return t.url;
    },
    name: () => {
      const t = w.tabs[i];
      if (!t || t.throws) throw new Error("Can't get tab.");
      return t.title === undefined ? "Title" : t.title;
    },
    index: () => i + 1,
    close: () => {
      const [gone] = w.tabs.splice(i, 1);
      closed.push(gone?.url ?? "?");
      if (w.tabs.length === 0) windows.splice(windows.indexOf(w), 1);
    },
  });
  const windowSpecifier = (w: FakeWindow) => ({
    id: () => w.id,
    index: () => windows.indexOf(w) + 1,
    tabs: () => {
      if (w.tabsThrow) throw new Error("Can't get tabs.");
      return w.tabs.map((_, i) => tabSpecifier(w, i));
    },
    currentTab: () => tabSpecifier(w, 0),
  });
  const list = Object.assign(() => windows.map(windowSpecifier), {
    byId: (id: number) => {
      const w = windows.find((x) => x.id === id);
      if (!w)
        return {
          id: () => {
            throw new Error("Can't get window.");
          },
        };
      return windowSpecifier(w);
    },
  });
  Object.defineProperty(list, "length", { get: () => windows.length });
  const app = { running: () => opts.running ?? true, frontmost: () => false, windows: list };
  return { app, closed, windows };
};

const run = (source: string, app: unknown, params: unknown = {}) =>
  JSON.parse(
    runInNewContext(`${source}\nrun([${JSON.stringify(JSON.stringify(params))}]);`, {
      Application: () => app,
    }) as string,
  ) as { ok: boolean; data: never };

describe("CLOSE_TABS, run", () => {
  it("closes the tab at the position it was sent, and only that one", () => {
    const s = fakeSafari([{ id: 7, tabs: [{ url: "https://a/" }, { url: "https://b/" }] }]);
    const r = run(CLOSE_TABS, s.app, {
      targets: [{ id: "x", windowId: 7, index: 2, url: "https://b/" }],
    });
    expect(r.data).toEqual({
      running: true,
      results: [{ id: "x", outcome: "closed", windowClosed: false }],
    });
    expect(s.closed).toEqual(["https://b/"]);
  });

  it("skips a tab that no longer shows the URL it was sent", () => {
    const s = fakeSafari([{ id: 7, tabs: [{ url: "https://a/" }, { url: "https://moved/" }] }]);
    const r = run(CLOSE_TABS, s.app, {
      targets: [{ id: "x", windowId: 7, index: 2, url: "https://b/" }],
    });
    expect(r.data).toMatchObject({ results: [{ id: "x", outcome: "stale" }] });
    expect(s.closed).toEqual([]);
  });

  it("skips a target whose window has gone, even when another window has that position", () => {
    const s = fakeSafari([{ id: 9, tabs: [{ url: "https://b/" }] }]);
    const r = run(CLOSE_TABS, s.app, {
      targets: [{ id: "x", windowId: 7, index: 1, url: "https://b/" }],
    });
    expect(r.data).toMatchObject({ results: [{ id: "x", outcome: "stale" }] });
    expect(s.closed).toEqual([]);
  });

  /**
   * Why the server sends targets rightmost first. Sent left to right, the
   * first close slides the next tab down into a position the second target no
   * longer names — and the URL check is the only thing that stops it.
   */
  it("closes two tabs in one window when sent rightmost first", () => {
    const tabs = [{ url: "https://a/" }, { url: "https://b/" }, { url: "https://c/" }];
    const s = fakeSafari([{ id: 7, tabs }]);
    run(CLOSE_TABS, s.app, {
      targets: [
        { id: "c", windowId: 7, index: 3, url: "https://c/" },
        { id: "a", windowId: 7, index: 1, url: "https://a/" },
      ],
    });
    expect(s.closed).toEqual(["https://c/", "https://a/"]);
    expect(s.windows[0]?.tabs).toEqual([{ url: "https://b/" }]);
  });

  it("finds a later window by its id after an earlier one closed", () => {
    const s = fakeSafari([
      { id: 3, tabs: [{ url: "https://only/" }] },
      { id: 7, tabs: [{ url: "https://x/" }, { url: "https://b/" }] },
    ]);
    const r = run(CLOSE_TABS, s.app, {
      targets: [
        { id: "only", windowId: 3, index: 1, url: "https://only/" },
        { id: "b", windowId: 7, index: 2, url: "https://b/" },
      ],
    });
    expect(r.data).toMatchObject({
      results: [
        { id: "only", outcome: "closed", windowClosed: true },
        { id: "b", outcome: "closed", windowClosed: false },
      ],
    });
    expect(s.closed).toEqual(["https://only/", "https://b/"]);
  });

  it("touches nothing in a Safari that is not running", () => {
    const s = fakeSafari([{ id: 7, tabs: [{ url: "https://a/" }] }], { running: false });
    const r = run(CLOSE_TABS, s.app, {
      targets: [{ id: "x", windowId: 7, index: 1, url: "https://a/" }],
    });
    expect(r.data).toEqual({ running: false, results: [] });
    expect(s.closed).toEqual([]);
  });
});

describe("LIVE_TABS, run", () => {
  it("reports each window's id with its tabs", () => {
    const s = fakeSafari([{ id: 41, tabs: [{ url: "https://a/" }] }]);
    const r = run(LIVE_TABS, s.app);
    expect(r.data).toMatchObject({ tabs: [{ windowId: 41, index: 1, url: "https://a/" }] });
  });

  it("keeps a missing URL null rather than the string null", () => {
    const s = fakeSafari([{ id: 41, tabs: [{ url: null }] }]);
    const r = run(LIVE_TABS, s.app);
    expect(r.data).toMatchObject({ tabs: [{ url: null, title: "Title" }] });
  });

  it("counts the tabs it could not read, so the list does not pass for complete", () => {
    const s = fakeSafari([
      { id: 41, tabs: [{ url: "https://a/" }, { url: "https://b/", throws: true }] },
      { id: 42, tabs: [{ url: "https://c/" }], tabsThrow: true },
    ]);
    const r = run(LIVE_TABS, s.app);
    expect(r.data).toMatchObject({
      unreadable: [
        { windowId: 41, tabs: 1 },
        { windowId: 42, tabs: null },
      ],
    });
  });
});
