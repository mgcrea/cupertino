import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { OsascriptRunner } from "../src/client/osascript.js";
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
    directory: "/tmp/does-not-exist/V10/" + UUID,
    messageCaching: "all messages and their attachments",
    mailboxes: ["INBOX", "Archive", "Sent Messages"],
  },
];

/** A runner that answers from canned data, dispatching on a marker in the script. */
const fakeRunner = (overrides: Record<string, unknown> = {}): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (script.includes("a.emailAddresses()")) return overrides.accounts ?? ACCOUNTS;
    if (script.includes("p.withCounts")) return overrides.mailboxes ?? [];
    if (script.includes("mb.unreadCount()") && script.includes("total:")) {
      return overrides.count ?? { accountUuid: UUID, mailbox: "INBOX", total: 100, unread: 0 };
    }
    if (script.includes("slice.subject()")) {
      return overrides.recent ?? { mailbox: "INBOX", total: 100, messages: [] };
    }
    return overrides.default ?? [];
  }) as OsascriptRunner["run"],
});

const connect = async (
  config: Config,
  osascript: OsascriptRunner = fakeRunner(),
): Promise<Client> => {
  const { server } = createServer({ config, osascript });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).toSorted();

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

const READ_TOOLS = [
  "apple_mail_count_messages",
  "apple_mail_diagnostics",
  "apple_mail_get_message",
  "apple_mail_get_message_source",
  "apple_mail_get_thread",
  "apple_mail_list_accounts",
  "apple_mail_list_attachments",
  "apple_mail_list_mailboxes",
  "apple_mail_list_messages",
  "apple_mail_search_messages",
];

describe("tool registration", () => {
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    readOnly = await toolNames(await connect(loadConfig({})));
    withWrites = await toolNames(await connect(loadConfig({ APPLE_MAIL_ALLOW_WRITES: "1" })));
  });

  it("registers the read tools in both modes", () => {
    expect(readOnly).toEqual(READ_TOOLS);
    for (const name of READ_TOOLS) expect(withWrites).toContain(name);
  });

  it("marks every read tool readOnly", async () => {
    const client = await connect(loadConfig({}));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
    }
  });

  it("gives every tool a description that says when to reach for it", async () => {
    const client = await connect(loadConfig({}));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(
        tool.description?.length ?? 0,
        `${tool.name} needs a real description`,
      ).toBeGreaterThan(80);
    }
  });

  /**
   * The registered set must be a pure function of allowWrites — FDA is a runtime
   * condition that can change mid-process, and MCP clients cache the tool list,
   * so a tool that comes and goes leaves clients calling names we no longer have.
   */
  it("registers the same tools whether or not the index is reachable", async () => {
    const reachable = await toolNames(
      await connect(loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: "/tmp/nope" })),
    );
    const disabled = await toolNames(await connect(loadConfig({ APPLE_MAIL_INDEX_MODE: "off" })));
    expect(reachable).toEqual(readOnly);
    expect(disabled).toEqual(readOnly);
  });
});

describe("read tools", () => {
  it("lists accounts without leaking the on-disk directory", async () => {
    const client = await connect(loadConfig({}));
    const result = await client.callTool({ name: "apple_mail_list_accounts", arguments: {} });
    const payload = JSON.parse(textOf(result));
    expect(payload[0]).toMatchObject({
      id: UUID,
      name: "iCloud",
      mailboxes: ["INBOX", "Archive", "Sent Messages"],
    });
    expect(textOf(result)).not.toContain("/tmp/does-not-exist");
  });

  it("enforces the account allowlist", async () => {
    const client = await connect(loadConfig({ APPLE_MAIL_ACCOUNTS: "SomeOtherAccount" }));
    const result = await client.callTool({ name: "apple_mail_list_accounts", arguments: {} });
    expect(JSON.parse(textOf(result))).toEqual([]);
  });

  it("admits an allowlisted account by name, case-insensitively", async () => {
    const client = await connect(loadConfig({ APPLE_MAIL_ACCOUNTS: "icloud" }));
    const result = await client.callTool({ name: "apple_mail_list_accounts", arguments: {} });
    expect(JSON.parse(textOf(result))).toHaveLength(1);
  });

  it("reports unread counts with their source, because Mail's cached value lies", async () => {
    const client = await connect(loadConfig({}));
    const result = await client.callTool({
      name: "apple_mail_count_messages",
      arguments: { mailbox: "INBOX" },
    });
    const payload = JSON.parse(textOf(result));
    expect(payload.unread).toEqual({ applescript: 0, index: null });
    expect(payload.note).toMatch(/cached/);
  });

  it("caps the degraded listing at degradedMaxMessages", async () => {
    const runner = fakeRunner();
    const client = await connect(loadConfig({ APPLE_MAIL_DEGRADED_MAX_MESSAGES: "5" }), runner);
    await client.callTool({ name: "apple_mail_list_messages", arguments: { limit: 200 } });

    const call = vi
      .mocked(runner.run)
      .mock.calls.find(([script]) => String(script).includes("slice.subject()"));
    expect(call).toBeDefined();
    expect((call![1] as { limit: number }).limit).toBe(5);
  });

  it("reports a failed mailbox lookup as a tool error, not an empty result", async () => {
    const client = await connect(loadConfig({}));
    const result = await client.callTool({
      name: "apple_mail_count_messages",
      arguments: { mailbox: "NoSuchMailbox" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NoSuchMailbox");
  });
});

describe("diagnostics", () => {
  it("says Full Disk Access is denied and how to grant it", async () => {
    const client = await connect(
      loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: "/tmp/definitely-not-here" }),
    );
    const payload = JSON.parse(
      textOf(await client.callTool({ name: "apple_mail_diagnostics", arguments: {} })),
    );
    expect(payload.lanes.index).toBe("unavailable");
    expect(payload.mailData.foundVia).toBe("config");
    expect(payload.settings.allowWrites).toBe(false);
  });

  it("reports the index as disabled, not broken, when it is switched off", async () => {
    const client = await connect(loadConfig({ APPLE_MAIL_INDEX_MODE: "off" }));
    const payload = JSON.parse(
      textOf(await client.callTool({ name: "apple_mail_diagnostics", arguments: {} })),
    );
    expect(payload.lanes.index).toBe("disabled");
    expect(payload.lanes.indexReason).toContain("off");
  });

  /**
   * The message-file lane degrades to AppleScript on every reader, so a lane
   * that has been broken for months looks like a lane that is merely slow.
   * Diagnostics has to probe it rather than infer it from the FDA bit.
   */
  it("probes the message-file lane per account instead of inferring it", async () => {
    const client = await connect(loadConfig({ APPLE_MAIL_INDEX_MODE: "off" }));
    const payload = JSON.parse(
      textOf(await client.callTool({ name: "apple_mail_diagnostics", arguments: {} })),
    );
    expect(payload.messageFile).toHaveLength(1);
    expect(payload.messageFile[0]).toMatchObject({
      accountUuid: UUID,
      account: "iCloud",
      status: "not-probed",
    });
    // It must say WHY it could not probe, rather than reporting a healthy lane.
    expect(payload.messageFile[0].reason).toBeTruthy();
  });
});
