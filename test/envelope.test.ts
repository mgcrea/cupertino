import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnvelopeIndex, escapeLike, openIndex, toFileUri } from "../src/client/envelope.js";
import { SchemaDriftError } from "../src/client/errors.js";
import { CORE_DATA_EPOCH_OFFSET, detectEpoch } from "../src/client/schema.js";

/**
 * The SQLite lane is NOT faked. These tests build a real database from the DDL
 * captured off a live Envelope Index (test/fixtures/envelope-index.sql), so the
 * joins, the LIKE escaping and the Gmail labels predicate are exercised against
 * real SQL — just without needing Mail or Full Disk Access.
 */

const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

const ICLOUD = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const GMAIL = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";

/** Seconds since the unix epoch, matching what Mail V10 actually stores. */
const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let dir: string;
let dbPath: string;

const seed = (db: DatabaseSync) => {
  db.exec(DDL);

  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${ICLOUD}/INBOX', 3, 1),
      (2, 'imap://${ICLOUD}/Archive', 1, 0),
      (3, 'imap://${GMAIL}/%5BGmail%5D/All%20Mail', 2, 1),
      (4, 'imap://${GMAIL}/INBOX', 0, 0),
      (5, 'local://Notes', 0, 0);

    INSERT INTO subjects (ROWID, subject) VALUES
      (1, 'Invoice 5753 from Domaine'),
      (2, 'Lunch on Friday?'),
      (3, '100% off everything_now'),
      (4, 'Standup notes'),
      (5, 'Deploy failed');

    INSERT INTO addresses (ROWID, address, comment) VALUES
      (1, 'billing@domaine.fr', 'Domaine Melusine'),
      (2, 'sam@example.com', 'Sam Rivers'),
      (3, 'noreply@shop.com', 'Shop Deals'),
      (4, 'me@icloud.com', 'Me');

    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
       mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES
      (101, 0, 1, 1, NULL,  1, ${t("2026-08-01T10:00:00Z")}, ${t("2026-08-01T10:00:05Z")}, 1, 0, 0, 0, 0, 5000, 900),
      (102, 0, 2, 2, NULL,  2, ${t("2026-08-05T09:00:00Z")}, ${t("2026-08-05T09:00:05Z")}, 1, 0, 1, 1, 0, 2000, 901),
      (103, 0, 3, 3, NULL,  3, ${t("2026-08-06T12:00:00Z")}, ${t("2026-08-06T12:00:05Z")}, 1, 0, 1, 0, 0, 1000, 902),
      (104, 0, 4, 2, 'Re: ', 2, ${t("2026-08-07T09:00:00Z")}, ${t("2026-08-07T09:00:05Z")}, 2, 0, 1, 0, 0, 2500, 901),
      (105, 0, 5, 4, NULL,  4, ${t("2026-08-08T08:00:00Z")}, ${t("2026-08-08T08:00:05Z")}, 3, 0, 1, 0, 0, 900, 903),
      (106, 0, 6, 4, NULL,  5, ${t("2026-08-09T08:00:00Z")}, ${t("2026-08-09T08:00:05Z")}, 3, 0, 0, 0, 0, 900, 904),
      (107, 0, 7, 1, NULL,  1, ${t("2026-07-01T10:00:00Z")}, ${t("2026-07-01T10:00:05Z")}, 1, 0, 1, 0, 1, 5000, 905);

    -- Gmail keeps everything in All Mail; INBOX membership is a label row only.
    INSERT INTO labels (message_id, mailbox_id) VALUES (105, 4), (106, 4);

    INSERT INTO recipients (ROWID, message, address, type, position) VALUES
      (1, 101, 4, 0, 0),
      (2, 102, 4, 0, 0),
      (3, 104, 2, 0, 0);

    INSERT INTO attachments (ROWID, message, attachment_id, name) VALUES
      (1, 101, 'att-1', 'invoice.pdf');
  `);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-"));
  dbPath = join(dir, "Envelope Index"); // the space is deliberate: it must survive URI encoding
  const db = new DatabaseSync(dbPath);
  seed(db);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = () => new EnvelopeIndex(openIndex(dbPath, "ro"));

describe("uri + like escaping", () => {
  it("percent-encodes the space in 'Envelope Index'", () => {
    expect(toFileUri("/a b/Envelope Index", "mode=ro")).toBe(
      "file:/a%20b/Envelope%20Index?mode=ro",
    );
  });

  it("escapes LIKE wildcards so they search literally", () => {
    expect(escapeLike("100% off_now")).toBe("100\\% off\\_now");
  });
});

describe("epoch detection", () => {
  const now = Date.parse("2026-08-18T00:00:00Z");

  it("reads Mail V10 values as raw unix seconds", () => {
    expect(detectEpoch(t("2026-08-18T00:00:00Z"), now).offset).toBe(0);
  });

  it("still handles a Core Data index", () => {
    const coreData = t("2026-08-18T00:00:00Z") - CORE_DATA_EPOCH_OFFSET;
    expect(detectEpoch(coreData, now).offset).toBe(CORE_DATA_EPOCH_OFFSET);
  });

  it("falls back to unix rather than throwing on an empty index", () => {
    expect(detectEpoch(null, now).offset).toBe(0);
  });
});

describe("opening", () => {
  it("opens read-only and refuses writes", () => {
    const index = open();
    expect(index.mode).toBe("ro");
    expect(index.caps.missing).toEqual([]);
    index.close();
  });

  it("detects the real capabilities of the captured schema", () => {
    const index = open();
    expect(index.caps.has).toMatchObject({
      labels: true,
      recipients: true,
      attachments: true,
      subjectPrefix: true,
      conversationId: true,
      messageIdHeader: true,
      mailboxCounts: true,
    });
    expect(index.caps.epochOffset).toBe(0);
    index.close();
  });

  it("refuses to open when writes are disabled by mode", () => {
    expect(() => openIndex(dbPath, "off")).toThrow(/disabled/);
  });

  it("degrades with a named column rather than crashing on schema drift", () => {
    const driftPath = join(dir, "drifted.db");
    const db = new DatabaseSync(driftPath);
    db.exec("CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INTEGER);");
    db.exec("CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);");
    db.close();
    expect(() => openIndex(driftPath, "ro")).toThrow(/messages.subject/);
    try {
      openIndex(driftPath, "ro");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDriftError);
    }
  });
});

describe("search", () => {
  it("returns newest first with joined subject and sender", () => {
    const index = open();
    const rows = index.search({ limit: 10, offset: 0 });
    expect(rows[0]?.subject).toBe("Deploy failed");
    expect(rows.map((r) => r.rowid)).toEqual([106, 105, 104, 103, 102, 101]);
    index.close();
  });

  it("excludes deleted messages", () => {
    const index = open();
    expect(index.search({ limit: 50, offset: 0 }).some((r) => r.rowid === 107)).toBe(false);
    index.close();
  });

  it("concatenates subject_prefix so Re: survives", () => {
    const index = open();
    const row = index.search({ limit: 50, offset: 0 }).find((r) => r.rowid === 104);
    expect(row?.subject).toBe("Re: Lunch on Friday?");
    index.close();
  });

  it("formats the sender as name plus address", () => {
    const index = open();
    const row = index.search({ sender: "domaine", limit: 5, offset: 0 })[0];
    expect(row?.senderName).toBe("Domaine Melusine");
    expect(row?.senderAddress).toBe("billing@domaine.fr");
    index.close();
  });

  it("matches free text across subject and sender", () => {
    const index = open();
    expect(index.search({ query: "lunch", limit: 5, offset: 0 }).map((r) => r.rowid)).toEqual([
      104, 102,
    ]);
    expect(index.search({ query: "Sam Rivers", limit: 5, offset: 0 }).map((r) => r.rowid)).toEqual([
      104, 102,
    ]);
    index.close();
  });

  it("treats % and _ in a query as literals, not wildcards", () => {
    const index = open();
    // If escaping were broken, "100%" would match everything.
    expect(index.search({ query: "100%", limit: 50, offset: 0 }).map((r) => r.rowid)).toEqual([
      103,
    ]);
    expect(
      index.search({ query: "everything_now", limit: 50, offset: 0 }).map((r) => r.rowid),
    ).toEqual([103]);
    index.close();
  });

  it("filters by unread, flagged and attachment", () => {
    const index = open();
    expect(index.search({ unreadOnly: true, limit: 50, offset: 0 }).map((r) => r.rowid)).toEqual([
      106, 101,
    ]);
    expect(index.search({ flaggedOnly: true, limit: 50, offset: 0 }).map((r) => r.rowid)).toEqual([
      102,
    ]);
    expect(index.search({ hasAttachment: true, limit: 50, offset: 0 }).map((r) => r.rowid)).toEqual(
      [101],
    );
    index.close();
  });

  it("filters by recipient through the join table", () => {
    const index = open();
    expect(
      index.search({ recipient: "sam@example.com", limit: 50, offset: 0 }).map((r) => r.rowid),
    ).toEqual([104]);
    index.close();
  });

  it("filters by date range", () => {
    const index = open();
    const rows = index.search({
      dateFrom: "2026-08-06T00:00:00Z",
      dateTo: "2026-08-07T23:59:59Z",
      limit: 50,
      offset: 0,
    });
    expect(rows.map((r) => r.rowid)).toEqual([104, 103]);
    index.close();
  });

  it("pages with limit and offset", () => {
    const index = open();
    expect(index.search({ limit: 2, offset: 0 }).map((r) => r.rowid)).toEqual([106, 105]);
    expect(index.search({ limit: 2, offset: 2 }).map((r) => r.rowid)).toEqual([104, 103]);
    index.close();
  });

  it("converts stored seconds to ISO", () => {
    const index = open();
    expect(index.search({ limit: 1, offset: 0 })[0]?.dateReceived).toBe("2026-08-09T08:00:05.000Z");
    index.close();
  });
});

describe("the Gmail labels predicate", () => {
  /**
   * This is the one that would silently return an empty inbox. On the real
   * machine the naive query found 0 messages where 51,128 existed.
   */
  it("finds Gmail INBOX messages that live in All Mail", () => {
    const index = open();
    const rows = index.search({ mailboxRowids: [4], limit: 50, offset: 0 });
    expect(rows.map((r) => r.rowid)).toEqual([106, 105]);
    index.close();
  });

  it("still scopes a normal IMAP mailbox by its foreign key", () => {
    const index = open();
    expect(index.search({ mailboxRowids: [2], limit: 50, offset: 0 }).map((r) => r.rowid)).toEqual([
      104,
    ]);
    index.close();
  });

  it("counts through the same predicate", () => {
    const index = open();
    expect(index.count({ mailboxRowids: [4] })).toEqual({ total: 2, unread: 1 });
    expect(index.count({ mailboxRowids: [1] })).toEqual({ total: 3, unread: 1 });
    index.close();
  });
});

describe("threads", () => {
  it("returns a conversation oldest first, across mailboxes", () => {
    const index = open();
    const conversation = index.conversationOf(102);
    expect(conversation).toBe(901);
    expect(index.thread(conversation!, 50).map((r) => r.rowid)).toEqual([102, 104]);
    index.close();
  });

  it("returns null for a row that does not exist", () => {
    const index = open();
    expect(index.conversationOf(999_999)).toBeNull();
    index.close();
  });
});
