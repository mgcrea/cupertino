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
      if (script.includes("M.Mailbox({")) {
        const name = (params as { name: string }).name;
        const accountUuid = (params as { accountUuid: string | null }).accountUuid;
        if (name === "Existing") {
          return {
            created: false,
            name,
            account: accountUuid ? "iCloud" : null,
            accountUuid,
            note: "A mailbox with that name already exists; nothing was created.",
          };
        }
        // The server renames it, which is why the tool reports what Mail re-read.
        return {
          created: true,
          name: name === "Renamed" ? "INBOX.Renamed" : name,
          account: accountUuid ? "iCloud" : null,
          accountUuid,
        };
      }
      if (script.includes("acct.draftsMailbox()")) {
        return { replaced: true, newId: 99, subject: "Quarterly numbers", originalDeleted: true };
      }
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
  "apple_mail_create_mailbox",
  "apple_mail_delete_messages",
  "apple_mail_forward_message",
  "apple_mail_move_messages",
  "apple_mail_reply_to_message",
  "apple_mail_save_attachment",
  "apple_mail_send_message",
  "apple_mail_set_message_flags",
  "apple_mail_update_draft",
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
    ["apple_mail_create_mailbox", { name: "Receipts" }],
    ["apple_mail_update_draft", { ref: refFor("Drafts", 1), body: "new text" }],
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

/**
 * `create_mailbox` exists so that `move_messages` has somewhere to move to.
 * Everything asserted here is about the two failure modes that make it
 * dangerous rather than merely useful: a duplicate nobody can delete from this
 * server, and a stale cache that breaks the very move it was created for.
 */
describe("apple_mail_create_mailbox", () => {
  const create = async (args: Record<string, unknown>) => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const res = await client.callTool({
      name: "apple_mail_create_mailbox",
      arguments: { confirm: true, ...args },
    });
    const text = textOf(res);
    return { isError: Boolean(res.isError), text, recorded, json: JSON.parse(text) as never };
  };

  it("creates a local mailbox when no account is named", async () => {
    const out = await create({ name: "Receipts" });
    const doc = out.json as { created: boolean; name: string; account: string | null };
    expect(doc).toMatchObject({ created: true, name: "Receipts", account: null });
    const call = out.recorded.find((r) => r.script.includes("M.Mailbox({"));
    expect(call?.params).toMatchObject({ name: "Receipts", accountUuid: null });
  });

  it("creates it on the named account", async () => {
    const out = await create({ name: "Receipts", account: "iCloud" });
    expect((out.json as { accountUuid: string }).accountUuid).toBe(UUID);
  });

  /** Safe to call before a move without checking first. */
  it("reports an existing mailbox as untouched rather than failing", async () => {
    const out = await create({ name: "Existing", account: "iCloud" });
    const doc = out.json as { created: boolean; note: string };
    expect(out.isError).toBe(false);
    expect(doc.created).toBe(false);
    expect(doc.note).toMatch(/already exists/);
  });

  /**
   * An IMAP server decides the final name. Echoing the request back would tell
   * a caller to move messages into a mailbox that is not what Mail now holds.
   */
  it("reports the name Mail re-read, not the one requested", async () => {
    const out = await create({ name: "Renamed", account: "iCloud" });
    expect((out.json as { name: string }).name).toBe("INBOX.Renamed");
  });

  it.each([["/Receipts"], ["Receipts/"], ["Projects//Cupertino"], ["   "]])(
    "refuses %j before touching Mail",
    async (name) => {
      const out = await create({ name });
      expect(out.isError).toBe(true);
      expect(out.recorded.some((r) => r.script.includes("M.Mailbox({"))).toBe(false);
    },
  );

  /**
   * The bug this guards against is invisible without it: MailboxMap caches each
   * account WITH its mailbox names, so a move to a just-created mailbox would
   * resolve against a list captured before it existed and fail naming a mailbox
   * this server had made a moment earlier.
   */
  it("drops the cached mailbox list so a move can find the new mailbox", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    await client.callTool({ name: "apple_mail_list_accounts", arguments: {} });
    const before = recorded.filter((r) => r.script.includes("a.emailAddresses()")).length;

    await client.callTool({
      name: "apple_mail_create_mailbox",
      arguments: { name: "Receipts", account: "iCloud", confirm: true },
    });
    await client.callTool({ name: "apple_mail_list_accounts", arguments: {} });

    const after = recorded.filter((r) => r.script.includes("a.emailAddresses()")).length;
    expect(after).toBeGreaterThan(before);
  });
});

describe("apple_mail_update_draft", () => {
  /**
   * Blanking a draft and reporting success is indistinguishable from having
   * written it, so the empty case is refused in the client rather than sent to
   * a script that would happily carry it out.
   */
  it("refuses an empty body before touching Mail", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    const res = await client.callTool({
      name: "apple_mail_update_draft",
      arguments: { ref: refFor("Drafts", 1), body: "   ", confirm: true },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/cannot be empty/);
    expect(recorded.some((r) => r.script.includes("acct.draftsMailbox()"))).toBe(false);
  });

  it("passes the ref through as account, mailbox and id", async () => {
    const { runner, recorded } = harness();
    const client = await connect(WRITES, runner);
    await client.callTool({
      name: "apple_mail_update_draft",
      arguments: { ref: refFor("Drafts", 7), body: "the new text", confirm: true },
    });
    const call = recorded.find((r) => r.script.includes("acct.draftsMailbox()"));
    expect(call?.params).toMatchObject({
      accountUuid: UUID,
      mailbox: "Drafts",
      id: 7,
      body: "the new text",
      subject: null,
    });
  });

  /** Deleting the user's draft is not something to do on an inferred intent. */
  it("is marked destructive", async () => {
    const { runner } = harness();
    const { tools } = await (await connect(WRITES, runner)).listTools();
    expect(tools.find((t) => t.name === "apple_mail_update_draft")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});
