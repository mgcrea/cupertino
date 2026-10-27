import { mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { toAppleSeconds } from "../src/client/dates.js";
import type { MessageArrival } from "../src/client/watch.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { messagesEventAdapter } from "../src/tools/events.js";

/**
 * Messages' `messages.received` adapter, over a real chat.db fixture.
 *
 * Nothing here reaches the developer's Messages or Contacts: each test owns a
 * temp store built from the captured DDL, as the watch tests do.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;
const schema = (): string => readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, "");

const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

const cleanups: (() => void)[] = [];
const opened: Client[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
  while (cleanups.length) cleanups.pop()?.();
});

type Fixture = { path: string; db: DatabaseSync };

const seedStore = (path: string): DatabaseSync => {
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
  return db;
};

const makeStore = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-apple-messages-events-"));
  const path = join(dir, "chat.db");
  const db = seedStore(path);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, db };
};

const addMessage = (
  db: DatabaseSync,
  m: { rowid: number; handle: number; chat?: number; fromMe?: 0 | 1; reaction?: number },
): void => {
  const date = appleNanos("2026-08-01T12:00:00Z");
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me, associated_message_type)
     VALUES (?, ?, 'secret body', ?, 'iMessage', ?, ?, ?)`,
  ).run(m.rowid, `guid-${m.rowid}`, m.handle, date, m.fromMe ?? 0, m.reaction ?? 0);
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(m.chat ?? 1, m.rowid, date);
};

const ON = { APPLE_MESSAGES_ALLOW_EVENTS: "1" };

const build = (fx: Fixture, env: NodeJS.ProcessEnv = ON) => {
  const config = loadConfig({ APPLE_MESSAGES_STORE: fx.path, ...env });
  return createServer({ config, home: "/nonexistent-home", contacts: null, era: "modern" });
};

const adapterFor = (fx: Fixture) => {
  const created = build(fx);
  if (!created.events) throw new Error("the events service was not built");
  return { adapter: messagesEventAdapter(created.events), ...created };
};

const connect = async (fx: Fixture, env: NodeJS.ProcessEnv = ON) => {
  const created = build(fx, env);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(a), client.connect(b)]);
  opened.push(client);
  return { ...created, client };
};

const poll = (client: Client, params: Record<string, unknown>) =>
  client.request(
    { method: "events/poll", params },
    z.looseObject({
      events: z.array(z.looseObject({})),
      cursor: z.string().nullable(),
      truncated: z.boolean(),
    }),
  );

const row = (over: Partial<MessageArrival> = {}): MessageArrival => ({
  cursor: 5,
  key: "guid-5",
  sender: "+33612345678",
  id: "msg-ref",
  chat: "chat-ref",
  handle: "+33612345678",
  date: "2026-08-01T12:00:00.000Z",
  ...over,
});

describe("messagesEventAdapter", () => {
  it("describes messages.received with poll and push, and an anyOf over from and domains", () => {
    const { adapter } = adapterFor(makeStore());
    expect(adapter.descriptor.name).toBe("messages.received");
    expect(adapter.descriptor.delivery).toEqual(["poll", "push"]);
    const input = adapter.descriptor.inputSchema as {
      properties: Record<string, { type: string; description: string }>;
      anyOf: unknown;
    };
    expect(Object.keys(input.properties)).toEqual(["from", "domains"]);
    for (const p of Object.values(input.properties)) {
      expect(p.type).toBe("array");
      expect(p.description).toBeTruthy();
    }
    expect(input.anyOf).toEqual([{ required: ["from"] }, { required: ["domains"] }]);
  });

  it("parseArguments refuses an empty filter with -32602", async () => {
    const { adapter } = adapterFor(makeStore());
    await expect(adapter.parseArguments({})).rejects.toMatchObject({ code: -32602 });
    await expect(adapter.parseArguments({ from: [] })).rejects.toMatchObject({ code: -32602 });
  });

  it("parseArguments refuses malformed arguments with -32602", async () => {
    const { adapter } = adapterFor(makeStore());
    await expect(adapter.parseArguments({ from: "a@b.c" })).rejects.toMatchObject({ code: -32602 });
  });

  it("parseArguments resolves a typed handle to the store's spelling, and keeps an unknown one", async () => {
    const { adapter } = adapterFor(makeStore());
    const filter = await adapter.parseArguments({ from: ["+33 6 12 34 56 78", "nobody@x.org"] });
    expect(filter.from).toEqual(["+33612345678", "nobody@x.org"]);
  });

  it("an unreadable store is -32603, not -32602", async () => {
    const config = loadConfig({ ...ON, APPLE_MESSAGES_STORE: "/nonexistent/chat.db" });
    const created = createServer({
      config,
      home: "/nonexistent-home",
      contacts: null,
      era: "modern",
    });
    if (!created.events) throw new Error("the events service was not built");
    const adapter = messagesEventAdapter(created.events);
    const err = await adapter.parseArguments({ from: ["a@b.c"] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).not.toBe(-32602);
    await expect(adapter.parseArguments({})).rejects.toMatchObject({ code: -32602 });

    // Over a connection, core maps that failure to -32603.
    const fx = { path: "/nonexistent/chat.db", db: undefined as never };
    const { client } = await connect(fx);
    await expect(
      poll(client, {
        name: "messages.received",
        arguments: { from: ["a@b.c"] },
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: -32603 });
  });

  it("parseArguments speaks of a subscription, never a watch", async () => {
    const { adapter } = adapterFor(makeStore());
    await expect(adapter.parseArguments({})).rejects.toThrow(
      "A subscription needs a sender: give at least one entry in `from` or `domains`.",
    );
    const fx = makeStore();
    const immutable = build(fx, { ...ON, APPLE_MESSAGES_INDEX_MODE: "immutable" });
    const err = await messagesEventAdapter(immutable.events!)
      .parseArguments({ from: ["+33612345678"] })
      .then(
        () => "",
        (e: unknown) => (e as Error).message,
      );
    expect(err).toContain("the newest messages are exactly what a subscription would miss.");
    expect(err).not.toMatch(/watch/i);
  });

  it("occurrence maps a row", () => {
    const { adapter } = adapterFor(makeStore());
    const occ = adapter.occurrence(row());
    expect(occ.eventId).toBe("guid-5");
    expect(occ.timestamp).toBe("2026-08-01T12:00:00.000Z");
    expect(Object.keys(occ.data).toSorted()).toEqual(["chat", "date", "handle", "id"]);
    expect(occ.data).toMatchObject({ id: "msg-ref", chat: "chat-ref", handle: "+33612345678" });
    expect(adapter.occurrence(row({ date: null })).timestamp).toBe("");
  });

  it("timestampMs is the message date, or null", () => {
    const { adapter } = adapterFor(makeStore());
    expect(adapter.timestampMs(row())).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
    expect(adapter.timestampMs(row({ date: null }))).toBeNull();
  });
});

describe("events over a connection", () => {
  it("poll delivers a matching message from a fixture chat.db", async () => {
    const fx = makeStore();
    const { client } = await connect(fx);
    const args = { name: "messages.received", arguments: { from: ["+33 6 12 34 56 78"] } };
    const boot = await poll(client, { ...args, cursor: null });
    expect(boot.events).toEqual([]);
    expect(boot.cursor).toMatch(/^v1\.\d+-\d+\.0$/);

    addMessage(fx.db, { rowid: 1, handle: 1 });
    addMessage(fx.db, { rowid: 2, handle: 2, chat: 1 });
    const res = await poll(client, { ...args, cursor: boot.cursor });
    expect(res.events).toHaveLength(1);
    const [event] = res.events as { name: string; eventId: string; data: object }[];
    expect(event?.name).toBe("messages.received");
    expect(event?.eventId).toBe("guid-1");
    expect(Object.keys(event?.data ?? {}).toSorted()).toEqual(["chat", "date", "handle", "id"]);
    expect(JSON.stringify(res)).not.toContain("secret body");
  });

  it("own messages and tapbacks produce no event", async () => {
    const fx = makeStore();
    const { client } = await connect(fx);
    const args = { name: "messages.received", arguments: { from: ["+33612345678"] } };
    const boot = await poll(client, { ...args, cursor: null });
    addMessage(fx.db, { rowid: 1, handle: 1, fromMe: 1 });
    addMessage(fx.db, { rowid: 2, handle: 1, reaction: 2000 });
    const res = await poll(client, { ...args, cursor: boot.cursor });
    expect(res.events).toEqual([]);
    expect(res.cursor).toMatch(/\.2$/);
  });

  it("a poll notices chat.db replaced since the last one: truncated, then the new file's rows", async () => {
    const fx = makeStore();
    for (let rowid = 1; rowid <= 5; rowid++) addMessage(fx.db, { rowid, handle: 1 });
    const { client } = await connect(fx);
    const args = { name: "messages.received", arguments: { from: ["+33612345678"] } };
    const boot = await poll(client, { ...args, cursor: null });
    expect(boot.cursor).toMatch(/\.5$/);

    // Messages rebuilds chat.db: a new file, renumbered from 1, renamed over the old one.
    // No stream is open, so no trigger runs: only the poll can notice.
    const next = `${fx.path}.rebuilt`;
    const rebuilt = seedStore(next);
    for (let rowid = 1; rowid <= 3; rowid++) addMessage(rebuilt, { rowid, handle: 1 });
    rebuilt.close();
    renameSync(next, fx.path);
    const { dev, ino } = statSync(fx.path);

    const after = await poll(client, { ...args, cursor: boot.cursor });
    expect(after.truncated).toBe(true);
    expect(after.events).toEqual([]);
    expect(after.cursor).toBe(`v1.${dev}-${ino}.3`);

    const live = new DatabaseSync(fx.path);
    cleanups.push(() => live.close());
    addMessage(live, { rowid: 4, handle: 1 });
    const later = await poll(client, { ...args, cursor: after.cursor });
    expect(later.truncated).toBe(false);
    expect(later.events.map((e) => e.eventId)).toEqual(["guid-4"]);
    expect(later.cursor).toBe(`v1.${dev}-${ino}.4`);
  });

  it("watches and events on together use separate services, both closed with the connection", async () => {
    const fx = makeStore();
    const { client, server, watches, events } = await connect(fx, {
      ...ON,
      APPLE_MESSAGES_ALLOW_WATCHES: "1",
    });
    expect(watches).toBeDefined();
    expect(events).toBeDefined();
    expect(events).not.toBe(watches);

    const made = await client.callTool({
      name: "apple_messages_watch",
      arguments: { from: ["+33612345678"] },
    });
    expect(made.isError).toBeFalsy();
    await poll(client, {
      name: "messages.received",
      arguments: { from: ["+33612345678"] },
      cursor: null,
    });
    expect(() => watches?.source.head()).not.toThrow();
    expect(() => events?.source.head()).not.toThrow();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's close hook.
    server.server.onclose?.();
    expect(() => watches?.source.head()).toThrow();
    expect(() => events?.source.head()).toThrow();
  });

  it("serves nothing with the gate off", async () => {
    const { client, events } = await connect(makeStore(), {});
    expect(events).toBeUndefined();
    await expect(
      client.request({ method: "events/list", params: {} }, z.looseObject({})),
    ).rejects.toMatchObject({ code: -32601 });
  });
});
