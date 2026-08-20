import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig } from "../src/config.js";

/**
 * The message-file lane, end to end, on the shape that broke it.
 *
 * A Gmail account nests its special mailboxes under `[Gmail].mbox`, and the ref
 * that reaches the file lane carries only the leaf name `All Mail` — the search
 * lane strips the `[Gmail]/` prefix on its way through. Joining
 * `<account>/All Mail.mbox` therefore found nothing, every reader quietly fell
 * back to AppleScript, and `save_attachment` (which has no fallback) failed on
 * every message while diagnostics reported Full Disk Access as granted.
 *
 * These tests build a real Envelope Index and a real nested mail store, so the
 * whole path — index url -> mailbox name -> on-disk directory -> file — runs.
 */

const GMAIL = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";
const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

/** Seconds since the unix epoch, matching what Mail V10 actually stores. */
const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const PLIST = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>';

const emlx = (mime: string): Buffer => {
  const body = Buffer.from(mime, "utf8");
  return Buffer.concat([
    Buffer.from(`${body.length}\n`, "ascii"),
    body,
    Buffer.from(PLIST, "utf8"),
  ]);
};

/** Two inline PNGs, the shape the live repro reported. */
const MESSAGE = [
  "From: sender@example.com",
  "Subject: Nested in a container",
  'Content-Type: multipart/mixed; boundary="M"',
  "",
  "--M",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "See the screenshots.",
  "--M",
  'Content-Type: image/png; name="image002.png"',
  'Content-Disposition: inline; filename="image002.png"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("PNG-TWO", "utf8").toString("base64"),
  "--M",
  'Content-Type: image/png; name="image003.png"',
  'Content-Disposition: inline; filename="image003.png"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("PNG-THREE", "utf8").toString("base64"),
  "--M--",
].join("\r\n");

/** ROWID 189233 -> floor(189233/1000) = 189 -> digits reversed -> 9/8/1 */
const ROWID = 189_233;
const SHARD = ["9", "8", "1"];

let dir: string;
let accountDir: string;
let dbPath: string;
let downloads: string;

const runner = (): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (script.includes("a.emailAddresses()")) {
      return [
        {
          id: GMAIL,
          name: "Magenta",
          enabled: true,
          accountType: "IMAP",
          emailAddresses: ["me@gmail.com"],
          fullName: "Me",
          directory: accountDir,
          messageCaching: "all messages and their attachments",
          // Mail reports leaf names, which is why the full path is unavailable
          // downstream and the directory has to be found by walking.
          mailboxes: ["INBOX", "All Mail", "Sent Mail", "Trash"],
        },
      ];
    }
    // GET_MESSAGES supplies the envelope fields (read/flagged) that the file
    // does not carry, so it is asked even when the file lane wins.
    if (script.includes("mb.messages.byId")) {
      return [
        {
          id: ROWID,
          accountUuid: GMAIL,
          mailbox: "All Mail",
          subject: "Nested in a container",
          sender: "Sender <sender@example.com>",
          dateReceived: "2026-08-09T08:00:05.000Z",
          read: true,
          flagged: false,
          // No `content`: if the file lane were to degrade, the body would come
          // back empty rather than silently looking like a successful read.
          content: null,
        },
      ];
    }
    return [];
  }) as OsascriptRunner["run"],
});

/** `container` omitted lays the mailbox flat, which is the regression guard. */
const layDownMessage = (container?: string) => {
  const messages = join(
    accountDir,
    ...(container ? [`${container}.mbox`] : []),
    "All Mail.mbox",
    "MBOX-UUID",
    "Data",
    ...SHARD,
    "Messages",
  );
  mkdirSync(messages, { recursive: true });
  writeFileSync(join(messages, `${ROWID}.emlx`), emlx(MESSAGE));
  return join(messages, `${ROWID}.emlx`);
};

const seedIndex = () => {
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (3, 'imap://${GMAIL}/%5BGmail%5D/All%20Mail', 1, 0);
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Nested in a container');
    INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'sender@example.com', 'Sender');
    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent,
       date_received, mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES
      (${ROWID}, 0, 1, 1, NULL, 1, ${t("2026-08-09T08:00:00Z")}, ${t("2026-08-09T08:00:05Z")},
       3, 0, 1, 0, 0, 900, 903);
  `);
  db.close();
};

const client = () =>
  new AppleMailClient({
    config: loadConfig({
      APPLE_MAIL_ENVELOPE_INDEX: dbPath,
      APPLE_MAIL_ATTACHMENT_DIR: downloads,
      APPLE_MAIL_ALLOW_WRITES: "1",
    }),
    osascript: runner(),
  });

const ref = encodeRef({ accountUuid: GMAIL, mailbox: "All Mail", id: ROWID });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-lane-"));
  accountDir = join(dir, "V10", GMAIL);
  dbPath = join(dir, "Envelope Index");
  downloads = join(dir, "Downloads");
  mkdirSync(accountDir, { recursive: true });
  seedIndex();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a mailbox nested under [Gmail]", () => {
  it("reads the body from the file rather than falling back to Mail", async () => {
    layDownMessage("[Gmail]");
    const { source, parsed } = await client().getMessageBody(ref);

    expect(source).toBe("emlx");
    expect(parsed?.body).toContain("See the screenshots.");
    expect(parsed?.path).toContain(join("[Gmail].mbox", "All Mail.mbox"));
  });

  it("lists both attachments instead of degrading", async () => {
    layDownMessage("[Gmail]");
    const { parsed } = await client().getMessageBody(ref);

    expect(parsed?.attachments.map((a) => a.filename)).toEqual(["image002.png", "image003.png"]);
  });

  it("saves an attachment, which has no AppleScript fallback to hide behind", async () => {
    layDownMessage("[Gmail]");
    const saved = await client().saveAttachment(ref, "image003.png");

    expect(saved.path).toBe(join(downloads, "image003.png"));
    expect(readFileSync(saved.path, "utf8")).toBe("PNG-THREE");
  });

  it("still reads a flat mailbox, so the INBOX path does not regress", async () => {
    const path = layDownMessage();
    const { source, parsed } = await client().getMessageBody(ref);

    expect(source).toBe("emlx");
    expect(parsed?.path).toBe(path);
  });
});

describe("diagnostics probing the lane", () => {
  it("reports ok with the resolved nested path", async () => {
    layDownMessage("[Gmail]");
    const [probe] = await client().probeMessageFile();

    expect(probe).toMatchObject({ account: "Magenta", status: "ok", rowid: ROWID });
    expect(probe?.path).toContain(join("[Gmail].mbox", "All Mail.mbox"));
  });

  it("reports unreachable and names what it probed when no file exists", async () => {
    // The mailbox directory is there; the message is not.
    mkdirSync(join(accountDir, "[Gmail].mbox", "All Mail.mbox", "MBOX-UUID"), { recursive: true });
    const [probe] = await client().probeMessageFile();

    expect(probe).toMatchObject({ status: "unreachable", reason: "no-message-file" });
    expect(probe?.probed?.[0]).toContain(join("[Gmail].mbox", "All Mail.mbox"));
  });

  it("resolves the index's full path back to a mailbox Mail knows by leaf name", async () => {
    layDownMessage("[Gmail]");
    const [probe] = await client().probeMessageFile();

    // The index stores `[Gmail]/All Mail`; Mail lists it as `All Mail`.
    expect(probe?.mailbox).toBe("All Mail");
  });
});
