import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterEach, describe, expect, it } from "vitest";

import { pageOfRequest } from "../src/client/actions.js";
import { PageCommandTimeoutError, PreconditionError } from "../src/client/errors.js";
import { AppleSafariClient } from "../src/client/safari.js";
import { loadConfig } from "../src/config.js";

/**
 * The network client, against a FAKE EXTENSION that serves canned records.
 *
 * What is under test is the server's half of the contract: which commands it
 * writes, how it pages a body through them, and what it does with the bytes
 * afterwards. The fake slices a body honestly by `offset`/`length`, the way
 * `network.js` does, so a client that mis-counts a chunk reassembles the wrong
 * text and fails here rather than on a real PDF.
 */

const PAGE_URL = "https://example.test/app";
const ID = "3f9a2c1d-r1";

let root: string;
let timers: (() => void)[] = [];

afterEach(() => {
  for (const stop of timers) stop();
  timers = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

const fakeOsascript: OsascriptRunner = {
  run: async <T>(): Promise<T> => ({ entries: [], folders: 0, depthTruncated: false }) as T,
};

type Canned = {
  /** Headers the page answers with, in place of the default content-type. */
  headers?: Record<string, string>;
  truncated?: boolean;
  splitSurrogates?: boolean;
  body: string;
  encoding?: "text" | "base64" | "summary" | null;
  contentType?: string;
  /**
   * The request body, served for `part: "request"`. `truncated` still comes
   * from the response, as `network.js`'s `view()` sets it: request bodies are
   * never cut, only replaced by a summary.
   */
  request?: string;
  /**
   * Answer this many chunks, then as `network.js` answers once the buffer has
   * evicted the body: no body, nothing to slice, done.
   */
  evictAfter?: number;
};

const setup = (env: NodeJS.ProcessEnv = {}) => {
  root = mkdtempSync(join(tmpdir(), "safari-netclient-"));
  const pages = join(root, "pages");
  const downloads = join(root, "downloads");
  mkdirSync(pages, { recursive: true });
  const config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_PAGES: pages,
    APPLE_SAFARI_ALLOW_WRITES: "true",
    APPLE_SAFARI_ALLOW_NETWORK: "true",
    APPLE_SAFARI_DOWNLOAD_DIR: downloads,
    APPLE_SAFARI_ACTION_TIMEOUT_MS: "500",
    ...env,
  });
  const client = new AppleSafariClient({
    config,
    home: "/nonexistent-home",
    osascript: fakeOsascript,
  });
  return {
    client,
    pages,
    downloads,
    commands: join(root, "commands"),
    results: join(root, "results"),
  };
};

/**
 * Claim commands by deletion and answer them, as the native handler and the
 * content script do together. `netGet` is answered from `records`, sliced the
 * way the page slices; anything else goes to `other`. `answers` caps how many
 * commands get an answer at all, to stand in for a page that goes away.
 */
const fakeExtension = (
  dirs: { commands: string; results: string },
  records: Record<string, Canned>,
  opts: {
    other?: (command: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string };
    answers?: number;
    stale?: string;
  } = {},
) => {
  const seen: Record<string, unknown>[] = [];
  const served: Record<string, number> = {};
  let answered = 0;
  const timer = setInterval(() => {
    let files: string[] = [];
    try {
      files = readdirSync(dirs.commands).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of files) {
      const file = join(dirs.commands, name);
      const command = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      seen.push(command);
      rmSync(file, { force: true });
      if (opts.answers !== undefined && answered >= opts.answers) continue;
      answered += 1;
      let reply: { ok: boolean; data?: unknown; error?: string };
      if (command.action === "netGet") {
        const record = records[String(command.requestId)];
        if (opts.stale || !record) {
          reply = {
            ok: false,
            error: opts.stale ?? `no request ${String(command.requestId)} on this page.`,
          };
        } else {
          const id = String(command.requestId);
          served[id] = (served[id] ?? 0) + 1;
          const evicted = record.evictAfter !== undefined && served[id] > record.evictAfter;
          const data = evicted
            ? ""
            : command.part === "request" && record.request !== undefined
              ? record.request
              : record.body;
          const total = data.length;
          const offset = Math.min(Number(command.offset) || 0, total);
          const length = Number(command.length) > 0 ? Number(command.length) : total - offset;
          let end = Math.min(offset + length, total);
          // As the real page does: never end on the first half of a pair.
          const last = data.charCodeAt(end - 1);
          if (end < total && last >= 0xd800 && last <= 0xdbff) end -= 1;
          const slice = data.slice(offset, end);
          reply = {
            ok: true,
            data: {
              entry: {
                id: command.requestId,
                bodyTruncated: record.truncated === true,
                bodyEvicted: evicted,
                url: "https://example.test/api",
                contentType: record.contentType ?? "application/json",
              },
              ...(command.headers === false
                ? {}
                : { headers: record.headers ?? { "content-type": "application/json" } }),
              encoding: evicted ? null : record.encoding === undefined ? "text" : record.encoding,
              totalChars: total,
              offset,
              slice,
              done: offset + slice.length >= total,
            },
          };
        }
      } else {
        reply = opts.other?.(command) ?? { ok: true, data: {} };
      }
      mkdirSync(dirs.results, { recursive: true });
      writeFileSync(
        join(dirs.results, `${String(command.id)}.json`),
        JSON.stringify({ id: command.id, completedAt: new Date().toISOString(), ...reply }),
      );
    }
  }, 10);
  const stop = () => clearInterval(timer);
  timers.push(stop);
  return { seen, netGets: () => seen.filter((c) => c.action === "netGet") };
};

describe("config", () => {
  it("defaults the three keys", () => {
    const config = loadConfig({});
    expect(config.allowNetwork).toBe(false);
    expect(config.downloadDir).toBe(join(homedir(), "Downloads"));
    expect(config.networkChunkChars).toBe(262_144);
  });

  it("parses the three keys from the environment", () => {
    const config = loadConfig({
      APPLE_SAFARI_ALLOW_NETWORK: "true",
      APPLE_SAFARI_DOWNLOAD_DIR: "/tmp/dl",
      APPLE_SAFARI_NETWORK_CHUNK_CHARS: "32768",
    });
    expect(config.allowNetwork).toBe(true);
    expect(config.downloadDir).toBe("/tmp/dl");
    expect(config.networkChunkChars).toBe(32_768);
  });

  it("rejects a chunk size outside the bounds", () => {
    expect(() => loadConfig({ APPLE_SAFARI_NETWORK_CHUNK_CHARS: "100" })).toThrow();
  });
});

describe("pageOfRequest", () => {
  it("accepts r, t and c ids and rejects anything else", () => {
    expect(pageOfRequest("3f9a2c1d-r12")).toBe("3f9a2c1d");
    expect(pageOfRequest("3f9a2c1d-t3")).toBe("3f9a2c1d");
    expect(pageOfRequest("3f9a2c1d-c1")).toBe("3f9a2c1d");
    expect(pageOfRequest("3f9a2c1d-e12")).toBeNull();
    expect(pageOfRequest("../etc")).toBeNull();
  });
});

describe("networkGet paging", () => {
  it("reassembles a body from several chunks", async () => {
    const t = setup({ APPLE_SAFARI_NETWORK_CHUNK_CHARS: "262144" });
    const body = Array.from({ length: 600_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      "",
    );
    const ext = fakeExtension(t, { [ID]: { body } });
    const out = await t.client.networkGet({
      url: PAGE_URL,
      id: ID,
      jsonPath: undefined,
      saveAs: "body.txt",
    });
    expect(ext.netGets()).toHaveLength(3);
    expect(ext.netGets().map((c) => c.offset)).toEqual([0, 262_144, 524_288]);
    expect(ext.netGets().every((c) => c.page === "3f9a2c1d")).toBe(true);
    expect(readFileSync(join(t.downloads, "body.txt"), "utf8")).toBe(body);
    expect(out.saved?.bytes).toBe(600_000);
  });

  it("pulls only the first chunk for an inline page and reports the next offset", async () => {
    const t = setup();
    const ext = fakeExtension(t, { [ID]: { body: "x".repeat(50_000) } });
    const out = await t.client.networkGet({
      url: PAGE_URL,
      id: ID,
      headers: true,
      offset: 0,
      maxChars: 20_000,
    });
    expect(ext.netGets()).toHaveLength(1);
    expect(out.text).toHaveLength(20_000);
    expect(out.truncated).toBe(true);
    expect(out.nextOffset).toBe(20_000);
    expect(out.totalChars).toBe(50_000);
    expect(out.headers).toEqual({ "content-type": "application/json" });
  });

  it("pages from an offset to the end", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "abcdefghij" } });
    const out = await t.client.networkGet({ url: PAGE_URL, id: ID, offset: 6, maxChars: 20_000 });
    expect(out.text).toBe("ghij");
    expect(out.truncated).toBe(false);
    expect(out.nextOffset).toBeNull();
  });

  it("spans two chunks when the window crosses a chunk boundary", async () => {
    const t = setup({ APPLE_SAFARI_NETWORK_CHUNK_CHARS: "16384" });
    const body = "y".repeat(40_000);
    const ext = fakeExtension(t, { [ID]: { body } });
    const out = await t.client.networkGet({
      url: PAGE_URL,
      id: ID,
      headers: true,
      offset: 0,
      maxChars: 20_000,
    });
    expect(ext.netGets()).toHaveLength(2);
    expect(out.text).toBe(body.slice(0, 20_000));
  });

  it("refuses a malformed id before anything is written", async () => {
    const t = setup();
    const ext = fakeExtension(t, {});
    await expect(t.client.networkGet({ url: PAGE_URL, id: "3f9a2c1d-e12" })).rejects.toThrow(
      /not a request id from apple_safari_network_list/,
    );
    expect(ext.seen).toHaveLength(0);
  });
});

describe("networkGet json path, decode and save", () => {
  const pdf = Buffer.from("%PDF-");
  const body = JSON.stringify({ data: { document: { content: pdf.toString("base64") } } });

  it("saves a base64 field of a JSON body as the file it encodes", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body } });
    const out = await t.client.networkGet({
      url: PAGE_URL,
      id: ID,
      jsonPath: "data.document.content",
      decode: "base64",
      saveAs: "doc.pdf",
    });
    const file = join(t.downloads, "doc.pdf");
    expect(readFileSync(file).equals(pdf)).toBe(true);
    expect(out.saved).toEqual({
      path: expect.stringContaining("doc.pdf"),
      bytes: 5,
      type: "application/pdf",
    });
    // The bytes never travel back to the caller.
    expect(JSON.stringify(out)).not.toContain(pdf.toString("base64"));
    expect(out.text).toBeUndefined();
  });

  it("decodes a body the page already marked base64 when saving", async () => {
    const t = setup();
    fakeExtension(t, {
      [ID]: {
        body: pdf.toString("base64"),
        encoding: "base64",
        contentType: "application/octet-stream",
      },
    });
    const out = await t.client.networkGet({ url: PAGE_URL, id: ID, saveAs: "raw.pdf" });
    expect(readFileSync(join(t.downloads, "raw.pdf")).equals(pdf)).toBe(true);
    expect(out.saved?.type).toBe("application/pdf");
  });

  it("returns the selected value as JSON text when not saving", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body } });
    const out = await t.client.networkGet({ url: PAGE_URL, id: ID, jsonPath: "data.document" });
    expect(JSON.parse(out.text ?? "")).toEqual({ content: pdf.toString("base64") });
    expect(out.truncated).toBe(false);
  });

  it("passes the helper's message through on a path miss", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body } });
    await expect(
      t.client.networkGet({ url: PAGE_URL, id: ID, jsonPath: "data.nope" }),
    ).rejects.toThrow(/No key "nope" at data\. Keys there: document\./);
  });

  it("says so when the body is not JSON", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "<html>", contentType: "text/html" } });
    await expect(t.client.networkGet({ url: PAGE_URL, id: ID, jsonPath: "a" })).rejects.toThrow(
      /body is not JSON \(content-type text\/html\)/,
    );
  });

  it("requires the selected value to be a string to decode", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: '{"n":1}' } });
    await expect(
      t.client.networkGet({ url: PAGE_URL, id: ID, jsonPath: "n", decode: "base64" }),
    ).rejects.toThrow(/must be a string/);
  });
});

describe("networkGet save confinement", () => {
  it("refuses saveAs without writes and names the setting", async () => {
    const t = setup({ APPLE_SAFARI_ALLOW_WRITES: "false" });
    const ext = fakeExtension(t, { [ID]: { body: "hello" } });
    const error = await t.client
      .networkGet({ url: PAGE_URL, id: ID, saveAs: "a.txt" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PreconditionError);
    expect(String(error.message)).toContain("APPLE_SAFARI_ALLOW_WRITES");
    expect(ext.seen).toHaveLength(0);
    expect(existsSync(join(t.downloads, "a.txt"))).toBe(false);
  });

  it("will not overwrite unless asked", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "one" } });
    await t.client.networkGet({ url: PAGE_URL, id: ID, saveAs: "a.txt" });
    await expect(t.client.networkGet({ url: PAGE_URL, id: ID, saveAs: "a.txt" })).rejects.toThrow();
    const again = await t.client.networkGet({
      url: PAGE_URL,
      id: ID,
      saveAs: "a.txt",
      overwrite: true,
    });
    expect(again.saved?.bytes).toBe(3);
  });

  it("keeps a traversal name inside the download directory", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "x" } });
    const out = await t.client
      .networkGet({ url: PAGE_URL, id: ID, saveAs: "../x.pdf" })
      .catch(() => null);
    expect(existsSync(join(root, "x.pdf"))).toBe(false);
    if (out) expect(out.saved?.path.startsWith(realpathSync(t.downloads))).toBe(true);
  });
});

describe("networkRecord", () => {
  it("refuses reload without writes and names the setting", async () => {
    const t = setup({ APPLE_SAFARI_ALLOW_WRITES: "false" });
    const ext = fakeExtension(t, {});
    const error = await t.client
      .networkRecord({ url: PAGE_URL, op: "start", reload: true })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PreconditionError);
    expect(String(error.message)).toContain("APPLE_SAFARI_ALLOW_WRITES");
    expect(ext.seen).toHaveLength(0);
  });

  it("sends the options and returns the page's state", async () => {
    const t = setup();
    const state = { recording: true, page: "3f9a2c1d", expiresAt: null, counts: {}, dropped: {} };
    const ext = fakeExtension(t, {}, { other: () => ({ ok: true, data: state }) });
    const out = await t.client.networkRecord({
      url: PAGE_URL,
      op: "start",
      captureBodies: true,
      armMinutes: 5,
    });
    expect(out).toEqual(state);
    expect(ext.seen[0]).toMatchObject({
      action: "netRecord",
      url: PAGE_URL,
      op: "start",
      captureBodies: true,
      armMinutes: 5,
    });
    expect(ext.seen[0]?.page).toBeUndefined();
  });
});

describe("networkList", () => {
  it("passes the filter and cursor and returns the page's answer", async () => {
    const t = setup();
    const answer = {
      recording: true,
      page: "3f9a2c1d",
      entries: [{ id: ID }],
      next: null,
      dropped: {},
    };
    const ext = fakeExtension(t, {}, { other: () => ({ ok: true, data: answer }) });
    const out = await t.client.networkList({
      url: PAGE_URL,
      filter: { method: "POST" },
      after: "x",
      limit: 10,
    });
    expect(out).toEqual(answer);
    expect(ext.seen[0]).toMatchObject({
      action: "netList",
      filter: { method: "POST" },
      after: "x",
      limit: 10,
    });
  });
});

describe("failures from the page", () => {
  it("surfaces an ok:false message verbatim", async () => {
    const t = setup();
    const message = `3f9a2c1d-r1 was recorded by a page load that has since gone; list again.`;
    fakeExtension(t, { [ID]: { body: "x" } }, { stale: message });
    await expect(t.client.networkGet({ url: PAGE_URL, id: ID })).rejects.toThrow(message);
  });

  it("explains an unclaimed first chunk as a stale id", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "x" } }, { answers: 0 });
    const error = await t.client.networkGet({ url: PAGE_URL, id: ID }).catch((e) => e);
    expect(error).toBeInstanceOf(PageCommandTimeoutError);
    expect(String(error.message)).toBe(
      `No page answered for request ${ID}. It was recorded by a page load that has since gone ` +
        `(reloaded, navigated or closed), or the tab is hidden and slow to answer; list again with ` +
        `apple_safari_network_list.`,
    );
  });

  it("names the chunk when the page stops answering partway through", async () => {
    const t = setup({ APPLE_SAFARI_NETWORK_CHUNK_CHARS: "16384" });
    fakeExtension(t, { [ID]: { body: "z".repeat(40_000) } }, { answers: 1 });
    const error = await t.client
      .networkGet({ url: PAGE_URL, id: ID, saveAs: "big.bin" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PageCommandTimeoutError);
    expect(String(error.message)).toContain(
      "stopped answering partway through the body (chunk 2 of 3)",
    );
  });
});

describe("headers, truncation and surrogate pairs", () => {
  it("returns headers when none are asked for explicitly, and omits them on false", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "x" } });
    expect((await t.client.networkGet({ url: PAGE_URL, id: ID })).headers).toEqual({
      "content-type": "application/json",
    });
    expect(
      (await t.client.networkGet({ url: PAGE_URL, id: ID, headers: false })).headers,
    ).toBeUndefined();
  });

  /**
   * The page redacts before anything leaves it, and this is the second layer:
   * a page copy of `network.js` from an older build, or one whose pattern
   * drifted, must still not hand a session cookie to the caller.
   */
  it("redacts sensitive headers again, whatever the page sent", async () => {
    const t = setup();
    fakeExtension(t, {
      [ID]: {
        body: "x",
        headers: {
          "content-type": "application/json",
          "Set-Cookie": "sid=abc123",
          "x-apikey": "k-1",
        },
      },
    });
    expect((await t.client.networkGet({ url: PAGE_URL, id: ID })).headers).toEqual({
      "content-type": "application/json",
      "Set-Cookie": "<redacted: 10 chars>",
      "x-apikey": "<redacted: 3 chars>",
    });
  });

  it("leaves a value the page already redacted as the page wrote it", async () => {
    const t = setup();
    fakeExtension(t, {
      [ID]: { body: "x", headers: { authorization: "<redacted: 42 chars>" } },
    });
    // Not "<redacted: 20 chars>": the length is the secret's, not the mask's.
    expect((await t.client.networkGet({ url: PAGE_URL, id: ID })).headers).toEqual({
      authorization: "<redacted: 42 chars>",
    });
  });

  it("refuses to save a body the page cut short, before pulling more", async () => {
    const t = setup();
    const ext = fakeExtension(t, { [ID]: { body: "x".repeat(40_000), truncated: true } });
    const error = await t.client
      .networkGet({ url: PAGE_URL, id: ID, saveAs: "cut.bin" })
      .catch((e) => e);
    expect(String(error.message)).toMatch(/cut short at the recording's maxBodyBytes/);
    expect(String(error.message)).toContain("50 MiB");
    expect(ext.netGets()).toHaveLength(1);
    expect(existsSync(join(t.downloads, "cut.bin"))).toBe(false);
  });

  it("refuses jsonPath on a body the page cut short", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: '{"a":1', truncated: true } });
    await expect(t.client.networkGet({ url: PAGE_URL, id: ID, jsonPath: "a" })).rejects.toThrow(
      /cut short at the recording's maxBodyBytes/,
    );
  });

  it("flags a cut-short body on an inline read, which still works", async () => {
    const t = setup();
    fakeExtension(t, { [ID]: { body: "partial", truncated: true } });
    const out = await t.client.networkGet({ url: PAGE_URL, id: ID });
    expect(out.text).toBe("partial");
    expect(out.bodyTruncated).toBe(true);
  });

  it("refuses a body evicted partway through the pull, and saves nothing", async () => {
    const t = setup({ APPLE_SAFARI_NETWORK_CHUNK_CHARS: "16384" });
    const ext = fakeExtension(t, { [ID]: { body: "z".repeat(40_000), evictAfter: 1 } });
    const error = await t.client
      .networkGet({ url: PAGE_URL, id: ID, saveAs: "big.bin" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PreconditionError);
    expect(String(error.message)).toMatch(/evicted|changed/);
    expect(ext.netGets()).toHaveLength(2);
    expect(existsSync(join(t.downloads, "big.bin"))).toBe(false);
  });

  it("reads a whole request body when only the response was cut short", async () => {
    const t = setup();
    fakeExtension(t, {
      [ID]: { body: "%PDF-".repeat(100), truncated: true, request: '{"filters":{"year":2026}}' },
    });
    const picked = await t.client.networkGet({
      url: PAGE_URL,
      id: ID,
      part: "request",
      jsonPath: "filters.year",
    });
    expect(picked.text).toBe("2026");
    expect(picked.bodyTruncated).toBe(false);
    const inline = await t.client.networkGet({ url: PAGE_URL, id: ID, part: "request" });
    expect(inline.text).toBe('{"filters":{"year":2026}}');
    expect(inline.bodyTruncated).toBe(false);
  });

  it("reassembles text whose chunk boundary falls inside an emoji", async () => {
    const t = setup({ APPLE_SAFARI_NETWORK_CHUNK_CHARS: "16384" });
    // The emoji's high half is unit 16383, so the first chunk ends one early.
    const body = "a".repeat(16_383) + "😀" + "b".repeat(20_000);
    const ext = fakeExtension(t, { [ID]: { body } });
    await t.client.networkGet({ url: PAGE_URL, id: ID, saveAs: "emoji.txt" });
    expect(readFileSync(join(t.downloads, "emoji.txt"), "utf8")).toBe(body);
    expect(ext.netGets().map((c) => c.offset)).toEqual([0, 16_383, 32_767]);
  });
});
