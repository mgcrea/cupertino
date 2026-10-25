import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The watch tools, over a real Envelope Index fixture.
 *
 * Nothing here reaches a real Mail: the runner is canned and the index is a
 * temp file built from the captured DDL.
 */
const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");
const UUID = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";

const ACCOUNTS = [
  {
    id: UUID,
    name: "iCloud",
    enabled: true,
    accountType: "iCloud",
    emailAddresses: ["me@icloud.com"],
    fullName: "Me",
    directory: null,
    messageCaching: null,
    mailboxes: ["INBOX", "Archive", "Sent Messages"],
  },
];

const runner = (): OsascriptRunner => ({
  run: vi.fn(async (script: string) =>
    script.includes("a.emailAddresses()") ? ACCOUNTS : [],
  ) as OsascriptRunner["run"],
});

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-watch-tools-"));
  dbPath = join(dir, "Envelope Index");
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${UUID}/INBOX', 0, 0),
      (2, 'imap://${UUID}/Archive', 0, 0);
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Hello');
    INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'sam@example.com', 'Sam');
    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
       mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES (101, 0, 7001, 1, NULL, 1, 1790000000, 1790000005, 1, 0, 0, 0, 0, 100, 900);
  `);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const build = (env: NodeJS.ProcessEnv, extra: { isMailRunning?: () => Promise<boolean> } = {}) => {
  const config = loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: dbPath, ...env });
  return createServer({ config, osascript: runner(), era: "modern", ...extra });
};

const connect = async (
  env: NodeJS.ProcessEnv,
  extra: { isMailRunning?: () => Promise<boolean> } = {},
) => {
  const created = build(env, extra);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(a), client.connect(b)]);
  return { ...created, client };
};

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Result): string => (r.content as { text: string }[])[0]?.text ?? "";
const json = (r: Result) => JSON.parse(textOf(r));
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

const ON = { APPLE_MAIL_ALLOW_WATCHES: "1" };
const running = async () => true;

describe("the allowWatches gate", () => {
  it("lists neither tool, and declares no subscribe, with the gate off", async () => {
    const { client } = await connect({});
    const tools = await names(client);
    expect(tools).not.toContain("apple_mail_watch");
    expect(tools).not.toContain("apple_mail_unwatch");
    expect(client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
  });

  it("lists both tools with the gate on, even with prompts off", async () => {
    const { client } = await connect({ ...ON, APPLE_MAIL_EXPOSE_PROMPTS: "0" });
    const tools = await names(client);
    expect(tools).toContain("apple_mail_watch");
    expect(tools).toContain("apple_mail_unwatch");
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
  });

  it("marks both readOnly, with writes off", async () => {
    const { client } = await connect(ON);
    const { tools } = await client.listTools();
    for (const n of ["apple_mail_watch", "apple_mail_unwatch"]) {
      expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("opens nothing on a server that never sees a watch call", async () => {
    const created = build(ON);
    const index = vi.spyOn(created.client, "index");
    const locate = vi.spyOn(created.client, "locate");
    const accounts = vi.spyOn(created.client, "accounts");
    const c = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(a), c.connect(b)]);
    await c.listTools();
    expect(index).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(accounts).not.toHaveBeenCalled();
  });
});

describe("apple_mail_watch", () => {
  it("refuses an empty filter, naming from and domains", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const res = await client.callTool({ name: "apple_mail_watch", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/from/);
    expect(textOf(res)).toMatch(/domains/);
  });

  it("returns a handle, its uri and the starting cursor", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { from: ["Sam@Example.com"] },
    });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.watch).toMatch(/^w_/);
    expect(out.uri).toBe(`cupertino://mail/watch/${out.watch}`);
    expect(out.cursor).toBe(101);
    expect(out.filter).toEqual({ from: ["sam@example.com"], domains: [], mailboxes: "default" });
    expect(out.note).toBeUndefined();
  });

  it("shares one setup between two concurrent watches", async () => {
    const created = build(ON, { isMailRunning: running });
    const index = vi.spyOn(created.client, "index");
    const c = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(a), c.connect(b)]);
    const [one, two] = await Promise.all([
      c.callTool({ name: "apple_mail_watch", arguments: { domains: ["a.com"] } }),
      c.callTool({ name: "apple_mail_watch", arguments: { domains: ["b.com"] } }),
    ]);
    expect(one.isError).toBeFalsy();
    expect(two.isError).toBeFalsy();
    expect(json(one).watch).not.toBe(json(two).watch);
    // One init: the index is asked for by init's own call and by the lookup, never once per watch.
    expect(index.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("refuses when the index only opens immutable, naming the WAL", async () => {
    const { client } = await connect(
      { ...ON, APPLE_MAIL_INDEX_MODE: "immutable" },
      { isMailRunning: running },
    );
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("WAL");
  });

  it("refuses with the index's own reason when it cannot be opened", async () => {
    const missing = join(dir, "missing", "Envelope Index");
    const { client } = await connect(
      { ...ON, APPLE_MAIL_ENVELOPE_INDEX: missing },
      { isMailRunning: running },
    );
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).length).toBeGreaterThan(0);
  });

  it("says Mail must be running when it is not", async () => {
    const { client } = await connect(ON, { isMailRunning: async () => false });
    const out = json(
      await client.callTool({ name: "apple_mail_watch", arguments: { domains: ["example.com"] } }),
    );
    expect(out.note).toMatch(/Mail has to be running/);
  });

  it("scopes to mailboxes through the resolver search uses", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const out = json(
      await client.callTool({
        name: "apple_mail_watch",
        arguments: { domains: ["example.com"], mailboxes: ["Archive"] },
      }),
    );
    expect(out.filter.mailboxes).toEqual(["Archive"]);
  });

  it("names an unknown mailbox in the error", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"], mailboxes: ["Nowhere"] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Nowhere");
  });

  it("refuses a second watch whose mailbox scope differs, naming the scope", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["a.com"], mailboxes: ["Archive"] },
    });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["b.com"] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Archive");
  });
});

describe("apple_mail_unwatch", () => {
  it("removes a watch once, then reports false", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const { watch } = json(
      await client.callTool({ name: "apple_mail_watch", arguments: { domains: ["a.com"] } }),
    );
    const first = json(await client.callTool({ name: "apple_mail_unwatch", arguments: { watch } }));
    const again = json(await client.callTool({ name: "apple_mail_unwatch", arguments: { watch } }));
    expect(first).toEqual({ removed: true });
    expect(again).toEqual({ removed: false });
  });
});
