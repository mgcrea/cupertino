import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  appFrontmost: true,
  windowOrderUnknown: false,
  tabs: [
    {
      window: 1,
      windowIndex: 1,
      index: 1,
      url: "https://example.com/",
      title: "Example Domain",
      active: true,
      frontmost: true,
    },
    {
      window: 1,
      windowIndex: 1,
      index: 2,
      url: "https://news.example.org/a?utm_source=x",
      title: "News",
      active: false,
      frontmost: false,
    },
    // The case that motivated `frontmost`: selected in ITS window, and not the
    // tab anybody is looking at. Two `active` tabs is the normal state.
    {
      window: 2,
      windowIndex: 2,
      index: 1,
      url: "https://unvisited.example/",
      title: "New",
      active: true,
      frontmost: false,
    },
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

  /**
   * `enrich: false` is a CHOICE, not a permission failure. Telling that caller
   * history is unreadable and to go grant Full Disk Access sends them after a
   * problem they do not have.
   */
  it("does not blame Full Disk Access when the caller declined enrichment", async () => {
    const c = await connect();
    const r = await call(c, "apple_safari_list_tabs", { enrich: false });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("enrichmentUnavailable");
    expect(r.text).not.toContain("Full Disk Access");
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

  /**
   * The whole point of `frontmost`. The fixture has two `active` tabs because
   * that is what two open windows produce, and a caller asking "what am I
   * looking at" must get one answer rather than the first of two.
   */
  it("marks exactly one tab frontmost even though two are active", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_tabs")).json() as {
      tabs: { url: string; active: boolean; frontmost: boolean }[];
      appFrontmost: boolean;
    };
    expect(body.tabs.filter((t) => t.active)).toHaveLength(2);
    const front = body.tabs.filter((t) => t.frontmost);
    expect(front).toHaveLength(1);
    expect(front[0]?.url).toBe("https://example.com/");
    expect(body.appFrontmost).toBe(true);
  });

  it("narrows to the one front tab", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_tabs", { only: "frontmost" })).json() as {
      tabs: { url: string }[];
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.tabs[0]?.url).toBe("https://example.com/");
  });

  it("narrows to the selected tab of every window", async () => {
    const c = await connect();
    const body = (await call(c, "apple_safari_list_tabs", { only: "active" })).json() as {
      tabs: { url: string }[];
    };
    expect(body.tabs.map((t) => t.url)).toEqual([
      "https://example.com/",
      "https://unvisited.example/",
    ]);
  });

  /**
   * With no readable window order there is no front window, so `only:
   * "frontmost"` returns nothing — which looks exactly like "Safari has no tabs
   * open" unless the result says otherwise.
   */
  /**
   * The join, end to end and against the REAL schema, because every other test
   * on this surface runs with no store at all.
   *
   * The fixture below is built so each rung of the ladder is represented: one
   * tab matches exactly, one matches only after a cosmetic difference is
   * normalised away, and one is not in history at all. That last one is the
   * case the tool description exists to protect — it must come back as a miss
   * rather than being forced onto a near-neighbour.
   */
  describe("enriched from a real store", () => {
    const withStore = async (tabs: unknown) => {
      const dir = mkdtempSync(join(tmpdir(), "safari-store-"));
      const path = join(dir, "History.db");
      const db = new DatabaseSync(path);
      db.exec(
        readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), "fixtures", "safari-history.sql"),
          "utf8",
        ),
      );
      db.exec(
        `INSERT INTO history_items
           (url, visit_count, daily_visit_counts, should_recompute_derived_visit_counts, visit_count_score)
         VALUES ('https://example.com/', 3, X'', 0, 0),
                ('https://news.example.org/a', 5, X'', 0, 0)`,
      );
      db.close();
      return connect(
        { APPLE_SAFARI_STORE: path, APPLE_SAFARI_INDEX_MODE: "ro" },
        fakeOsascript({ tabs }),
      );
    };

    it("matches each tab at the strongest rung that answers, and reports which", async () => {
      const c = await withStore(TABS_PAYLOAD);
      const body = (await call(c, "apple_safari_list_tabs")).json() as {
        tabs: {
          url: string;
          history: { visitCount: number } | null;
          historyMatch: string | null;
        }[];
        historyMatched: string;
        historyMatchKinds: Record<string, number>;
      };

      const byUrl = new Map(body.tabs.map((t) => [t.url, t]));
      // Byte-identical to a stored row.
      expect(byUrl.get("https://example.com/")?.historyMatch).toBe("exact");
      expect(byUrl.get("https://example.com/")?.history?.visitCount).toBe(3);

      // Stored as `.../a`; the tab carries a tracking parameter. This is the
      // match the old exact-then-strip-query lookup would have called
      // query-stripped, and the ladder can now call what it is.
      expect(byUrl.get("https://news.example.org/a?utm_source=x")?.historyMatch).toBe("normalized");
      expect(byUrl.get("https://news.example.org/a?utm_source=x")?.history?.visitCount).toBe(5);

      // Not in history. Must stay a miss.
      expect(byUrl.get("https://unvisited.example/")?.history).toBeNull();
      expect(byUrl.get("https://unvisited.example/")?.historyMatch).toBeNull();

      expect(body.historyMatched).toBe("2/3");
      expect(body.historyMatchKinds).toEqual({ exact: 1, normalized: 1 });
    });

    it("does not claim a page was never visited when the store simply lacks the URL", async () => {
      const c = await withStore(TABS_PAYLOAD);
      const r = await call(c, "apple_safari_list_tabs");
      // With a store present, the "no history at all" explanation must be gone —
      // it would misattribute a genuine miss to a missing permission.
      expect(r.text).not.toContain("enrichmentUnavailable");
    });
  });

  it("says so when window order is unreadable, rather than returning a bare empty list", async () => {
    const c = await connect(
      {},
      fakeOsascript({
        tabs: {
          ...TABS_PAYLOAD,
          windowOrderUnknown: true,
          tabs: TABS_PAYLOAD.tabs.map((t) => ({ ...t, frontmost: false })),
        },
      }),
    );
    const r = await call(c, "apple_safari_list_tabs", { only: "frontmost" });
    expect(r.text).toContain("frontmostUnavailable");
    expect((r.json() as { count: number }).count).toBe(0);
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
    expect((await call(c, "apple_safari_diagnostics")).text).toContain("about half");
  });

  it("says it ships no do JavaScript verb", async () => {
    const c = await connect();
    expect((await call(c, "apple_safari_diagnostics")).text).toContain("do JavaScript");
  });
});
