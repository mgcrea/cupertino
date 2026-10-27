import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OsascriptRunner } from "../src/client/osascript.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * Reads the index can answer must not wait on Mail.
 *
 * Measured through the bridge on a 210k-message store: list_messages took
 * 8.4 s for twenty messages over Apple Events, list_mailboxes 1.2 s,
 * count_messages 0.77 s, and get_message 0.45 s — of which 2 ms was reading
 * the message file and the rest one Apple Event per summary property. Every
 * field those Apple Events returned is a column of the Envelope Index the
 * server already holds open.
 *
 * So each test here runs the real server against a real index and a real
 * message file, records every script sent to Mail, and asserts on WHICH
 * scripts ran: the speed is a consequence of an Apple Event not being sent,
 * and that is the part a regression would quietly undo.
 */

const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

const ICLOUD = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const GMAIL = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Markers the JXA scripts carry, as `tools.test.ts` dispatches on them. */
const SCRIPT = {
  accounts: "a.emailAddresses()",
  listMailboxes: "p.withCounts",
  countMailbox: "mb.unreadCount()",
  listRecent: "slice.subject()",
  getMessages: "mb.messages.byId",
} as const;

let dir: string;
let dbPath: string;
let icloudDir: string;
let gmailDir: string;

const accounts = () => [
  {
    id: ICLOUD,
    name: "iCloud",
    enabled: true,
    accountType: "iCloud",
    emailAddresses: ["me@icloud.com"],
    fullName: "Me",
    directory: icloudDir,
    messageCaching: "all messages and their attachments",
    mailboxes: ["INBOX", "Archive", "Junk"],
  },
  {
    id: GMAIL,
    name: "Google",
    enabled: true,
    accountType: "imap",
    emailAddresses: ["me@gmail.com"],
    fullName: "Me",
    directory: gmailDir,
    messageCaching: "all messages and their attachments",
    mailboxes: ["INBOX", "All Mail"],
  },
];

/** Answers like Mail, and keeps every script it was sent. */
const recordingRunner = () => {
  const sent: string[] = [];
  const runner: OsascriptRunner = {
    run: vi.fn(async (script: string) => {
      const kind = Object.entries(SCRIPT).find(([, marker]) => script.includes(marker))?.[0];
      sent.push(kind ?? "other");
      switch (kind) {
        case "accounts":
          return accounts();
        case "listMailboxes":
          return [
            { accountUuid: ICLOUD, accountName: "iCloud", name: "INBOX", total: 9, unread: 9 },
          ];
        case "countMailbox":
          return { accountUuid: ICLOUD, mailbox: "INBOX", total: 9, unread: 9 };
        case "listRecent":
          return {
            mailbox: "INBOX",
            total: 9,
            messages: [
              {
                id: 103,
                accountUuid: ICLOUD,
                mailbox: "INBOX",
                subject: "From Apple Events",
                sender: "x@example.com",
                dateReceived: null,
                read: true,
                flagged: false,
              },
            ],
          };
        case "getMessages":
          return [
            {
              id: 102,
              accountUuid: ICLOUD,
              mailbox: "INBOX",
              subject: "From Apple Events",
              sender: "x@example.com",
              dateReceived: null,
              read: true,
              flagged: false,
              content: "body from Mail",
            },
          ];
        default:
          return [];
      }
    }) as OsascriptRunner["run"],
  };
  /** Everything but the account list, which the cache answers after the first call. */
  const mailEvents = () => sent.filter((k) => k !== "accounts");
  return { runner, sent, mailEvents };
};

const seedIndex = () => {
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  // Mail's cached per-mailbox counts are deliberately wrong here, the way the
  // live ones were observed to be: a count must come from the messages.
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${ICLOUD}/INBOX', 77, 77),
      (2, 'imap://${ICLOUD}/Archive', 77, 77),
      (3, 'imap://${GMAIL}/%5BGmail%5D/All%20Mail', 77, 77),
      (4, 'imap://${GMAIL}/INBOX', 0, 0);

    INSERT INTO subjects (ROWID, subject) VALUES
      (1, 'Invoice 5753'), (2, 'Lunch on Friday?'), (3, 'Standup notes'), (4, 'Deploy failed');

    INSERT INTO addresses (ROWID, address, comment) VALUES
      (1, 'billing@domaine.fr', 'Domaine Melusine'), (2, 'sam@example.com', 'Sam Rivers'),
      (3, 'jane@example.com', 'Doe, "JD", Jane'), (4, 'jd@example.com', 'J. D. Doe (Acme)');

    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent,
       date_received, mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES
      (101, 0, 1, 1, NULL,   1, ${t("2026-08-01T10:00:00Z")}, ${t("2026-08-01T10:00:05Z")}, 1, 0, 1, 0, 0, 5000, 900),
      (102, 0, 2, 2, 'Re: ', 2, ${t("2026-08-05T09:00:00Z")}, ${t("2026-08-05T09:00:05Z")}, 1, 0, 0, 1, 0, 2000, 901),
      (103, 0, 3, 2, NULL,   2, ${t("2026-08-06T09:00:00Z")}, ${t("2026-08-06T09:00:05Z")}, 1, 0, 1, 0, 0, 2100, 901),
      (104, 0, 4, 1, NULL,   1, ${t("2026-07-01T10:00:00Z")}, ${t("2026-07-01T10:00:05Z")}, 1, 0, 0, 0, 1, 5000, 902),
      (105, 0, 5, 2, NULL,   3, ${t("2026-08-08T08:00:00Z")}, ${t("2026-08-08T08:00:05Z")}, 3, 0, 1, 0, 0, 900, 903),
      (106, 0, 6, 2, NULL,   4, ${t("2026-08-09T08:00:00Z")}, ${t("2026-08-09T08:00:05Z")}, 3, 0, 0, 0, 0, 900, 904),
      (107, 0, 7, 2, NULL,   4, ${t("2026-08-10T08:00:00Z")}, ${t("2026-08-10T08:00:05Z")}, 3, 0, 0, 0, 0, 900, 905),
      (108, 0, 8, 3, NULL,   3, ${t("2026-08-11T08:00:00Z")}, ${t("2026-08-11T08:00:05Z")}, 2, 0, 1, 0, 0, 900, 906),
      (109, 0, 9, 4, NULL,   3, ${t("2026-08-12T08:00:00Z")}, ${t("2026-08-12T08:00:05Z")}, 2, 0, 1, 0, 0, 900, 907);

    INSERT INTO labels (message_id, mailbox_id) VALUES (105, 4), (106, 4);
  `);
  db.close();
};

const PLIST = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>';

/** ROWID 102 -> floor(102/1000) = 0 -> shard "0". */
const layDownMessage = (rowid: number) => {
  const mime = [
    "From: Sam Rivers <sam@example.com>",
    "Subject: Re: Lunch on Friday?",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Noon works.",
  ].join("\r\n");
  const body = Buffer.from(mime, "utf8");
  const messages = join(icloudDir, "INBOX.mbox", "MBOX-UUID", "Data", "0", "Messages");
  mkdirSync(messages, { recursive: true });
  writeFileSync(
    join(messages, `${rowid}.emlx`),
    Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from(PLIST)]),
  );
};

const connect = async (env: Record<string, string> = {}) => {
  const recorder = recordingRunner();
  const config = loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: dbPath, ...env });
  const { server } = createServer({ config, osascript: recorder.runner });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "{}";
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { call, ...recorder };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-index-first-"));
  dbPath = join(dir, "Envelope Index");
  icloudDir = join(dir, "V10", ICLOUD);
  gmailDir = join(dir, "V10", GMAIL);
  mkdirSync(icloudDir, { recursive: true });
  mkdirSync(gmailDir, { recursive: true });
  seedIndex();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ref102 = encodeRef({ accountUuid: ICLOUD, mailbox: "INBOX", id: 102 });

describe("get_message", () => {
  it("takes the summary from the index when the message file is read", async () => {
    layDownMessage(102);
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_get_message", { ref: ref102 });

    expect(mailEvents()).toEqual([]);
    expect(payload).toMatchObject({
      ref: ref102,
      source: "emlx",
      subject: "Re: Lunch on Friday?",
      sender: "Sam Rivers <sam@example.com>",
      dateReceived: "2026-08-05T09:00:05.000Z",
      read: false,
      flagged: true,
      body: expect.stringContaining("Noon works."),
    });
  });

  it("still asks Mail for the summary when the index is off", async () => {
    layDownMessage(102);
    const { call, mailEvents } = await connect({ APPLE_MAIL_INDEX_MODE: "off" });
    const payload = await call("apple_mail_get_message", { ref: ref102 });

    expect(mailEvents()).toEqual(["getMessages"]);
    expect(payload).toMatchObject({ source: "emlx", subject: "From Apple Events" });
  });
});

describe("list_attachments", () => {
  it("sends Mail nothing when the message file is read", async () => {
    layDownMessage(102);
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_list_attachments", { ref: ref102 });

    expect(mailEvents()).toEqual([]);
    expect(payload).toMatchObject({ source: "emlx", count: 0 });
  });

  /*
   * The fallback could never have produced a manifest: Mail's scripting
   * interface has none. Fetching the body over Apple Events only to discard it
   * was a slow way to say "degraded".
   */
  it("does not fetch a body from Mail it cannot use when the file is missing", async () => {
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_list_attachments", { ref: ref102 });

    expect(mailEvents()).toEqual([]);
    expect(payload).toMatchObject({ degraded: true, capability: "message-file" });
  });
});

describe("list_messages", () => {
  /*
   * Mail quotes a display name that holds a comma, and only then. Measured
   * over 725 names: every one of the 361 with a comma came back quoted, none
   * without one did, and names a full RFC 5322 set of specials would quote
   * came back bare. Unquoted, an Exchange "Last, First" reads as two
   * recipients.
   */
  it("quotes a display name the way Mail does", async () => {
    const { call } = await connect();
    const payload = await call("apple_mail_list_messages", {
      account: "iCloud",
      mailbox: "Archive",
    });

    expect(payload.messages.map((m: { sender: string }) => m.sender)).toEqual([
      "J. D. Doe (Acme) <jd@example.com>",
      '"Doe, \\"JD\\", Jane" <jane@example.com>',
    ]);
  });

  it("lists from the index, newest first, with the index's total", async () => {
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_list_messages", { account: "iCloud", mailbox: "INBOX" });

    expect(mailEvents()).toEqual([]);
    expect(payload).toMatchObject({ account: "iCloud", mailbox: "INBOX", source: "index" });
    // 104 is deleted, so it is neither listed nor counted.
    expect(payload.total).toBe(3);
    expect(payload.returned).toBe(3);
    expect(payload.messages.map((m: { subject: string }) => m.subject)).toEqual([
      "Lunch on Friday?",
      "Re: Lunch on Friday?",
      "Invoice 5753",
    ]);
    expect(payload.messages[1]).toMatchObject({ ref: ref102, read: false, flagged: true });
  });

  it("lists a Gmail INBOX, whose messages it holds by label only", async () => {
    const { call } = await connect();
    const payload = await call("apple_mail_list_messages", { account: "Google", mailbox: "INBOX" });

    expect(payload.total).toBe(2);
    expect(payload.messages.map((m: { subject: string }) => m.subject)).toEqual([
      "Deploy failed",
      "Standup notes",
    ]);
  });

  it("is not held to the Apple Events cap", async () => {
    const { call } = await connect({ APPLE_MAIL_DEGRADED_MAX_MESSAGES: "1" });
    const payload = await call("apple_mail_list_messages", {
      account: "iCloud",
      mailbox: "INBOX",
      limit: 3,
    });

    expect(payload.returned).toBe(3);
    expect(payload.note).toBeUndefined();
  });

  it("falls back to Apple Events when the index is off", async () => {
    const { call, mailEvents } = await connect({ APPLE_MAIL_INDEX_MODE: "off" });
    const payload = await call("apple_mail_list_messages", { account: "iCloud", mailbox: "INBOX" });

    expect(mailEvents()).toEqual(["listRecent"]);
    expect(payload).toMatchObject({ source: "applescript", total: 9 });
    expect(payload.note).toMatch(/capped/);
  });

  /*
   * A mailbox Mail lists but the index has no row for — new, or not synced
   * yet. Apple Events can still list it, so this is a slower answer rather
   * than the refusal a search gives.
   */
  it("falls back to Apple Events for a mailbox the index does not hold", async () => {
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_list_messages", { account: "iCloud", mailbox: "Junk" });

    expect(mailEvents()).toEqual(["listRecent"]);
    expect(payload.source).toBe("applescript");
  });
});

describe("count_messages", () => {
  it("answers from the index without asking Mail", async () => {
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_count_messages", {
      account: "Google",
      mailbox: "INBOX",
    });

    expect(mailEvents()).toEqual([]);
    expect(payload).toMatchObject({
      account: "Google",
      mailbox: "INBOX",
      total: 2,
      unread: { index: 1 },
      source: "index",
    });
  });

  it("reports Mail's own figures when the index is off", async () => {
    const { call, mailEvents } = await connect({ APPLE_MAIL_INDEX_MODE: "off" });
    const payload = await call("apple_mail_count_messages", {
      account: "iCloud",
      mailbox: "INBOX",
    });

    expect(mailEvents()).toEqual(["countMailbox"]);
    expect(payload).toMatchObject({
      total: 9,
      unread: { applescript: 9, index: null },
      source: "applescript",
    });
  });

  it("falls back to Mail for a mailbox the index does not hold", async () => {
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_count_messages", { account: "iCloud", mailbox: "Junk" });

    expect(mailEvents()).toEqual(["countMailbox"]);
    expect(payload.source).toBe("applescript");
  });
});

describe("list_mailboxes", () => {
  it("lists names from the account list, with no further Apple Event", async () => {
    const { call, mailEvents } = await connect();
    const payload = await call("apple_mail_list_mailboxes", {});

    expect(mailEvents()).toEqual([]);
    expect(payload).toEqual([
      { accountUuid: ICLOUD, accountName: "iCloud", name: "INBOX" },
      { accountUuid: ICLOUD, accountName: "iCloud", name: "Archive" },
      { accountUuid: ICLOUD, accountName: "iCloud", name: "Junk" },
      { accountUuid: GMAIL, accountName: "Google", name: "INBOX" },
      { accountUuid: GMAIL, accountName: "Google", name: "All Mail" },
    ]);
  });

  it("counts from the index, agreeing with count_messages", async () => {
    const { call, mailEvents } = await connect();
    const listed = await call("apple_mail_list_mailboxes", { account: "Google", withCounts: true });
    const counted = await call("apple_mail_count_messages", {
      account: "Google",
      mailbox: "INBOX",
    });

    expect(mailEvents()).toEqual([]);
    expect(listed).toEqual([
      {
        accountUuid: GMAIL,
        accountName: "Google",
        name: "INBOX",
        total: 2,
        unread: 1,
        countsSource: "index",
      },
      {
        accountUuid: GMAIL,
        accountName: "Google",
        name: "All Mail",
        total: 3,
        unread: 2,
        countsSource: "index",
      },
    ]);
    expect(listed[0]).toMatchObject({ total: counted.total, unread: counted.unread.index });
  });

  /*
   * Nothing to count is not zero. A mailbox with no index row reports null,
   * the way an unread figure nobody could read is null everywhere else.
   */
  it("reports null, not zero, for a mailbox the index does not hold", async () => {
    const { call } = await connect();
    const listed = await call("apple_mail_list_mailboxes", { account: "iCloud", withCounts: true });

    expect(listed.find((m: { name: string }) => m.name === "Junk")).toEqual({
      accountUuid: ICLOUD,
      accountName: "iCloud",
      name: "Junk",
      total: null,
      unread: null,
      countsSource: "index",
    });
    expect(listed.find((m: { name: string }) => m.name === "INBOX")).toMatchObject({
      total: 3,
      unread: 1,
    });
  });

  it("counts over Apple Events when the index is off", async () => {
    const { call, mailEvents } = await connect({ APPLE_MAIL_INDEX_MODE: "off" });
    const listed = await call("apple_mail_list_mailboxes", { account: "iCloud", withCounts: true });

    expect(mailEvents()).toEqual(["listMailboxes"]);
    expect(listed[0]).toMatchObject({ name: "INBOX", total: 9, unread: 9 });
  });
});
