import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toAppleSeconds } from "../src/client/dates.js";
import { AppleMessagesClient } from "../src/client/messages.js";
import { encodeChatRef, encodeMessageRef } from "../src/client/ref.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The watch tools, over a real chat.db fixture.
 *
 * Nothing here reaches the developer's Messages or Contacts: each test owns a
 * temp store built from the captured DDL (triggers dropped, as `store.test.ts`
 * does), and `contacts: null` keeps the resolver away from the address book.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;
const schema = (): string => readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, "");

const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

const cleanups: (() => void)[] = [];
/** Connections are closed first, so no watcher outlives the temp dir it watches. */
const opened: Client[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
  while (cleanups.length) cleanups.pop()?.();
  vi.restoreAllMocks();
});

type Fixture = { path: string; db: DatabaseSync };

const makeStore = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-apple-messages-watch-tools-"));
  const path = join(dir, "chat.db");
  const db = new DatabaseSync(path);
  db.exec(schema());
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+33612345678', 'iMessage'),
      (2, '+33698765432', 'iMessage'),
      (3, 'Friend@Example.com', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style, service_name) VALUES
      (1, 'iMessage;-;+33612345678', '+33612345678', NULL, 45, 'iMessage'),
      (2, 'iMessage;-;Friend@Example.com', 'Friend@Example.com', NULL, 45, 'iMessage');
  `);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, db };
};

const addMessage = (
  db: DatabaseSync,
  m: { rowid: number; handle: number; chat?: number; text?: string; fromMe?: 0 | 1 },
): void => {
  const date = appleNanos("2026-08-01T12:00:00Z");
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me, associated_message_type)
     VALUES (?, ?, ?, ?, 'iMessage', ?, ?, 0)`,
  ).run(m.rowid, `guid-${m.rowid}`, m.text ?? "secret body", m.handle, date, m.fromMe ?? 0);
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(m.chat ?? 1, m.rowid, date);
};

const connect = async (fx: Fixture, env: NodeJS.ProcessEnv = {}) => {
  const config = loadConfig({ APPLE_MESSAGES_STORE: fx.path, ...env });
  const created = createServer({
    config,
    home: "/nonexistent-home",
    contacts: null,
    era: "modern",
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(a), client.connect(b)]);
  opened.push(client);
  return { client, messages: created.client, server: created.server, watches: created.watches };
};

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Result): string => (r.content as { text: string }[])[0]?.text ?? "";
const json = (r: Result) => JSON.parse(textOf(r));
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const watch = (c: Client, args: Record<string, unknown>) =>
  c.callTool({ name: "apple_messages_watch", arguments: args });
const read = async (c: Client, uri: string) => {
  const res = await c.readResource({ uri });
  return JSON.parse(String((res.contents[0] as { text?: string }).text));
};

const ON = { APPLE_MESSAGES_ALLOW_WATCHES: "1" };

describe("the allowWatches gate", () => {
  it("lists neither tool, and declares no subscribe, with the gate off", async () => {
    const { client } = await connect(makeStore());
    const tools = await names(client);
    expect(tools).not.toContain("apple_messages_watch");
    expect(tools).not.toContain("apple_messages_unwatch");
    expect(client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
  });

  it("lists both tools with the gate on, even with prompts off", async () => {
    const off = await names((await connect(makeStore())).client);
    const { client } = await connect(makeStore(), { ...ON, APPLE_MESSAGES_EXPOSE_PROMPTS: "0" });
    const on = await names(client);
    expect(on.filter((n) => !off.includes(n)).toSorted()).toEqual([
      "apple_messages_unwatch",
      "apple_messages_watch",
    ]);
    expect(off.filter((n) => !on.includes(n))).toEqual([]);
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
  });

  it("marks both readOnly, with writes off", async () => {
    const { client } = await connect(makeStore(), ON);
    const { tools } = await client.listTools();
    for (const n of ["apple_messages_watch", "apple_messages_unwatch"]) {
      expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("opens nothing on a server that never sees a watch call", async () => {
    // Spies go on the prototype first, so even a call made while the server is built is seen.
    const store = vi.spyOn(AppleMessagesClient.prototype, "store");
    const located = vi.spyOn(AppleMessagesClient.prototype, "located");
    const watchStore = vi.spyOn(AppleMessagesClient.prototype, "watchStore");
    const { client } = await connect(makeStore(), ON);
    await client.listTools();
    expect(store).not.toHaveBeenCalled();
    expect(located).not.toHaveBeenCalled();
    expect(watchStore).not.toHaveBeenCalled();
  });
});

describe("apple_messages_watch", () => {
  it("refuses an empty filter, naming from and domains", async () => {
    const { client } = await connect(makeStore(), ON);
    const res = await watch(client, {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/from/);
    expect(textOf(res)).toMatch(/domains/);
  });

  it("stores a typed number as the store's own spelling", async () => {
    const { client } = await connect(makeStore(), ON);
    const res = await watch(client, { from: ["+33 6 12 34 56 78"] });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.watch).toMatch(/^w_/);
    expect(out.uri).toBe(`cupertino://messages/watch/${out.watch}`);
    expect(out.filter).toEqual({ from: ["+33612345678"], domains: [] });
    expect(out.unresolved).toEqual([]);
    expect(out.cursor).toBe(0);
  });

  it("resolves an email case-insensitively", async () => {
    const { client } = await connect(makeStore(), ON);
    const out = json(await watch(client, { from: ["FRIEND@example.com"] }));
    expect(out.filter.from).toEqual(["friend@example.com"]);
    expect(out.unresolved).toEqual([]);
  });

  it("keeps a handle the store does not hold, lowercased, and lists it as unresolved", async () => {
    const { client } = await connect(makeStore(), ON);
    const out = json(await watch(client, { from: ["Nobody@Example.org", "+33 6 12 34 56 78"] }));
    expect(out.filter.from).toEqual(["nobody@example.org", "+33612345678"]);
    expect(out.unresolved).toEqual(["nobody@example.org"]);
  });

  it("leaves a local spelling unresolved, with the stored handle as a suggestion, and never fires", async () => {
    const fx = makeStore();
    const { client } = await connect(fx, ON);
    const out = json(await watch(client, { from: ["06 12 34 56 78"] }));
    expect(out.filter.from).toEqual(["0612345678"]);
    expect(out.unresolved).toEqual(["0612345678"]);
    expect(out.suggestions).toEqual([{ typed: "06 12 34 56 78", candidates: ["+33612345678"] }]);
    addMessage(fx.db, { rowid: 1, handle: 1 });
    expect((await read(client, out.uri)).messages).toEqual([]);
  });

  it("returns no suggestions when nothing is near", async () => {
    const { client } = await connect(makeStore(), ON);
    const out = json(await watch(client, { from: ["nobody@example.org"] }));
    expect(out.suggestions).toBeUndefined();
  });

  it("reads the store's handles once per call, however many entries", async () => {
    const { client, messages } = await connect(makeStore(), ON);
    await watch(client, { domains: ["a.com"] });
    const handles = vi.spyOn(messages.watchStore().store, "handles");
    await watch(client, { from: ["+33 6 12 34 56 78", "friend@example.com", "x@y.z"] });
    expect(handles).toHaveBeenCalledTimes(1);
  });

  it("does not let a short prefix match every number that starts with it", async () => {
    const { client } = await connect(makeStore(), ON);
    const out = json(await watch(client, { from: ["+336"] }));
    expect(out.filter.from).toEqual(["+336"]);
    expect(out.unresolved).toEqual(["+336"]);
  });

  it("shares one setup between two concurrent watches", async () => {
    const { client, messages } = await connect(makeStore(), ON);
    const watchStore = vi.spyOn(messages, "watchStore");
    const [one, two] = await Promise.all([
      watch(client, { domains: ["a.com"] }),
      watch(client, { domains: ["b.com"] }),
    ]);
    expect(one.isError).toBeFalsy();
    expect(two.isError).toBeFalsy();
    expect(json(one).watch).not.toBe(json(two).watch);
    expect(watchStore).toHaveBeenCalledTimes(1);
  });

  it("refuses when the store only opens immutable, naming the WAL", async () => {
    const { client } = await connect(makeStore(), {
      ...ON,
      APPLE_MESSAGES_INDEX_MODE: "immutable",
    });
    const res = await watch(client, { domains: ["example.com"] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("WAL");
    expect(textOf(res)).toContain("APPLE_MESSAGES_INDEX_MODE");
    expect(textOf(res)).not.toContain("Full Disk Access");
  });

  it("refuses with the client's store error when it cannot be opened", async () => {
    const fx = makeStore();
    const missing = join(fx.path, "..", "missing", "chat.db");
    const { client, messages } = await connect(fx, { ...ON, APPLE_MESSAGES_STORE: missing });
    const res = await watch(client, { domains: ["example.com"] });
    expect(res.isError).toBe(true);
    expect(messages.located().reason).toBeTruthy();
    expect(textOf(res)).toContain(messages.located().reason!);
  });

  it("refuses when the index is switched off", async () => {
    const { client } = await connect(makeStore(), { ...ON, APPLE_MESSAGES_INDEX_MODE: "off" });
    const res = await watch(client, { domains: ["example.com"] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("APPLE_MESSAGES_INDEX_MODE=off");
  });

  it("retries setup after a failure instead of keeping it", async () => {
    const { client, messages } = await connect(makeStore(), ON);
    const real = messages.watchStore.bind(messages);
    const spy = vi.spyOn(messages, "watchStore").mockImplementationOnce(() => {
      throw new Error("not yet");
    });
    expect((await watch(client, { domains: ["a.com"] })).isError).toBe(true);
    spy.mockImplementation(real);
    expect((await watch(client, { domains: ["a.com"] })).isError).toBeFalsy();
  });

  it("stops its watches when the server closes", async () => {
    const { client, server, watches } = await connect(makeStore(), ON);
    await watch(client, { domains: ["a.com"] });
    expect(watches?.count).toBe(1);
    await server.close();
    expect(watches?.count).toBe(0);
  });
});

describe("reading a watch", () => {
  it("returns id, handle, chat and date, and no text", async () => {
    const fx = makeStore();
    addMessage(fx.db, { rowid: 10, handle: 1 });
    const { client } = await connect(fx, ON);
    const made = json(await watch(client, { from: ["+33 6 12 34 56 78"] }));
    expect(made.cursor).toBe(10);
    addMessage(fx.db, { rowid: 11, handle: 1 });

    const body = await read(client, made.uri);
    expect(body.watch).toBe(made.uri);
    expect(body.cursor).toBe(11);
    expect(body.messages).toHaveLength(1);
    const [m] = body.messages;
    expect(Object.keys(m)).toEqual(expect.arrayContaining(["id", "handle", "chat", "date"]));
    expect(m).not.toHaveProperty("text");
    expect(m.handle).toBe("+33612345678");
    expect(m.id).toBe(encodeMessageRef("guid-11"));
    expect(m.chat).toBe(encodeChatRef("iMessage;-;+33612345678"));
    expect(m.date).toBe("2026-08-01T12:00:00.000Z");
    expect(JSON.stringify(body)).not.toContain("secret body");
  });

  it("matches the handle the caller typed in another spelling", async () => {
    const fx = makeStore();
    const { client } = await connect(fx, ON);
    const made = json(await watch(client, { from: ["+33 6 12 34 56 78"] }));
    addMessage(fx.db, { rowid: 1, handle: 1 });
    addMessage(fx.db, { rowid: 2, handle: 2 });
    const body = await read(client, made.uri);
    expect(body.messages.map((x: { handle: string }) => x.handle)).toEqual(["+33612345678"]);
  });

  it("never fires for my own messages", async () => {
    const fx = makeStore();
    const { client } = await connect(fx, ON);
    const made = json(await watch(client, { from: ["+33612345678"] }));
    addMessage(fx.db, { rowid: 1, handle: 1, fromMe: 1 });
    addMessage(fx.db, { rowid: 2, handle: 1 });
    const body = await read(client, made.uri);
    expect(body.messages).toHaveLength(1);
  });

  it("matches `domains` against email handles only, never a phone handle", async () => {
    const fx = makeStore();
    const { client } = await connect(fx, ON);
    const made = json(await watch(client, { domains: ["example.com"] }));
    expect(made.unresolved).toEqual([]);
    addMessage(fx.db, { rowid: 1, handle: 1 });
    addMessage(fx.db, { rowid: 2, handle: 3, chat: 2 });
    const body = await read(client, made.uri);
    expect(body.messages.map((x: { handle: string }) => x.handle)).toEqual(["Friend@Example.com"]);
  });

  it("reading a watch after unwatch is a not-found error", async () => {
    const { client } = await connect(makeStore(), ON);
    const { watch: id, uri } = json(await watch(client, { domains: ["a.com"] }));
    await expect(client.readResource({ uri })).resolves.toBeDefined();
    await client.callTool({ name: "apple_messages_unwatch", arguments: { watch: id } });
    await expect(client.readResource({ uri })).rejects.toMatchObject({ code: -32602 });
  });
});

describe("apple_messages_unwatch", () => {
  it("removes a watch once, then reports false", async () => {
    const { client } = await connect(makeStore(), ON);
    const { watch: id } = json(await watch(client, { domains: ["a.com"] }));
    const first = json(
      await client.callTool({ name: "apple_messages_unwatch", arguments: { watch: id } }),
    );
    const again = json(
      await client.callTool({ name: "apple_messages_unwatch", arguments: { watch: id } }),
    );
    expect(first).toEqual({ removed: true });
    expect(again).toEqual({ removed: false });
  });
});
