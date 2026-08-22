import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ProtocolError, type OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";

import { toAppleSeconds } from "../src/client/dates.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The send lane, exercised end to end without sending anything.
 *
 * Two seams do the work. `osascript` is faked, so the Apple Event never leaves
 * the process — the alternative is a suite that messages a real person on every
 * `pnpm test`. And the store is a temp file built from the captured schema, so
 * target selection and reconciliation run against real SQL rather than a mock.
 *
 * The fake runner also does what Messages does: it INSERTS the outgoing row. So
 * the reconciliation test asserts the actual thing — that a row written by
 * another process, after the handle was opened, is found and returned as a ref.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-db.sql");
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;

const appleNanos = (ms: number): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(ms)))) * 1_000_000_000n;

let storePath: string;

const build = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "messages-send-")), "chat.db");
  const db = new DatabaseSync(path);
  db.exec(readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, ""));
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+33612345678', 'iMessage'),
      (2, 'friend@example.com', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style, service_name) VALUES
      (1, 'iMessage;-;+33612345678', '+33612345678', NULL, 45, 'iMessage'),
      (2, 'iMessage;+;chat9001', 'chat9001', 'Book club', 43, 'iMessage'),
      (3, 'iMessage;-;friend@example.com', 'friend@example.com', NULL, 45, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 1), (3, 2);
  `);
  db.close();
  return path;
};

/** Everything the fake runner saw, and what it should do about it. */
type Sent = { script: string; params: Record<string, unknown> };

const runner = (
  seen: Sent[],
  behaviour: "ok" | "not-found" | "refused" = "ok",
  writeRow = false,
): OsascriptRunner => ({
  run: async <T>(script: string, params?: unknown): Promise<T> => {
    const p = (params ?? {}) as Record<string, unknown>;
    seen.push({ script, params: p });
    if (behaviour === "not-found") {
      throw new ProtocolError("Messages would not resolve a chat or participant.", {
        code: "SEND_TARGET_NOT_FOUND",
        detail: ["chat-guid: no chat", "accounts(iMessage): Application isn't running."],
      });
    }
    if (behaviour === "refused") {
      throw new ProtocolError("iMessage is not signed in.", { code: "SEND_FAILED", detail: [] });
    }
    if (writeRow) {
      // What Messages does after `send`: writes the outgoing row, from another
      // process, after this server's read handle was already open.
      const db = new DatabaseSync(storePath);
      const chatId = p.chatGuid === "iMessage;+;chat9001" ? 2 : 1;
      const at = appleNanos(Date.now());
      db.prepare(
        `INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me,
                              associated_message_type)
         VALUES (99, 'SENT-GUID-1', ?, 0, 'iMessage', ?, 1, 0)`,
      ).run(String(p.text), at);
      db.prepare(
        `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, 99, ?)`,
      ).run(chatId, at);
      db.close();
    }
    return { strategy: "chat-guid", targetKind: "chat", launched: false, attempts: [] } as T;
  },
});

const connect = async (osascript: OsascriptRunner, env: NodeJS.ProcessEnv = {}) => {
  const config: Config = loadConfig({
    APPLE_MESSAGES_ALLOW_WRITES: "1",
    APPLE_MESSAGES_STORE: storePath,
    APPLE_MESSAGES_SEND_RECONCILE_MS: "0",
    ...env,
  });
  const { server } = createServer({ config, home: "/nonexistent-home", contacts: null, osascript });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const send = async (client: Client, args: Record<string, unknown>) => {
  const res = (await client.callTool({
    name: "apple_messages_send_message",
    arguments: { confirm: true, ...args },
  })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) as never };
};

beforeEach(() => {
  storePath = build();
});

describe("choosing the target", () => {
  /**
   * The arrangement this whole lane rests on: the file lane knows the chat guid,
   * the write lane can address a chat by id, and neither has to do the thing it
   * cannot. Messages will not enumerate participants for a script at all.
   */
  it("hands the script a chat guid read out of the store", async () => {
    const seen: Sent[] = [];
    await send(await connect(runner(seen)), { to: "+33612345678", text: "hi" });
    expect(seen[0]?.params.chatGuid).toBe("iMessage;-;+33612345678");
  });

  /**
   * `packages/contacts`' measured last-9 rule, applied to the store's own
   * handles. A caller who types the number the way their phone shows it and a
   * store that holds E.164 are the same person.
   */
  it("matches a local spelling of the same number", async () => {
    const seen: Sent[] = [];
    await send(await connect(runner(seen)), { to: "06 12 34 56 78", text: "hi" });
    expect(seen[0]?.params.chatGuid).toBe("iMessage;-;+33612345678");
  });

  it("matches an email handle case-insensitively", async () => {
    const seen: Sent[] = [];
    await send(await connect(runner(seen)), { to: "Friend@Example.com", text: "hi" });
    expect(seen[0]?.params.chatGuid).toBe("iMessage;-;friend@example.com");
  });

  /**
   * The failure that would be worst here: "message Alice" landing in a group
   * Alice happens to be in, visible to five other people.
   */
  it("never picks a group chat for a bare handle", async () => {
    const seen: Sent[] = [];
    await send(await connect(runner(seen)), { to: "+33612345678", text: "hi" });
    expect(seen[0]?.params.chatGuid).not.toBe("iMessage;+;chat9001");
  });

  it("sends to a group when a chat ref names one", async () => {
    const seen: Sent[] = [];
    await send(await connect(runner(seen)), { chatRef: "mc1:iMessage;+;chat9001", text: "hi" });
    expect(seen[0]?.params.chatGuid).toBe("iMessage;+;chat9001");
  });

  it("still sends when the handle has no chat, leaving the ladder to guess", async () => {
    const seen: Sent[] = [];
    const res = await send(await connect(runner(seen)), { to: "+15550009999", text: "hi" });
    expect(res.isError).toBe(false);
    expect(seen[0]?.params.chatGuid).toBeUndefined();
    expect(seen[0]?.params.handle).toBe("+15550009999");
  });

  it("refuses a chat ref that no longer resolves", async () => {
    const res = await send(await connect(runner([])), { chatRef: "mc1:gone", text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No chat for ref/);
  });
});

describe("reconciliation", () => {
  /**
   * `docs/messages.md` called the id bridge "unanswerable by construction" —
   * Apple Events returns no identifier for what it sent. This is the answer: the
   * row is found in the store afterwards, so a send reports a real ref.
   */
  it("finds the row Messages wrote and returns it as a ref", async () => {
    const client = await connect(runner([], "ok", true));
    const res = await send(client, { to: "+33612345678", text: "hi there" });
    const body = res.json() as unknown as {
      reconciliation: string;
      message: { ref: string; text: string; fromMe: boolean };
    };
    expect(body.reconciliation).toBe("matched");
    expect(body.message.ref).toBe("m1:SENT-GUID-1");
    expect(body.message.text).toBe("hi there");
    expect(body.message.fromMe).toBe(true);
  });

  /**
   * A miss is `pending`, never an error. The send already happened — reporting a
   * failure would invite a retry, and a retry here sends the message twice.
   */
  it("reports pending rather than failing when no row appears", async () => {
    const res = await send(await connect(runner([])), { to: "+33612345678", text: "hi" });
    const body = res.json() as unknown as { sent: boolean; reconciliation: string; note: string };
    expect(res.isError).toBe(false);
    expect(body.sent).toBe(true);
    expect(body.reconciliation).toBe("pending");
    expect(body.note).toMatch(/do NOT|rather than sending again/i);
  });

  it("says unavailable when there was no chat to look in", async () => {
    const res = await send(await connect(runner([])), { to: "+15550009999", text: "hi" });
    expect((res.json() as unknown as { reconciliation: string }).reconciliation).toBe(
      "unavailable",
    );
  });
});

describe("refusals", () => {
  it("requires confirm at the schema", async () => {
    const client = await connect(runner([]));
    const res = (await client.callTool({
      name: "apple_messages_send_message",
      arguments: { to: "+33612345678", text: "hi" },
    })) as { isError?: boolean };
    expect(Boolean(res.isError)).toBe(true);
  });

  /** Guessing between the two would send a real message to the wrong person. */
  it("refuses both chatRef and to", async () => {
    const res = await send(await connect(runner([])), {
      chatRef: "mc1:iMessage;-;+33612345678",
      to: "+33612345678",
      text: "hi",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/exactly one/);
  });

  it("refuses neither", async () => {
    const res = await send(await connect(runner([])), { text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/exactly one/);
  });

  it("rejects empty text at the schema", async () => {
    const res = await send(await connect(runner([])), { to: "+33612345678", text: "" });
    expect(res.isError).toBe(true);
  });

  /**
   * The ladder's failures are the only diagnostic this surface has, so they are
   * carried out of the script and onto the error rather than swallowed.
   */
  it("explains a target failure and keeps the attempts", async () => {
    const res = await send(await connect(runner([], "not-found")), {
      to: "+33612345678",
      text: "hi",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Open the conversation once in Messages.app/);
    expect(res.text).toMatch(/Application isn't running/);
  });

  it("reports a refused send as a refusal, not a success", async () => {
    const res = await send(await connect(runner([], "refused")), {
      to: "+33612345678",
      text: "hi",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Messages refused the send/);
  });
});
