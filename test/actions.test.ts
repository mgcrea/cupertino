import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { OsascriptRunner } from "../src/client/osascript.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

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
    mailboxes: ["INBOX", "Archive"],
  },
];

const refFor = (mailbox: string, id: number) => encodeRef({ accountUuid: UUID, mailbox, id });

type Recorded = { script: string; params: Record<string, unknown> };

const harness = () => {
  const recorded: Recorded[] = [];
  const runner: OsascriptRunner = {
    run: vi.fn(async (script: string, params?: unknown) => {
      recorded.push({ script, params: (params ?? {}) as Record<string, unknown> });
      if (script.includes("a.emailAddresses()")) return ACCOUNTS;
      if (script.includes("m.readStatus = p.read")) {
        const ids = (params as { ids: number[] }).ids;
        // Report the post-state Mail would have re-read.
        return {
          mailbox: "INBOX",
          results: ids.map((id) => ({ id, ok: true, read: true, flagged: false })),
        };
      }
      if (script.includes("M.move(m,")) {
        const ids = (params as { ids: number[] }).ids;
        return {
          destination: "Archive",
          destinationAccountUuid: UUID,
          results: ids.map((id) => ({ id, ok: true, newId: id + 1000, messageId: "<x@y>" })),
        };
      }
      if (script.includes("M.delete(m)")) {
        const ids = (params as { ids: number[] }).ids;
        return {
          movedToTrash: true,
          results: ids.map((id) => ({ id, ok: true, subjectLength: 5 })),
        };
      }
      if (script.includes("M.OutgoingMessage(")) return { sent: false, draft: true };
      if (script.includes("M.forward(original")) return { sent: false, draft: true, mode: "reply" };
      if (script.includes("M.checkForNewMail(")) return { checked: "all accounts" };
      return {};
    }) as OsascriptRunner["run"],
  };
  return { runner, recorded };
};

const connect = async (config: Config, runner: OsascriptRunner): Promise<Client> => {
  const { server } = createServer({ config, osascript: runner });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
};

const WRITES = loadConfig({ APPLE_MAIL_ALLOW_WRITES: "1" });
const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string =>
  (r.content as { text: string }[])[0]?.text ?? "";

const WRITE_TOOLS = [
  "apple_mail_check_for_new_mail",
  "apple_mail_delete_messages",
  "apple_mail_forward_message",
  "apple_mail_move_messages",
  "apple_mail_reply_to_message",
  "apple_mail_send_message",
  "apple_mail_set_message_flags",
];

describe("write tool visibility", () => {
  it("hides every write tool when writes are disabled", async () => {
    const { runner } = harness();
    const names = (await (await connect(loadConfig({}), runner)).listTools()).tools.map(
      (t) => t.name,
    );
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
  });

  it("registers them all when writes are enabled", async () => {
    const { runner } = harness();
    const names = (await (await connect(WRITES, runner)).listTools()).tools.map((t) => t.name);
    for (const tool of WRITE_TOOLS) expect(names).toContain(tool);
  });

  it("marks the irreversible ones destructive", async () => {
    const { runner } = harness();
    const { tools } = await (await connect(WRITES, runner)).listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["apple_mail_delete_messages", "apple_mail_send_message"]) {
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true);
    }
    expect(byName.get("apple_mail_set_message_flags")?.annotations?.destructiveHint).toBe(false);
  });
});

describe("confirm gates", () => {
  it.each([
    ["apple_mail_move_messages", { refs: [refFor("INBOX", 1)], destinationMailbox: "Archive" }],
    ["apple_mail_delete_messages", { refs: [refFor("INBOX", 1)] }],
  ])("%s refuses without confirm, before touching Mail", async (name, args) => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    // Rejected by the schema — no script ever ran.
    expect(recorded).toHaveLength(0);
  });
});

describe("send gate", () => {
  it("leaves a draft by default", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    await client.callTool({
      name: "apple_mail_send_message",
      arguments: { to: ["a@b.com"], subject: "hi", body: "there" },
    });
    const call = recorded.find((r) => r.script.includes("M.OutgoingMessage("));
    expect(call?.params.sendNow).toBe(false);
  });

  it("refuses sendNow without confirm, before composing anything", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_send_message",
      arguments: { to: ["a@b.com"], subject: "hi", body: "there", sendNow: true },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm/);
    expect(recorded.some((r) => r.script.includes("M.OutgoingMessage("))).toBe(false);
  });

  it("sends when both gates are satisfied", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    await client.callTool({
      name: "apple_mail_send_message",
      arguments: { to: ["a@b.com"], subject: "hi", body: "there", sendNow: true, confirm: true },
    });
    expect(recorded.find((r) => r.script.includes("M.OutgoingMessage("))?.params.sendNow).toBe(
      true,
    );
  });

  it("refuses a message with no recipients", async () => {
    const { runner } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_send_message",
      arguments: { subject: "hi", body: "there" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/recipients/);
  });

  it("rejects a malformed address at the schema, not at Mail", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_send_message",
      arguments: { to: ["not-an-address"], subject: "hi", body: "there" },
    });
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});

describe("batching and refs", () => {
  it("groups refs by mailbox into one round-trip each", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    await client.callTool({
      name: "apple_mail_set_message_flags",
      arguments: {
        refs: [refFor("INBOX", 1), refFor("INBOX", 2), refFor("Archive", 3)],
        read: true,
      },
    });
    const flagCalls = recorded.filter((r) => r.script.includes("m.readStatus = p.read"));
    expect(flagCalls).toHaveLength(2);
    const inboxCall = flagCalls.find((c) => c.params.mailbox === "INBOX");
    expect(inboxCall).toBeDefined();
    expect((inboxCall!.params.ids as number[]).toSorted()).toEqual([1, 2]);
  });

  it("does nothing when no flag fields are supplied", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_set_message_flags",
      arguments: { refs: [refFor("INBOX", 1)] },
    });
    expect(JSON.parse(textOf(result)).changed).toBe(0);
    expect(recorded.some((r) => r.script.includes("m.readStatus = p.read"))).toBe(false);
  });

  it("returns the post-state Mail re-read, not what was requested", async () => {
    const { runner } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_set_message_flags",
      arguments: { refs: [refFor("INBOX", 1)], read: true, flagged: true },
    });
    const payload = JSON.parse(textOf(result));
    expect(payload.changed).toBe(1);
    // The fake reports flagged:false despite flagged:true being requested.
    expect(payload.results[0].flagged).toBe(false);
  });

  it("issues fresh refs after a move and marks the old ones dead", async () => {
    const { runner } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_move_messages",
      arguments: { refs: [refFor("INBOX", 7)], destinationMailbox: "Archive", confirm: true },
    });
    const payload = JSON.parse(textOf(result));
    expect(payload.moved).toBe(1);
    expect(payload.results[0].previousRef).toContain("INBOX#7");
    expect(payload.results[0].ref).toContain("Archive#1007");
  });

  it("reports whether a delete went to Trash", async () => {
    const { runner } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_delete_messages",
      arguments: { refs: [refFor("INBOX", 1)], confirm: true },
    });
    expect(JSON.parse(textOf(result)).movedToTrash).toBe(true);
  });

  it("rejects a hand-built ref before any Apple Event", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const result = await client.callTool({
      name: "apple_mail_set_message_flags",
      arguments: { refs: ["198577"], read: true },
    });
    expect(result.isError).toBe(true);
    expect(recorded.some((r) => r.script.includes("m.readStatus"))).toBe(false);
  });
});
