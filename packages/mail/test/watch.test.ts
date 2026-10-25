import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnvelopeIndex, openIndex } from "../src/client/envelope.js";
import { decodeRef, encodeRef } from "../src/client/ref.js";
import { isMailRunning, isUnwatchedMailbox, MailArrivalSource } from "../src/client/watch.js";

const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

const ICLOUD = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const GMAIL = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let dir: string;
let dbPath: string;

const seed = (db: DatabaseSync) => {
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${ICLOUD}/INBOX', 0, 0),
      (2, 'imap://${ICLOUD}/Archive', 0, 0),
      (3, 'imap://${GMAIL}/%5BGmail%5D/All%20Mail', 0, 0),
      (4, 'imap://${ICLOUD}/Sent%20Messages', 0, 0);

    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Lunch on Friday?'), (2, 'Standup notes');

    INSERT INTO addresses (ROWID, address, comment) VALUES
      (1, 'sam@example.com', 'Sam Rivers'),
      (2, 'me@icloud.com', 'Me');

    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
       mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES
      (101, 0, 7001, 1, NULL,  1, ${t("2026-08-01T10:00:00Z")}, ${t("2026-08-01T10:00:05Z")}, 1, 0, 0, 0, 0, 100, 900),
      (102, 0, 7002, 1, 'Re: ', 1, ${t("2026-08-05T09:00:00Z")}, ${t("2026-08-05T09:00:05Z")}, 1, 0, 0, 0, 0, 100, 900),
      (103, 0, 7003, 2, NULL,  2, ${t("2026-08-06T12:00:00Z")}, ${t("2026-08-06T12:00:05Z")}, 4, 0, 1, 0, 0, 100, 901),
      (104, 0, 7004, 2, NULL,  2, ${t("2026-08-07T09:00:00Z")}, ${t("2026-08-07T09:00:05Z")}, 3, 0, 1, 0, 0, 100, 902),
      (105, 0, 7005, 1, NULL,  2, ${t("2026-08-08T08:00:00Z")}, ${t("2026-08-08T08:00:05Z")}, 3, 0, 1, 0, 0, 100, 903),
      (106, 0, 7006, 1, NULL,  1, ${t("2026-08-09T08:00:00Z")}, ${t("2026-08-09T08:00:05Z")}, 2, 0, 1, 0, 0, 100, 904);
  `);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-watch-"));
  dbPath = join(dir, "Envelope Index");
  const db = new DatabaseSync(dbPath);
  seed(db);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = () => new EnvelopeIndex(openIndex(dbPath, "ro"));

describe("isUnwatchedMailbox", () => {
  const leaves = [
    "Sent Messages",
    "Sent",
    "Sent Mail",
    "Sent Items",
    "Drafts",
    "Junk",
    "Junk E-mail",
    "Spam",
    "Trash",
    "Deleted Messages",
    "Deleted Items",
    "Bin",
  ];

  it.each(leaves)("is true for %s", (leaf) => {
    expect(isUnwatchedMailbox(`imap://${ICLOUD}/${encodeURIComponent(leaf)}`)).toBe(true);
  });

  it("decodes percent-escapes and ignores case", () => {
    expect(isUnwatchedMailbox(`imap://${GMAIL}/%5BGmail%5D/Sent%20Mail`)).toBe(true);
    expect(isUnwatchedMailbox(`imap://${ICLOUD}/TRASH`)).toBe(true);
    expect(isUnwatchedMailbox(`imap://${ICLOUD}/sent%20messages`)).toBe(true);
  });

  it("is false for INBOX, Archive and All Mail", () => {
    expect(isUnwatchedMailbox(`imap://${ICLOUD}/INBOX`)).toBe(false);
    expect(isUnwatchedMailbox(`imap://${ICLOUD}/Archive`)).toBe(false);
    expect(isUnwatchedMailbox(`imap://${GMAIL}/%5BGmail%5D/All%20Mail`)).toBe(false);
  });
});

describe("EnvelopeIndex arrival scan", () => {
  it("returns rowids after the cursor, ascending, with the sender joined", () => {
    const index = open();
    try {
      const rows = index.arrivalsAfter(101, 10);
      expect(rows.map((r) => r.rowid)).toEqual([102, 103, 104, 105, 106]);
      expect(rows[0]).toMatchObject({
        key: "7002",
        mailboxRowid: 1,
        subject: "Re: Lunch on Friday?",
        senderAddress: "sam@example.com",
        senderName: "Sam Rivers",
        dateReceived: t("2026-08-05T09:00:05Z"),
      });
      expect(index.arrivalsAfter(101, 2).map((r) => r.rowid)).toEqual([102, 103]);
    } finally {
      index.close();
    }
  });

  it("reports the highest ROWID as head", () => {
    const index = open();
    try {
      expect(index.headRowid()).toBe(106);
    } finally {
      index.close();
    }
  });

  // Guards the watch cursor's premise: a ROWID is never reused, so "ROWID >
  // cursor" cannot miss a message. A schema refresh that drops AUTOINCREMENT
  // from `messages` must fail here.
  it("never reuses the ROWID of a deleted top row (messages is AUTOINCREMENT)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      seed(db);
      const insert = () =>
        Number(
          db
            .prepare(
              `INSERT INTO messages (message_id, global_message_id, sender, subject, date_sent,
               date_received, mailbox, flags, read, flagged, deleted, size, conversation_id)
             VALUES (0, 9000, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1)`,
            )
            .run().lastInsertRowid,
        );
      const first = insert();
      db.prepare("DELETE FROM messages WHERE ROWID = ?").run(first);
      expect(insert()).toBeGreaterThan(first);
    } finally {
      db.close();
    }
  });
});

describe("MailArrivalSource", () => {
  const own = ["ME@icloud.com"];

  it("marks Sent, own-address and inbox rows correctly", () => {
    const index = open();
    try {
      const source = new MailArrivalSource({ index, ownAddresses: own });
      const rows = source.since(100, 10);
      const by = Object.fromEntries(rows.map((r) => [r.cursor, r]));
      expect(by[101]?.excluded).toBeUndefined();
      expect(by[101]?.sender).toBe("sam@example.com");
      // Sent Messages, whatever the sender.
      expect(by[103]?.excluded).toBe(true);
      // All Mail, from me@icloud.com, matched case-insensitively.
      expect(by[104]?.excluded).toBe(true);
      // All Mail, from someone else.
      expect(by[105]?.excluded).toBeUndefined();
    } finally {
      index.close();
    }
  });

  it("excludes rows outside the mailbox scope", () => {
    const index = open();
    try {
      const source = new MailArrivalSource({ index, ownAddresses: [], mailboxRowids: [2] });
      const rows = source.since(100, 10);
      expect(rows.filter((r) => !r.excluded).map((r) => r.cursor)).toEqual([106]);
      expect(rows).toHaveLength(6);
    } finally {
      index.close();
    }
  });

  it("carries envelope metadata only, with key, ref and date as search renders them", () => {
    const index = open();
    try {
      const source = new MailArrivalSource({ index, ownAddresses: [] });
      const [row] = source.since(101, 1);
      expect(row).toEqual({
        cursor: 102,
        key: "7002",
        sender: "sam@example.com",
        ref: encodeRef({ accountUuid: ICLOUD, mailbox: "INBOX", id: 102 }),
        mailbox: "INBOX",
        senderAddress: "sam@example.com",
        senderName: "Sam Rivers",
        subject: "Re: Lunch on Friday?",
        dateReceived: new Date(t("2026-08-05T09:00:05Z") * 1000).toISOString(),
      });
      expect(decodeRef(row!.ref)).toEqual({ accountUuid: ICLOUD, mailbox: "INBOX", id: 102 });
    } finally {
      index.close();
    }
  });

  it("resolves mailbox names through an injected resolver", () => {
    const index = open();
    try {
      const source = new MailArrivalSource({
        index,
        ownAddresses: [],
        resolveMailbox: (url) =>
          url.endsWith("/All%20Mail") ? { accountUuid: GMAIL, mailbox: "All Mail" } : null,
      });
      const row = source.since(104, 1)[0]!;
      expect(row.mailbox).toBe("All Mail");
      expect(decodeRef(row.ref).mailbox).toBe("All Mail");
    } finally {
      index.close();
    }
  });

  it("reports head from the index", () => {
    const index = open();
    try {
      expect(new MailArrivalSource({ index, ownAddresses: [] }).head()).toBe(106);
    } finally {
      index.close();
    }
  });
});

describe("isMailRunning", () => {
  it("is true on exit 0 and false otherwise, asking pgrep for Mail", async () => {
    const calls: [string, string[]][] = [];
    const run = (code: number) => async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return code;
    };
    expect(await isMailRunning(run(0))).toBe(true);
    expect(await isMailRunning(run(1))).toBe(false);
    expect(calls[0]).toEqual(["/usr/bin/pgrep", ["-x", "Mail"]]);
  });

  it("is false when the runner throws", async () => {
    expect(
      await isMailRunning(async () => {
        throw new Error("spawn failed");
      }),
    ).toBe(false);
  });
});
