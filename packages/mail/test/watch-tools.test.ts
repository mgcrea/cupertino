import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MAIL_SURFACE, MailNotRunningError } from "../src/client/errors.js";
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

/**
 * Answers `LIST_ACCOUNTS` like the real prelude does while Mail is closed:
 * with `MailNotRunningError`, whether or not the answer is canned.
 */
const runner = (open: () => boolean = () => true): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (!script.includes("a.emailAddresses()")) return [];
    if (!open()) throw new MailNotRunningError(MAIL_SURFACE);
    return ACCOUNTS;
  }) as OsascriptRunner["run"],
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

type Extra = { isMailRunning?: () => Promise<boolean>; osascript?: OsascriptRunner };

const build = (env: NodeJS.ProcessEnv, extra: Extra = {}) => {
  const config = loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: dbPath, ...env });
  return createServer({
    config,
    osascript: extra.osascript ?? runner(),
    era: "modern",
    ...(extra.isMailRunning ? { isMailRunning: extra.isMailRunning } : {}),
  });
};

/** Every connection a test opens, closed after it so no watcher outlives the temp dir. */
const opened: Client[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
});

const connect = async (env: NodeJS.ProcessEnv, extra: Extra = {}) => {
  const created = build(env, extra);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(a), client.connect(b)]);
  opened.push(client);
  return { client, mail: created.client, server: created.server, watches: created.watches };
};

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Result): string => (r.content as { text: string }[])[0]?.text ?? "";
const json = (r: Result) => JSON.parse(textOf(r));
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

const ON = { APPLE_MAIL_ALLOW_WATCHES: "1" };
const running = async () => true;
const closed = async () => false;

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
    const { client, mail } = await connect(ON);
    const index = vi.spyOn(mail, "index");
    const locate = vi.spyOn(mail, "locate");
    const accounts = vi.spyOn(mail, "accounts");
    await client.listTools();
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
    const { client, mail } = await connect(ON, { isMailRunning: running });
    const index = vi.spyOn(mail, "index");
    const [one, two] = await Promise.all([
      client.callTool({ name: "apple_mail_watch", arguments: { domains: ["a.com"] } }),
      client.callTool({ name: "apple_mail_watch", arguments: { domains: ["b.com"] } }),
    ]);
    expect(one.isError).toBeFalsy();
    expect(two.isError).toBeFalsy();
    expect(json(one).watch).not.toBe(json(two).watch);
    // One setup asks for the index twice: its own open, and the mailbox lookup. A setup
    // per watch would make it four.
    expect(index).toHaveBeenCalledTimes(2);
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
    const { client, mail } = await connect(
      { ...ON, APPLE_MAIL_ENVELOPE_INDEX: missing },
      { isMailRunning: running },
    );
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"] },
    });
    expect(res.isError).toBe(true);
    expect(mail.indexError).toBeTruthy();
    expect(textOf(res)).toContain(mail.indexError!);
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

  it.each(["Junk", "Sent Messages", "[Gmail]/Trash", "Drafts"])(
    "refuses %s, which can never fire, and says why",
    async (name) => {
      const { client } = await connect(ON, { isMailRunning: running });
      const res = await client.callTool({
        name: "apple_mail_watch",
        arguments: { domains: ["example.com"], mailboxes: [name] },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(name);
      expect(textOf(res)).toMatch(/never|excluded/i);
    },
  );

  it("bounds the mailboxes it takes", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: {
        domains: ["example.com"],
        mailboxes: Array.from({ length: 21 }, (_, i) => `Box ${i}`),
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/20/);
  });

  it("allows watches with different mailboxes on one connection", async () => {
    const { client } = await connect(ON, { isMailRunning: running });
    const one = json(
      await client.callTool({
        name: "apple_mail_watch",
        arguments: { domains: ["a.com"], mailboxes: ["Archive"] },
      }),
    );
    const two = json(
      await client.callTool({ name: "apple_mail_watch", arguments: { domains: ["b.com"] } }),
    );
    expect(one.filter.mailboxes).toEqual(["Archive"]);
    expect(two.filter.mailboxes).toBe("default");
  });

  it("stops its watches when the server closes", async () => {
    const { client, server, watches } = await connect(ON, { isMailRunning: running });
    await client.callTool({ name: "apple_mail_watch", arguments: { domains: ["a.com"] } });
    expect(watches?.count).toBe(1);
    await server.close();
    expect(watches?.count).toBe(0);
  });
});

describe("apple_mail_watch while Mail is closed", () => {
  it("sets a watch with no mailboxes, and returns the note", async () => {
    const { client } = await connect(ON, {
      isMailRunning: closed,
      osascript: runner(() => false),
    });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"] },
    });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.watch).toMatch(/^w_/);
    expect(out.cursor).toBe(101);
    expect(out.note).toMatch(/Mail has to be running/);
  });

  it("refuses mailboxes, saying names cannot be resolved until Mail is running", async () => {
    const { client } = await connect(ON, {
      isMailRunning: closed,
      osascript: runner(() => false),
    });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"], mailboxes: ["Archive"] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/mailbox names/i);
    expect(textOf(res)).toMatch(/until Mail is running/);
  });

  it("still fails for a real reason when Mail is running", async () => {
    // Mail is running by `pgrep`, yet the account listing fails: that is not "closed".
    const failing: OsascriptRunner = {
      run: vi.fn(async () => {
        throw new Error("boom");
      }) as OsascriptRunner["run"],
    };
    const { client } = await connect(ON, { isMailRunning: running, osascript: failing });
    const res = await client.callTool({
      name: "apple_mail_watch",
      arguments: { domains: ["example.com"] },
    });
    expect(res.isError).toBe(true);
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
