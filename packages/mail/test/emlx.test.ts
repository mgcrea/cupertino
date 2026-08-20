import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  locateEmlx,
  lookupEmlx,
  readEmlx,
  readEmlxSource,
  resolveMailboxDirs,
  shardPath,
  splitEmlx,
} from "../src/client/emlx.js";
import { PreconditionError } from "../src/client/errors.js";

/**
 * These write real files at the real derived paths, so the shard derivation and
 * the scan fallback are both exercised on a filesystem rather than mocked away.
 */

const PLIST =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>1</integer></dict></plist>';

/** Build the container: length prefix, exactly that many bytes, then the trailer. */
const emlx = (mime: string): Buffer => {
  const body = Buffer.from(mime, "utf8");
  return Buffer.concat([
    Buffer.from(`${body.length}\n`, "ascii"),
    body,
    Buffer.from(PLIST, "utf8"),
  ]);
};

const MESSAGE = [
  "From: Domaine <billing@domaine.fr>",
  "To: me@icloud.com",
  "Subject: =?UTF-8?B?RmFjdHVyZSA1NzUz?=",
  "Date: Sat, 1 Aug 2026 10:00:00 +0000",
  "Message-ID: <abc123@domaine.fr>",
  'Content-Type: multipart/mixed; boundary="M"',
  "",
  "--M",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Votre facture est prete.",
  "--M",
  'Content-Type: application/pdf; name="facture.pdf"',
  'Content-Disposition: attachment; filename="facture.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--M--",
].join("\r\n");

let dir: string;
let accountDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-emlx-"));
  accountDir = join(dir, "V10", "ACCOUNT-UUID");

  // 198577 -> floor(198577/1000) = 198 -> digits reversed -> 8/9/1
  const derived = join(accountDir, "INBOX.mbox", "MBOX-UUID", "Data", "8", "9", "1", "Messages");
  mkdirSync(derived, { recursive: true });
  writeFileSync(join(derived, "198577.emlx"), emlx(MESSAGE));

  // A .partial.emlx twin, at its own shard.
  const partialDir = join(accountDir, "INBOX.mbox", "MBOX-UUID", "Data", "9", "9", "1", "Messages");
  mkdirSync(partialDir, { recursive: true });
  writeFileSync(
    join(partialDir, "199577.partial.emlx"),
    emlx(
      [
        "From: x@y.com",
        "Subject: Stripped",
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        "Content-Type: text/plain",
        "",
        "Body kept.",
        "--M",
        'Content-Type: application/zip; name="big.zip"',
        'Content-Disposition: attachment; filename="big.zip"',
        "",
        "--M--",
      ].join("\r\n"),
    ),
  );

  // A message filed somewhere the derivation will NOT predict, to force the scan.
  const odd = join(accountDir, "Archive.mbox", "MBOX-UUID", "Data", "weird", "Messages");
  mkdirSync(odd, { recursive: true });
  writeFileSync(join(odd, "42.emlx"), emlx("Subject: Found by scanning\r\n\r\nhello"));

  /*
   * The Gmail shape, which is what the flat `<account>/<mailbox>.mbox` join got
   * wrong: special mailboxes live under a `[Gmail].mbox` container, so nothing
   * named "All Mail" sits at the account root. Verified against a live store.
   *
   * 189233 -> floor(189233/1000) = 189 -> digits reversed -> 9/8/1
   */
  const gmail = join(
    accountDir,
    "[Gmail].mbox",
    "All Mail.mbox",
    "MBOX-UUID",
    "Data",
    "9",
    "8",
    "1",
    "Messages",
  );
  mkdirSync(gmail, { recursive: true });
  writeFileSync(join(gmail, "189233.emlx"), emlx("Subject: Nested\r\n\r\nfrom the container"));

  // Two levels of nesting: a Gmail label "Work/Projects" lands here.
  const deep = join(
    accountDir,
    "Work.mbox",
    "Projects.mbox",
    "Notes.mbox",
    "MBOX-UUID",
    "Data",
    "7",
    "Messages",
  );
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "7001.emlx"), emlx("Subject: Two deep\r\n\r\nhello"));

  /*
   * The same leaf name under two containers. The ref carries only "Receipts",
   * so the name alone cannot say which one — only the rowid can.
   */
  for (const [container, rowid] of [
    ["Personal", 3001],
    ["Business", 3002],
  ] as const) {
    const shared = join(
      accountDir,
      `${container}.mbox`,
      "Receipts.mbox",
      "MBOX-UUID",
      "Data",
      "3",
      "Messages",
    );
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, `${rowid}.emlx`), emlx(`Subject: ${container}\r\n\r\nreceipt`));
  }

  /*
   * A decoy inside a Data tree. The walk must never descend into `Data/` — if
   * it did, this would shadow the real mailbox and the walk would also be
   * scanning every message shard in the account.
   */
  const decoy = join(
    accountDir,
    "INBOX.mbox",
    "MBOX-UUID",
    "Data",
    "Trap.mbox",
    "MBOX-UUID",
    "Data",
    "8",
    "Messages",
  );
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "8123.emlx"), emlx("Subject: Decoy\r\n\r\nshould not be found"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("shard derivation", () => {
  it.each([
    [198_577, "8/9/1"],
    [5607, "5"],
    [49_461, "9/4"],
    [999, "0"],
  ])("maps %i to %s", (rowid, expected) => {
    expect(shardPath(rowid)).toBe(expected);
  });
});

describe("the container", () => {
  it("uses the length prefix to cut the plist trailer off", () => {
    const parsed = splitEmlx(emlx("Subject: x\r\n\r\nbody")).toString("utf8");
    expect(parsed).toBe("Subject: x\r\n\r\nbody");
    expect(parsed).not.toContain("plist");
  });

  it("never reads past the end when the prefix overstates the length", () => {
    const lying = Buffer.concat([Buffer.from("99999\n"), Buffer.from("short")]);
    expect(splitEmlx(lying).toString("utf8")).toBe("short");
  });

  it("falls back to the whole buffer when there is no prefix", () => {
    expect(splitEmlx(Buffer.from("Subject: x")).toString("utf8")).toBe("Subject: x");
  });
});

describe("locating", () => {
  it("finds a message at the derived shard", () => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 198_577 });
    expect(found?.path).toContain(join("Data", "8", "9", "1", "Messages", "198577.emlx"));
    expect(found?.partial).toBe(false);
  });

  it("finds the .partial twin and flags it", () => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 199_577 });
    expect(found?.partial).toBe(true);
  });

  it("falls back to scanning when the derived path is wrong", () => {
    // This is the case that keeps the body lane alive if Apple changes the layout.
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "Archive", rowid: 42 });
    expect(found?.path).toContain(join("weird", "Messages", "42.emlx"));
  });

  it("returns null for an unknown mailbox or message", () => {
    expect(locateEmlx({ accountDirectory: accountDir, mailbox: "Nope", rowid: 1 })).toBeNull();
    expect(locateEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 123 })).toBeNull();
  });
});

/**
 * The regression this file exists for: a Gmail account nests its special
 * mailboxes under `[Gmail].mbox`, so joining `<account>/<mailbox>.mbox` finds
 * nothing and every message-file capability silently degrades.
 */
describe("locating inside nested .mbox containers", () => {
  it("finds a Gmail mailbox from the bare leaf name the ref carries", () => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "All Mail", rowid: 189_233 });
    expect(found?.path).toContain(join("[Gmail].mbox", "All Mail.mbox"));
    expect(found?.path).toContain(join("Data", "9", "8", "1", "Messages", "189233.emlx"));
  });

  it("also accepts the full path, which the search lane resolves with", () => {
    const found = locateEmlx({
      accountDirectory: accountDir,
      mailbox: "[Gmail]/All Mail",
      rowid: 189_233,
    });
    expect(found?.path).toContain(join("[Gmail].mbox", "All Mail.mbox"));
  });

  it("finds a mailbox two containers deep", () => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "Notes", rowid: 7001 });
    expect(found?.path).toContain(join("Work.mbox", "Projects.mbox", "Notes.mbox"));
  });

  it("matches case-insensitively, like the name ladder does", () => {
    expect(
      locateEmlx({ accountDirectory: accountDir, mailbox: "all mail", rowid: 189_233 }),
    ).not.toBeNull();
  });

  it("picks the container that actually holds the rowid when the leaf name is ambiguous", () => {
    // "Receipts" exists under both Personal and Business; only the rowid decides.
    const personal = locateEmlx({ accountDirectory: accountDir, mailbox: "Receipts", rowid: 3001 });
    const business = locateEmlx({ accountDirectory: accountDir, mailbox: "Receipts", rowid: 3002 });
    expect(personal?.path).toContain(join("Personal.mbox", "Receipts.mbox"));
    expect(business?.path).toContain(join("Business.mbox", "Receipts.mbox"));
  });

  it("never descends into Data/, so message shards are not scanned", () => {
    expect(locateEmlx({ accountDirectory: accountDir, mailbox: "Trap", rowid: 8123 })).toBeNull();
    expect(resolveMailboxDirs(accountDir, "Trap")).toEqual([]);
  });

  it("keeps the flat layout as the first candidate", () => {
    expect(resolveMailboxDirs(accountDir, "INBOX")).toEqual([join(accountDir, "INBOX.mbox")]);
  });
});

/** The lane degrades quietly; these are the facts that let a caller say why. */
describe("explaining a miss", () => {
  it("reports no-mailbox-dir and the path it probed", () => {
    const miss = lookupEmlx({ accountDirectory: accountDir, mailbox: "Nope", rowid: 1 });
    expect(miss.found).toBe(false);
    if (miss.found) return;
    expect(miss.reason).toBe("no-mailbox-dir");
    expect(miss.mailboxDirs).toEqual([]);
    expect(miss.probed).toEqual([join(accountDir, "Nope.mbox")]);
  });

  it("distinguishes a resolved mailbox with no such message", () => {
    const miss = lookupEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 123 });
    expect(miss.found).toBe(false);
    if (miss.found) return;
    expect(miss.reason).toBe("no-message-file");
    expect(miss.mailboxDirs).toContain(join(accountDir, "INBOX.mbox"));
    expect(miss.probed.length).toBeGreaterThan(0);
  });
});

describe("reading", () => {
  const read = (rowid: number, mailbox = "INBOX", maxBodyBytes = 65_536) => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox, rowid });
    return readEmlx(found!.path, { maxBodyBytes, partial: found!.partial });
  };

  it("decodes headers, body and attachments together", () => {
    const parsed = read(198_577);
    expect(parsed.headers.subject).toBe("Facture 5753");
    expect(parsed.headers.from).toBe("Domaine <billing@domaine.fr>");
    expect(parsed.headers.messageId).toBe("<abc123@domaine.fr>");
    expect(parsed.body).toBe("Votre facture est prete.");
    expect(parsed.bodyFrom).toBe("text/plain");
    expect(parsed.attachments).toEqual([
      expect.objectContaining({ filename: "facture.pdf", contentType: "application/pdf" }),
    ]);
  });

  it("truncates a long body loudly rather than silently", () => {
    const parsed = read(198_577, "INBOX", 10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.body).toContain("[truncated:");
  });

  it("does not mark a short body as truncated", () => {
    expect(read(198_577).truncated).toBe(false);
  });

  it("reports a stripped attachment as absent even when a delimiter byte survives", () => {
    // The real-mail shape: locateEmlx finds the .partial file, the body is
    // intact, and the attachment must not claim to be retrievable.
    const dir2 = join(accountDir, "INBOX.mbox", "MBOX-UUID", "Data", "7", "9", "1", "Messages");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(dir2, "197577.partial.emlx"),
      emlx(
        [
          'Content-Type: multipart/mixed; boundary="M"',
          "",
          "--M",
          "Content-Type: text/plain",
          "",
          "Voir piece jointe.",
          "--M",
          'Content-Type: application/pdf; name="Facture_5753.pdf"',
          'Content-Disposition: attachment; filename="Facture_5753.pdf"',
          "",
          " ",
          "--M--",
        ].join("\r\n"),
      ),
    );
    const parsed = read(197_577);
    expect(parsed.partial).toBe(true);
    expect(parsed.body).toBe("Voir piece jointe.");
    expect(parsed.attachments[0]).toMatchObject({
      filename: "Facture_5753.pdf",
      inline: false,
      // No sidecar file exists here, so nothing can be fetched and the size
      // stays unknown rather than being guessed at.
      retrievable: false,
      sizeBytes: null,
    });
  });

  /**
   * The normal case on a real mail store: the bytes are not in the message
   * file, but they ARE on disk in the sidecar tree, so the size is exact and
   * save_attachment will succeed. Nothing in the message itself says this —
   * only statting the sidecar does.
   */
  it("reports the exact size from the sidecar tree when Mail stored it there", () => {
    const mboxRoot = join(accountDir, "INBOX.mbox", "MBOX-UUID");
    const msgs = join(mboxRoot, "Data", "6", "9", "1", "Messages");
    mkdirSync(msgs, { recursive: true });
    writeFileSync(
      join(msgs, "196577.partial.emlx"),
      emlx(
        [
          'Content-Type: multipart/mixed; boundary="M"',
          "",
          "--M",
          'Content-Type: application/pdf; name="Real.pdf"',
          'Content-Disposition: attachment; filename="Real.pdf"',
          // Deliberately wrong on purpose: this is the base64 length, and the
          // implementation must ignore it in favour of the file on disk.
          "X-Apple-Content-Length: 224634",
          "",
          " ",
          "--M--",
        ].join("\r\n"),
      ),
    );

    const sidecar = join(mboxRoot, "Data", "6", "9", "1", "Attachments", "196577", "2");
    mkdirSync(sidecar, { recursive: true });
    writeFileSync(join(sidecar, "Real.pdf"), Buffer.alloc(164_156, 7));

    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 196_577 });
    const parsed = readEmlx(found!.path, { maxBodyBytes: 4096, partial: true, rowid: 196_577 });

    expect(parsed.attachments[0]).toMatchObject({
      filename: "Real.pdf",
      inline: false,
      retrievable: true,
      sizeBytes: 164_156,
    });
  });

  it("keeps the body of a partial message and reports the stripped attachment", () => {
    const parsed = read(199_577);
    expect(parsed.partial).toBe(true);
    expect(parsed.body).toBe("Body kept.");
    expect(parsed.attachments[0]).toMatchObject({ filename: "big.zip", inline: false });
  });

  it("refuses an absurdly large file instead of loading it", () => {
    const huge = join(dir, "huge.emlx");
    writeFileSync(huge, Buffer.alloc(26 * 1024 * 1024));
    expect(() => readEmlx(huge, { maxBodyBytes: 1024 })).toThrow(PreconditionError);
  });
});

describe("raw source", () => {
  it("returns the RFC 5322 bytes without the plist trailer", () => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 198_577 });
    const raw = readEmlxSource(found!.path, { offset: 0, maxBytes: 1_000_000 });
    expect(raw.source).toContain("Message-ID: <abc123@domaine.fr>");
    expect(raw.source).not.toContain("plist");
    expect(raw.truncated).toBe(false);
  });

  it("pages with offset and reports that more remains", () => {
    const found = locateEmlx({ accountDirectory: accountDir, mailbox: "INBOX", rowid: 198_577 });
    const head = readEmlxSource(found!.path, { offset: 0, maxBytes: 20 });
    expect(head.truncated).toBe(true);
    expect(head.source).toBe("From: Domaine <billi");

    const next = readEmlxSource(found!.path, { offset: 20, maxBytes: 20 });
    expect(next.source).toBe("ng@domaine.fr>\r\nTo: ");
    expect(next.totalBytes).toBe(head.totalBytes);
  });
});
