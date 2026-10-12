import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAIL_SURFACE,
  MailNotRunningError,
  OsascriptTimeoutError,
  ProtocolError,
} from "../src/client/errors.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

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

/** What Mail does when asked to fetch and save an attachment. */
type Fetch = (params: {
  accountUuid: string;
  mailbox: string;
  id: number;
  filename: string;
  dest: string;
}) => unknown;

const runner = (fetch?: Fetch): OsascriptRunner => ({
  run: vi.fn(async (script: string, params?: unknown) => {
    if (script.includes("M.save(")) {
      if (!fetch) throw new Error("Mail was asked to fetch an attachment");
      return fetch(params as Parameters<Fetch>[0]);
    }
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

/**
 * A .sql attachment Mail stripped out of the message file: the part keeps its
 * headers and loses its body. The shape of the live repro.
 */
const STRIPPED = [
  "From: sender@example.com",
  "Subject: Nested in a container",
  'Content-Type: multipart/mixed; boundary="M"',
  "",
  "--M",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Attached: our failing queries.",
  "--M",
  'Content-Type: application/octet-stream; name="failures.sql"',
  'Content-Disposition: attachment; filename="failures.sql"',
  "",
  "--M--",
].join("\r\n");

/** `container` omitted lays the mailbox flat, which is the regression guard. */
const layDownMessage = (container?: string, mime = MESSAGE) => {
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
  writeFileSync(join(messages, `${ROWID}.emlx`), emlx(mime));
  return join(messages, `${ROWID}.emlx`);
};

const layDownSidecar = (messagePath: string) => {
  // Mail's layout: Data/<shard>/Attachments/<rowid>/<part>/<filename>
  const part = join(messagePath, "..", "..", "Attachments", String(ROWID), "2");
  mkdirSync(part, { recursive: true });
  writeFileSync(join(part, "failures.sql"), "SELECT 1;\n");
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

const config = () =>
  loadConfig({
    APPLE_MAIL_ENVELOPE_INDEX: dbPath,
    APPLE_MAIL_ATTACHMENT_DIR: downloads,
    APPLE_MAIL_ALLOW_WRITES: "1",
  });

const client = (osascript: OsascriptRunner = runner()) =>
  new AppleMailClient({ config: config(), osascript });

/** Call a tool through the real server, for what the handler adds on top. */
const callTool = async (name: string, args: Record<string, unknown>) => {
  const { server } = createServer({ config: config(), osascript: runner() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  const result = await mcp.callTool({ name, arguments: args });
  return JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}");
};

const ref = encodeRef({ accountUuid: GMAIL, mailbox: "All Mail", id: ROWID });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-lane-"));
  accountDir = join(dir, "V10", GMAIL);
  dbPath = join(dir, "Envelope Index");
  // Resolved, because a saved path is: the confinement check follows symlinks
  // now, and the temp directory is under /var, which is one.
  downloads = join(realpathSync(dir), "Downloads");
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

/**
 * get_message's note has to agree with what save_attachment will do. It used to
 * fire on any stripped attachment, so an agent read "cannot retrieve them"
 * beside `retrievable: true`, believed the note, and never tried the save that
 * would have worked.
 */
describe("an attachment stripped out to the sidecar tree", () => {
  it("does not tell the caller to open Mail when the sidecar is on disk", async () => {
    layDownSidecar(layDownMessage(undefined, STRIPPED));
    const payload = await callTool("apple_mail_get_message", { ref });

    expect(payload.attachments).toEqual([
      expect.objectContaining({ filename: "failures.sql", sizeBytes: 10, retrievable: true }),
    ]);
    expect(payload.note).toBeUndefined();
  });

  it("names the attachment Mail has not downloaded yet", async () => {
    layDownMessage(undefined, STRIPPED);
    const payload = await callTool("apple_mail_get_message", { ref });

    expect(payload.attachments[0]).toMatchObject({ retrievable: false, sizeBytes: null });
    expect(payload.note).toMatch(/failures\.sql/);
    // save_attachment now has Mail download it, so the note points there
    // rather than sending the caller to open Mail by hand.
    expect(payload.note).toMatch(/apple_mail_save_attachment asks Mail to download/);
    expect(payload.note).not.toMatch(/cannot retrieve/);
  });
});

/**
 * An attachment Mail never downloaded: a Gmail account caching messages without
 * their attachments leaves a `.partial.emlx` and no sidecar. Mail's own `save`
 * fetches it from the server, and that also leaves the sidecar behind, so
 * save_attachment asks Mail rather than sending the caller to open the message.
 */
const SQL = "SELECT 1;\n";

/** Mail fetching the file and writing it where it was told. */
const mailSaves =
  (bytes: string = SQL, name?: string): Fetch =>
  (p) => {
    writeFileSync(name ? join(dirname(p.dest), name) : p.dest, bytes);
    return { saved: true, downloaded: false, fileSize: bytes.length };
  };

describe("an attachment Mail has not downloaded", () => {
  const leftInDownloads = () => (existsSync(downloads) ? readdirSync(downloads) : []);

  it("asks Mail to download it and saves what Mail fetched", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(mailSaves());
    const saved = await client(runner(fetch)).saveAttachment(ref, "failures.sql");

    expect(saved).toEqual({ path: join(downloads, "failures.sql"), bytes: 10, from: "mail" });
    expect(readFileSync(saved.path, "utf8")).toBe(SQL);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        accountUuid: GMAIL,
        mailbox: "All Mail",
        id: ROWID,
        filename: "failures.sql",
      }),
    );
  });

  it("lets Mail write into a staging folder it then removes, never the destination", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(mailSaves());
    await client(runner(fetch)).saveAttachment(ref, "failures.sql");

    const dest = fetch.mock.calls[0]![0].dest;
    expect(dest).not.toBe(join(downloads, "failures.sql"));
    expect(dest.startsWith(downloads + "/")).toBe(true);
    expect(leftInDownloads()).toEqual(["failures.sql"]);
  });

  it("takes the file Mail wrote even when Mail named it differently", async () => {
    layDownMessage(undefined, STRIPPED);
    await client(runner(mailSaves(SQL, "failures 2.sql"))).saveAttachment(ref, "failures.sql");

    expect(readFileSync(join(downloads, "failures.sql"), "utf8")).toBe(SQL);
    expect(leftInDownloads()).toEqual(["failures.sql"]);
  });

  it("gives the download a longer budget than an ordinary Apple Event", async () => {
    layDownMessage(undefined, STRIPPED);
    const osascript = runner(mailSaves());
    await client(osascript).saveAttachment(ref, "failures.sql");

    const fetchCall = vi
      .mocked(osascript.run)
      .mock.calls.find(([script]) => (script as string).includes("M.save("));
    // A margin over Mail's own 120 s reply deadline, so the script's catch
    // around `save` answers before the process is killed.
    expect(fetchCall?.[2]).toEqual({ timeoutMs: 135_000 });
  });

  it("never asks Mail when the sidecar is already on disk", async () => {
    layDownSidecar(layDownMessage(undefined, STRIPPED));
    const fetch = vi.fn(mailSaves());
    const saved = await client(runner(fetch)).saveAttachment(ref, "failures.sql");

    expect(saved.from).toBe("sidecar");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses before downloading when the destination already exists", async () => {
    layDownMessage(undefined, STRIPPED);
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, "failures.sql"), "mine");
    const fetch = vi.fn(mailSaves());

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /already exists/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(downloads, "failures.sql"), "utf8")).toBe("mine");
  });

  it("names what Mail lists when no attachment matches", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => ({
      saved: false,
      reason: "none",
      names: ["queries.sql", "logo.png"],
    }));

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /queries\.sql, logo\.png/,
    );
    expect(leftInDownloads()).toEqual([]);
  });

  it("refuses to guess between two attachments of the same name", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => ({ saved: false, reason: "ambiguous", count: 2 }));

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /2 attachments named "failures\.sql"/,
    );
    expect(leftInDownloads()).toEqual([]);
  });

  it("passes on Mail's reason when the download fails", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => ({
      saved: false,
      reason: "save-failed",
      error: "The operation couldn't be completed.",
    }));

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /could not download "failures\.sql".*couldn't be completed/,
    );
    expect(leftInDownloads()).toEqual([]);
  });

  it("does not report success when Mail wrote nothing", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => ({ saved: true, downloaded: false, fileSize: 10 }));

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /wrote no file/,
    );
    expect(leftInDownloads()).toEqual([]);
  });

  it("says Mail has to be running to download it", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => {
      throw new MailNotRunningError(MAIL_SURFACE);
    });

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /not stored locally.*Mail is not running/,
    );
    expect(leftInDownloads()).toEqual([]);
  });

  it("does not mistake an answer it cannot read for Mail's reason", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => []);

    const failure = client(runner(fetch)).saveAttachment(ref, "failures.sql");
    await expect(failure).rejects.toThrow(/not stored locally.*answer/);
    await expect(failure).rejects.not.toThrow(/undefined/);
  });

  it("takes only a file from Mail, not a folder it left there", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn((p: Parameters<Fetch>[0]) => {
      mkdirSync(p.dest);
      return { saved: true, downloaded: false, fileSize: 10 };
    });

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /wrote no file/,
    );
    expect(leftInDownloads()).toEqual([]);
  });

  it("says Mail may still be downloading when the call runs out of time", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => {
      throw new OsascriptTimeoutError(135_000, MAIL_SURFACE);
    });

    const failure = client(runner(fetch)).saveAttachment(ref, "failures.sql");
    await expect(failure).rejects.toThrow(/not stored locally.*still be downloading/);
    // Raising the osascript budget cannot outlast Mail's own reply deadline,
    // so the generic advice to do that must not reach the caller.
    await expect(failure).rejects.not.toThrow(/OSASCRIPT_TIMEOUT_MS/);
    expect(leftInDownloads()).toEqual([]);
  });

  it("keeps the context when Mail's script fails", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => {
      throw new ProtocolError("No message 189233 in All Mail", { code: "MESSAGE_NOT_FOUND" });
    });

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /not stored locally.*No message 189233 in All Mail/,
    );
  });

  it("reads an empty answer as unreadable rather than crashing on it", async () => {
    layDownMessage(undefined, STRIPPED);
    const fetch = vi.fn(() => undefined);

    await expect(client(runner(fetch)).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /not stored locally.*answer/,
    );
  });

  it("replaces an existing file through the download when asked to", async () => {
    layDownMessage(undefined, STRIPPED);
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, "failures.sql"), "old");

    const saved = await client(runner(mailSaves())).saveAttachment(ref, "failures.sql", {
      overwrite: true,
    });
    expect(saved.from).toBe("mail");
    expect(readFileSync(join(downloads, "failures.sql"), "utf8")).toBe(SQL);
  });

  it("does not report success when Mail wrote an empty file", async () => {
    layDownMessage(undefined, STRIPPED);

    await expect(client(runner(mailSaves(""))).saveAttachment(ref, "failures.sql")).rejects.toThrow(
      /empty/,
    );
    expect(leftInDownloads()).toEqual([]);
  });
});

/**
 * The live repro (Gmail "All Mail", 2017, Open-Xchange): a headers-only part
 * whose filename is an RFC 2047 encoded word split across unstarred RFC 2231
 * continuations. The list tools reported the raw encoded word; saving by that
 * name passed the message-file check and then Mail, which lists the decoded
 * name, refused it; saving by the decoded name failed the message-file check.
 */
const ENCODED_NAME = "=?UTF-8?Q?COF01_ind-_plan_ing=C3=A9nieur_b=C3=A9ton_du_28.02.2017.pdf?=";
const DECODED_NAME = "COF01 ind- plan ingénieur béton du 28.02.2017.pdf";
const PDF = "%PDF-1.4 plan\n";

const SPLIT_ENCODED_WORD = [
  "From: Jean-Christophe Simon <contact@example.fr>",
  "Subject: =?UTF-8?Q?Etude_ing=C3=A9nieur?=",
  "MIME-Version: 1.0",
  "Content-Type: multipart/mixed;",
  ' boundary="----=_Part_13453"',
  "",
  "",
  "------=_Part_13453",
  "Content-Transfer-Encoding: 7BIT",
  "Content-Type: TEXT/HTML;",
  "\tcharset=UTF-8",
  "",
  "<p>Ci joint le plan modifi&#233;.</p>",
  "------=_Part_13453",
  "Content-Transfer-Encoding: BASE64",
  "Content-Disposition: ATTACHMENT;",
  '\tfilename*0="=?UTF-8?Q?COF01_ind-_plan_ing=C3=A9nieur_b=C3=A9ton_du_28.02.201";',
  '\tfilename*1="7.pdf?="',
  "Content-Type: APPLICATION/PDF;",
  '\tname*0="=?UTF-8?Q?COF01_ind-_plan_ing=C3=A9nieur_b=C3=A9ton_du_28.02.201";',
  '\tname*1="7.pdf?="',
  "X-Apple-Content-Length: 363882",
  "",
  "",
  "------=_Part_13453--",
].join("\n");

/** Mail as it behaves: it lists the decoded name and matches it after NFC. */
const mailHasDecodedName: Fetch = (p) => {
  if (p.filename.normalize("NFC") !== DECODED_NAME.normalize("NFC")) {
    return { saved: false, reason: "none", names: [DECODED_NAME] };
  }
  writeFileSync(p.dest, PDF);
  return { saved: true, downloaded: false, fileSize: PDF.length };
};

describe("a filename sent as an encoded word split across continuations", () => {
  it("lists the decoded name, in both list_attachments and get_message", async () => {
    layDownMessage(undefined, SPLIT_ENCODED_WORD);

    const listed = await callTool("apple_mail_list_attachments", { ref });
    expect(listed.attachments).toEqual([
      expect.objectContaining({ filename: DECODED_NAME, retrievable: false, sizeBytes: null }),
    ]);

    const message = await callTool("apple_mail_get_message", { ref });
    expect(message.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      DECODED_NAME,
    ]);
    expect(message.note).toContain(DECODED_NAME);
  });

  it("saves it by the listed name, through Mail's download", async () => {
    layDownMessage(undefined, SPLIT_ENCODED_WORD);
    const fetch = vi.fn(mailHasDecodedName);
    const saved = await client(runner(fetch)).saveAttachment(ref, DECODED_NAME);

    expect(saved).toEqual({ path: join(downloads, DECODED_NAME), bytes: PDF.length, from: "mail" });
    expect(readFileSync(saved.path, "utf8")).toBe(PDF);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ filename: DECODED_NAME }));
  });

  it("still accepts the raw encoded form an earlier version listed, and saves the decoded name", async () => {
    layDownMessage(undefined, SPLIT_ENCODED_WORD);
    const fetch = vi.fn(mailHasDecodedName);
    const saved = await client(runner(fetch)).saveAttachment(ref, ENCODED_NAME);

    expect(saved).toMatchObject({ path: join(downloads, DECODED_NAME), from: "mail" });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ filename: DECODED_NAME }));
  });

  it("matches a name spelled in NFD against the message's NFC", async () => {
    layDownMessage(undefined, SPLIT_ENCODED_WORD);
    const fetch = vi.fn(mailHasDecodedName);
    const saved = await client(runner(fetch)).saveAttachment(ref, DECODED_NAME.normalize("NFD"));

    expect(saved.from).toBe("mail");
    expect(readFileSync(saved.path, "utf8")).toBe(PDF);
  });

  it("finds a sidecar Mail stored under the NFD spelling", async () => {
    const path = layDownMessage(undefined, SPLIT_ENCODED_WORD);
    const part = join(path, "..", "..", "Attachments", String(ROWID), "2");
    mkdirSync(part, { recursive: true });
    writeFileSync(join(part, DECODED_NAME.normalize("NFD")), PDF);
    const fetch = vi.fn(mailHasDecodedName);

    const listed = await callTool("apple_mail_list_attachments", { ref });
    expect(listed.attachments[0]).toMatchObject({ retrievable: true, sizeBytes: PDF.length });

    const saved = await client(runner(fetch)).saveAttachment(ref, DECODED_NAME);
    expect(saved.from).toBe("sidecar");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names what the message holds when nothing matches", async () => {
    layDownMessage(undefined, SPLIT_ENCODED_WORD);

    await expect(client(runner(vi.fn())).saveAttachment(ref, "other.pdf")).rejects.toThrow(
      `No attachment named "other.pdf" in this message. It lists: ${DECODED_NAME}.`,
    );
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

/*
 * The raw source when no file is on disk and Mail has to supply it.
 *
 * The tool pages in bytes, as the `.emlx` lane does, but this lane sliced the
 * JavaScript string Mail returned: its offsets and `totalBytes` were UTF-16
 * code units, so one offset named a different place in each lane, and a page
 * could end on half a surrogate pair.
 */
describe("the source Mail supplies when the file is not cached", () => {
  const SOURCE = "Subject: Réunion été\r\n\r\nCafé \u{1F600} fin\r\n";

  const sourceRunner = (): OsascriptRunner => {
    const base = runner();
    return {
      run: vi.fn(async (script: string, params?: unknown) => {
        const answer = await base.run<Record<string, unknown>[]>(script, params);
        return script.includes("mb.messages.byId")
          ? answer.map((m) => ({ ...m, source: SOURCE }))
          : answer;
      }) as OsascriptRunner["run"],
    };
  };

  it("counts and pages in UTF-8 bytes, like the file lane", async () => {
    const mail = new AppleMailClient({ config: config(), osascript: sourceRunner() });
    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await mail.getMessageSource(ref, { offset, maxBytes: 11 });
      expect(page.via).toBe("applescript");
      expect(page.totalBytes).toBe(Buffer.byteLength(SOURCE, "utf8"));
      pages.push(page.source);
      if (!page.truncated) break;
      offset = page.nextOffset;
    }
    expect(pages.join("")).toBe(SOURCE);
    expect(pages.join("")).not.toContain("�");
  });
});
