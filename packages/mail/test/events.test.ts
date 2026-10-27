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
    ).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/never watched/) });
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

    const { client } = await connect({ ...ON, APPLE_MAIL_ENVELOPE_INDEX: missing }, running);
    await expect(poll(client, { ...acme, cursor: null })).rejects.toMatchObject({ code: -32603 });
  });

  it("serves nothing with the gate off", async () => {
    const { client, events } = await connect({}, running);
    expect(events).toBeUndefined();
    await expect(
      client.request({ method: "events/list", params: {} }, z.looseObject({})),
    ).rejects.toMatchObject({ code: -32601 });
  });
});
