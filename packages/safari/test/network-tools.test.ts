import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The three network tools, through the MCP client, against a FAKE EXTENSION.
 *
 * `network-client.test.ts` covers the client half (chunking, reassembly, the
 * save) by calling it directly. What this file adds is the layer above: which
 * tools exist under which gates, how an argument becomes a command, and that a
 * refusal arrives as `isError` rather than as an exception. It deliberately
 * does not repeat the chunk arithmetic.
 *
 * Every URL is `example.test`. The one real site this feature was built for
 * serves a PDF behind a signing link that is a bearer credential, and neither
 * that link nor anything shaped like it belongs in a fixture.
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

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  root = mkdtempSync(join(tmpdir(), "safari-nettools-"));
  const pages = join(root, "pages");
  const downloads = join(root, "downloads");
  mkdirSync(pages, { recursive: true });
  const config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_PAGES: pages,
    APPLE_SAFARI_DOWNLOAD_DIR: downloads,
    APPLE_SAFARI_ACTION_TIMEOUT_MS: "800",
    ...env,
  });
  const { server } = createServer({ config, home: "/nonexistent-home", osascript: fakeOsascript });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, downloads, commands: join(root, "commands"), results: join(root, "results") };
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
 * Answer commands the way the native handler and content script do together:
 * claim by deletion, reply by writing `results/<id>.json`. `netGet` is sliced
 * honestly by `offset`/`length` from `body`; everything else goes to `other`.
 */
const fakeExtension = (
  dirs: { commands: string; results: string },
  opts: {
    body?: string;
    other?: (command: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string };
  } = {},
) => {
  const seen: Record<string, unknown>[] = [];
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
      let reply: { ok: boolean; data?: unknown; error?: string };
      if (command.action === "netGet") {
        const body = opts.body ?? "";
        const offset = Math.min(Number(command.offset) || 0, body.length);
        const length = Number(command.length) > 0 ? Number(command.length) : body.length - offset;
        const slice = body.slice(offset, offset + length);
        reply = {
          ok: true,
          data: {
            entry: { id: command.requestId, bodyTruncated: false, contentType: "application/json" },
            ...(command.headers === false
              ? {}
              : { headers: { "content-type": "application/json" } }),
            encoding: "text",
            totalChars: body.length,
            offset,
            slice,
            done: offset + slice.length >= body.length,
          },
        };
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
  return { seen, of: (action: string) => seen.filter((c) => c.action === action) };
};

const NET_TOOLS = [
  "apple_safari_network_get",
  "apple_safari_network_list",
  "apple_safari_network_record",
];

const netNames = async (c: Client) =>
  (await c.listTools()).tools
    .map((t) => t.name)
    .filter((n) => n.startsWith("apple_safari_network_"))
    .toSorted();

describe("network tool registration", () => {
  it("registers none of the three with the gate off, even with writes on", async () => {
    const { client } = await connect({ APPLE_SAFARI_ALLOW_WRITES: "true" });
    expect(await netNames(client)).toEqual([]);
  });

  it("registers all three with the gate on and writes off", async () => {
    const { client } = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    expect(await netNames(client)).toEqual(NET_TOOLS);
  });

  it("keeps the network gate independent of the codes gate, both ways", async () => {
    const off = (await (await connect()).client.listTools()).tools.map((t) => t.name);
    const net = (
      await (await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" })).client.listTools()
    ).tools.map((t) => t.name);
    const codes = (
      await (await connect({ APPLE_SAFARI_ALLOW_CODES: "true" })).client.listTools()
    ).tools.map((t) => t.name);
    expect(net.filter((n) => !off.includes(n)).toSorted()).toEqual(NET_TOOLS);
    expect(codes.filter((n) => !off.includes(n))).toEqual(["apple_safari_find_codes"]);
  });

  it("annotates record, list and get as the brief says", async () => {
    const { client } = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const { tools } = await client.listTools();
    const of = (n: string) => tools.find((t) => t.name === n)?.annotations;
    expect(of("apple_safari_network_record")).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(of("apple_safari_network_list")).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(of("apple_safari_network_get")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("states the limits a caller would otherwise discover the hard way", async () => {
    const { client } = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const { tools } = await client.listTools();
    const all = tools
      .filter((t) => t.name.startsWith("apple_safari_network_"))
      .map((t) => t.description ?? "")
      .join("\n");
    expect(all).toMatch(/subframe/i);
    expect(all).toMatch(/WebSocket/);
    expect(all).toMatch(/NOT redacted/);
    expect(all).toMatch(/reload/);
    expect(all).toContain("APPLE_SAFARI_ALLOW_WRITES");
    expect(all).toContain("jsonPath");
    expect(all).toContain("saveAs");
  });

  it("says how the hook gets into the page, and what a strict CSP costs", async () => {
    const { client } = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const { tools } = await client.listTools();
    const record = JSON.stringify(tools.find((t) => t.name === "apple_safari_network_record"));
    expect(record).toContain("hook.injection");
    expect(record).toMatch(/Content-Security-Policy/);
    expect(record).toMatch(/first requests/i);
    expect(record).not.toContain("hook.background");
  });
});

describe("network tools with writes off", () => {
  it("refuses reload with an error naming APPLE_SAFARI_ALLOW_WRITES", async () => {
    const t = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const ext = fakeExtension(t);
    const r = await call(t.client, "apple_safari_network_record", {
      url: PAGE_URL,
      action: "start",
      reload: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_ALLOW_WRITES");
    expect(ext.seen).toHaveLength(0);
  });

  it("refuses saveAs the same way, before pulling anything", async () => {
    const t = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const ext = fakeExtension(t, { body: "{}" });
    const r = await call(t.client, "apple_safari_network_get", {
      url: PAGE_URL,
      id: ID,
      saveAs: "x.pdf",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_ALLOW_WRITES");
    expect(ext.seen).toHaveLength(0);
  });

  it("still records without reload", async () => {
    const t = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const ext = fakeExtension(t, {
      other: () => ({ ok: true, data: { recording: true, page: "3f9a2c1d", expiresAt: null } }),
    });
    const r = await call(t.client, "apple_safari_network_record", {
      url: PAGE_URL,
      action: "start",
      kinds: ["xhr"],
      armMinutes: 30,
    });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ recording: true, page: "3f9a2c1d" });
    expect(ext.of("netRecord")[0]).toMatchObject({
      op: "start",
      kinds: ["xhr"],
      armMinutes: 30,
      url: PAGE_URL,
    });
  });
});

describe("network_list", () => {
  const listed = async (args: Record<string, unknown>) => {
    const t = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const ext = fakeExtension(t, {
      other: () => ({
        ok: true,
        data: { recording: true, page: "3f9a2c1d", entries: [{ id: ID }], next: null },
      }),
    });
    const r = await call(t.client, "apple_safari_network_list", { url: PAGE_URL, ...args });
    return { r, filter: ext.of("netList")[0]?.filter as Record<string, unknown> | undefined };
  };

  it("turns an exact status into statusMin and statusMax", async () => {
    const { r, filter } = await listed({ status: "404" });
    expect(r.isError).toBe(false);
    expect(filter).toMatchObject({ statusMin: 404, statusMax: 404 });
  });

  it("turns a range into statusMin and statusMax, inclusive", async () => {
    const { filter } = await listed({ status: "400-599", failed: true, method: "post" });
    expect(filter).toMatchObject({ statusMin: 400, statusMax: 599, failed: true, method: "post" });
  });

  it("rejects a malformed status with an example", async () => {
    for (const status of ["4xx", "400-", "599-400", "40"]) {
      const { r } = await listed({ status });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("400-599");
    }
  });

  it("returns the entries", async () => {
    const { r } = await listed({});
    expect(r.json()).toMatchObject({ entries: [{ id: ID }] });
  });
});

describe("the PDF recipe, end to end", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const body = JSON.stringify({ data: { document: { content: pdf.toString("base64") } } });

  it("selects, decodes and saves without returning the bytes", async () => {
    const t = await connect({
      APPLE_SAFARI_ALLOW_NETWORK: "true",
      APPLE_SAFARI_ALLOW_WRITES: "true",
    });
    fakeExtension(t, { body });
    const r = await call(t.client, "apple_safari_network_get", {
      url: PAGE_URL,
      id: ID,
      jsonPath: "data.document.content",
      decode: "base64",
      saveAs: "signed.pdf",
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(t.downloads, "signed.pdf"))).toEqual(pdf);
    const out = r.json() as { saved: { path: string; bytes: number; type: string | null } };
    expect(out.saved).toMatchObject({ bytes: pdf.length, type: "application/pdf" });
    expect(out.saved.path).toBe(realpathSync(join(t.downloads, "signed.pdf")));
    expect(r.text).not.toContain(pdf.toString("base64"));
  });

  it("says plainly when the saved type was not recognised", async () => {
    const t = await connect({
      APPLE_SAFARI_ALLOW_NETWORK: "true",
      APPLE_SAFARI_ALLOW_WRITES: "true",
    });
    fakeExtension(t, {
      body: JSON.stringify({ v: Buffer.from("plain words").toString("base64") }),
    });
    const r = await call(t.client, "apple_safari_network_get", {
      url: PAGE_URL,
      id: ID,
      jsonPath: "v",
      decode: "base64",
      saveAs: "mystery.bin",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/not recogni[sz]ed/i);
  });

  it("refuses to overwrite unless asked", async () => {
    const t = await connect({
      APPLE_SAFARI_ALLOW_NETWORK: "true",
      APPLE_SAFARI_ALLOW_WRITES: "true",
    });
    fakeExtension(t, { body });
    const args = {
      url: PAGE_URL,
      id: ID,
      jsonPath: "data.document.content",
      decode: "base64",
      saveAs: "signed.pdf",
    };
    expect((await call(t.client, "apple_safari_network_get", args)).isError).toBe(false);
    expect((await call(t.client, "apple_safari_network_get", args)).isError).toBe(true);
    expect(
      (await call(t.client, "apple_safari_network_get", { ...args, overwrite: true })).isError,
    ).toBe(false);
  });

  it("reads inline with headers and the truncation fields", async () => {
    const t = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    fakeExtension(t, { body: "abcdefghij" });
    const r = await call(t.client, "apple_safari_network_get", {
      url: PAGE_URL,
      id: ID,
      offset: 2,
      maxChars: 3,
    });
    expect(r.json()).toMatchObject({
      text: "cde",
      truncated: true,
      nextOffset: 5,
      totalChars: 10,
      bodyTruncated: false,
      headers: { "content-type": "application/json" },
    });
  });

  it("turns a page's refusal into an error result", async () => {
    const t = await connect({ APPLE_SAFARI_ALLOW_NETWORK: "true" });
    const r = await call(t.client, "apple_safari_network_get", { url: PAGE_URL, id: "nonsense" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("apple_safari_network_list");
  });
});
