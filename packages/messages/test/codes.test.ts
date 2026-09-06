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
 * `apple_messages_find_codes` against a store that opens.
 *
 * The thing under test is what `limit` bounds. It used to cap the messages
 * SCANNED: the tool fetched `limit` rows newest-first and only then discarded
 * the user's own messages and anything not matching `service`. So an ordinary
 * few minutes of replies pushed the code being looked for off a page that was
 * never about it, and the tool answered `count: 0` — which its own description
 * has to warn does NOT mean the code was missed.
 *
 * The store is built under a temp `home` so discovery never reaches the
 * developer's own conversations, and `contacts: null` keeps the resolver away
 * from their address book.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;
const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

let home: string;

/** Recent, because the tool's window is minutes wide by default. */
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

beforeAll(() => {
  home = join(mkdtempSync(join(tmpdir(), "mcp-apple-messages-codes-")), "home");
  mkdirSync(join(home, "Library", "Messages"), { recursive: true });

  const db = new DatabaseSync(join(home, "Library", "Messages", "chat.db"));
  db.exec(readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, ""));
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+15551234567', 'iMessage'),
      (2, '272121', 'SMS');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style, service_name) VALUES
      (1, 'iMessage;-;+15551234567', '+15551234567', NULL, 45, 'iMessage'),
      (2, 'SMS;-;272121', '272121', NULL, 45, 'SMS');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 2);
  `);

  const message = db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me,
       associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const link = db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  );

  // The code, and then a burst of the user's OWN replies after it. Newest
  // first, the replies come back before the code does.
  const rows: [number, string, string, number, string, number, 0 | 1, string][] = [
    [1, "CODE", "Your Acme code is 448213", 2, "SMS", 2, 0, minutesAgo(4)],
    [2, "R1", "on my way", 1, "iMessage", 1, 1, minutesAgo(3)],
    [3, "R2", "five minutes", 1, "iMessage", 1, 1, minutesAgo(2)],
    [4, "R3", "here now", 1, "iMessage", 1, 1, minutesAgo(1)],
  ];
  for (const [rowid, guid, text, handle, service, chat, fromMe, iso] of rows) {
    message.run(rowid, guid, text, handle, service, appleNanos(iso), fromMe);
    link.run(chat, rowid, appleNanos(iso));
  }
  db.close();
});

const find = async (args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const { server } = createServer({
    config: loadConfig({ APPLE_MESSAGES_ALLOW_CODES: "1" }),
    home,
    contacts: null,
  });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({
    name: "apple_messages_find_codes",
    arguments: args,
  })) as { content: { text: string }[]; isError?: boolean };
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(res.content.map((c) => c.text).join("")) as Record<string, unknown>;
};

describe("apple_messages_find_codes over MCP", () => {
  it("finds a recent code", async () => {
    const body = await find();
    expect(body.count).toBe(1);
    expect((body.codes as { code: string }[])[0]?.code).toBe("448213");
  });

  /**
   * Three of the user's own replies are newer than the code. With `limit: 2`
   * applied to the SCAN, the code was never looked at.
   */
  it("looks past the user's own newer replies", async () => {
    const body = await find({ limit: 2 });
    expect(body.count).toBe(1);
    expect((body.codes as { code: string }[])[0]?.code).toBe("448213");
  });

  it("still never returns a code the user sent themselves", async () => {
    const body = await find({ limit: 10 });
    for (const c of body.codes as { from: { handle: string | null } }[]) {
      expect(c.from.handle).not.toBe("+15551234567");
    }
  });

  it("limits the CODES returned, not the messages scanned", async () => {
    const body = await find({ limit: 1 });
    expect((body.codes as unknown[]).length).toBeLessThanOrEqual(1);
  });
});
