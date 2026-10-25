import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { normalizeFilter, WatchRegistry } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import { toAppleSeconds } from "../src/client/dates.js";
import { encodeChatRef, encodeMessageRef } from "../src/client/ref.js";
import { introspect, MessagesStore } from "../src/client/store.js";
import { MessagesArrivalSource } from "../src/client/watch.js";

/**
 * Schema only, seeded the way `store.test.ts` seeds it: triggers dropped, because
 * they call functions only Messages.app registers on its own connection.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;
const schema = (): string => readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, "");

const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

type Seed = {
  rowid: number;
  guid: string;
  chat?: number;
  handle?: number | null;
  text?: string | null;
  iso?: string;
  fromMe?: 0 | 1;
  reactionType?: number | null;
};

const addMessage = (db: DatabaseSync, m: Seed): void => {
  const date = appleNanos(m.iso ?? "2026-08-01T12:00:00Z");
  db.prepare(
    `INSERT INTO message
       (ROWID, guid, text, handle_id, service, date, is_from_me, associated_message_type)
     VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?)`,
  ).run(
    m.rowid,
    m.guid,
    m.text ?? null,
    m.handle === undefined ? 1 : m.handle,
    date,
    m.fromMe ?? 0,
    m.reactionType === undefined ? 0 : m.reactionType,
  );
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(m.chat ?? 1, m.rowid, date);
};

const build = (seed?: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema());
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+15551234567', 'iMessage'),
      (2, 'Friend@Example.com', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style, service_name) VALUES
      (1, 'iMessage;-;+15551234567', '+15551234567', NULL, 45, 'iMessage');
  `);
  seed?.(db);
  const store = new MessagesStore(db, "ro", introspect(db));
  return { db, store };
};

const maxRowid = (db: DatabaseSync): number =>
  Number((db.prepare(`SELECT MAX(ROWID) AS r FROM message`).get() as { r: number }).r);

describe("MessagesStore watch reads", () => {
  it("headRowid is the highest message ROWID, 0 when empty", () => {
    expect(build().store.headRowid()).toBe(0);
    const { store } = build((db) => {
      addMessage(db, { rowid: 5, guid: "g5" });
      addMessage(db, { rowid: 9, guid: "g9" });
    });
    expect(store.headRowid()).toBe(9);
  });

  it("arrivalsAfter returns rows past the cursor, ascending, with the handle joined", () => {
    const { store } = build((db) => {
      addMessage(db, { rowid: 3, guid: "g3", handle: 2 });
      addMessage(db, { rowid: 1, guid: "g1" });
      addMessage(db, { rowid: 2, guid: "g2", reactionType: 2000 });
    });
    const rows = store.arrivalsAfter(1, 10);
    expect(rows.map((r) => r.rowid)).toEqual([2, 3]);
    expect(rows[1]?.handle).toBe("Friend@Example.com");
    // Reactions come back too: they advance the cursor.
    expect(rows[0]?.reactionType).toBe(2000);
    expect(store.arrivalsAfter(0, 2).map((r) => r.rowid)).toEqual([1, 2]);
  });

  it("pins that the message table is AUTOINCREMENT, which the watch cursor relies on", () => {
    // A cursor is a ROWID high-water mark. If a deleted top row's id were handed
    // to the next insert, a new message could land at or below the cursor and
    // never be seen. AUTOINCREMENT forbids that; this guards the premise.
    const { db } = build();
    addMessage(db, { rowid: 1, guid: "a" });
    db.prepare(`INSERT INTO message (guid, service) VALUES ('top', 'iMessage')`).run();
    const top = maxRowid(db);
    db.prepare(`DELETE FROM message WHERE ROWID = ?`).run(top);
    db.prepare(`INSERT INTO message (guid, service) VALUES ('next', 'iMessage')`).run();
    expect(maxRowid(db)).toBeGreaterThan(top);
  });
});

describe("MessagesArrivalSource", () => {
  const source = (seed: (db: DatabaseSync) => void) =>
    new MessagesArrivalSource({ store: build(seed).store });

  it("head and since follow the store, with the cursor on the ROWID", () => {
    const s = source((db) => {
      addMessage(db, { rowid: 1, guid: "g1" });
      addMessage(db, { rowid: 2, guid: "g2" });
    });
    expect(s.head()).toBe(2);
    expect(s.since(1, 10).map((r) => r.cursor)).toEqual([2]);
  });

  it("emits ref, guid key, lowercased sender, chat ref and ISO date", () => {
    const [a] = source((db) =>
      addMessage(db, { rowid: 1, guid: "G-1", handle: 2, iso: "2026-08-02T08:30:00Z" }),
    ).since(0, 10);
    expect(a).toMatchObject({
      cursor: 1,
      key: "G-1",
      id: encodeMessageRef("G-1"),
      sender: "friend@example.com",
      handle: "Friend@Example.com",
      chat: encodeChatRef("iMessage;-;+15551234567"),
      date: "2026-08-02T08:30:00.000Z",
    });
    expect(a?.excluded).toBeUndefined();
    expect(a?.scope).toBeUndefined();
  });

  it("has a null sender and chat when the row has neither", () => {
    const { db, store } = build();
    db.prepare(
      `INSERT INTO message (ROWID, guid, service, date) VALUES (1, 'orphan', 'iMessage', ?)`,
    ).run(appleNanos("2026-08-01T12:00:00Z"));
    const [a] = new MessagesArrivalSource({ store }).since(0, 10);
    expect(a).toMatchObject({ sender: null, handle: null, chat: null });
  });

  it("excludes my own messages and tapbacks, and returns them", () => {
    const rows = source((db) => {
      addMessage(db, { rowid: 1, guid: "in" });
      addMessage(db, { rowid: 2, guid: "out", fromMe: 1 });
      addMessage(db, { rowid: 3, guid: "tap", reactionType: 2001 });
      addMessage(db, { rowid: 4, guid: "untap", reactionType: 3001 });
      addMessage(db, { rowid: 5, guid: "plain", reactionType: null });
    }).since(0, 10);
    expect(rows.map((r) => [r.key, r.excluded === true])).toEqual([
      ["in", false],
      ["out", true],
      ["tap", true],
      ["untap", true],
      ["plain", false],
    ]);
  });

  it("carries no text, even when the row has one", () => {
    const [a] = source((db) => addMessage(db, { rowid: 1, guid: "g", text: "secret body" })).since(
      0,
      10,
    );
    expect(a).toBeDefined();
    expect("text" in (a as object)).toBe(false);
    expect(JSON.stringify(a)).not.toContain("secret body");
  });

  it("returns one arrival for a message joined to several chats, and a read holds it once", () => {
    const { db, store } = build();
    db.exec(`INSERT INTO chat (ROWID, guid, chat_identifier, style, service_name)
      VALUES (2, 'iMessage;+;chat9001', 'chat9001', 43, 'iMessage')`);
    const arrivals = new MessagesArrivalSource({ store });
    const registry = new WatchRegistry({
      surface: "messages",
      source: arrivals,
      onUpdate: () => {},
    });
    const watch = registry.add(normalizeFilter({ from: ["+15551234567"] }));
    // Joined to chat 2 first, then chat 1: the lowest chat_id still wins.
    addMessage(db, { rowid: 1, guid: "multi", chat: 2 });
    db.prepare(
      `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (1, 1, 0)`,
    ).run();
    addMessage(db, { rowid: 2, guid: "after" });

    // LIMIT counts messages, not join rows.
    expect(arrivals.since(0, 1).map((r) => r.key)).toEqual(["multi"]);
    const rows = arrivals.since(0, 10);
    expect(rows.map((r) => r.cursor)).toEqual([1, 2]);
    expect(rows[0]?.chat).toBe(encodeChatRef("iMessage;-;+15551234567"));
    expect(registry.read(watch.id)?.messages.map((m) => m.key)).toEqual(["multi", "after"]);
  });

  it("keeps a missing date null rather than inventing one", () => {
    const { db, store } = build();
    db.prepare(
      `INSERT INTO message (ROWID, guid, service, date) VALUES (1, 'zero', 'iMessage', 0)`,
    ).run();
    db.prepare(`INSERT INTO message (ROWID, guid, service) VALUES (2, 'null', 'iMessage')`).run();
    const rows = new MessagesArrivalSource({ store }).since(0, 10);
    expect(rows.map((r) => r.date)).toEqual([null, null]);
  });
});
