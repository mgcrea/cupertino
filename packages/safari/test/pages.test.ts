import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The extension lane, which differs from every other lane here in one way that
 * shapes the whole test file: its store is written by a component on its own
 * schedule, so this must behave sanely on a directory that is absent, empty,
 * half-written, or holding something from an older extension.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const store = (entries: Record<string, unknown>[] | null): string => {
  const root = mkdtempSync(join(tmpdir(), "safari-pages-"));
  dirs.push(root);
  const pages = join(root, "pages");
  if (entries !== null) {
    mkdirSync(pages, { recursive: true });
    // Named as the extension names them: by the SHA-256 of the URL, so one
    // file per URL and a revisit overwrites it.
    entries.forEach((e, i) => {
      const name =
        typeof e.url === "string" ? createHash("sha256").update(e.url).digest("hex") : String(i);
      writeFileSync(join(pages, `${name}.json`), JSON.stringify(e));
    });
  }
  return pages;
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const capture = (over: Record<string, unknown> = {}) => ({
  url: "https://example.com/",
  title: "Example Domain",
  capturedAt: new Date().toISOString(),
  text: "Example Domain. This domain is for use in documentation.",
  html: "<html><body><h1>Example Domain</h1></body></html>",
  textTruncated: false,
  htmlTruncated: false,
  ...over,
});

const connect = async (pagesPath: string) => {
  const config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_PAGES: pagesPath,
    // No tab will ever answer in this suite; it is about the capture store.
    // The live read is exercised against a fake extension in actions.test.ts.
    APPLE_SAFARI_LIVE_READ_TIMEOUT_MS: "0",
  });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const read = async (pagesPath: string, args: Record<string, unknown>) => {
  const c = await connect(pagesPath);
  const res = (await c.callTool({ name: "apple_safari_read_page", arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((x) => x.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) };
};

describe("reading a captured page", () => {
  it("returns readable text by default", async () => {
    const r = await read(store([capture()]), { url: "https://example.com/" });
    expect(r.isError).toBe(false);
    const body = r.json() as { format: string; content: string; capturedAt: string };
    expect(body.format).toBe("text");
    expect(body.content).toContain("This domain is for use");
    expect(body.capturedAt).toBeTruthy();
  });

  it("returns raw HTML when asked", async () => {
    const r = await read(store([capture()]), { url: "https://example.com/", format: "html" });
    expect((r.json() as { content: string }).content).toContain("<h1>");
  });

  /** Two tabs on one URL collapse to one entry; the freshest must win. */
  it("reads the capture filed under the URL's digest, as the extension files it", async () => {
    const pages = store([capture({ text: "filed", capturedAt: hoursAgo(0.1) })]);
    // A newer file holding the same URL under another name is not something
    // the extension writes; the lookup goes to the one file it would.
    writeFileSync(join(pages, "decoy.json"), JSON.stringify(capture({ text: "decoy" })));
    const r = await read(pages, { url: "https://example.com/" });
    expect((r.json() as { content: string }).content).toBe("filed");
  });
});

/**
 * The lane is a CACHE, and the timestamp is the only thing stopping a caller
 * describing a page the user left ten minutes ago as the one on screen.
 */
describe("staleness", () => {
  it("reports the age of every capture", async () => {
    const r = await read(
      store([capture({ capturedAt: new Date(Date.now() - 60_000).toISOString() })]),
      {
        url: "https://example.com/",
      },
    );
    const body = r.json() as { ageSeconds: number };
    expect(body.ageSeconds).toBeGreaterThanOrEqual(59);
    expect(body.ageSeconds).toBeLessThan(70);
  });

  it("warns in words once a capture is old enough to mislead", async () => {
    const r = await read(
      store([capture({ capturedAt: new Date(Date.now() - 20 * 60_000).toISOString() })]),
      {
        url: "https://example.com/",
      },
    );
    expect(r.text).toContain("stale");
    expect(r.text).toContain("20 minutes ago");
  });

  it("says nothing about staleness for a fresh capture", async () => {
    const r = await read(store([capture()]), { url: "https://example.com/" });
    expect(r.text).not.toContain('"stale"');
  });
});

/**
 * Three different reasons a read comes back empty, needing three different
 * fixes. Collapsing them into one "not found" is what would send someone to
 * re-install an extension that is already installed and merely unpermitted.
 */
describe("telling the failure modes apart", () => {
  it("says the extension has never run when there is no store", async () => {
    const r = await read(store(null), { url: "https://example.com/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("never run");
    expect(r.text).toContain("Settings > Extensions");
  });

  it("says to allow it on a website when the store is empty", async () => {
    const r = await read(store([]), { url: "https://example.com/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("one site at a time");
    expect(r.text).not.toContain("never run");
  });

  it("says the extension works but this URL is not captured", async () => {
    const r = await read(store([capture()]), { url: "https://other.example/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("extension is working");
    expect(r.text).toContain("1 other page");
  });
});

/**
 * Whether the extension is ENABLED lives in Safari's UI and only the containing
 * app can read it. What this process can measure is silence — and silence
 * changes what a miss means, which is the difference between sending someone to
 * Safari's Extensions pane and sending them to check a URL.
 */
describe("a lane that has gone quiet", () => {
  it("blames the extension when nothing has been captured for a long time", async () => {
    const r = await read(store([capture({ capturedAt: hoursAgo(3) })]), {
      url: "https://other.example/",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("switched off");
    expect(r.text).toContain("stale");
  });

  it("does NOT blame the extension when captures are recent", async () => {
    const r = await read(store([capture()]), { url: "https://other.example/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("extension is working");
    expect(r.text).not.toContain("switched off");
  });

  /**
   * A quiet lane still serves what it has. The captures are real, and the
   * timestamp says how old — refusing them would lose information the caller
   * may want, so the honest move is to answer and date it.
   */
  it("still returns an old capture when asked for it by URL", async () => {
    const r = await read(store([capture({ capturedAt: hoursAgo(3) })]), {
      url: "https://example.com/",
    });
    expect(r.isError).toBe(false);
    const body = r.json() as { ageSeconds: number; stale: string };
    expect(body.ageSeconds).toBeGreaterThan(10_000);
    expect(body.stale).toContain("minutes ago");
  });
});

/** A heartbeat as the native handler stamps one: a file per origin, named by its digest. */
const beat = (pages: string, origin: string, at = new Date().toISOString()) => {
  const dir = join(dirname(pages), "heartbeat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${createHash("sha256").update(origin).digest("hex")}.json`),
    JSON.stringify({ origin, at, extensionVersion: "1.33.0" }),
  );
};

/**
 * With heartbeats on disk the miss stops guessing from the captures' age: it
 * says whether anything is running, and whether it is running on this site.
 */
describe("a miss read against the heartbeats", () => {
  it("names this site when other sites are answering", async () => {
    const pages = store([capture({ capturedAt: hoursAgo(3) })]);
    beat(pages, "https://example.com");
    const r = await read(pages, { url: "https://gallica.bnf.fr/SRU?query=x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not on https://gallica.bnf.fr");
    expect(r.text).toContain("not allowed on this site");
  });

  it("says nothing is running when no heartbeat is fresh", async () => {
    const pages = store([capture({ capturedAt: hoursAgo(7) })]);
    beat(pages, "https://example.com", hoursAgo(7));
    const r = await read(pages, { url: "https://gallica.bnf.fr/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No open page has polled");
    expect(r.text).toContain("second Cupertino");
  });
});

describe("truncation", () => {
  it("cuts to maxChars and says so", async () => {
    const r = await read(store([capture({ text: "x".repeat(500) })]), {
      url: "https://example.com/",
      maxChars: 100,
    });
    const body = r.json() as { content: string; chars: number; truncated: boolean };
    expect(body.chars).toBe(100);
    expect(body.truncated).toBe(true);
  });

  /**
   * The cap applies with no `maxChars` at all. It was optional and undefaulted,
   * so a plain read returned the whole capture - up to the extension's own
   * 256 KiB of text, which is a quarter of a million tokens for a tool a model
   * reaches for casually.
   */
  it("caps by default when maxChars is not given", async () => {
    const r = await read(store([capture({ text: "x".repeat(40_000) })]), {
      url: "https://example.com/",
    });
    const body = r.json() as { chars: number; truncated: boolean };
    expect(body.chars).toBe(32_768);
    expect(body.truncated).toBe(true);
  });

  it("returns a short page whole, with no truncation flag", async () => {
    const r = await read(store([capture({ text: "x".repeat(500) })]), {
      url: "https://example.com/",
    });
    const body = r.json() as { chars: number; truncated?: boolean };
    expect(body.chars).toBe(500);
    expect(body.truncated).toBeUndefined();
  });

  /**
   * The extension's own cap is a different fact from this call's, and reporting
   * only one would let a caller believe it had the whole page.
   */
  it("distinguishes the extension's cap from this call's", async () => {
    const r = await read(store([capture({ text: "y".repeat(50), textTruncated: true })]), {
      url: "https://example.com/",
    });
    const body = r.json() as { truncated?: boolean; captureTruncated?: boolean };
    expect(body.captureTruncated).toBe(true);
    expect(body.truncated).toBeUndefined();
  });
});

/**
 * The store is written by a separate component that updates on its own
 * schedule, so this lane must never fail a call over one bad entry.
 */
describe("tolerating a store it does not control", () => {
  it("skips unparseable and foreign entries", async () => {
    const pages = store([capture()]);
    writeFileSync(join(pages, "torn.json"), "{ not json");
    writeFileSync(join(pages, "foreign.json"), JSON.stringify({ something: "else" }));
    const r = await read(pages, { url: "https://example.com/" });
    expect(r.isError).toBe(false);
    expect((r.json() as { content: string }).content).toContain("This domain");
  });
});
