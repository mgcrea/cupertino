import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeFilter, WatchRegistry } from "@mgcrea/mcp-apple-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIL_SURFACE, MailNotRunningError } from "../src/client/errors.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { decodeRef } from "../src/client/ref.js";
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

/** A runner that counts `LIST_ACCOUNTS`, the one osascript a watch can cost, and can fail it. */
const countingRunner = () => {
  const state = { listAccounts: 0, open: true };
  const run: OsascriptRunner = {
    run: vi.fn(async (script: string) => {
      if (!script.includes("a.emailAddresses()")) return [];
      state.listAccounts += 1;
      if (!state.open) throw new MailNotRunningError(MAIL_SURFACE);
      return ACCOUNTS;
    }) as OsascriptRunner["run"],
  };
  return { state, run };
};

/**
 * A service over `path` with a registry bound to it, the way `createServer`
 * wires them, and a clock the test moves. The clock is `Date` itself, faked, so
 * the client's own account cache ages with the service's TTL as it does live.
 */
const serviceOn = (
  path: string,
  opts: { ttlMs?: number; isMailRunning?: () => Promise<boolean> } = {},
) => {
  // Before anything is built: the client captures `Date.now` when it is constructed.
  vi.useFakeTimers({ toFake: ["Date"] });
  const config = loadConfig({
    APPLE_MAIL_ENVELOPE_INDEX: path,
    APPLE_MAIL_MAILBOX_CACHE_TTL_MS: String(opts.ttlMs ?? 60_000),
  });
  const counted = countingRunner();
  const warn = vi.fn();
  const client = new AppleMailClient({ config, osascript: counted.run, ax: null });
  const clock = {
    advance: (ms: number) => vi.setSystemTime(Date.now() + ms),
  };
  const service = new MailWatchService({
    client,
    config,
    logger: { warn },
    isMailRunning: opts.isMailRunning ?? running,
  });
  const onUpdate = vi.fn();
  const registry = new WatchRegistry<MailArrival>({
    surface: "mail",
    source: service.source,
    onUpdate,
  });
  service.bind(registry);
  cleanups.push(() => {
    registry.close();
    service.close();
    vi.useRealTimers();
  });
  const trigger = () => service.onTrigger(() => registry.tick());
  const warned = (pattern: RegExp) =>
    warn.mock.calls.filter(([message]) => pattern.test(String(message))).length;
  return { client, service, registry, onUpdate, runner: counted.state, clock, trigger, warned };
};

const sam = normalizeFilter({ from: ["sam@example.com"] });

/** A tick that fails the way a locked index does. */
const busy = () => {
  throw new Error("SQLITE_BUSY");
};

describe("MailWatchService: what a trigger costs", () => {
  it("runs no osascript on an idle poll, however long past the TTL", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path);
    await w.service.add(sam, undefined);
    const before = w.runner.listAccounts;
    for (let i = 0; i < 5; i++) {
      w.clock.advance(10 * 60_000);
      await w.trigger();
    }
    expect(w.runner.listAccounts).toBe(before);
  });

  it("refreshes past the TTL only once rows are waiting to be judged", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path);
    const { watch } = await w.service.add(sam, undefined);
    const before = w.runner.listAccounts;
    w.clock.advance(120_000);
    await w.trigger();
    expect(w.runner.listAccounts).toBe(before);
    addMessage(fx.db, 30, 1);
    await w.trigger();
    expect(w.runner.listAccounts).toBe(before + 1);
    expect(w.onUpdate).toHaveBeenCalledExactlyOnceWith(watch.uri);
  });

  it("refreshes exactly once for a row in a mailbox it has never seen, then judges the row", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path);
    const { watch } = await w.service.add(sam, undefined);
    const before = w.runner.listAccounts;

    // Inside the TTL: only the unknown mailbox can justify a refresh.
    w.clock.advance(500);
    fx.db.exec(`INSERT INTO mailboxes (ROWID, url, total_count, unread_count)
                VALUES (2, 'imap://${UUID}/Receipts', 0, 0)`);
    addMessage(fx.db, 20, 2);
    await w.trigger();
    expect(w.runner.listAccounts).toBe(before + 1);
    expect(w.onUpdate).toHaveBeenCalledExactlyOnceWith(watch.uri);
    expect(w.registry.read(watch.id)?.messages.map((m) => m.mailbox)).toEqual(["Receipts"]);

    addMessage(fx.db, 21, 2);
    await w.trigger();
    expect(w.runner.listAccounts).toBe(before + 1);
    expect(w.onUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for a mailbox it knew and could not resolve", async () => {
    const fx = copyIndex();
    fx.db.exec(`INSERT INTO mailboxes (ROWID, url, total_count, unread_count)
                VALUES (3, 'local://Notes', 0, 0)`);
    const w = serviceOn(fx.path);
    await w.service.add(sam, undefined);
    const before = w.runner.listAccounts;
    addMessage(fx.db, 20, 3);
    await w.trigger();
    expect(w.runner.listAccounts).toBe(before);
    expect(w.onUpdate).not.toHaveBeenCalled();
    expect(w.registry.mark).toBe(20);
  });

  it("logs a failed refresh once until one succeeds", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path);
    await w.service.add(sam, undefined);
    w.runner.open = false;
    for (const rowid of [30, 31, 32]) {
      w.clock.advance(120_000);
      addMessage(fx.db, rowid, 1);
      await w.trigger();
    }
    expect(w.warned(/refresh/)).toBe(1);
    w.runner.open = true;
    w.clock.advance(120_000);
    addMessage(fx.db, 33, 1);
    await w.trigger();
    w.runner.open = false;
    w.clock.advance(120_000);
    addMessage(fx.db, 34, 1);
    await w.trigger();
    expect(w.warned(/refresh/)).toBe(2);
  });

  it("logs a failing tick once until a tick succeeds", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path);
    await w.service.add(sam, undefined);
    await w.service.runTrigger(busy);
    await w.service.runTrigger(busy);
    await w.service.runTrigger(busy);
    expect(w.warned(/tick failed/)).toBe(1);
    await w.service.runTrigger(() => {});
    await w.service.runTrigger(busy);
    expect(w.warned(/tick failed/)).toBe(2);
  });
});

describe("MailWatchService freshness", () => {
  it("never scans before the first mailbox lookup has succeeded", async () => {
    const fx = copyIndex();
    let mailUp = false;
    const w = serviceOn(fx.path, { isMailRunning: async () => mailUp });
    w.runner.open = false;

    // Set with Mail closed: the lookup starts empty.
    const { watch } = await w.service.add(sam, undefined);
    addMessage(fx.db, 40, 1);

    // Mail is launching: it has written the index, but cannot answer for its accounts yet.
    mailUp = true;
    await w.trigger();
    expect(w.onUpdate).not.toHaveBeenCalled();
    // A read must not hand out the row as excluded-by-emptiness, nor move the cursor.
    const early = w.registry.read(watch.id);
    expect(early?.messages).toEqual([]);
    expect(early?.cursor).toBe(watch.createdAt);

    // Mail answers: the same trigger path now loads, ticks, and the arrival is whole.
    w.runner.open = true;
    await w.trigger();
    expect(w.onUpdate).toHaveBeenCalledExactlyOnceWith(watch.uri);
    const late = w.registry.read(watch.id);
    expect(late?.messages.map((m) => m.mailbox)).toEqual(["INBOX"]);
    expect(late?.cursor).toBe(40);
  });

  it("keeps working when Mail has quit and the TTL has passed", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path, { ttlMs: 0 });
    const { watch } = await w.service.add(sam, undefined);

    w.runner.open = false;
    w.clock.advance(10 * 60_000);
    // A later `watch` call must not fail for want of a refresh it can do without.
    await expect(w.service.ensure()).resolves.toBeUndefined();
    addMessage(fx.db, 50, 1);
    await w.trigger();
    // The refresh failed, and the tick still ran on the last lookup.
    expect(w.onUpdate).toHaveBeenCalledExactlyOnceWith(watch.uri);
  });

  it("ticks only after the refresh has settled", async () => {
    const fx = copyIndex();
    const w = serviceOn(fx.path);
    await w.service.add(sam, undefined);
    const before = w.runner.listAccounts;
    w.clock.advance(120_000);
    addMessage(fx.db, 60, 1);
    const order: string[] = [];
    await w.service.onTrigger(() =>
      order.push(`tick after ${w.runner.listAccounts - before} refreshes`),
    );
    expect(order).toEqual(["tick after 1 refreshes"]);
  });
});

describe("MailWatchService: an index replaced underneath a watch", () => {
  it("is reopened on the next trigger, resets without notifying, and later arrivals fire", async () => {
    const fx = copyIndex();
    for (let rowid = 1; rowid <= 50; rowid++) addMessage(fx.db, rowid, 1);
    const w = serviceOn(fx.path);
    const searchIndex = await w.client.index();
    const { watch } = await w.service.add(sam, undefined);
    expect(watch.createdAt).toBe(50);

    // Mail re-indexes: a new file, renumbered from 1, renamed over the old one.
    const next = `${fx.path}.rebuilt`;
    const rebuilt = new DatabaseSync(next);
    rebuilt.exec(DDL);
    rebuilt.exec(`
      INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
        (1, 'imap://${UUID}/INBOX', 0, 0);
      INSERT INTO subjects (ROWID, subject) VALUES (1, 'Hello');
      INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'sam@example.com', 'Sam');
    `);
    for (let rowid = 1; rowid <= 3; rowid++) addMessage(rebuilt, rowid, 1);
    rebuilt.close();
    renameSync(next, fx.path);

    await w.trigger();
    expect(w.onUpdate).not.toHaveBeenCalled();
    expect(w.registry.read(watch.id)?.cursor).toBe(3);

    const live = new DatabaseSync(fx.path);
    cleanups.push(() => live.close());
    addMessage(live, 4, 1);
    await w.trigger();
    expect(w.onUpdate).toHaveBeenCalledExactlyOnceWith(watch.uri);
    expect(w.registry.read(watch.id)?.messages.map((m) => decodeRef(m.ref).id)).toEqual([4]);
    // Search keeps the handle it had: only the watch reopened.
    expect(await w.client.index()).toBe(searchIndex);
  });
});
