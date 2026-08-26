import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";

import { toAppleSeconds } from "../src/client/dates.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * `apple_messages_save_attachment`, against a fake home.
 *
 * The store is built inside a temp directory that is then handed over as the
 * server's `home`, so discovery resolves to it and never to the developer's own
 * `~/Library/Messages` — the same seam `tools.test.ts` uses, turned up one
 * notch because this suite needs a store that actually opens.
 *
 * Most of what follows is about paths. This is the only tool in the repo that
 * reads a filesystem path OUT of a database and copies the file it names, so it
 * has a boundary on both sides, and both are asserted here.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;
const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

const PHOTO = Buffer.from("not really a heic, but the bytes are what get copied", "utf8");

let home: string;
let downloads: string;

type Attachment = {
  rowid: number;
  guid: string;
  /** As stored: `~`-prefixed, or null for an offloaded attachment. */
  filename: string | null;
  /** Resolve `filename` against the home this build creates, absolutely. */
  absolute?: boolean;
  transferName?: string | null;
  mimeType?: string;
};

const build = (attachments: readonly Attachment[]): void => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-apple-messages-att-"));
  home = join(dir, "home");
  downloads = join(dir, "Downloads");
  mkdirSync(join(home, "Library", "Messages"), { recursive: true });

  const db = new DatabaseSync(join(home, "Library", "Messages", "chat.db"));
  db.exec(readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, ""));
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551234567', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, style, service_name)
      VALUES (1, 'iMessage;-;+15551234567', '+15551234567', 45, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);
  `);
  db.prepare(
    `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me,
       cache_has_attachments) VALUES (1, 'MSG-1', 'look at this', 1, 'iMessage', ?, 0, 1)`,
  ).run(appleNanos("2026-08-01T12:00:00Z"));
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (1, 1, ?)`,
  ).run(appleNanos("2026-08-01T12:00:00Z"));

  const insert = db.prepare(
    `INSERT INTO attachment (ROWID, guid, original_guid, filename, mime_type, transfer_name,
       total_bytes, is_sticker) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (const a of attachments) {
    insert.run(
      a.rowid,
      a.guid,
      a.guid,
      // Resolved here, not by the caller: `home` only exists once build() runs.
      a.absolute && a.filename ? join(home, a.filename) : a.filename,
      a.mimeType ?? "image/heic",
      a.transferName === undefined ? "holiday.heic" : a.transferName,
      PHOTO.length,
    );
    db.prepare(`INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, ?)`).run(
      a.rowid,
    );
  }
  db.close();
};

/** Put real bytes at a path relative to the fake home. */
const place = (relative: string): string => {
  const full = join(home, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, PHOTO);
  return full;
};

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config = loadConfig({
    APPLE_MESSAGES_ALLOW_WRITES: "1",
    APPLE_MESSAGES_ATTACHMENT_DIR: downloads,
    ...env,
  });
  const { server } = createServer({ config, home, contacts: null });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const call = async (name: string, args: Record<string, unknown> = {}, env = {}) => {
  const res = (await (await connect(env)).callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: JSON.parse(text) as never };
};

const save = (args: Record<string, unknown>, env = {}) =>
  call("apple_messages_save_attachment", args, env);

const ATTACHMENT_PATH = join(
  "Library",
  "Messages",
  "Attachments",
  "ab",
  "01",
  "GUID-1",
  "IMG.heic",
);

describe("apple_messages_save_attachment", () => {
  beforeEach(() => {
    build([{ rowid: 1, guid: "AT-1", filename: `~/${ATTACHMENT_PATH}` }]);
    place(ATTACHMENT_PATH);
  });

  it("copies the bytes into the configured directory", async () => {
    const out = await save({ attachmentId: "AT-1" });
    const doc = out.json as { path: string; bytes: number; mimeType: string };
    expect(out.isError).toBe(false);
    expect(doc.path).toBe(join(downloads, "holiday.heic"));
    expect(doc.bytes).toBe(PHOTO.length);
    expect(doc.mimeType).toBe("image/heic");
    expect(readFileSync(doc.path)).toEqual(PHOTO);
  });

  /**
   * The column really is `~`-prefixed on a live store, so expanding it is not
   * defensive coding — an implementation that skipped it would fail on every
   * real attachment and pass against a fixture that used absolute paths.
   */
  it("reads an absolute path as readily as a tilde-prefixed one", async () => {
    build([{ rowid: 1, guid: "AT-1", filename: ATTACHMENT_PATH, absolute: true }]);
    place(ATTACHMENT_PATH);
    expect((await save({ attachmentId: "AT-1" })).isError).toBe(false);
  });

  it("writes into a subdirectory when asked", async () => {
    const out = await save({ attachmentId: "AT-1", directory: "trip" });
    expect((out.json as { path: string }).path).toBe(join(downloads, "trip", "holiday.heic"));
  });

  it("refuses to overwrite unless told to", async () => {
    expect((await save({ attachmentId: "AT-1" })).isError).toBe(false);
    const second = await save({ attachmentId: "AT-1" });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/already exists/);
    expect((await save({ attachmentId: "AT-1", overwrite: true })).isError).toBe(false);
  });

  // ── the destination boundary ──────────────────────────────────────────────

  it("refuses a directory that escapes the configured one", async () => {
    const out = await save({ attachmentId: "AT-1", directory: "../../etc" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Refusing to write outside/);
  });

  it("refuses an absolute directory", async () => {
    const out = await save({ attachmentId: "AT-1", directory: "/tmp" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Refusing to write outside/);
  });

  /**
   * `transfer_name` is chosen by whoever sent the message, which is exactly the
   * position path traversal needs. It is basename'd before it is trusted.
   */
  it("strips a path out of the sender's filename", async () => {
    build([
      {
        rowid: 1,
        guid: "AT-1",
        filename: `~/${ATTACHMENT_PATH}`,
        transferName: "../../../../tmp/evil.sh",
      },
    ]);
    place(ATTACHMENT_PATH);
    const out = await save({ attachmentId: "AT-1" });
    expect((out.json as { path: string }).path).toBe(join(downloads, "evil.sh"));
    expect(existsSync("/tmp/evil.sh")).toBe(false);
  });

  // ── the source boundary ───────────────────────────────────────────────────

  /**
   * The check that has never fired on a real store. `filename` comes out of a
   * database this server does not write, and taken at face value it names any
   * file the process can read.
   */
  it("refuses to read a file outside the Messages directory", async () => {
    const secret = join(home, "Documents", "passwords.txt");
    mkdirSync(dirname(secret), { recursive: true });
    writeFileSync(secret, "hunter2");
    build([{ rowid: 1, guid: "AT-1", filename: secret }]);
    const out = await save({ attachmentId: "AT-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/outside/);
    expect(out.text).toMatch(/Messages/);
  });

  it("refuses a traversal hidden inside a Messages path", async () => {
    build([
      {
        rowid: 1,
        guid: "AT-1",
        filename: `~/Library/Messages/Attachments/../../../../etc/hosts`,
      },
    ]);
    const out = await save({ attachmentId: "AT-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/outside/);
  });

  // ── the states that are normal rather than broken ─────────────────────────

  /** iCloud offloads bytes and keeps the row. That is not an error condition. */
  it("explains an offloaded attachment instead of failing obscurely", async () => {
    build([{ rowid: 1, guid: "AT-1", filename: null }]);
    const out = await save({ attachmentId: "AT-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/offloaded/);
    expect(out.text).toMatch(/Open the conversation in Messages/);
  });

  it("explains a row whose file has been pruned", async () => {
    build([{ rowid: 1, guid: "AT-1", filename: `~/${ATTACHMENT_PATH}` }]);
    const out = await save({ attachmentId: "AT-1" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no file there/);
  });

  it("says where an id comes from when it does not resolve", async () => {
    const out = await save({ attachmentId: "AT-NOPE" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/apple_messages_get_message/);
  });

  // ── the read side that feeds it ───────────────────────────────────────────

  /**
   * The id has to be reachable, or the tool is unusable. It is the attachment's
   * guid rather than its ROWID for the reason `ref.ts` records: Messages deletes
   * constantly and SQLite reuses freed rowids.
   */
  it("is reachable from get_message, by an id that is not a rowid", async () => {
    const out = await call("apple_messages_get_message", { ref: "m1:MSG-1" });
    const doc = out.json as {
      attachments: { id: string; path: string; mimeType: string; transferName: string }[];
    };
    expect(doc.attachments).toHaveLength(1);
    expect(doc.attachments[0]!.id).toBe("AT-1");
    expect(doc.attachments[0]!.id).not.toBe("1");
    expect(doc.attachments[0]!.transferName).toBe("holiday.heic");
  });

  /**
   * A regression, and the reason this file found it.
   *
   * `wrap()` JSON-encodes whatever its body returns, so a body that returns
   * `ok(x)` produced a tool result whose text was a serialised ToolResult —
   * `{"content":[{"type":"text","text":"{…}"}]}` — with the real payload one
   * decode further down. `wrapResult()` is the helper for a body that shapes its
   * own result. Nothing caught it because every existing assertion read a field
   * off `JSON.parse(text)` and got `undefined`, which reads as "absent" rather
   * than "wrapped twice".
   */
  it("returns the message itself, not a serialised tool result", async () => {
    const out = await call("apple_messages_get_message", { ref: "m1:MSG-1" });
    expect(out.text).not.toMatch(/"content"/);
    expect((out.json as { ref: string }).ref).toBe("m1:MSG-1");
  });

  /** The other half of the same bug: a failure that reported itself as a success. */
  it("marks an unresolvable ref as an error rather than returning one as data", async () => {
    const out = await call("apple_messages_get_message", { ref: "m1:GONE" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Re-run the search/);
  });

  it("is not registered at all when writes are off", async () => {
    const client = await connect({ APPLE_MESSAGES_ALLOW_WRITES: "0" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("apple_messages_save_attachment");
  });
});
