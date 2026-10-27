import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnvelopeIndex, openIndex } from "../src/client/envelope.js";

/**
 * `countGroups` must give every group exactly what `count` gives it.
 *
 * It exists to be fast — one pass for every mailbox, where `count` per
 * mailbox scans `messages` each time — and the fast shape has to get the
 * overlaps right: a Gmail message belongs to INBOX by label while living in
 * All Mail, a label can name the message's own mailbox, and one mailbox name
 * can cover several index rowids. Each overlap is a message that must be
 * counted once, never twice and never not at all.
 */

const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

let dir: string;
let index: EnvelopeIndex;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-count-groups-"));
  const path = join(dir, "Envelope Index");
  const db = new DatabaseSync(path);
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url) VALUES
      (1, 'imap://A/INBOX'), (2, 'imap://A/Archive'),
      (3, 'imap://G/%5BGmail%5D/All%20Mail'), (4, 'imap://G/INBOX'),
      (5, 'imap://G/Trash'), (6, 'imap://G/%5BGmail%5D/Trash');
    INSERT INTO subjects (ROWID, subject) VALUES (1, 's');
    INSERT INTO messages (ROWID, global_message_id, subject, mailbox, read, deleted) VALUES
      (1, 1, 1, 1, 0, 0),
      (2, 2, 1, 1, 1, 0),
      (3, 3, 1, 1, 0, 1),
      (4, 4, 1, 2, 1, 0),
      (5, 5, 1, 3, 0, 0),
      (6, 6, 1, 3, 1, 0),
      (7, 7, 1, 3, 0, 0),
      (8, 8, 1, 5, 0, 0),
      (9, 9, 1, 3, 1, 0);
    INSERT INTO labels (message_id, mailbox_id) VALUES
      (5, 4), (6, 4),
      -- a label naming the message's own mailbox
      (7, 3),
      -- one message labelled into both Trash rowids, and one living in one
      -- of them while labelled into the other
      (9, 5), (9, 6), (8, 6),
      -- a deleted message's label still does not count
      (3, 2);
  `);
  db.close();
  index = new EnvelopeIndex(openIndex(path, "ro"));
});

afterAll(() => {
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const GROUPS = [
  { key: "A/INBOX", rowids: [1] },
  { key: "A/Archive", rowids: [2] },
  { key: "G/All Mail", rowids: [3] },
  { key: "G/INBOX", rowids: [4] },
  { key: "G/Trash", rowids: [5, 6] },
];

describe("countGroups", () => {
  it("gives every group the count `count` gives it", () => {
    const counts = index.countGroups(GROUPS);
    for (const g of GROUPS) {
      expect(counts.get(g.key) ?? { total: 0, unread: 0 }, g.key).toEqual(
        index.count({ mailboxRowids: g.rowids }),
      );
    }
  });

  it("counts a Gmail INBOX by its labels", () => {
    expect(index.countGroups(GROUPS).get("G/INBOX")).toEqual({ total: 2, unread: 1 });
  });

  it("counts once a message labelled with its own mailbox", () => {
    expect(index.countGroups(GROUPS).get("G/All Mail")).toEqual({ total: 4, unread: 2 });
  });

  it("counts once a message reached through two rowids of one name", () => {
    expect(index.countGroups(GROUPS).get("G/Trash")).toEqual({ total: 2, unread: 1 });
  });

  it("leaves out deleted messages, labels included", () => {
    expect(index.countGroups(GROUPS).get("A/INBOX")).toEqual({ total: 2, unread: 1 });
    expect(index.countGroups(GROUPS).get("A/Archive")).toEqual({ total: 1, unread: 0 });
  });

  it("reports nothing for a group with no rowids", () => {
    expect(index.countGroups([{ key: "none", rowids: [] }]).size).toBe(0);
  });
});
