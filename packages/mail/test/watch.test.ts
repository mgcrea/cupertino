import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeFilter, WatchRegistry } from "@mgcrea/mcp-apple-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnvelopeIndex, openIndex } from "../src/client/envelope.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { decodeRef, encodeRef } from "../src/client/ref.js";
import { isMailRunning, isUnwatchedMailbox, MailArrivalSource } from "../src/client/watch.js";
import { loadConfig } from "../src/config.js";

const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

const ICLOUD = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const GMAIL = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let dir: string;
let dbPath: string;

const seed = (db: DatabaseSync) => {
  db.exec(DDL);
  // Row 110 points at a mailbox that does not exist, which the schema forbids
  // with enforcement on; Mail's own writes are not ours to second-guess.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${ICLOUD}/INBOX', 0, 0),
      (2, 'imap://${ICLOUD}/Archive', 0, 0),
      (3, 'imap://${GMAIL}/%5BGmail%5D/All%20Mail', 0, 0),
      (4, 'imap://${ICLOUD}/Sent%20Messages', 0, 0),
      (5, 'local://Notes', 0, 0),
      (6, 'imap://${GMAIL}/INBOX', 0, 0);

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
      (106, 0, 7006, 1, NULL,  1, ${t("2026-08-09T08:00:00Z")}, ${t("2026-08-09T08:00:05Z")}, 2, 0, 1, 0, 0, 100, 904),
      (107, 0, 7007, 1, NULL,  1, ${t("2026-08-10T08:00:00Z")}, ${t("2026-08-10T08:00:05Z")}, 4, 0, 1, 0, 0, 100, 905),
      (108, 0, 7008, 1, NULL,  2, ${t("2026-08-11T08:00:00Z")}, ${t("2026-08-11T08:00:05Z")}, 3, 0, 1, 0, 0, 100, 906),
      (109, 0, 7009, 1, NULL,  1, ${t("2026-08-12T08:00:00Z")}, ${t("2026-08-12T08:00:05Z")}, 5, 0, 1, 0, 0, 100, 907),
      (110, 0, 7010, 1, NULL,  1, ${t("2026-08-13T08:00:00Z")}, ${t("2026-08-13T08:00:05Z")}, 99, 0, 1, 0, 0, 100, 908),
      (111, 0, 7011, 1, NULL,  1, ${t("2026-08-14T08:00:00Z")}, NULL, 1, 0, 1, 0, 0, 100, 909);

    -- Gmail keeps INBOX membership as a label row on the All Mail message.
    INSERT INTO labels (message_id, mailbox_id) VALUES (108, 6);
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

/** What the mailbox map would say for the fixture. Mailbox 5 (`local://`) resolves to nothing. */
const LOOKUP = new Map([
  [1, { accountUuid: ICLOUD, mailbox: "INBOX" }],
  [2, { accountUuid: ICLOUD, mailbox: "Archive" }],
  [3, { accountUuid: GMAIL, mailbox: "All Mail" }],
  [4, { accountUuid: ICLOUD, mailbox: "Sent Messages" }],
  [6, { accountUuid: GMAIL, mailbox: "INBOX" }],
]);
const lookup = (rowid: number) => LOOKUP.get(rowid) ?? null;

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
      const rows = index.arrivalsAfter(101, 20);
      expect(rows.map((r) => r.rowid)).toEqual([102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
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

  it("returns label mailbox ids, and keeps a null date_received null", () => {
    const index = open();
    try {
      const rows = new Map(index.arrivalsAfter(100, 20).map((r) => [r.rowid, r]));
      expect(rows.get(108)?.labelMailboxIds).toEqual([6]);
      expect(rows.get(105)?.labelMailboxIds).toEqual([]);
      expect(rows.get(111)?.dateReceived).toBeNull();
    } finally {
      index.close();
    }
  });

  it("returns a row whose mailbox row is missing instead of dropping it", () => {
    const index = open();
    try {
      const row = index.arrivalsAfter(109, 1)[0];
      expect(row).toMatchObject({ rowid: 110, mailboxRowid: 99, mailboxUrl: null });
    } finally {
      index.close();
    }
  });

  it("reports the highest ROWID as head", () => {
    const index = open();
    try {
      expect(index.headRowid()).toBe(111);
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

const rowsOf = (source: MailArrivalSource) =>
  new Map(source.since(100, 20).map((r) => [r.cursor, r]));

describe("MailArrivalSource", () => {
  const own = ["ME@icloud.com"];

  it("excludes Sent, own-address and unresolvable rows, each for its own reason", () => {
    const index = open();
    try {
      const by = rowsOf(new MailArrivalSource({ index, ownAddresses: own, lookup }));
      expect(by.get(101)?.excluded).toBeUndefined();
      expect(by.get(101)?.sender).toBe("sam@example.com");
      // Sent Messages from an own address.
      expect(by.get(103)?.excluded).toBe(true);
      // All Mail from me@icloud.com, matched case-insensitively: only the sender rule applies.
      expect(by.get(104)?.excluded).toBe(true);
      // All Mail from someone else.
      expect(by.get(105)?.excluded).toBeUndefined();
      // Sent Messages from a NON-own sender: only the Sent rule applies.
      expect(by.get(107)?.excluded).toBe(true);
      // No lookup entry (local://) and no mailbox row at all: excluded, no ref from the raw URL.
      for (const id of [109, 110]) {
        expect(by.get(id)?.excluded).toBe(true);
        expect(by.get(id)?.ref).toBe("");
        expect(by.get(id)?.mailbox).toBe("");
      }
    } finally {
      index.close();
    }
  });

  it("does not exclude a Sent row when ownAddresses is empty and the sender is not own", () => {
    const index = open();
    try {
      const by = rowsOf(new MailArrivalSource({ index, ownAddresses: [], lookup }));
      expect(by.get(104)?.excluded).toBeUndefined();
      expect(by.get(107)?.excluded).toBe(true);
    } finally {
      index.close();
    }
  });

  it("tags every row with its own mailbox rowid, plus its labels, as scope keys", () => {
    const index = open();
    try {
      const by = rowsOf(new MailArrivalSource({ index, ownAddresses: [], lookup }));
      expect(by.get(106)?.scope).toEqual(["2"]);
      // 108 lives in All Mail (3) and is in INBOX (6) only by its label.
      expect([...(by.get(108)?.scope ?? [])].toSorted()).toEqual(["3", "6"]);
    } finally {
      index.close();
    }
  });

  it("does not drop out-of-scope rows itself: scope is the watch's to apply", () => {
    const index = open();
    try {
      const rows = new MailArrivalSource({ index, ownAddresses: [], lookup }).since(100, 20);
      expect(rows.filter((r) => !r.excluded).map((r) => r.cursor)).toContain(106);
      expect(rows.filter((r) => !r.excluded).map((r) => r.cursor)).toContain(101);
    } finally {
      index.close();
    }
  });

  it("counts a Gmail label as membership: a watch scoped to Gmail INBOX reads the labelled row", () => {
    const index = open();
    try {
      const registry = new WatchRegistry({
        surface: "mail",
        source: new MailArrivalSource({ index, ownAddresses: [], lookup }),
        onUpdate: () => {},
      });
      const watch = registry.add(normalizeFilter({ from: ["sam@example.com"], scope: ["6"] }));
      const read = registry.read(watch.id, 100);
      expect(read?.messages.map((m) => m.cursor)).toEqual([108]);
    } finally {
      index.close();
    }
  });

  it("carries envelope metadata only, with key, ref and date as search renders them", () => {
    const index = open();
    try {
      const source = new MailArrivalSource({ index, ownAddresses: [], lookup });
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
        scope: ["1"],
      });
      expect(decodeRef(row!.ref)).toEqual({ accountUuid: ICLOUD, mailbox: "INBOX", id: 102 });
    } finally {
      index.close();
    }
  });

  it("renders a null date_received as null, not the epoch", () => {
    const index = open();
    try {
      const by = rowsOf(new MailArrivalSource({ index, ownAddresses: [], lookup }));
      expect(by.get(111)?.dateReceived).toBeNull();
    } finally {
      index.close();
    }
  });

  it("reports head from the index", () => {
    const index = open();
    try {
      expect(new MailArrivalSource({ index, ownAddresses: [], lookup }).head()).toBe(111);
    } finally {
      index.close();
    }
  });
});

describe("refs match search refs", () => {
  const ACCOUNTS = [
    {
      id: ICLOUD,
      name: "iCloud",
      enabled: true,
      accountType: "iCloud",
      emailAddresses: ["me@icloud.com"],
      fullName: "Me",
      directory: null,
      messageCaching: null,
      mailboxes: ["INBOX", "Archive", "Sent Messages"],
    },
    {
      id: GMAIL,
      name: "Gmail",
      enabled: true,
      accountType: "Gmail",
      emailAddresses: ["me@gmail.com"],
      fullName: "Me",
      directory: null,
      messageCaching: null,
      mailboxes: ["All Mail", "INBOX"],
    },
  ];

  const clientFor = (env: Record<string, string>) =>
    new AppleMailClient({
      config: loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: dbPath, ...env }),
      osascript: { run: async () => ACCOUNTS } as unknown as OsascriptRunner,
      ax: null,
    });

  const compare = async (env: Record<string, string>) => {
    const client = clientFor(env);
    const index = (await client.index())!;
    const found = await client.searchMessages({ limit: 50, offset: 0 });
    const map = await client.mailboxLookup();
    const source = new MailArrivalSource({
      index,
      ownAddresses: [],
      lookup: (rowid) => map.get(rowid) ?? null,
    });
    const rows = new Map(source.since(0, 50).map((r) => [r.cursor, r]));
    return { found: found!.messages, rows, index };
  };

  it("is byte-identical to searchMessages for every row search returns", async () => {
    const { found, rows, index } = await compare({});
    try {
      const ids = found.map((m) => decodeRef(m.ref).id).toSorted();
      // INBOX, Archive, Sent, Gmail All Mail (with and without a label): all resolve.
      expect(ids).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 111]);
      for (const m of found) {
        const row = rows.get(decodeRef(m.ref).id)!;
        expect(row.ref).toBe(m.ref);
        expect(row.mailbox).toBe(decodeRef(m.ref).mailbox);
        expect(row.dateReceived).toBe(m.dateReceived);
      }
      // The Gmail row, in particular, is `All Mail` and not `[Gmail]/All Mail`.
      expect(rows.get(105)?.mailbox).toBe("All Mail");
      expect(rows.get(105)?.ref).toBe(
        encodeRef({ accountUuid: GMAIL, mailbox: "All Mail", id: 105 }),
      );
      // The local:// row and the orphan are not in search, and are excluded here.
      expect(rows.get(109)?.excluded).toBe(true);
      expect(rows.get(110)?.excluded).toBe(true);
    } finally {
      index.close();
    }
  });

  it("drops the same rows search drops when the account allowlist hides Gmail", async () => {
    const { found, rows, index } = await compare({ APPLE_MAIL_ACCOUNTS: "iCloud" });
    try {
      const ids = new Set(found.map((m) => decodeRef(m.ref).id));
      expect(ids.has(105)).toBe(false);
      for (const id of [104, 105, 108]) {
        expect(rows.get(id)?.excluded).toBe(true);
        expect(rows.get(id)?.ref).toBe("");
      }
      for (const m of found) expect(rows.get(decodeRef(m.ref).id)?.ref).toBe(m.ref);
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
