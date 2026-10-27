// A temp Mail store for scripts that run Mail's built server against fixtures.
//
// Shared by `scripts/mcp-era.test.mjs` (stdio) and `scripts/events-conformance.mjs`
// (HTTP), which need the same three things: an `Envelope Index` built from the
// captured DDL, as packages/mail's tests build theirs; one iCloud account with an
// INBOX and one sender, `jo@acme.com`; and a stub `osascript` that answers the
// account listing a watch or an event poll sends, so the mailbox lookup loads
// whether or not Mail is running here. Nothing real is read or driven.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const UUID = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
export const ACCOUNT = {
  id: UUID,
  name: "iCloud",
  enabled: true,
  accountType: "iCloud",
  emailAddresses: ["me@icloud.com"],
  fullName: "Me",
  directory: null,
  messageCaching: null,
  mailboxes: ["INBOX"],
};

/**
 * A temp dir holding a seeded `Envelope Index` and a stub `osascript`.
 *
 * `arrive(rowid)` inserts one message from `jo@acme.com` into INBOX, received at
 * `receivedAt` (Unix seconds; a fixed 2026 date unless given). Row 101 is there
 * from the start.
 */
export const mailFixture = (prefix = "mail-fixture-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const index = join(dir, "Envelope Index");
  const db = new DatabaseSync(index);
  db.exec(
    readFileSync(join(root, "packages", "mail", "test", "fixtures", "envelope-index.sql"), "utf8"),
  );
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (1, 'imap://${UUID}/INBOX', 0, 0);
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Quote');
    INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'jo@acme.com', 'Jo');
  `);
  const arrive = (rowid, receivedAt = 1790000005) =>
    db.exec(`
      INSERT INTO messages
        (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
         mailbox, flags, read, flagged, deleted, size, conversation_id)
      VALUES (${rowid}, 0, ${rowid + 7000}, 1, NULL, 1, ${receivedAt - 5}, ${receivedAt}, 1, 0, 0, 0, 0, 100, 900);
    `);
  arrive(101);
  // Reads the script on stdin like osascript, and answers the account listing
  // with the canned account; any other script gets an empty list. The shebang
  // names this node by path: the runner does not pass the caller's PATH on.
  const osascript = join(dir, "osascript");
  writeFileSync(
    osascript,
    `#!${process.execPath}
let script = "";
process.stdin.on("data", (c) => (script += c));
process.stdin.on("end", () => {
  const data = script.includes("a.emailAddresses()") ? ${JSON.stringify([ACCOUNT])} : [];
  process.stdout.write(JSON.stringify({ ok: true, data }));
});
`,
  );
  chmodSync(osascript, 0o755);
  return {
    dir,
    index,
    osascript,
    arrive,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
