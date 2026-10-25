import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { MailWatchService } from "../src/tools/watch.js";

/**
 * Reading a watch's handle, and keeping a running watch's mailbox map fresh.
 * Each test owns a private index so it can add mail and mailboxes underneath a
 * live watch.
 */
const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");
const UUID = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";

const ACCOUNTS = [
  {
    id: UUID,
    name: "iCloud",
    enabled: true,
    accountType: "iCloud",
    emailAddresses: ["me@icloud.com"],
    fullName: "Me",
    directory: null,
    messageCaching: null,
    mailboxes: ["INBOX", "Receipts"],
  },
];

const runner = (): OsascriptRunner => ({
  run: vi.fn(async (script: string) =>
    script.includes("a.emailAddresses()") ? ACCOUNTS : [],
  ) as OsascriptRunner["run"],
});

const running = async () => true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const copyIndex = (): { path: string; db: DatabaseSync } => {
  const d = mkdtempSync(join(tmpdir(), "mcp-apple-mail-watch-copy-"));
  const path = join(d, "Envelope Index");
  const db = new DatabaseSync(path);
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${UUID}/INBOX', 0, 0);
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Hello');
    INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'sam@example.com', 'Sam');
  `);
  cleanups.push(() => {
    db.close();
    rmSync(d, { recursive: true, force: true });
  });
  return { path, db };
};

const addMessage = (db: DatabaseSync, rowid: number, mailbox: number): void => {
  db.exec(`
    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
       mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES (${rowid}, 0, ${rowid + 7000}, 1, NULL, 1, 1790000000, 1790000005, ${mailbox}, 0, 0, 0, 0, 100, 900);
  `);
};

describe("reading a watch", () => {
  it("returns the spec's shape, with only what arrived after the watch", async () => {
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    const config = loadConfig({
      APPLE_MAIL_ENVELOPE_INDEX: fx.path,
      APPLE_MAIL_ALLOW_WATCHES: "1",
    });
    const created = createServer({
      config,
      osascript: runner(),
      era: "modern",
      isMailRunning: running,
    });
    const c = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(a), c.connect(b)]);

    const made = await c.callTool({
      name: "apple_mail_watch",
      arguments: { from: ["sam@example.com"] },
    });
    const { uri, cursor } = JSON.parse((made.content as { text: string }[])[0]!.text);
    expect(cursor).toBe(10);
    addMessage(fx.db, 11, 1);

    const res = await c.readResource({ uri });
    const body = JSON.parse(String((res.contents[0] as { text?: string }).text));
    expect(Object.keys(body).toSorted()).toEqual(["cursor", "filter", "messages", "more", "watch"]);
    expect(body.watch).toBe(uri);
    expect(body.cursor).toBe(11);
    expect(body.more).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      mailbox: "INBOX",
      senderAddress: "sam@example.com",
      subject: "Hello",
    });
    expect(body.messages[0].ref).toMatch(/^m1:/);
  });
});

describe("MailWatchService freshness", () => {
  it("picks up a mailbox created after the watch started, once the TTL has passed", async () => {
    const fx = copyIndex();
    const config = loadConfig({
      APPLE_MAIL_ENVELOPE_INDEX: fx.path,
      APPLE_MAIL_MAILBOX_CACHE_TTL_MS: "1000",
    });
    const client = new AppleMailClient({ config, osascript: runner() });
    let clock = 1_000_000;
    const service = new MailWatchService({ client, config, now: () => clock });
    await service.ensure();

    fx.db.exec(`INSERT INTO mailboxes (ROWID, url, total_count, unread_count)
                VALUES (2, 'imap://${UUID}/Receipts', 0, 0)`);
    addMessage(fx.db, 20, 2);

    // Inside the TTL the lookup is the old one: the new mailbox is unknown, so excluded.
    clock += 500;
    await service.onTrigger(() => {});
    expect(service.source.since(0, 10)[0]?.excluded).toBe(true);

    clock += 1000;
    await service.onTrigger(() => {});
    const row = service.source.since(0, 10)[0];
    expect(row?.excluded).toBeUndefined();
    expect(row?.mailbox).toBe("Receipts");
  });

  it("ticks only after the refresh has settled", async () => {
    const fx = copyIndex();
    const config = loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: fx.path });
    const client = new AppleMailClient({ config, osascript: runner() });
    let clock = 1_000_000;
    const service = new MailWatchService({ client, config, now: () => clock });
    await service.ensure();
    clock += 120_000;
    const order: string[] = [];
    const spy = vi.spyOn(client, "mailboxLookup");
    await service.onTrigger(() => order.push(`tick after ${spy.mock.calls.length} lookups`));
    expect(order).toEqual(["tick after 1 lookups"]);
  });
});
