import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { recordOpenedTab } from "../src/client/opened.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The write lane, tested through the tools rather than the client, because the
 * things worth pinning here are things a CALLER can be told — a refusal, a
 * disclosure, an unconfirmed add that must not read as a failure.
 *
 * Every test asserts on `sent`, the scripts that actually reached osascript. On
 * this surface that list is the security boundary: a refused URL that still
 * sent an Apple Event would be a refusal in name only.
 */

const FIXTURE_BOOKMARKS = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "Bookmarks.plist",
);

/** One Reading List entry, so verification has something to find. */
const BOOKMARKS_PAYLOAD = {
  entries: [
    {
      uuid: "AAAA-2",
      url: "https://longread.example/essay",
      title: "An Essay",
      folder: "Reading List",
      readingList: true,
      dateAdded: "2026-08-01T10:00:00.000Z",
      dateLastViewed: null,
      previewText: null,
    },
  ],
  folders: 1,
  depthTruncated: false,
};

const OPEN_PAYLOAD = {
  route: "tab-push",
  launchedSafari: false,
  windows: 1,
  windowId: 41,
  tab: { url: "https://example.com/", title: "Example Domain", index: 2 },
};

/** A live tab as the live-tabs script reports one. */
const liveTab = (over: Record<string, unknown> = {}) => ({
  window: 1,
  windowId: 41,
  windowIndex: 1,
  index: 2,
  url: "https://example.com/",
  title: "Example Domain",
  active: false,
  frontmost: false,
  ...over,
});

const tabsPayload = (tabs: unknown[], over: Record<string, unknown> = {}) => ({
  running: true,
  windows: 1,
  appFrontmost: false,
  windowOrderUnknown: false,
  tabs,
  ...over,
});

type Recorder = { sent: { script: string; params: unknown }[]; runner: OsascriptRunner };

const recorder = (
  overrides: { open?: unknown; add?: unknown; tabs?: unknown; close?: unknown } = {},
): Recorder => {
  const sent: { script: string; params: unknown }[] = [];
  return {
    sent,
    runner: {
      run: async <T>(script: string, params?: unknown): Promise<T> => {
        sent.push({ script, params });
        if (script.includes("addReadingListItem")) return (overrides.add ?? {}) as T;
        if (script.includes("openLocation")) return (overrides.open ?? OPEN_PAYLOAD) as T;
        if (script.includes("NSDictionary")) return BOOKMARKS_PAYLOAD as T;
        if (script.includes(".close()")) {
          // By default every target the server sends is closed, which is what
          // the script does when each tab still shows the URL it was sent.
          const { targets } = params as { targets: { id: string }[] };
          return (overrides.close ?? {
            running: true,
            results: targets.map((t) => ({ id: t.id, outcome: "closed", windowClosed: false })),
          }) as T;
        }
        return (overrides.tabs ?? tabsPayload([], { windows: 0 })) as T;
      },
    },
  };
};

const isClose = (s: { script: string }) => s.script.includes(".close()");

/** A fresh record per test, so no test sees another's opened tabs. */
const openedDir = () => join(mkdtempSync(join(tmpdir(), "safari-writes-")), "opened-tabs");

const connect = async (env: NodeJS.ProcessEnv = {}, rec: Recorder = recorder()) => {
  const config: Config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_BOOKMARKS: FIXTURE_BOOKMARKS,
    APPLE_SAFARI_ALLOW_WRITES: "true",
    APPLE_SAFARI_OPENED_TABS: openedDir(),
    // No real wait in tests. The delay exists to straddle Safari's measured 2 s
    // write lag, and a suite that slept for it would pay 3 s per unconfirmed
    // add to prove something about a fake osascript.
    APPLE_SAFARI_READING_LIST_CONFIRM_MS: "0",
    ...env,
  });
  const { server } = createServer({ config, home: "/nonexistent-home", osascript: rec.runner });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) as never };
};

/**
 * The reason this lane can ship without "Allow JavaScript from Apple Events".
 *
 * A `javascript:` URL reaches the same capability through a navigation verb, so
 * these are not input-validation tests — they are the boundary itself.
 */
describe("the scheme gate", () => {
  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "about:blank",
    "  https://example.com/",
  ]) {
    it(`refuses ${url.trim().slice(0, 28)} without sending an Apple Event`, async () => {
      const rec = recorder();
      const c = await connect({}, rec);
      const r = await call(c, "apple_safari_open_url", { url });
      expect(r.isError).toBe(true);
      expect(rec.sent).toEqual([]);
    });
  }

  it("says why, rather than just refusing", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_open_url", { url: "javascript:alert(1)" });
    expect(r.text).toContain("execute script in the page");
  });

  it("gates the Reading List by the same rule", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    const r = await call(c, "apple_safari_add_reading_list_item", { url: "javascript:alert(1)" });
    expect(r.isError).toBe(true);
    expect(rec.sent).toEqual([]);
  });

  it("accepts a plain https URL", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    const r = await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    expect(r.isError).toBe(false);
    expect(rec.sent).toHaveLength(1);
  });
});

/**
 * `liveTabs: false` promises a server that sends NO Apple Event. A write that
 * ignored it would break that promise on the one machine whose owner asked for
 * it — and would do it invisibly, since the tool list does not change.
 */
describe("with the Apple Events lane switched off", () => {
  it("refuses every write and sends nothing", async () => {
    const rec = recorder();
    const c = await connect({ APPLE_SAFARI_LIVE_TABS: "false" }, rec);
    const open = await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    const add = await call(c, "apple_safari_add_reading_list_item", {
      url: "https://example.com/",
    });
    const close = await call(c, "apple_safari_close_tabs", { all: true });
    expect(open.isError).toBe(true);
    expect(add.isError).toBe(true);
    expect(close.isError).toBe(true);
    expect(open.text).toContain("APPLE_SAFARI_LIVE_TABS");
    expect(rec.sent).toEqual([]);
  });

  it("still registers them, because the tool list must not vary with runtime state", async () => {
    const c = await connect({ APPLE_SAFARI_LIVE_TABS: "false" });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("apple_safari_open_url");
  });
});

describe("apple_safari_open_url", () => {
  it("defaults to a new tab and to not stealing focus", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    expect(rec.sent[0]?.params).toEqual({
      url: "https://example.com/",
      target: "new-tab",
      activate: false,
    });
  });

  it("passes current-tab through when asked", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    await call(c, "apple_safari_open_url", { url: "https://example.com/", target: "current-tab" });
    expect(rec.sent[0]?.params).toMatchObject({ target: "current-tab" });
  });

  it("always says the page was not waited for", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    expect(r.json()).toMatchObject({ route: "tab-push", loadNote: expect.any(String) });
  });

  /**
   * The fallback route means Safari chose where the page went. A caller that
   * reads `tab` as "where it landed" would be wrong exactly here, so this is
   * the one case that gets an extra note.
   */
  it("discloses imprecise placement, and only then", async () => {
    const precise = await call(await connect(), "apple_safari_open_url", {
      url: "https://example.com/",
    });
    expect(precise.json()).not.toHaveProperty("placementNote");

    const fell = recorder({ open: { ...OPEN_PAYLOAD, route: "open-location-fallback" } });
    const r = await call(await connect({}, fell), "apple_safari_open_url", {
      url: "https://example.com/",
    });
    expect(r.json()).toHaveProperty("placementNote");
  });

  it("records a new tab and hands back a ref that can close it", async () => {
    const dir = openedDir();
    const c = await connect({ APPLE_SAFARI_OPENED_TABS: dir });
    const r = await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    expect(r.json()).toMatchObject({ ref: expect.stringMatching(/^st1:[0-9a-f-]{36}$/) });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  /** The page in front of the user was theirs; the agent only navigated it. */
  it("records nothing for current-tab", async () => {
    const dir = openedDir();
    const c = await connect({ APPLE_SAFARI_OPENED_TABS: dir });
    const r = await call(c, "apple_safari_open_url", {
      url: "https://example.com/",
      target: "current-tab",
    });
    expect(r.json()).not.toHaveProperty("ref");
    expect(() => readdirSync(dir)).toThrow();
  });

  it("still reports the open when the record cannot be written", async () => {
    const c = await connect({ APPLE_SAFARI_OPENED_TABS: "/dev/null/opened-tabs" });
    const r = await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    expect(r.isError).toBe(false);
    expect(r.json()).not.toHaveProperty("ref");
    expect(r.json()).toHaveProperty("refNote");
  });

  it("reports a launch of Safari, and stays quiet when there was none", async () => {
    const quiet = await call(await connect(), "apple_safari_open_url", {
      url: "https://example.com/",
    });
    expect(quiet.json()).not.toHaveProperty("launchedSafari");

    const launched = recorder({ open: { ...OPEN_PAYLOAD, launchedSafari: true } });
    const r = await call(await connect({}, launched), "apple_safari_open_url", {
      url: "https://example.com/",
    });
    expect(r.json()).toMatchObject({ launchedSafari: true });
  });
});

describe("apple_safari_add_reading_list_item", () => {
  it("confirms the add by re-reading the Reading List", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_add_reading_list_item", {
      url: "https://longread.example/essay",
    });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ verified: true });
    expect(r.json()).not.toHaveProperty("verifyNote");
  });

  /**
   * The failure mode this whole design is arranged around. Safari writes
   * Bookmarks.plist lazily, so a successful add is routinely invisible a moment
   * later — and a caller that read that as a failure would retry, leaving two
   * entries and no verb able to remove either.
   */
  it("does not report an unconfirmed add as a failure", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_add_reading_list_item", {
      url: "https://brand-new.example/post",
    });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ verified: null });
    expect(r.text).toContain("does not mean the add failed");
    expect(r.text).toContain("Do not retry");
  });

  /**
   * The reason the confirmation is deferred at all. Safari commits an add to
   * Bookmarks.plist after a measured 2 s, so one immediate walk could never
   * find it — the tool would pay for an 880 KB traversal to report `null` on
   * every successful add. A miss must cost a SECOND look before it is reported.
   */
  it("looks twice before reporting an add unconfirmed", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    await call(c, "apple_safari_add_reading_list_item", { url: "https://brand-new.example/post" });
    const walks = rec.sent.filter((s) => s.script.includes("NSDictionary"));
    expect(walks).toHaveLength(2);
  });

  it("stops at the first look when the item is already there", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    await call(c, "apple_safari_add_reading_list_item", {
      url: "https://longread.example/essay",
    });
    const walks = rec.sent.filter((s) => s.script.includes("NSDictionary"));
    expect(walks).toHaveLength(1);
  });

  it("omits the optional fields rather than sending blanks", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    await call(c, "apple_safari_add_reading_list_item", { url: "https://example.com/" });
    const params = rec.sent[0]?.params as Record<string, unknown>;
    expect(params.title).toBeUndefined();
    expect(params.previewText).toBeUndefined();
  });

  it("passes a title and preview through when given", async () => {
    const rec = recorder();
    const c = await connect({}, rec);
    await call(c, "apple_safari_add_reading_list_item", {
      url: "https://example.com/",
      title: "A Title",
      previewText: "It begins…",
    });
    expect(rec.sent[0]?.params).toMatchObject({ title: "A Title", previewText: "It begins…" });
  });

  it("warns that duplicates cannot be undone", async () => {
    const r = await call(await connect(), "apple_safari_add_reading_list_item", {
      url: "https://example.com/",
    });
    expect(r.text).toContain("cannot remove one");
  });
});

describe("apple_safari_close_tabs", () => {
  const URL_A = "https://example.com/";
  const setup = (
    tabs: unknown[],
    recorded: { url: string; windowId: number | null }[] = [{ url: URL_A, windowId: 41 }],
    over: { close?: unknown; tabs?: unknown } = {},
  ) => {
    const dir = openedDir();
    const refs = recorded.map((r) => `st1:${recordOpenedTab(dir, r).id}`);
    const rec = recorder({ tabs: tabsPayload(tabs), ...over });
    return { dir, refs, rec, client: connect({ APPLE_SAFARI_OPENED_TABS: dir }, rec) };
  };

  it("closes a tab still on the URL it was opened on, and forgets it", async () => {
    const { dir, refs, rec, client } = setup([liveTab({ index: 1, url: "https://x/" }), liveTab()]);
    const r = await call(await client, "apple_safari_close_tabs", { refs });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ closed: [{ ref: refs[0], url: URL_A }] });
    const sent = rec.sent.find(isClose)?.params as { targets: unknown[] };
    expect(sent.targets).toEqual([{ id: expect.any(String), windowId: 41, index: 2, url: URL_A }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves open, and lets go of, a tab that moved off its URL", async () => {
    const { dir, refs, rec, client } = setup([liveTab({ url: "https://example.com/next" })]);
    const r = await call(await client, "apple_safari_close_tabs", { refs });
    expect(r.json()).toMatchObject({ notFound: [{ ref: refs[0], url: URL_A }] });
    expect(r.json()).not.toHaveProperty("closed");
    expect(rec.sent.some(isClose)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("closes nothing when another tab shows the same URL", async () => {
    const { dir, refs, rec, client } = setup([liveTab({ index: 1 }), liveTab({ index: 2 })]);
    const r = await call(await client, "apple_safari_close_tabs", { refs });
    expect(r.json()).toMatchObject({ ambiguous: [{ ref: refs[0], url: URL_A, tabs: 2 }] });
    expect(rec.sent.some(isClose)).toBe(false);
    // Kept: the user may close their own copy, and then this one is closeable.
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("closes every recorded tab with all, rightmost first", async () => {
    const { rec, client } = setup(
      [liveTab({ index: 1 }), liveTab({ index: 2, url: "https://b.example/" })],
      [
        { url: URL_A, windowId: 41 },
        { url: "https://b.example/", windowId: 41 },
      ],
    );
    const r = await call(await client, "apple_safari_close_tabs", { all: true });
    expect((r.json() as { closed: unknown[] }).closed).toHaveLength(2);
    const sent = rec.sent.find(isClose)?.params as { targets: { index: number }[] };
    expect(sent.targets.map((t) => t.index)).toEqual([2, 1]);
  });

  it("closes nothing in a window with a tab the read could not see", async () => {
    const { dir, refs, rec } = setup([]);
    const blind = recorder({
      tabs: tabsPayload([liveTab()], { unreadable: [{ windowId: 41, tabs: 1 }] }),
    });
    const r = await call(
      await connect({ APPLE_SAFARI_OPENED_TABS: dir }, blind),
      "apple_safari_close_tabs",
      { refs },
    );
    expect(r.json()).toMatchObject({ ambiguous: [{ ref: refs[0] }] });
    expect(blind.sent.some(isClose)).toBe(false);
    expect(rec.sent).toEqual([]);
  });

  /** The same ref twice would send one position twice, and the next tab slides into it. */
  it("closes a ref given twice once", async () => {
    const { refs, rec, client } = setup([liveTab()]);
    const r = await call(await client, "apple_safari_close_tabs", { refs: [refs[0], refs[0]] });
    const sent = rec.sent.find(isClose)?.params as { targets: unknown[] };
    expect(sent.targets).toHaveLength(1);
    expect((r.json() as { closed: unknown[] }).closed).toHaveLength(1);
  });

  it("reports a tab the script refused as stale, with the script's reason", async () => {
    const { dir, refs } = setup([liveTab()]);
    const id = refs[0]!.slice(4);
    const over = recorder({
      tabs: tabsPayload([liveTab()]),
      close: { running: true, results: [{ id, outcome: "failed", message: "no such tab" }] },
    });
    const r = await call(
      await connect({ APPLE_SAFARI_OPENED_TABS: dir }, over),
      "apple_safari_close_tabs",
      { refs },
    );
    expect(r.json()).toMatchObject({ stale: [{ ref: refs[0], reason: "no such tab" }] });
  });

  it("names a ref that is not in the record rather than failing the call", async () => {
    const { client } = setup([liveTab()]);
    const ghost = "st1:00000000-0000-4000-8000-000000000000";
    const r = await call(await client, "apple_safari_close_tabs", { refs: [ghost] });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ unknown: [ghost] });
  });

  it("refuses a ref of another kind", async () => {
    const { client } = setup([liveTab()]);
    const r = await call(await client, "apple_safari_close_tabs", {
      refs: ["s1:https://example.com/"],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HISTORY ref");
  });

  it("wants exactly one of refs and all", async () => {
    const { client, refs } = setup([liveTab()]);
    const c = await client;
    expect((await call(c, "apple_safari_close_tabs", {})).isError).toBe(true);
    expect((await call(c, "apple_safari_close_tabs", { refs, all: true })).isError).toBe(true);
  });

  /** A quit Safari is not launched to close tabs, and its tabs may come back on restore. */
  it("closes and forgets nothing while Safari is quit", async () => {
    const { dir, refs, rec, client } = setup([], undefined, {
      tabs: { running: false, windows: 0, appFrontmost: null, windowOrderUnknown: false, tabs: [] },
    });
    const r = await call(await client, "apple_safari_close_tabs", { refs });
    expect(r.json()).toMatchObject({ safariRunning: false });
    expect(rec.sent.some(isClose)).toBe(false);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  /** The tab moved between the read and the close: the script's own check refused it. */
  it("keeps a tab the close script found changed", async () => {
    const { dir, refs, client } = setup([liveTab()], undefined, {
      close: { running: true, results: [] },
    });
    const c = await client;
    const id = refs[0]!.slice(4);
    const rec2 = await call(c, "apple_safari_close_tabs", { refs });
    expect(rec2.json()).toMatchObject({ stale: [{ ref: refs[0] }] });
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
  });

  it("is not registered without writes", async () => {
    const c = await connect({ APPLE_SAFARI_ALLOW_WRITES: "false" });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("apple_safari_close_tabs");
  });
});
