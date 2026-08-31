import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

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
  tab: { url: "https://example.com/", title: "Example Domain", index: 2 },
};

type Recorder = { sent: { script: string; params: unknown }[]; runner: OsascriptRunner };

const recorder = (overrides: { open?: unknown; add?: unknown } = {}): Recorder => {
  const sent: { script: string; params: unknown }[] = [];
  return {
    sent,
    runner: {
      run: async <T>(script: string, params?: unknown): Promise<T> => {
        sent.push({ script, params });
        if (script.includes("addReadingListItem")) return (overrides.add ?? {}) as T;
        if (script.includes("openLocation")) return (overrides.open ?? OPEN_PAYLOAD) as T;
        if (script.includes("NSDictionary")) return BOOKMARKS_PAYLOAD as T;
        return { windows: 0, appFrontmost: null, windowOrderUnknown: false, tabs: [] } as T;
      },
    },
  };
};

const connect = async (env: NodeJS.ProcessEnv = {}, rec: Recorder = recorder()) => {
  const config: Config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_BOOKMARKS: FIXTURE_BOOKMARKS,
    APPLE_SAFARI_ALLOW_WRITES: "true",
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
  it("refuses both writes and sends nothing", async () => {
    const rec = recorder();
    const c = await connect({ APPLE_SAFARI_LIVE_TABS: "false" }, rec);
    const open = await call(c, "apple_safari_open_url", { url: "https://example.com/" });
    const add = await call(c, "apple_safari_add_reading_list_item", {
      url: "https://example.com/",
    });
    expect(open.isError).toBe(true);
    expect(add.isError).toBe(true);
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
