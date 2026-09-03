import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { toAppleSeconds } from "../src/client/dates.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * `apple_messages_count_messages` end to end, against a store that opens.
 *
 * `store.test.ts` pins the SQL. What this suite is for is the half a store test
 * cannot see: that the tool is reachable over MCP, that a grouped result comes
 * back in the SHARED aggregation envelope — the same `groupedBy` / `totalRows` /
 * `truncated` shape Mail's query lane returns, so a model reads one having
 * learned the other — and that a chat group carries a ref you can hand straight
 * to `list_messages`.
 *
 * The store is built in a temp directory handed over as the server's `home`, so
 * discovery never reaches the developer's own conversations; `contacts: null`
 * keeps the resolver away from their address book.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;
const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

let home: string;

const build = (): void => {
  home = join(mkdtempSync(join(tmpdir(), "mcp-apple-messages-count-")), "home");
  mkdirSync(join(home, "Library", "Messages"), { recursive: true });

  const db = new DatabaseSync(join(home, "Library", "Messages", "chat.db"));
  db.exec(readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, ""));
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+15551234567', 'iMessage'),
      (2, 'friend@example.com', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style, service_name) VALUES
      (1, 'iMessage;-;+15551234567', '+15551234567', NULL, 45, 'iMessage'),
      (2, 'iMessage;+;chat9001', 'chat9001', 'Book club', 43, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 1), (2, 2);
  `);

  const message = db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me,
       associated_message_type) VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?)`,
  );
  const link = db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  );
  const rows: [number, string, number, number, 0 | 1, string, number][] = [
    [1, "A", 1, 1, 1, "2026-08-01T12:00:00Z", 0],
    [2, "B", 1, 1, 0, "2026-08-02T12:00:00Z", 0],
    [3, "C", 1, 1, 0, "2026-08-03T12:00:00Z", 0],
    [4, "D", 2, 2, 0, "2026-08-04T12:00:00Z", 0],
    // A tapback, which must not be counted as something somebody wrote.
    [5, "E", 1, 1, 0, "2026-08-05T12:00:00Z", 2000],
  ];
  for (const [rowid, guid, chat, handle, fromMe, iso, reaction] of rows) {
    message.run(rowid, guid, `text ${guid}`, handle, appleNanos(iso), fromMe, reaction);
    link.run(chat, rowid, appleNanos(iso));
  }
  db.close();
};

const connect = async (): Promise<Client> => {
  const config = loadConfig({});
  const { server } = createServer({ config, home, contacts: null });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const count = async (args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = (await (
    await connect()
  ).callTool({
    name: "apple_messages_count_messages",
    arguments: args,
  })) as { content: { text: string }[]; isError?: boolean };
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(res.content.map((c) => c.text).join("")) as Record<string, unknown>;
};

beforeAll(build);

describe("apple_messages_count_messages over MCP", () => {
  it("answers a plain count with the sent/received split", async () => {
    expect(await count()).toMatchObject({ total: 4, sent: 1, received: 3 });
  });

  it("groups by chat in the shared aggregation envelope", async () => {
    const result = await count({ groupBy: "chat" });
    expect(result).toMatchObject({
      groupedBy: "chat",
      totalGroups: 2,
      totalRows: 4,
      truncated: false,
    });
    expect(result.groups).toMatchObject([
      { key: "iMessage;-;+15551234567", count: 3, ref: "mc1:iMessage;-;+15551234567" },
      { key: "iMessage;+;chat9001", label: "Book club", count: 1 },
    ]);
  });

  it("caps groups without capping what was counted, and says so", async () => {
    const result = await count({ groupBy: "day", limit: 2 });
    expect(result).toMatchObject({ totalGroups: 4, totalRows: 4, truncated: true });
    expect(result.groups).toHaveLength(2);
  });

  it("counts one person across their conversations", async () => {
    const result = await count({ groupBy: "handle" });
    // Three with the phone number: two received and one sent, since an outgoing
    // one-to-one row carries the correspondent's handle, not the sender's.
    expect(result.groups).toMatchObject([
      { key: "+15551234567", count: 3, sent: 1, received: 2 },
      { key: "friend@example.com", count: 1, sent: 0, received: 1 },
    ]);
  });

  it("narrows to a window, and to one direction", async () => {
    expect(await count({ from: "2026-08-02", to: "2026-08-04" })).toMatchObject({ total: 2 });
    expect(await count({ direction: "sent" })).toMatchObject({ total: 1, received: 0 });
  });

  it("refuses a date it cannot read rather than counting the whole store", async () => {
    const res = (await (
      await connect()
    ).callTool({
      name: "apple_messages_count_messages",
      arguments: { from: "last tuesday" },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join("")).toContain("ISO-8601");
  });
});
