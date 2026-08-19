import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const ACCOUNTS = [
  { id: "acct-1", name: "iCloud", defaultFolder: "Notes", folderCount: 2, noteCount: 3 },
];

const FOLDERS = [
  {
    id: "f-1",
    name: "Notes",
    accountId: "acct-1",
    accountName: "iCloud",
    depth: 1,
    shared: false,
    noteCount: 2,
  },
  {
    id: "f-2",
    name: "Archive",
    accountId: "acct-1",
    accountName: "iCloud",
    depth: 2,
    shared: false,
    noteCount: 1,
  },
];

const NOTE_ID = "x-coredata://STORE/ICNote/p1";

/** A runner that answers from canned data, dispatching on a marker in the script. */
const fakeRunner = (overrides: Record<string, unknown> = {}): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (script.includes("a.defaultFolder.name()")) return overrides.accounts ?? ACCOUNTS;
    if (script.includes("folders[j].accountName")) return overrides.folders ?? FOLDERS;
    if (script.includes("N.notes.plaintext()") && script.includes("ids:")) {
      return overrides.bulkText ?? { ids: [NOTE_ID], texts: ["shopping list: milk and eggs"] };
    }
    if (script.includes("folderOf[row.id]")) {
      return (
        overrides.bulkNotes ?? {
          count: 1,
          notes: [
            {
              id: NOTE_ID,
              name: "Shopping list",
              modified: "2026-08-19T10:00:00.000Z",
              created: "2026-08-01T10:00:00.000Z",
              locked: false,
              folder: "Notes",
              account: "iCloud",
            },
          ],
        }
      );
    }
    if (script.includes("out.push({ id: id, found: false })")) {
      return (
        overrides.bodies ?? [
          {
            id: NOTE_ID,
            found: true,
            locked: false,
            name: "Shopping list",
            plaintext: "shopping list: milk and eggs",
            body: "<h1>Shopping list</h1>",
            modified: "2026-08-19T10:00:00.000Z",
            created: "2026-08-01T10:00:00.000Z",
          },
        ]
      );
    }
    return overrides.default ?? [];
  }) as OsascriptRunner["run"],
});

/** No store on disk, so every test runs the degraded Apple Events lane. */
const config = (over: Partial<Config> = {}): Config => ({
  ...loadConfig({ APPLE_NOTES_STORE: "/tmp/mcp-apple-notes-does-not-exist/NoteStore.sqlite" }),
  ...over,
});

const connect = async (cfg: Config, osascript: OsascriptRunner = fakeRunner()): Promise<Client> => {
  const { server } = createServer({ config: cfg, osascript });
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
  "apple_notes_diagnostics",
  "apple_notes_get_note",
  "apple_notes_list_accounts",
  "apple_notes_list_attachments",
  "apple_notes_list_folders",
  "apple_notes_list_notes",
  "apple_notes_save_attachment",
  "apple_notes_search_notes",
];

const WRITE_TOOLS = [
  "apple_notes_create_note",
  "apple_notes_delete_notes",
  "apple_notes_move_note",
  "apple_notes_update_note",
];

describe("tool registration", () => {
  it("registers only the read tools by default", async () => {
    expect(await toolNames(await connect(config()))).toEqual(READ_TOOLS);
  });

  /**
   * With writes off the mutating tools are not merely refused, they are
   * invisible — a model cannot call a name it never sees.
   */
  it("adds the mutating tools only when writes are enabled", async () => {
    const names = await toolNames(await connect(config({ allowWrites: true })));
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS].toSorted());
  });

  /**
   * The registered set must not depend on Full Disk Access. It is a runtime
   * condition that can change while the process lives, and clients cache the
   * tool list — a tool that came and went would leave them calling names the
   * server no longer has.
   */
  it("registers the same tools whether or not the index is available", async () => {
    const withIndex = await toolNames(await connect(config({ indexMode: "off" })));
    const withoutIndex = await toolNames(await connect(config()));
    expect(withIndex).toEqual(withoutIndex);
  });
});

describe("reads through the Apple Events lane", () => {
  it("lists accounts", async () => {
    const client = await connect(config());
    const out = await client.callTool({ name: "apple_notes_list_accounts", arguments: {} });
    expect(JSON.parse(textOf(out))).toEqual(ACCOUNTS);
  });

  it("honours the account allowlist", async () => {
    const client = await connect(config({ accounts: ["Work"] }));
    const out = await client.callTool({ name: "apple_notes_list_accounts", arguments: {} });
    expect(JSON.parse(textOf(out))).toEqual([]);
  });

  it("returns nested folders with their depth", async () => {
    const client = await connect(config());
    const out = await client.callTool({ name: "apple_notes_list_folders", arguments: {} });
    expect(JSON.parse(textOf(out)).map((f: { depth: number }) => f.depth)).toEqual([1, 2]);
  });

  it("lists notes with a ref that round-trips", async () => {
    const client = await connect(config());
    const out = await client.callTool({ name: "apple_notes_list_notes", arguments: {} });
    const [first] = JSON.parse(textOf(out));
    expect(first.ref).toBe(`n1:${NOTE_ID}`);
    expect(first.source).toBe("apple-events");
  });

  it("searches full text by scanning bodies, not with a whose clause", async () => {
    const client = await connect(config());
    const out = await client.callTool({
      name: "apple_notes_search_notes",
      arguments: { query: "milk" },
    });
    const result = JSON.parse(textOf(out));
    expect(result.source).toBe("apple-events");
    expect(result.scope).toBe("full-text");
    expect(result.notes).toHaveLength(1);
  });

  it("returns the body as text rather than escaped JSON", async () => {
    const client = await connect(config());
    const out = await client.callTool({
      name: "apple_notes_get_note",
      arguments: { ref: `n1:${NOTE_ID}` },
    });
    expect(textOf(out)).toBe("shopping list: milk and eggs");
  });
});

describe("diagnostics", () => {
  it("says Full Disk Access is unavailable and how to grant it", async () => {
    const client = await connect(config());
    const out = await client.callTool({ name: "apple_notes_diagnostics", arguments: {} });
    const report = JSON.parse(textOf(out));
    expect(report.permissions.fullDiskAccess).toMatch(/unknown|denied/);
    expect(report.permissions.howToGrant.join(" ")).toContain("Full Disk Access");
    expect(report.permissions.howToGrant.join(" ")).toContain(
      "Granting it to Notes.app does nothing",
    );
  });

  it("reports the index lane as disabled rather than broken when switched off", async () => {
    const client = await connect(config({ indexMode: "off" }));
    const out = await client.callTool({ name: "apple_notes_diagnostics", arguments: {} });
    expect(JSON.parse(textOf(out)).server.lanes.index).toBe("disabled");
  });
});

describe("refs", () => {
  it("rejects a hand-built ref with a message pointing at the search tools", async () => {
    const client = await connect(config());
    const out = await client.callTool({
      name: "apple_notes_get_note",
      arguments: { ref: "p1" },
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("search and list tools");
  });
});
