import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * What diagnostics say about the extension lane, from what is on disk.
 *
 * Seen 2026-10-27: `working: true` beside a newest capture 7.5 hours old and a
 * note calling the extension "probably switched off". `working` meant only that
 * the directory existed, which it does forever once the extension has run, so
 * an agent reading that one field trusted a lane that had been dead all day.
 * Every case here is a state the container can actually be in.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

type Setup = {
  /** null: no `pages` directory at all. */
  captures?: string[] | null;
  /** null: no `heartbeat` directory, i.e. an extension from before heartbeats. */
  heartbeats?: Record<string, string> | null;
};

/** A container as the extension leaves it: `pages/` and `heartbeat/` side by side. */
const container = ({ captures = null, heartbeats = null }: Setup): string => {
  const root = mkdtempSync(join(tmpdir(), "safari-health-"));
  dirs.push(root);
  const pages = join(root, "pages");
  if (captures !== null) {
    mkdirSync(pages);
    captures.forEach((capturedAt, i) => {
      const url = `https://site${i}.example/`;
      writeFileSync(
        join(pages, `${sha(url)}.json`),
        JSON.stringify({ url, title: "", capturedAt, text: "", html: "" }),
      );
    });
  }
  if (heartbeats !== null) {
    const beats = join(root, "heartbeat");
    mkdirSync(beats);
    for (const [origin, at] of Object.entries(heartbeats)) {
      writeFileSync(
        join(beats, `${sha(origin)}.json`),
        JSON.stringify({ origin, at, extensionVersion: "1.32.0" }),
      );
    }
  }
  return pages;
};

type Extension = {
  state: string;
  working: boolean;
  answering: boolean | null;
  answeringOrigins?: string[];
  captured: number;
  newestAgeSeconds: number | null;
  canTell: string;
  quiet?: string;
};

const diagnose = async (setup: Setup): Promise<Extension> => {
  const config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_PAGES: container(setup),
  });
  const { server } = createServer({ config, home: "/nonexistent-home" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: "apple_safari_diagnostics", arguments: {} })) as {
    content: { text: string }[];
  };
  return (JSON.parse(res.content[0]!.text) as { lanes: { extension: Extension } }).lanes.extension;
};

describe("the extension lane's state", () => {
  it("is never-ran, and not working, with no container at all", async () => {
    const ext = await diagnose({});
    expect(ext.state).toBe("never-ran");
    expect(ext.working).toBe(false);
  });

  it("is never-captured when the store exists but is empty", async () => {
    const ext = await diagnose({ captures: [] });
    expect(ext.state).toBe("never-captured");
    expect(ext.working).toBe(false);
  });

  /** The 2026-10-27 report, as it was on disk. */
  it("is stale, and NOT working, when the newest capture is 7.5 hours old", async () => {
    const ext = await diagnose({ captures: [minutesAgo(450), minutesAgo(460), minutesAgo(470)] });
    expect(ext.state).toBe("stale");
    expect(ext.working).toBe(false);
    expect(ext.captured).toBe(3);
    expect(ext.quiet).toBeDefined();
  });

  it("is capturing, and working, with a capture inside the TTL from an extension with no heartbeat", async () => {
    const ext = await diagnose({ captures: [minutesAgo(5)] });
    expect(ext.state).toBe("capturing");
    expect(ext.working).toBe(true);
    // Unknown, not false: this extension writes no heartbeat to judge by.
    expect(ext.answering).toBeNull();
  });

  it("is answering when a page polled within the last half minute", async () => {
    const ext = await diagnose({
      captures: [minutesAgo(400)],
      heartbeats: { "https://gallica.bnf.fr": minutesAgo(0.1) },
    });
    expect(ext.state).toBe("answering");
    expect(ext.working).toBe(true);
    expect(ext.answering).toBe(true);
    expect(ext.answeringOrigins).toEqual(["https://gallica.bnf.fr"]);
  });

  /**
   * An extension that writes heartbeats and has written none lately is not
   * running on any open page. A recent capture says it was a few minutes ago,
   * which is no help to a command sent now.
   */
  it("is not working when it writes heartbeats and none is fresh, even with a recent capture", async () => {
    const ext = await diagnose({
      captures: [minutesAgo(5)],
      heartbeats: { "https://gallica.bnf.fr": minutesAgo(3) },
    });
    expect(ext.state).toBe("capturing");
    expect(ext.answering).toBe(false);
    expect(ext.working).toBe(false);
  });

  it("says what it cannot tell apart", async () => {
    const ext = await diagnose({ captures: [minutesAgo(450)] });
    expect(ext.canTell).toContain("cannot tell");
    expect(ext.canTell).toContain("switched off");
  });
});
