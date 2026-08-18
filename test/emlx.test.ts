import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locateEmlx, readEmlx, readEmlxSource, shardPath, splitEmlx } from "../src/client/emlx.js";
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
