import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";

import { registerEvents } from "@mgcrea/mcp-apple-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { mailEventAdapter } from "../src/tools/events.js";
import { MailWatchService } from "../src/tools/watch.js";

/**
 * What the events service's mailbox lookup costs, and what it holds back.
 *
 * Each test owns a private index so it can add mail and mailboxes underneath a
 * live subscription. The runner is canned and counts the one Apple Event the
 * lookup costs, the account listing; nothing reaches a real Mail.
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

/** Counts the account listing; `open: false` makes it fail, as Mail does while launching. */
const countingRunner = () => {
  const state = { listAccounts: 0, open: true };
  const run: OsascriptRunner = {
    run: vi.fn(async (script: string) => {
      if (!script.includes("a.emailAddresses()")) return [];
      state.listAccounts += 1;
      if (!state.open) throw new Error("Mail got an error: not ready");
      return ACCOUNTS;
    }) as OsascriptRunner["run"],
  };
  return { state, run };
};

const running = async () => true;
const closed = async () => false;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.useRealTimers();
});

const copyIndex = (): { path: string; db: DatabaseSync } => {
  const d = mkdtempSync(join(tmpdir(), "mcp-apple-mail-events-lookup-"));
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

/** Mailbox 2, "Receipts", created after the lookup was built. */
const addReceipts = (db: DatabaseSync): void => {
  db.exec(`INSERT INTO mailboxes (ROWID, url, total_count, unread_count)
           VALUES (2, 'imap://${UUID}/Receipts', 0, 0)`);
};

const sam = { name: "mail.received", arguments: { from: ["sam@example.com"] } };

const Poll = z.looseObject({
  events: z.array(z.looseObject({ eventId: z.string() })),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
});

type Frame = { method: string; params: Record<string, unknown> };

/** A client on `server`, collecting every `notifications/events/*` frame it is sent. */
const connect = async (server: McpServer) => {
  const client = new Client({ name: "test", version: "0" });
  const frames: Frame[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method.startsWith("notifications/events/")) frames.push(n as Frame);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  const poll = (cursor: string | null) =>
    client.request({ method: "events/poll", params: { ...sam, cursor } }, Poll);
  /** Opens a stream and waits for its `active`; the request stays pending until the test ends. */
  const stream = async () => {
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    client
      .request({ method: "events/stream", params: { ...sam, cursor: null } }, z.looseObject({}), {
        signal: abort.signal,
      })
      .catch(() => {});
    await until(() => frames.some((f) => f.method === "notifications/events/active"), "active");
  };
  const events = () =>
    frames
      .filter((f) => f.method === "notifications/events/event")
      .map((f) => f.params.eventId as string);
  return { client, frames, poll, stream, events };
};

/** Waits, on real turns of the event loop, until `pred` holds. */
const until = async (pred: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await nextTurn();
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Lets every queued tick and the Apple Event it may await run to the end. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await nextTurn();
};

/**
 * The events service `createServer` builds, over `path`, with the account
 * listing counted. Only `Date` is faked, so the TTL can pass without waiting.
 */
const eventsServer = (
  path: string,
  ttlMs: number,
  isMailRunning: () => Promise<boolean> = running,
  open = true,
) => {
  const config = loadConfig({
    APPLE_MAIL_ENVELOPE_INDEX: path,
    APPLE_MAIL_ALLOW_EVENTS: "1",
    APPLE_MAIL_MAILBOX_CACHE_TTL_MS: String(ttlMs),
  });
  const counted = countingRunner();
  counted.state.open = open;
  const created = createServer({
    config,
    osascript: counted.run,
    era: "modern",
    isMailRunning,
  });
  return { ...created, runner: counted.state };
};

/**
 * An events service whose trigger the test fires by hand: `registerEvents` over
 * the adapter, with `startTrigger` swapped for one that keeps `onChange`.
 */
const handFired = (path: string, ttlMs: number) => {
  const config = loadConfig({
    APPLE_MAIL_ENVELOPE_INDEX: path,
    APPLE_MAIL_MAILBOX_CACHE_TTL_MS: String(ttlMs),
  });
  const counted = countingRunner();
  const client = new AppleMailClient({ config, osascript: counted.run, ax: null });
  const service = new MailWatchService({ client, config, isMailRunning: running, mode: "events" });
  const trigger = { onChange: undefined as (() => void) | undefined };
  const server = new McpServer({ name: "test", version: "0" });
  const served = registerEvents(server, {
    era: "modern",
    adapters: [
      {
        ...mailEventAdapter(service),
        startTrigger: (onChange) => {
          trigger.onChange = onChange;
          return { stop: () => {} };
        },
      },
    ],
  });
  cleanups.push(() => {
    served.close();
    service.close();
  });
  const fire = async () => {
    trigger.onChange?.();
    await settle();
  };
  return { server, runner: counted.state, fire };
};

describe("events: a mailbox the lookup has never seen", () => {
  it("a poll neither delivers nor passes over its rows, and the next poll delivers them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    const { server, runner } = eventsServer(fx.path, 60_000);
    const { poll } = await connect(server);
    const boot = await poll(null);
    expect(boot.cursor).toMatch(/\.10$/);
    const before = runner.listAccounts;

    // Inside the TTL: only the unknown mailbox can justify a refresh.
    vi.advanceTimersByTime(500);
    addReceipts(fx.db);
    addMessage(fx.db, 20, 2);
    addMessage(fx.db, 21, 1);

    const held = await poll(boot.cursor);
    expect(held.events).toEqual([]);
    expect(held.cursor).toBe(boot.cursor);
    expect(held.truncated).toBe(false);

    const next = await poll(held.cursor);
    expect(runner.listAccounts).toBe(before + 1);
    expect(next.events.map((e) => e.eventId)).toEqual(["7020", "7021"]);
    expect(next.events.map((e) => (e.data as { mailbox: string }).mailbox)).toEqual([
      "Receipts",
      "INBOX",
    ]);
    expect(next.cursor).toMatch(/\.21$/);
  });

  it("a stream holds its rows back, and delivers them on its next trigger", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    const { server, runner, fire } = handFired(fx.path, 60_000);
    const { stream, events } = await connect(server);
    await stream();
    const before = runner.listAccounts;

    vi.advanceTimersByTime(500);
    addReceipts(fx.db);
    addMessage(fx.db, 20, 2);
    addMessage(fx.db, 21, 1);

    await fire();
    expect(events()).toEqual([]);
    expect(runner.listAccounts).toBe(before);

    await fire();
    expect(runner.listAccounts).toBe(before + 1);
    expect(events()).toEqual(["7020", "7021"]);
  });
});

describe("events: a row the lookup can never learn", () => {
  it("a row whose mailbox has no row at all is held once, then excluded, and mail after it arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    const { server, runner } = eventsServer(fx.path, 60_000);
    const { poll } = await connect(server);
    let cursor = (await poll(null)).cursor;
    const before = runner.listAccounts;

    // Mailbox 99 is in no `mailboxes` row: no refresh can ever make it known.
    addMessage(fx.db, 20, 99);
    addMessage(fx.db, 21, 1);
    const delivered: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await poll(cursor);
      delivered.push(...res.events.map((e) => e.eventId));
      cursor = res.cursor;
    }
    expect(delivered).toEqual(["7021"]);
    expect(cursor).toMatch(/\.21$/);
    // One refresh for the hold, not one per poll.
    expect(runner.listAccounts).toBe(before + 1);
  });
});

describe("events: a lookup that has never loaded", () => {
  it("is asked for again on the next poll, which delivers what waited, with no new arrival", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    // Mail is launching: it has written the index but cannot answer yet.
    const { server, runner } = eventsServer(fx.path, 60_000, closed, false);
    const { poll } = await connect(server);
    const boot = await poll(null);
    addMessage(fx.db, 11, 1);
    const waiting = await poll(boot.cursor);
    expect(waiting.events).toEqual([]);
    expect(waiting.cursor).toBe(boot.cursor);

    runner.open = true;
    const res = await poll(waiting.cursor);
    expect(res.events.map((e) => e.eventId)).toEqual(["7011"]);
    expect(res.cursor).toMatch(/\.11$/);
  });
});

describe("events: what an idle subscription costs", () => {
  it("an idle stream asks Mail for nothing, however many TTLs pass", async () => {
    // The trigger's own minute poll is what fires while nothing arrives.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    const { server, runner } = eventsServer(fx.path, 60_000);
    const { stream, events } = await connect(server);
    await stream();
    const before = runner.listAccounts;

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2 * 60_000);
      await settle();
    }
    expect(runner.listAccounts).toBe(before);

    // The trigger is live: a row that arrives is refreshed for once, and delivered.
    addMessage(fx.db, 11, 1);
    vi.advanceTimersByTime(60_000);
    await until(() => events().length > 0, "the event");
    await settle();
    expect(events()).toEqual(["7011"]);
    expect(runner.listAccounts).toBe(before + 1);
  });

  it("idle polls ask Mail for nothing, however many TTLs pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fx = copyIndex();
    addMessage(fx.db, 10, 1);
    const { server, runner } = eventsServer(fx.path, 60_000);
    const { poll } = await connect(server);
    let cursor = (await poll(null)).cursor;
    const before = runner.listAccounts;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2 * 60_000);
      cursor = (await poll(cursor)).cursor;
    }
    expect(runner.listAccounts).toBe(before);
  });
});
