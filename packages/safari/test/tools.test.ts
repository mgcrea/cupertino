import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * Two seams, both load-bearing.
 *
 * `home: "/nonexistent-home"` keeps discovery away from the real
 * `~/Library/Safari`, and the injected `osascript` keeps every test away from
 * the developer's actual open tabs. On the machine this is developed on, either
 * omission would mean the suite passed or failed on somebody's real browsing.
 */
const TABS_PAYLOAD = {
  windows: 2,
  tabs: [
    { window: 1, index: 1, url: "https://example.com/", title: "Example Domain", active: true },
    {
      window: 1,
      index: 2,
      url: "https://news.example.org/a?utm_source=x",
      title: "News",
      active: false,
    },
    { window: 2, index: 1, url: "https://unvisited.example/", title: "New", active: true },
  ],
};

const BOOKMARKS_PAYLOAD = {
  entries: [
    {
      uuid: "AAAA-1",
      url: "https://docs.example.com/guide",
      title: "The Guide",
      folder: "Work",
      readingList: false,
      dateAdded: null,
      dateLastViewed: null,
      previewText: null,
    },
    {
      uuid: "AAAA-2",
      url: "https://longread.example/essay",
      title: "An Essay",
      folder: "Reading List",
      readingList: true,
      dateAdded: "2026-08-01T10:00:00.000Z",
      dateLastViewed: null,
      previewText: "It begins…",
    },
    {
      uuid: "AAAA-3",
      url: "https://longread.example/read-already",
      title: "Already Read",
      folder: "Reading List",
      readingList: true,
      dateAdded: "2026-07-01T10:00:00.000Z",
      dateLastViewed: "2026-07-02T08:00:00.000Z",
      previewText: null,
    },
  ],
  folders: 3,
  depthTruncated: false,
};

const fakeOsascript = (
  overrides: { tabs?: unknown; bookmarks?: unknown; throws?: Error } = {},
): OsascriptRunner => ({
  run: async <T>(script: string): Promise<T> => {
    if (overrides.throws) throw overrides.throws;
    if (script.includes("NSDictionary")) {
      return (overrides.bookmarks ?? BOOKMARKS_PAYLOAD) as T;
    }
    return (overrides.tabs ?? TABS_PAYLOAD) as T;
  },
});

/**
 * A real, readable file, so the bookmark tools exercise their actual
 * readability gate rather than skipping past it. The WALK is faked here — it is
 * tested for real against this same fixture in `bookmarks.test.ts` — but
 * "is the file there and can it be opened" is answered honestly.
 */
const FIXTURE_BOOKMARKS = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "Bookmarks.plist",
);

const connect = async (
  env: NodeJS.ProcessEnv = {},
  osascript: OsascriptRunner = fakeOsascript(),
) => {
  const config: Config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_BOOKMARKS: FIXTURE_BOOKMARKS,
    ...env,
  });
  const { server } = createServer({ config, home: "/nonexistent-home", osascript });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).toSorted();

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) as never };
};

describe("tool registration", () => {
  it("registers six read tools", async () => {
    expect(await toolNames(await connect())).toEqual([
      "apple_safari_diagnostics",
      "apple_safari_get_page",
      "apple_safari_list_bookmarks",
      "apple_safari_list_reading_list",
      "apple_safari_list_tabs",
      "apple_safari_search_history",
    ]);
  });

  /**
   * v1 has no write tool, and that is a decision rather than an omission.
   * docs/safari.md records that no write on this surface was ever probed —
   * opening a URL or adding to the Reading List navigates a real, visible
   * browser. This asserts the list is IDENTICAL with writes on, so adding one
   * cannot happen without this test being changed deliberately.
   */
  it("registers the same tools with writes enabled", async () => {
    const off = await toolNames(await connect());
    const on = await toolNames(await connect({ APPLE_SAFARI_ALLOW_WRITES: "true" }));
    expect(on).toEqual(off);
  });

  /**
   * The tool list must not vary with which lane is working. It is a runtime
   * condition and MCP clients cache the list, so a list that shrank without
   * Full Disk Access would stay shrunk after the grant.
   */
  it("registers history tools even with no readable store", async () => {
    expect(await toolNames(await connect())).toContain("apple_safari_search_history");
  });
});

/**
 * The failure this surface is most prone to. Without Full Disk Access the tab
 * lane still works, so the server LOOKS alive — and an empty history result
 * would read as "this person does not browse" rather than "the grant is
 * missing".
 */
describe("history without the grant", () => {
  it("errors rather than returning an empty list", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_search_history", { query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('"pages":[]');
  });

  it("says which permission is missing, and that tabs still work", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_search_history", {});
    expect(r.text).toContain("Full Disk Access");
    expect(r.text).toContain("Live tabs still work");
  });

  it("rejects a malformed ref before it reaches the store", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_get_page", { ref: "r1:12345" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Reminders");
  });
});

describe("live tabs", () => {
  it("lists tabs with no store at all", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_list_tabs");
    expect(r.isError).toBe(false);
    const body = r.json() as { tabs: unknown[]; windows: number };
    expect(body.windows).toBe(2);
    expect(body.tabs).toHaveLength(3);
  });

  /**
   * A null `history` must never read as "never visited". With no store, every
   * tab is unenriched and the result says so explicitly.
   */
  it("explains why no tab carries history", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_list_tabs");
    expect(r.text).toContain("enrichmentUnavailable");
    expect(r.text).toContain("Full Disk Access");
  });

  it("can be disabled entirely, and says so instead of erroring obscurely", async () => {
    const c = await connect({ APPLE_SAFARI_LIVE_TABS: "false" });
    const r = await call(c, "apple_safari_list_tabs");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_LIVE_TABS");
  });

  it("surfaces an Automation failure rather than pretending there are no tabs", async () => {
    const c = await connect({}, fakeOsascript({ throws: new Error("Not authorized to send") }));
    const r = await call(c, "apple_safari_list_tabs");
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('"tabs":[]');
  });
});

describe("bookmarks and the Reading List", () => {
  it("lists bookmarks, excluding Reading List entries", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_bookmarks")).json() as {
      bookmarks: { url: string }[];
    };
    expect(body.bookmarks.map((b) => b.url)).toEqual(["https://docs.example.com/guide"]);
  });

  it("filters bookmarks by folder as well as title and url", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_bookmarks", { query: "work" })).json() as {
      bookmarks: unknown[];
    };
    expect(body.bookmarks).toHaveLength(1);
  });

  it("lists the Reading List with unread derived from the last-viewed date", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_reading_list")).json() as {
      readingList: { url: string; unread: boolean }[];
      unread: number;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.unread).toBe(1);
    expect(body.readingList.find((r) => r.url.endsWith("essay"))?.unread).toBe(true);
    expect(body.readingList.find((r) => r.url.endsWith("read-already"))?.unread).toBe(false);
  });

  it("filters to unread only", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_reading_list", { unreadOnly: true })).json() as {
      readingList: unknown[];
    };
    expect(body.readingList).toHaveLength(1);
  });

  /**
   * A plain bookmark has no read state, so `unread` is null rather than false —
   * reporting false would invent a state Safari does not track for bookmarks.
   * Explicitly null rather than absent, because an absent key reads as an
   * oversight while a null one reads as an answer.
   */
  it("reports unread as null for a plain bookmark", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_bookmarks")).json() as {
      bookmarks: { unread: unknown }[];
    };
    expect(body.bookmarks[0]?.unread).toBeNull();
  });
});

describe("diagnostics", () => {
  it("reports the two lanes separately rather than one health flag", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_diagnostics")).json() as {
      lanes: { fileLane: { working: boolean }; appleEvents: { enabled: boolean } };
    };
    expect(body.lanes.fileLane.working).toBe(false);
    expect(body.lanes.appleEvents.enabled).toBe(true);
  });

  it("states that the lanes are not fallbacks for each other", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_diagnostics");
    expect(r.text).toContain("NOT fallbacks");
  });

  it("carries the tab-match caveat", async () => {
    const c = await connect();
    expect((await call(c, "apple_safari_diagnostics")).text).toContain("55%");
  });

  it("says it ships no do JavaScript verb", async () => {
    const c = await connect();
    expect((await call(c, "apple_safari_diagnostics")).text).toContain("do JavaScript");
  });
});
