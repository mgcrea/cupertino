import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig } from "../src/config.js";

/**
 * Saving an attachment is the only path in this server that writes a file whose
 * NAME comes from message content — i.e. from whoever sent the mail. These
 * tests are mostly about that.
 */

const UUID = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const ROWID = 198_577;

const PLIST = '<?xml version="1.0"?><plist version="1.0"><dict/></plist>';

const emlx = (mime: string): Buffer => {
  const body = Buffer.from(mime, "utf8");
  return Buffer.concat([
    Buffer.from(`${body.length}\n`, "ascii"),
    body,
    Buffer.from(PLIST, "utf8"),
  ]);
};

const message = (filename: string) =>
  [
    "From: x@y.com",
    "Subject: Here you go",
    'Content-Type: multipart/mixed; boundary="M"',
    "",
    "--M",
    "Content-Type: text/plain",
    "",
    "See attached.",
    "--M",
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("PDF-BYTES", "utf8").toString("base64"),
    "--M--",
  ].join("\r\n");

let dir: string;
let accountDir: string;
let downloads: string;

const runner = (): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (script.includes("a.emailAddresses()")) {
      return [
        {
          id: UUID,
          name: "iCloud",
          enabled: true,
          accountType: "iCloud",
          emailAddresses: ["me@icloud.com"],
          fullName: "Me",
          directory: accountDir,
          messageCaching: "all messages and their attachments",
          mailboxes: ["INBOX"],
        },
      ];
    }
    return [];
  }) as OsascriptRunner["run"],
});

const clientWith = (filename: string) => {
  const messagesDir = join(
    accountDir,
    "INBOX.mbox",
    "MBOX-UUID",
    "Data",
    "8",
    "9",
    "1",
    "Messages",
  );
  mkdirSync(messagesDir, { recursive: true });
  writeFileSync(join(messagesDir, `${ROWID}.emlx`), emlx(message(filename)));

  return new AppleMailClient({
    config: loadConfig({ APPLE_MAIL_ATTACHMENT_DIR: downloads, APPLE_MAIL_ALLOW_WRITES: "1" }),
    osascript: runner(),
  });
};

const ref = encodeRef({ accountUuid: UUID, mailbox: "INBOX", id: ROWID });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-att-"));
  accountDir = join(dir, "V10", UUID);
  downloads = join(dir, "Downloads");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("saving attachments", () => {
  it("writes the decoded bytes into the configured directory", async () => {
    const client = clientWith("invoice.pdf");
    const saved = await client.saveAttachment(ref, "invoice.pdf");

    expect(saved.path).toBe(join(downloads, "invoice.pdf"));
    expect(saved.from).toBe("inline");
    expect(readFileSync(saved.path, "utf8")).toBe("PDF-BYTES");
  });

  it("refuses to overwrite by default, and obeys an explicit overwrite", async () => {
    const client = clientWith("dup.pdf");
    await client.saveAttachment(ref, "dup.pdf");

    await expect(client.saveAttachment(ref, "dup.pdf")).rejects.toThrow(/already exists/);
    await expect(client.saveAttachment(ref, "dup.pdf", { overwrite: true })).resolves.toMatchObject(
      {
        bytes: 9,
      },
    );
  });

  /**
   * The filename comes from the sender. `../` in it must not escape the
   * download directory — it should be stripped, not honoured.
   */
  it.each([
    ["../escaped.pdf", "escaped.pdf"],
    ["../../../../etc/passwd", "passwd"],
    ["/absolute/path.pdf", "path.pdf"],
  ])("confines a traversing filename %s to the download dir", async (evil, expected) => {
    const client = clientWith(evil);
    const saved = await client.saveAttachment(ref, evil);

    expect(saved.path).toBe(join(downloads, expected));
    expect(existsSync(join(dir, "escaped.pdf"))).toBe(false);
  });

  it("explains rather than crashing when the attachment is not in the message", async () => {
    const client = clientWith("real.pdf");
    await expect(client.saveAttachment(ref, "imaginary.pdf")).rejects.toThrow(
      /No attachment named "imaginary.pdf"/,
    );
  });

  it("says the bytes are not local when Mail stripped them", async () => {
    const messagesDir = join(
      accountDir,
      "INBOX.mbox",
      "MBOX-UUID",
      "Data",
      "8",
      "9",
      "1",
      "Messages",
    );
    mkdirSync(messagesDir, { recursive: true });
    writeFileSync(
      join(messagesDir, `${ROWID}.emlx`),
      emlx(
        [
          'Content-Type: multipart/mixed; boundary="M"',
          "",
          "--M",
          'Content-Type: application/zip; name="stripped.zip"',
          'Content-Disposition: attachment; filename="stripped.zip"',
          "",
          "--M--",
        ].join("\r\n"),
      ),
    );
    const client = new AppleMailClient({
      config: loadConfig({ APPLE_MAIL_ATTACHMENT_DIR: downloads }),
      osascript: runner(),
    });
    await expect(client.saveAttachment(ref, "stripped.zip")).rejects.toThrow(/not stored locally/);
  });
});
