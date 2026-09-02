import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { EnvelopeIndex, openIndex } from "../src/client/envelope.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Mail itself is never reached by this lane; the runner just has to exist. */
const fakeRunner = (): OsascriptRunner => ({
  run: vi.fn(async (script: string) =>
    script.includes("a.emailAddresses()")
      ? [
          {
            id: ICLOUD,
            name: "iCloud",
            enabled: true,
            accountType: "iCloud",
            emailAddresses: ["me@icloud.com"],
            fullName: "Me",
            directory: `/tmp/does-not-exist/V10/${ICLOUD}`,
            mailboxes: ["INBOX", "Archive"],
          },
        ]
      : [],
  ) as OsascriptRunner["run"],
});

/**
 * The aggregate lane, against the same real SQLite fixture the search lane uses.
 *
 * The seed is deliberately identical to envelope.test.ts so a count asserted
 * here can be checked by eye against the rows asserted there.
 */

const DDL = readFileSync(join(import.meta.dirname, "fixtures", "envelope-index.sql"), "utf8");

const ICLOUD = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const GMAIL = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-mail-query-"));
  dbPath = join(dir, "Envelope Index");
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES
      (1, 'imap://${ICLOUD}/INBOX', 3, 1),
      (2, 'imap://${ICLOUD}/Archive', 1, 0),
      (3, 'imap://${GMAIL}/%5BGmail%5D/All%20Mail', 2, 1),
      (4, 'imap://${GMAIL}/INBOX', 0, 0);

    INSERT INTO subjects (ROWID, subject) VALUES
      (1, 'Invoice 5753 from Domaine'),
      (2, 'Lunch on Friday?'),
      (3, '100% off everything_now'),
      (4, 'Standup notes'),
      (5, 'Deploy failed');

    INSERT INTO addresses (ROWID, address, comment) VALUES
      (1, 'billing@domaine.fr', 'Domaine Melusine'),
      (2, 'sam@example.com', 'Sam Rivers'),
      (3, 'noreply@shop.com', 'Shop Deals'),
      (4, 'me@icloud.com', 'Me');

    INSERT INTO messages
      (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
       mailbox, flags, read, flagged, deleted, size, conversation_id)
    VALUES
      (101, 0, 1, 1, NULL,  1, ${t("2026-08-01T10:00:00Z")}, ${t("2026-08-01T10:00:05Z")}, 1, 0, 0, 0, 0, 5000, 900),
      (102, 0, 2, 2, NULL,  2, ${t("2026-08-05T09:00:00Z")}, ${t("2026-08-05T09:00:05Z")}, 1, 0, 1, 1, 0, 2000, 901),
      (103, 0, 3, 3, NULL,  3, ${t("2026-08-06T12:00:00Z")}, ${t("2026-08-06T12:00:05Z")}, 1, 0, 1, 0, 0, 1000, 902),
      (104, 0, 4, 2, 'Re: ', 2, ${t("2026-08-07T09:00:00Z")}, ${t("2026-08-07T09:00:05Z")}, 2, 0, 1, 0, 0, 2500, 901),
      (105, 0, 5, 4, NULL,  4, ${t("2026-08-08T08:00:00Z")}, ${t("2026-08-08T08:00:05Z")}, 3, 0, 1, 0, 0, 900, 903),
      (106, 0, 6, 4, NULL,  5, ${t("2026-08-09T08:00:00Z")}, ${t("2026-08-09T08:00:05Z")}, 3, 0, 0, 0, 0, 900, 904),
      (107, 0, 7, 1, NULL,  1, ${t("2026-07-01T10:00:00Z")}, ${t("2026-07-01T10:00:05Z")}, 1, 0, 1, 0, 1, 5000, 905);

    INSERT INTO labels (message_id, mailbox_id) VALUES (105, 4), (106, 4);
  `);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = () => new EnvelopeIndex(openIndex(dbPath, "ro"));

describe("groupBy", () => {
  it("counts per sender across every match", () => {
    const { groups, totalGroups, totalRows } = open().groupBy({ limit: 25 }, "sender");
    expect(totalRows).toBe(6); // 101-106; the deleted 107 is excluded
    expect(totalGroups).toBe(4);
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["me@icloud.com", 2],
      ["sam@example.com", 2],
      ["billing@domaine.fr", 1],
      ["noreply@shop.com", 1],
    ]);
  });

  /*
   * THE TRAP THIS LANE EXISTS FOR.
   *
   * `limit` caps the groups returned, never the messages counted. If the
   * aggregate ran over a page instead, totalRows would come back as 2 and the
   * top-two counts would be whatever those two rows happened to contain — a
   * wrong answer shaped exactly like a right one.
   */
  it("caps the number of groups without capping what was counted", () => {
    const { groups, totalGroups, totalRows } = open().groupBy({ limit: 2 }, "sender");
    expect(groups).toHaveLength(2);
    expect(totalRows).toBe(6);
    expect(totalGroups).toBe(4);
    // Still the real top two, with their real full-set counts.
    expect(groups.map((g) => g.count)).toEqual([2, 2]);
  });

  it("carries the sender's display name and unread count", () => {
    const { groups } = open().groupBy({ limit: 25 }, "sender");
    const me = groups.find((g) => g.key === "me@icloud.com");
    expect(me?.label).toBe("Me");
    expect(me?.unread).toBe(1); // 106 unread, 105 read
    expect(me?.firstAt).toBe(new Date(t("2026-08-08T08:00:05Z") * 1000).toISOString());
    expect(me?.lastAt).toBe(new Date(t("2026-08-09T08:00:05Z") * 1000).toISOString());
  });

  it("applies the same filters the search lane does", () => {
    const { groups, totalRows } = open().groupBy(
      { limit: 25, dateFrom: "2026-08-06T00:00:00Z" },
      "sender",
    );
    expect(totalRows).toBe(4); // 103, 104, 105, 106
    expect(groups.find((g) => g.key === "billing@domaine.fr")).toBeUndefined();
  });

  it("narrows to a mailbox through the same predicate, labels included", () => {
    // Mailbox 4 is Gmail's INBOX, which owns its messages by label only.
    const { totalRows } = open().groupBy({ limit: 25, mailboxRowids: [4] }, "sender");
    expect(totalRows).toBe(2);
  });

  it("groups by day and by month", () => {
    const byDay = open().groupBy({ limit: 25 }, "day");
    expect(byDay.totalGroups).toBe(6);
    expect(byDay.groups.every((g) => g.count === 1)).toBe(true);

    const byMonth = open().groupBy({ limit: 25 }, "month");
    expect(byMonth.groups).toEqual([
      expect.objectContaining({ key: "2026-08", count: 6, unread: 2 }),
    ]);
  });

  it("groups by subject, prefix included", () => {
    const { groups } = open().groupBy({ limit: 25 }, "subject");
    // 104 carries a "Re: " prefix, so it is its own subject, not a second
    // "Lunch on Friday?" — the same concatenation the search lane displays.
    expect(groups.map((g) => g.key)).toContain("Re: Lunch on Friday?");
    expect(groups.find((g) => g.key === "Lunch on Friday?")?.count).toBe(1);
  });

  it("reports an empty result without claiming groups", () => {
    const { groups, totalGroups, totalRows } = open().groupBy(
      { limit: 25, sender: "nobody@nowhere.invalid" },
      "sender",
    );
    expect(groups).toEqual([]);
    expect(totalGroups).toBe(0);
    expect(totalRows).toBe(0);
  });
});

const call = async (client: Client, args: Record<string, unknown>) => {
  const result = await client.callTool({ name: "apple_mail_query", arguments: args });
  return JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}");
};

/*
 * The same lane through a real MCP client, so the tool's own wiring — arg
 * parsing, the projection, the envelope — is exercised, not just the SQL.
 */
describe("apple_mail_query over MCP", () => {
  const connect = async (env: Record<string, string>) => {
    const { server } = createServer({
      config: loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: dbPath, ...env }),
      osascript: fakeRunner(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  it("returns a grouped answer with the full-set totals", async () => {
    const body = await call(await connect({}), { groupBy: "sender", limit: 2 });
    expect(body.groupedBy).toBe("sender");
    expect(body.groups).toHaveLength(2);
    expect(body.totalRows).toBe(6);
    expect(body.truncated).toBe(true);
  });

  it("projects rows down to the named fields", async () => {
    const body = await call(await connect({}), { select: ["ref", "subject"] });
    expect(body.messages.length).toBeGreaterThan(0);
    for (const row of body.messages) {
      expect(Object.keys(row).toSorted()).toEqual(["ref", "subject"]);
    }
    expect(body.unknownFields).toBeUndefined();
  });

  it("names the selectable fields when one is wrong", async () => {
    const body = await call(await connect({}), { select: ["ref", "priority"] });
    expect(body.unknownFields).toEqual(["priority"]);
    expect(body.hint).toContain("dateReceived");
  });

  it("refuses a group it cannot spell", async () => {
    const result = await (
      await connect({})
    ).callTool({ name: "apple_mail_query", arguments: { groupBy: "sendr" } });
    expect(result.isError).toBe(true);
  });

  it("degrades like the other index tools when there is no index", async () => {
    const body = await call(
      await connect({ APPLE_MAIL_ENVELOPE_INDEX: "/tmp/definitely-not-here" }),
      {
        groupBy: "sender",
      },
    );
    expect(body.degraded).toBe(true);
    expect(body.capability).toBe("search-index");
  });
});
