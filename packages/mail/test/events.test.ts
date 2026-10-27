import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MAIL_SURFACE, MailNotRunningError } from "../src/client/errors.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import type { MailArrival } from "../src/client/watch.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { mailEventAdapter } from "../src/tools/events.js";

/**
 * Mail's `mail.received` adapter, over a real Envelope Index fixture.
 *
 * Nothing reaches a real Mail: the runner is canned, `isMailRunning` is injected
 * and the index is a temp file built from the captured DDL.
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
    mailboxes: ["INBOX", "Archive"],
  },
];

const runner = (open: () => boolean = () => true): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (!script.includes("a.emailAddresses()")) return [];
    if (!open()) throw new MailNotRunningError(MAIL_SURFACE);
    return ACCOUNTS;
  }) as OsascriptRunner["run"],
});

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-events-"));
  dbPath = join(dir, "Envelope Index");
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${UUID}/INBOX', 0, 0),
      (2, 'imap://${UUID}/Archive', 0, 0);
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Quote');
    INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'jo@acme.com', 'Jo');
    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
       mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES
      (101, 0, 7101, 1, NULL, 1, 1790000000, 1790000005, 1, 0, 0, 0, 0, 100, 900),
      (102, 0, 7102, 1, NULL, 1, 1790000000, 1790000006, 1, 0, 0, 0, 0, 100, 900);
  `);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opened: Client[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
});

type Env = NodeJS.ProcessEnv;
const ON: Env = { APPLE_MAIL_ALLOW_EVENTS: "1" };

const build = (env: Env, isMailRunning: () => Promise<boolean>, osascript = runner()) => {
  const config = loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: dbPath, ...env });
  return createServer({ config, osascript, era: "modern", isMailRunning });
};

/** The adapter over the events service `createServer` builds when the gate is on. */
const adapterFor = (isMailRunning: () => Promise<boolean>, osascript?: OsascriptRunner) => {
  const created = build(ON, isMailRunning, osascript);
  if (!created.events) throw new Error("the events service was not built");
  return { adapter: mailEventAdapter(created.events), ...created };
};

const connect = async (
  env: Env,
  isMailRunning: () => Promise<boolean>,
  osascript?: OsascriptRunner,
) => {
  const created = build(env, isMailRunning, osascript);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(a), client.connect(b)]);
  opened.push(client);
  return { ...created, client };
};

const running = async () => true;
const closed = async () => false;

const row = (over: Partial<MailArrival> = {}): MailArrival => ({
  cursor: 5,
  key: "7105",
  sender: "jo@acme.com",
  excluded: false,
  scope: ["1"],
  ref: "ref-1",
  mailbox: "INBOX",
  senderAddress: "jo@acme.com",
  senderName: "Jo",
  subject: "Quote",
  dateReceived: "2026-10-27T10:00:00.000Z",
  ...over,
});

describe("mailEventAdapter", () => {
  it("describes mail.received with poll and push, and an anyOf over from and domains", () => {
    const { adapter } = adapterFor(running);
    expect(adapter.descriptor.name).toBe("mail.received");
    expect(adapter.descriptor.delivery).toEqual(["poll", "push"]);
    const schema = adapter.descriptor.inputSchema as {
      properties: Record<string, { type: string; description: string }>;
      anyOf: unknown;
    };
    expect(Object.keys(schema.properties)).toEqual(["from", "domains", "mailboxes"]);
    for (const p of Object.values(schema.properties)) {
      expect(p.type).toBe("array");
      expect(p.description).toBeTruthy();
    }
    expect(schema.anyOf).toEqual([{ required: ["from"] }, { required: ["domains"] }]);
  });

  it("parseArguments refuses an empty filter with -32602", async () => {
    const { adapter } = adapterFor(running);
    await expect(adapter.parseArguments({})).rejects.toMatchObject({ code: -32602 });
    await expect(adapter.parseArguments({ mailboxes: ["INBOX"] })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("parseArguments refuses malformed arguments with -32602", async () => {
    const { adapter } = adapterFor(running);
    await expect(adapter.parseArguments({ from: "jo@acme.com" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("parseArguments resolves mailboxes to scope keys", async () => {
    const { adapter } = adapterFor(running);
    const filter = await adapter.parseArguments({ domains: ["acme.com"], mailboxes: ["INBOX"] });
    expect(filter.scope).toEqual(["1"]);
    expect(filter.domains).toEqual(["acme.com"]);
  });

  it("parseArguments refuses an unknown mailbox and an unwatched one with -32602", async () => {
    const { adapter } = adapterFor(running);
    await expect(
      adapter.parseArguments({ domains: ["acme.com"], mailboxes: ["Nowhere"] }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("Nowhere") });
    await expect(
      adapter.parseArguments({ domains: ["acme.com"], mailboxes: ["Sent Messages"] }),
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/never followed/) });
  });

  it("parseArguments speaks of a subscription, never a watch", async () => {
    const { adapter } = adapterFor(running);
    const refusal = (args: unknown) =>
      adapter.parseArguments(args).then(
        () => "",
        (e: unknown) => (e as Error).message,
      );
    expect(await refusal({})).toBe(
      "A subscription needs a sender: give at least one entry in `from` or `domains`.",
    );
    const junk = await refusal({ domains: ["acme.com"], mailboxes: ["Junk"] });
    expect(junk).toBe(
      '"Junk" is never followed: Sent, Drafts, Junk and Trash are excluded, so a subscription ' +
        "on it could never fire.",
    );

    const closedMail = adapterFor(
      closed,
      runner(() => false),
    ).adapter;
    const notRunning = await closedMail
      .parseArguments({
        domains: ["acme.com"],
        mailboxes: ["INBOX"],
      })
      .then(
        () => "",
        (e: unknown) => (e as Error).message,
      );
    expect(notRunning).toContain("Open Mail and try again, or subscribe without `mailboxes`.");
    expect(notRunning).not.toMatch(/watch/i);
  });

  it("refuses more mailboxes than a subscription can follow, in its own words", async () => {
    const d = mkdtempSync(join(tmpdir(), "mcp-apple-mail-events-many-"));
    try {
      const path = join(d, "Envelope Index");
      const uuids = Array.from(
        { length: 51 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      const db = new DatabaseSync(path);
      db.exec(DDL);
      for (const [i, id] of uuids.entries()) {
        db.exec(`INSERT INTO mailboxes (ROWID, url, total_count, unread_count)
                 VALUES (${i + 1}, 'imap://${id}/INBOX', 0, 0)`);
      }
      db.close();
      const accounts = uuids.map((id, i) => ({ ...ACCOUNTS[0], id, name: `Account ${i}` }));
      const many: OsascriptRunner = {
        run: vi.fn(async (script: string) =>
          script.includes("a.emailAddresses()") ? accounts : [],
        ) as OsascriptRunner["run"],
      };
      const created = createServer({
        config: loadConfig({ ...ON, APPLE_MAIL_ENVELOPE_INDEX: path }),
        osascript: many,
        era: "modern",
        isMailRunning: running,
      });
      const err = await mailEventAdapter(created.events!)
        .parseArguments({ domains: ["acme.com"], mailboxes: ["INBOX"] })
        .then(
          () => null,
          (e: unknown) => e as { code: number; message: string },
        );
      expect(err?.code).toBe(-32602);
      expect(err?.message).toBe(
        "Those names cover 51 mailboxes across the accounts, more than a subscription can " +
          "follow (50). Name fewer mailboxes.",
      );
      created.events!.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("occurrence maps a row", () => {
    const { adapter } = adapterFor(running);
    const occ = adapter.occurrence(row());
    expect(occ.eventId).toBe("7105");
    expect(occ.timestamp).toBe("2026-10-27T10:00:00.000Z");
    expect(Object.keys(occ.data).toSorted()).toEqual(
      ["dateReceived", "mailbox", "ref", "senderAddress", "senderName", "subject"].toSorted(),
    );
    expect(occ.data).toMatchObject({ ref: "ref-1", mailbox: "INBOX", subject: "Quote" });
  });

  it("occurrence stamps an undated row with the scan time, never an empty string", () => {
    const { adapter } = adapterFor(running);
    const before = Date.now();
    const occ = adapter.occurrence(row({ dateReceived: null }));
    const at = Date.parse(occ.timestamp);
    expect(occ.timestamp).toBe(new Date(at).toISOString());
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(occ.data.dateReceived).toBeNull();
  });

  it("timestampMs is the received date, or null", () => {
    const { adapter } = adapterFor(running);
    expect(adapter.timestampMs(row())).toBe(Date.parse("2026-10-27T10:00:00.000Z"));
    expect(adapter.timestampMs(row({ dateReceived: null }))).toBeNull();
  });
});

const poll = (client: Client, params: Record<string, unknown>) =>
  client.request(
    { method: "events/poll", params },
    z.looseObject({
      events: z.array(z.looseObject({})),
      cursor: z.string().nullable(),
      truncated: z.boolean(),
    }),
  );
const acme = { name: "mail.received", arguments: { domains: ["acme.com"] } };

describe("events over a connection", () => {
  it("Mail closed: poll does not advance past unjudged rows", async () => {
    const { client } = await connect(
      ON,
      closed,
      runner(() => false),
    );
    // Start the connection's store at row 100, below the fixture's two rows.
    const boot = await poll(client, { ...acme, cursor: null });
    const mark = boot.cursor?.replace(/\.\d+$/, ".100");
    // Nothing has loaded the mailbox lookup (Mail is closed), so nothing is judged.
    const res = await client.request(
      { method: "events/poll", params: { ...acme, cursor: mark } },
      z.looseObject({ events: z.array(z.looseObject({})), cursor: z.string() }),
    );
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe(mark);
  });

  it("watches and events on together are independent", async () => {
    const { client, server, watches, events } = await connect(
      { ...ON, APPLE_MAIL_ALLOW_WATCHES: "1" },
      running,
    );
    expect(watches).toBeDefined();
    expect(events).toBeDefined();
    expect(events).not.toBe(watches);

    const made = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["acme.com"] },
    });
    expect(made.isError).toBeFalsy();
    const boot = await poll(client, { ...acme, cursor: null });
    const mark = boot.cursor!.replace(/\.\d+$/, ".100");
    const res = await poll(client, { ...acme, cursor: mark });
    expect(res.events.map((e) => e.eventId)).toEqual(["7101", "7102"]);

    // Both services hold an index handle now; closing the connection closes both.
    expect(() => watches?.source.head()).not.toThrow();
    expect(() => events?.source.head()).not.toThrow();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's close hook.
    server.server.onclose?.();
    expect(() => watches?.source.head()).toThrow();
    expect(() => events?.source.head()).toThrow();
  });

  it("an unreadable index is not the client's mistake: -32603, not -32602", async () => {
    const missing = join(dir, "missing", "Envelope Index");
    const config = loadConfig({ ...ON, APPLE_MAIL_ENVELOPE_INDEX: missing });
    const created = createServer({
      config,
      osascript: runner(),
      era: "modern",
      isMailRunning: running,
    });
    const adapter = mailEventAdapter(created.events!);
    for (const args of [
      { domains: ["acme.com"] },
      { domains: ["acme.com"], mailboxes: ["INBOX"] },
    ]) {
      const err = await adapter.parseArguments(args).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: number }).code).not.toBe(-32602);
    }

    // An empty filter is the caller's mistake whatever state the index is in.
    for (const args of [{}, { mailboxes: ["INBOX"] }]) {
      await expect(adapter.parseArguments(args)).rejects.toMatchObject({ code: -32602 });
    }

    const { client } = await connect({ ...ON, APPLE_MAIL_ENVELOPE_INDEX: missing }, running);
    await expect(poll(client, { ...acme, cursor: null })).rejects.toMatchObject({ code: -32603 });
    await expect(
      poll(client, {
        name: "mail.received",
        arguments: { domains: ["acme.com"], mailboxes: ["INBOX"] },
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: -32603 });
    await expect(
      poll(client, { name: "mail.received", arguments: {}, cursor: null }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("a store that cannot be read is refused in events terms", async () => {
    const missing = join(dir, "missing", "Envelope Index");
    const unreadable = await connect({ ...ON, APPLE_MAIL_ENVELOPE_INDEX: missing }, running);
    const one = await poll(unreadable.client, { ...acme, cursor: null }).then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
    expect(one).toContain(
      "The Envelope Index cannot be read, so there is nothing to read events from: ",
    );
    expect(one).not.toMatch(/watch/i);

    const immutable = await connect({ ...ON, APPLE_MAIL_INDEX_MODE: "immutable" }, running);
    const two = await poll(immutable.client, { ...acme, cursor: null }).then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
    expect(two).toContain("the newest mail is exactly what a subscription would miss.");
    expect(two).not.toMatch(/watch/i);
  });

  it("Mail not running with mailboxes is the server's state, not the client's mistake: -32603", async () => {
    const created = build(
      ON,
      closed,
      runner(() => false),
    );
    const adapter = mailEventAdapter(created.events!);
    const args = { domains: ["acme.com"], mailboxes: ["INBOX"] };
    const err = await adapter.parseArguments(args).then(
      () => null,
      (e: unknown) => e as { code?: number },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.code).not.toBe(-32602);
    // Without mailboxes, a closed Mail is no refusal at all.
    await expect(adapter.parseArguments({ domains: ["acme.com"] })).resolves.toBeDefined();
    created.events!.close();

    const { client } = await connect(
      ON,
      closed,
      runner(() => false),
    );
    const res = await poll(client, { name: "mail.received", arguments: args, cursor: null }).then(
      () => null,
      (e: unknown) => e as { code: number; message: string },
    );
    expect(res?.code).toBe(-32603);
    expect(res?.message).toContain(
      "Mailbox names cannot be resolved until Mail is running: Mail is what says which " +
        "mailboxes an account has. Open Mail and try again, or subscribe without `mailboxes`.",
    );
  });

  it("serves nothing with the gate off", async () => {
    const { client, events } = await connect({}, running);
    expect(events).toBeUndefined();
    await expect(
      client.request({ method: "events/list", params: {} }, z.looseObject({})),
    ).rejects.toMatchObject({ code: -32601 });
  });
});
