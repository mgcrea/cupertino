import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * How a tool result is shaped, which is not the same question as what it says.
 *
 * `wrap()` JSON-encodes whatever its body returns, so a body that itself returns
 * `ok(x)` produced a result whose text was a serialised ToolResult —
 * `{"content":[{"type":"text","text":"{…}"}]}` — with the real payload one
 * decode further in. The same mistake swallowed `fail()`: the envelope carried
 * `isError` as data, so an MCP client saw a successful call. `wrapResult()` is
 * the helper for a body that shapes its own result.
 *
 * Nothing caught either half, because every assertion in the suite read a field
 * off `JSON.parse(text)` and got `undefined` — which reads as "the field is
 * absent" rather than "the whole payload is wrapped twice". These assertions are
 * about the envelope on purpose.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "contacts-store.sql");
const ENT = { contact: 22, group: 19, info: 24, container: 25 } as const;

let storePath: string;

beforeAll(() => {
  storePath = join(mkdtempSync(join(tmpdir(), "mcp-apple-contacts-wrap-")), "AddressBook.abcddb");
  writeFileSync(storePath, "");
  const d = new DatabaseSync(storePath);
  d.exec(readFileSync(FIXTURE, "utf8"));
  d.exec(`
    INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES
      (${ENT.group}, 'ABCDGroup', 18, 0),
      (${ENT.info}, 'ABCDInfo', 17, 0),
      (${ENT.contact}, 'ABCDContact', 17, 0),
      (23, 'ABCDSubscribedContact', 22, 0),
      (${ENT.container}, 'CNCDContainer', 17, 0)`);
  d.prepare(
    `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZLASTNAME, ZUNIQUEID)
     VALUES (1, ${ENT.contact}, 'Ada', 'Lovelace', 'uid-1')`,
  ).run();
  d.close();
});

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  const config = loadConfig({ APPLE_CONTACTS_STORE: storePath, ...env });
  const { server } = createServer({ config, home: "/nonexistent-home" });
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

describe("get_contact", () => {
  it("returns the contact itself, not a serialised tool result", async () => {
    const found = (await call("apple_contacts_search_contacts", { query: "Lovelace" })).json as {
      ref: string;
    }[];
    expect(found).toHaveLength(1);

    const out = await call("apple_contacts_get_contact", { ref: found[0]!.ref });
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/"content"/);
    const doc = out.json as { name: string; ref: string };
    expect(doc.name).toBe("Ada Lovelace");
    expect(doc.ref).toBe(found[0]!.ref);
  });

  it("marks a ref that no longer resolves as an error rather than returning one as data", async () => {
    const out = await call("apple_contacts_get_contact", { ref: "k1:acct/99999" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Re-run the search/);
  });
});

describe("create_contact", () => {
  /**
   * Refused at the tool, before any Apple Event: a card with no name at all is
   * a blank row that has to be hunted down in the UI. The refusal has to reach
   * the client AS a refusal.
   */
  it("reports a nameless card as an error rather than returning one as data", async () => {
    const out = await call(
      "apple_contacts_create_contact",
      { nickname: "nobody" },
      { APPLE_CONTACTS_ALLOW_WRITES: "1" },
    );
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/"content"/);
    expect(out.text).toMatch(/firstName, lastName or organization/);
  });
});
