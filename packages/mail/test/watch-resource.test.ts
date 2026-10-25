import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeFilter, WatchRegistry } from "@mgcrea/mcp-apple-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIL_SURFACE, MailNotRunningError } from "../src/client/errors.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import type { MailArrival } from "../src/client/watch.js";
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
/** Connections are closed first, so no watcher outlives the temp dir it watches. */
const opened: Client[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
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
    opened.push(c);

    const made = await c.callTool({
      name: "apple_mail_watch",
      arguments: { from: ["sam@example.com"] },
    });
    const { watch, uri, cursor } = JSON.parse((made.content as { text: string }[])[0]!.text);
    expect(cursor).toBe(10);
    addMessage(fx.db, 11, 1);

    const res = await c.readResource({ uri });
    const body = JSON.parse(String((res.contents[0] as { text?: string }).text));
    expect(Object.keys(body).toSorted()).toEqual(["cursor", "filter", "messages", "more", "watch"]);
    expect(body.watch).toBe(watch);
    expect(body.cursor).toBe(11);
    expect(body.more).toBe(false);
    expect(body.messages).toHaveLength(1);
    // The spec's fields and nothing else: no cursor, key, sender, scope or excluded.
    expect(Object.keys(body.messages[0]).toSorted()).toEqual([
      "dateReceived",
      "mailbox",
      "ref",
      "senderAddress",
      "senderName",
      "subject",
    ]);
    expect(body.messages[0]).toMatchObject({
      mailbox: "INBOX",
      senderAddress: "sam@example.com",
      subject: "Hello",
    });
    expect(body.messages[0].ref).toMatch(/^m1:/);
  });
});

describe("per-watch mailboxes", () => {
  it("fires each watch only for its own mailbox, on one connection", async () => {
    const fx = copyIndex();
    fx.db.exec(`INSERT INTO mailboxes (ROWID, url, total_count, unread_count)
                VALUES (2, 'imap://${UUID}/Receipts', 0, 0)`);
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
    opened.push(c);
    const watch = async (mailboxes?: string[]) => {
      const made = await c.callTool({
        name: "apple_mail_watch",
        arguments: { from: ["sam@example.com"], ...(mailboxes ? { mailboxes } : {}) },
      });
      return JSON.parse((made.content as { text: string }[])[0]!.text) as { uri: string };
    };
    const inbox = await watch(["INBOX"]);
    const receipts = await watch(["Receipts"]);
    const everything = await watch();
    addMessage(fx.db, 30, 1);
    addMessage(fx.db, 31, 2);
    const read = async (uri: string) => {
      const res = await c.readResource({ uri });
      const body = JSON.parse(String((res.contents[0] as { text?: string }).text));
      return { cursors: body.messages.length as number, filter: body.filter };
    };
    expect((await read(inbox.uri)).cursors).toBe(1);
    expect((await read(receipts.uri)).cursors).toBe(1);
    expect((await read(everything.uri)).cursors).toBe(2);
    expect((await read(inbox.uri)).filter.scope).toEqual(["1"]);
    expect((await read(everything.uri)).filter.scope).toBeUndefined();
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

  it("never scans before the first mailbox lookup has succeeded", async () => {
    const fx = copyIndex();
    const config = loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: fx.path });
    let accountsAnswer = false;
    const runnerNow: OsascriptRunner = {
      run: vi.fn(async (script: string) => {
        if (!script.includes("a.emailAddresses()")) return [];
        if (!accountsAnswer) throw new MailNotRunningError(MAIL_SURFACE);
        return ACCOUNTS;
      }) as OsascriptRunner["run"],
    };
    const client = new AppleMailClient({ config, osascript: runnerNow });
    let mailUp = false;
    const service = new MailWatchService({
      client,
      config,
      now: () => 1_000_000,
      isMailRunning: async () => mailUp,
    });
    const onUpdate = vi.fn();
    const registry = new WatchRegistry<MailArrival>({
      surface: "mail",
      source: service.source,
      onUpdate,
    });
    service.bind(registry);

    // Set with Mail closed: the lookup starts empty.
    const { watch } = await service.add(normalizeFilter({ from: ["sam@example.com"] }), undefined);
    addMessage(fx.db, 40, 1);

    // Mail is launching: it has written the index, but cannot answer for its accounts yet.
    mailUp = true;
    await service.onTrigger(() => registry.tick());
    expect(onUpdate).not.toHaveBeenCalled();
    // A read must not hand out the row as excluded-by-emptiness, nor move the cursor.
    const early = registry.read(watch.id);
    expect(early?.messages).toEqual([]);
    expect(early?.cursor).toBe(watch.createdAt);

    // Mail answers: the same trigger path now loads, ticks, and the arrival is whole.
    accountsAnswer = true;
    await service.onTrigger(() => registry.tick());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(watch.uri);
    const late = registry.read(watch.id);
    expect(late?.messages.map((m) => m.mailbox)).toEqual(["INBOX"]);
    expect(late?.cursor).toBe(40);
  });

  it("keeps working when Mail has quit and the TTL has passed", async () => {
    const fx = copyIndex();
    // A zero TTL makes the client's own account cache stale too, so the refresh really runs.
    const config = loadConfig({
      APPLE_MAIL_ENVELOPE_INDEX: fx.path,
      APPLE_MAIL_MAILBOX_CACHE_TTL_MS: "0",
    });
    let open = true;
    const toggling: OsascriptRunner = {
      run: vi.fn(async (script: string) => {
        if (!script.includes("a.emailAddresses()")) return [];
        if (!open) throw new MailNotRunningError(MAIL_SURFACE);
        return ACCOUNTS;
      }) as OsascriptRunner["run"],
    };
    const client = new AppleMailClient({ config, osascript: toggling });
    let clock = 1_000_000;
    const service = new MailWatchService({ client, config, now: () => clock });
    await service.ensure();

    open = false;
    clock += 10 * 60_000;
    // A later `watch` call must not fail for want of a refresh it can do without.
    await expect(service.ensure()).resolves.toBeUndefined();
    const ticked = vi.fn();
    await service.onTrigger(ticked);
    expect(ticked).toHaveBeenCalledTimes(1);
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
