import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  forgetOpenedTabs,
  locateOpenedTabs,
  OPENED_TAB_TTL_MS,
  readOpenedTabs,
  recordOpenedTab,
  sameUrl,
  type LiveTab,
  type OpenedTab,
} from "../src/client/opened.js";

/**
 * The record of tabs an agent opened, and how one is found again.
 *
 * Safari gives a tab no identity over Apple Events, so the URL is the identity
 * here exactly as it is everywhere else on this surface. These tests pin the
 * one property that matters: a tab is only ever named as the agent's when no
 * other open tab could be it.
 */

const entry = (over: Partial<OpenedTab> = {}): OpenedTab => ({
  id: "a",
  url: "https://gallica.bnf.fr/ark:/12148/bpt6k1",
  windowId: 7,
  openedAt: "2026-10-28T10:00:00.000Z",
  ...over,
});

const tab = (over: Partial<LiveTab> = {}): LiveTab => ({
  windowId: 7,
  index: 3,
  url: "https://gallica.bnf.fr/ark:/12148/bpt6k1",
  ...over,
});

describe("sameUrl", () => {
  it("treats a bare host and its trailing slash as one page", () => {
    // Safari reports `https://example.com/` for a tab opened as `https://example.com`.
    expect(sameUrl("https://example.com", "https://example.com/")).toBe(true);
  });

  it("ignores the case of the host but not of the path", () => {
    expect(sameUrl("https://Example.COM/a", "https://example.com/a")).toBe(true);
    expect(sameUrl("https://example.com/A", "https://example.com/a")).toBe(false);
  });

  it("keeps the query and the fragment significant", () => {
    expect(sameUrl("https://example.com/?q=1", "https://example.com/?q=2")).toBe(false);
    expect(sameUrl("https://example.com/#a", "https://example.com/#b")).toBe(false);
  });

  it("falls back to exact comparison for something that is not a URL", () => {
    expect(sameUrl("not a url", "not a url")).toBe(true);
    expect(sameUrl("not a url", "not  a url")).toBe(false);
  });
});

describe("locateOpenedTabs", () => {
  it("finds the tab still showing the URL it was opened on", () => {
    const e = entry();
    const [hit] = locateOpenedTabs([e], [e], [tab({ index: 1, url: "https://other/" }), tab()]);
    expect(hit?.outcome).toEqual({ kind: "found", tab: tab() });
  });

  it("reports a tab that is no longer on its URL as not found, never as another tab", () => {
    const e = entry();
    const [hit] = locateOpenedTabs([e], [e], [tab({ url: "https://gallica.bnf.fr/elsewhere" })]);
    expect(hit?.outcome).toEqual({ kind: "notFound" });
  });

  /**
   * The case the whole rule exists for. Two tabs on the URL and one agent
   * entry: one of them is the user's, and nothing here can tell which.
   */
  it("refuses to choose when more tabs show the URL than agents opened", () => {
    const e = entry();
    const [hit] = locateOpenedTabs([e], [e], [tab({ index: 2 }), tab({ index: 5 })]);
    expect(hit?.outcome).toEqual({ kind: "ambiguous", tabs: 2 });
  });

  it("counts every agent's entry for the URL, not only the ones asked about", () => {
    const a = entry({ id: "a", openedAt: "2026-10-28T10:00:00.000Z" });
    const b = entry({ id: "b", openedAt: "2026-10-28T10:05:00.000Z" });
    const live = [tab({ index: 2 }), tab({ index: 5 })];
    const [hit] = locateOpenedTabs([b], [a, b], live);
    // Two agent tabs on the same page: each entry takes one, in order.
    expect(hit?.outcome).toEqual({ kind: "found", tab: tab({ index: 5 }) });
  });

  it("gives the extra entries nothing when fewer tabs remain than agents opened", () => {
    const a = entry({ id: "a", openedAt: "2026-10-28T10:00:00.000Z" });
    const b = entry({ id: "b", openedAt: "2026-10-28T10:05:00.000Z" });
    const hits = locateOpenedTabs([a, b], [a, b], [tab()]);
    expect(hits.map((h) => h.outcome.kind)).toEqual(["found", "notFound"]);
  });

  it("looks only in the window it was opened in while that window is open", () => {
    const e = entry({ windowId: 7 });
    const live = [tab({ windowId: 7, index: 1, url: "https://x/" }), tab({ windowId: 9 })];
    // The user's own copy of the page in another window is not the agent's tab.
    const [hit] = locateOpenedTabs([e], [e], live);
    expect(hit?.outcome).toEqual({ kind: "notFound" });
  });

  it("scopes the ambiguity to that window too", () => {
    const e = entry({ windowId: 7 });
    const live = [tab({ windowId: 7 }), tab({ windowId: 9 })];
    const [hit] = locateOpenedTabs([e], [e], live);
    expect(hit?.outcome).toEqual({ kind: "found", tab: tab({ windowId: 7 }) });
  });

  /** Window ids do not survive a Safari relaunch; session restore brings the tabs back. */
  it("searches every window once its own has gone", () => {
    const e = entry({ windowId: 7 });
    const [hit] = locateOpenedTabs([e], [e], [tab({ windowId: 12 })]);
    expect(hit?.outcome).toEqual({ kind: "found", tab: tab({ windowId: 12 }) });
  });

  /**
   * A tab whose URL cannot be read — loading, a native error page, a window
   * whose tab list failed — may be the agent's. Counting it as absent would let
   * the user's own copy of the page pass for the agent's.
   */
  it("refuses to choose while a tab in scope cannot be read", () => {
    const e = entry();
    const live = [tab({ index: 1, url: null }), tab({ index: 2 })];
    const [hit] = locateOpenedTabs([e], [e], live);
    expect(hit?.outcome).toEqual({ kind: "ambiguous", tabs: 2 });
  });

  it("does not let an unreadable tab elsewhere block a window it is not in", () => {
    const e = entry({ windowId: 7 });
    const live = [tab({ windowId: 9, index: null, url: null }), tab({ windowId: 7 })];
    const [hit] = locateOpenedTabs([e], [e], live);
    expect(hit?.outcome).toEqual({ kind: "found", tab: tab({ windowId: 7 }) });
  });

  /** An entry whose window has gone searches everywhere, but not in tabs already claimed. */
  it("never gives a window-less entry the tab a window-scoped entry holds", () => {
    const held = entry({ id: "held", windowId: 7, openedAt: "2026-10-28T10:05:00.000Z" });
    const lost = entry({ id: "lost", windowId: 3, openedAt: "2026-10-28T10:00:00.000Z" });
    const hits = locateOpenedTabs([held, lost], [held, lost], [tab({ windowId: 7 })]);
    expect(hits.map((h) => [h.entry.id, h.outcome.kind])).toEqual([
      ["held", "found"],
      ["lost", "notFound"],
    ]);
  });

  it("searches every window for an entry that never knew its window", () => {
    const e = entry({ windowId: null });
    const [hit] = locateOpenedTabs([e], [e], [tab({ windowId: 3 })]);
    expect(hit?.outcome).toEqual({ kind: "found", tab: tab({ windowId: 3 }) });
  });
});

const dir = () => join(mkdtempSync(join(tmpdir(), "safari-opened-")), "opened-tabs");

describe("the record on disk", () => {
  const NOW = Date.parse("2026-10-28T10:00:00.000Z");

  it("reads back what was recorded", () => {
    const d = dir();
    const e = recordOpenedTab(d, { url: "https://example.com/", windowId: 4 }, NOW);
    expect(readOpenedTabs(d, NOW)).toEqual([e]);
    expect(e.openedAt).toBe("2026-10-28T10:00:00.000Z");
  });

  /** One file per tab, so two servers recording at once cannot overwrite each other. */
  it("keeps entries recorded separately apart", () => {
    const d = dir();
    recordOpenedTab(d, { url: "https://a/", windowId: 1 }, NOW);
    recordOpenedTab(d, { url: "https://b/", windowId: 1 }, NOW);
    expect(readdirSync(d)).toHaveLength(2);
    expect(
      readOpenedTabs(d, NOW)
        .map((e) => e.url)
        .toSorted(),
    ).toEqual(["https://a/", "https://b/"]);
  });

  it("forgets the entries it is told to, and only those", () => {
    const d = dir();
    const a = recordOpenedTab(d, { url: "https://a/", windowId: 1 }, NOW);
    const b = recordOpenedTab(d, { url: "https://b/", windowId: 1 }, NOW);
    forgetOpenedTabs(d, [a.id]);
    expect(readOpenedTabs(d, NOW)).toEqual([b]);
  });

  it("drops an entry older than the time to live, from disk too", () => {
    const d = dir();
    recordOpenedTab(d, { url: "https://old/", windowId: 1 }, NOW - OPENED_TAB_TTL_MS - 1);
    expect(readOpenedTabs(d, NOW)).toEqual([]);
    expect(readdirSync(d)).toEqual([]);
  });

  it("reads a directory that does not exist yet as empty", () => {
    expect(readOpenedTabs(dir(), NOW)).toEqual([]);
  });

  it("skips a file it cannot parse rather than failing the read", () => {
    const d = dir();
    const e = recordOpenedTab(d, { url: "https://a/", windowId: 1 }, NOW);
    writeFileSync(join(d, "garbage.json"), "{not json");
    expect(readOpenedTabs(d, NOW)).toEqual([e]);
  });

  it("skips an entry whose date cannot be read, so it cannot outlive the time to live", () => {
    const d = dir();
    const e = recordOpenedTab(d, { url: "https://a/", windowId: 1 }, NOW);
    writeFileSync(join(d, `${e.id}.json`), JSON.stringify({ ...e, openedAt: "soon" }));
    expect(readOpenedTabs(d, NOW)).toEqual([]);
  });

  /** A file that cannot be forgotten by its id must not count as a claim on a URL either. */
  it("skips an entry stored under a name other than its id", () => {
    const d = dir();
    const e = recordOpenedTab(d, { url: "https://a/", windowId: 1 }, NOW);
    writeFileSync(join(d, "copy.json"), JSON.stringify(e));
    expect(readOpenedTabs(d, NOW)).toEqual([e]);
  });

  it("ignores an id that is not one of its own when forgetting", () => {
    const d = dir();
    const outside = join(d, "..", "keep.json");
    writeFileSync(outside, "{}");
    forgetOpenedTabs(d, ["../keep"]);
    expect(existsSync(outside)).toBe(true);
  });
});
