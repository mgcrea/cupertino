import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { toAppleSeconds } from "../src/client/dates.js";
import { SchemaDriftError } from "../src/client/errors.js";
import { introspect, MessagesStore, reactionLabel } from "../src/client/store.js";

/**
 * Built from the DDL a real store handed `pnpm probe:messages --write`.
 *
 * Schema only, never a row — which is what lets this suite run on a machine with
 * no Full Disk Access and nobody's real conversations in it. Every message below
 * was written here.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chat-db.sql");

/**
 * Replay the captured schema WITHOUT its triggers.
 *
 * `chat.db` carries 27 triggers, and they call functions Messages registers on
 * its own connection at runtime — `verify_chat`, `guid_for_chat`,
 * `before_delete_attachment_path` and three more. Those functions do not exist
 * in a plain `node:sqlite` database, so any INSERT or DROP that fires one dies
 * with "no such function".
 *
 * The fixture keeps them because it is a faithful record of the schema. Dropping
 * them belongs here, at replay, where the constraint actually is: this suite
 * exercises SELECTs, and a trigger that can only run inside Messages.app has
 * nothing to say about them.
 */
const TRIGGER = /^CREATE TRIGGER[\s\S]*?END;$/gm;

const schema = (): string => readFileSync(FIXTURE, "utf8").replaceAll(TRIGGER, "");

/**
 * Nanoseconds since 2001, which is how Messages actually stores a date — and the
 * whole reason `dates.ts` exists. Written as a BigInt because these values are
 * past `Number.MAX_SAFE_INTEGER` and `node:sqlite` throws on reading them back
 * as numbers.
 */
const appleNanos = (iso: string): bigint =>
  BigInt(Math.round(toAppleSeconds(new Date(iso)))) * 1_000_000_000n;

const seed = (db: DatabaseSync): void => {
  db.exec(`
    INSERT INTO handle (ROWID, id, service) VALUES
      (1, '+15551234567', 'iMessage'),
      (2, 'friend@example.com', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name, style, service_name) VALUES
      (1, 'iMessage;-;+15551234567', '+15551234567', NULL, 45, 'iMessage'),
      (2, 'iMessage;+;chat9001', 'chat9001', 'Book club', 43, 'iMessage');
    INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 1), (2, 2);
  `);
};

type MessageSeed = {
  rowid: number;
  guid: string;
  chat: number;
  handle?: number;
  text?: string | null;
  blob?: Uint8Array | null;
  iso?: string;
  fromMe?: 0 | 1;
  reactionType?: number;
  reactionTarget?: string;
  threadOriginator?: string;
};

const addMessage = (db: DatabaseSync, m: MessageSeed): void => {
  db.prepare(
    `INSERT INTO message
       (ROWID, guid, text, attributedBody, handle_id, service, date, is_from_me,
        associated_message_type, associated_message_guid, thread_originator_guid)
     VALUES (?, ?, ?, ?, ?, 'iMessage', ?, ?, ?, ?, ?)`,
  ).run(
    m.rowid,
    m.guid,
    m.text ?? null,
    m.blob ?? null,
    m.handle ?? 1,
    appleNanos(m.iso ?? "2026-08-01T12:00:00Z"),
    m.fromMe ?? 0,
    m.reactionType ?? 0,
    m.reactionTarget ?? null,
    m.threadOriginator ?? null,
  );
  db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`,
  ).run(m.chat, m.rowid, appleNanos(m.iso ?? "2026-08-01T12:00:00Z"));
};

/**
 * A real `attributedBody`, archived by `NSArchiver` from the string
 * "Hello, world" — see `typedstream.test.ts`. Using the genuine bytes here is
 * what makes the blob-fallback tests mean anything.
 */
const HELLO_BLOB = Buffer.from(
  "040b73747265616d747970656481e803840140848484124e534174747269627574656453747269" +
    "6e67008484084e534f626a656374008592848484084e53537472696e67019484012b0c48656c6c" +
    "6f2c20776f726c648684026949010c928484840c4e5344696374696f6e6172790094840169008686",
  "hex",
);

const store = (seedMore?: (db: DatabaseSync) => void): MessagesStore => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema());
  seed(db);
  seedMore?.(db);
  return new MessagesStore(db, "ro", introspect(db));
};

describe("introspect", () => {
  it("finds the tables and columns the queries name", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema());
    const caps = introspect(db);
    expect(caps.hasReactions).toBe(true);
    expect(caps.hasThreads).toBe(true);
    expect(caps.hasEdits).toBe(true);
    expect(caps.hasAttachments).toBe(true);
    expect(caps.messageColumns.has("attributedBody")).toBe(true);
    expect(caps.messageColumns.has("date")).toBe(true);
  });

  it("raises SchemaDriftError when a required table is gone", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema());
    db.exec(`DROP TABLE message`);
    expect(() => introspect(db)).toThrow(SchemaDriftError);
  });
});

describe("dates", () => {
  /**
   * THE TRAP. `date` is nanoseconds since 2001 — eighteen digits, past
   * Number.MAX_SAFE_INTEGER — and `node:sqlite` THROWS rather than truncating.
   * Selecting the column raw is the bug; `appleSecondsSql` divides in SQL so the
   * integer never reaches JavaScript.
   */
  it("reads a date that does not fit in a JavaScript number", () => {
    const s = store((db) =>
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "hi", iso: "2026-08-22T10:30:00Z" }),
    );
    const [row] = s.range({ limit: 10 });
    expect(row?.sentAt).toBeCloseTo(toAppleSeconds(new Date("2026-08-22T10:30:00Z")), 0);
  });

  /** Selecting it raw is what a naive reader does, and it throws. */
  it("proves the raw column is unreadable, which is why the SQL divides", () => {
    const s = store((db) => addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "hi" }));
    expect(() => s.db.prepare(`SELECT date FROM message`).get()).toThrow();
  });
});

describe("body", () => {
  it("prefers the text column and says so", () => {
    const s = store((db) => addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "from column" }));
    const [row] = s.range({ limit: 10 });
    expect(row?.text).toBe("from column");
    expect(row?.textSource).toBe("column");
  });

  /**
   * The 3.1%. 3,051 of 97,416 messages have an empty `text` and content only in
   * `attributedBody`; a reader that selects the column returns nothing for one
   * message in thirty-two, silently and with no error to notice.
   */
  it("falls back to the blob when the column is empty", () => {
    const s = store((db) =>
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: null, blob: HELLO_BLOB }),
    );
    const [row] = s.range({ limit: 10 });
    expect(row?.text).toBe("Hello, world");
    expect(row?.textSource).toBe("decoded");
  });

  it("reports no content rather than an empty string", () => {
    const s = store((db) => addMessage(db, { rowid: 1, guid: "A", chat: 1, text: null }));
    const [row] = s.range({ limit: 10 });
    expect(row?.text).toBeNull();
    expect(row?.textSource).toBe("none");
  });
});

describe("reactions", () => {
  /**
   * 2,788 rows in the measured store are tapbacks. They live in the message
   * table like anything else, so a reader that does not filter them renders
   * `Liked "see you at 8"` as if somebody had typed it.
   */
  it("excludes tapbacks from a conversation by default", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "see you at 8" });
      addMessage(db, {
        rowid: 2,
        guid: "B",
        chat: 1,
        text: 'Liked "see you at 8"',
        reactionType: 2001,
        reactionTarget: "A",
      });
    });
    expect(s.range({ limit: 10 }).map((m) => m.guid)).toEqual(["A"]);
    expect(
      s
        .range({ limit: 10, includeReactions: true })
        .map((m) => m.guid)
        .toSorted(),
    ).toEqual(["A", "B"]);
  });

  it("reports them against the message they target", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "see you at 8" });
      addMessage(db, {
        rowid: 2,
        guid: "B",
        chat: 1,
        reactionType: 2001,
        reactionTarget: "A",
        handle: 2,
      });
    });
    const reactions = s.reactionsFor("A");
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.label).toBe("liked");
    expect(reactions[0]?.handle).toBe("friend@example.com");
  });

  /** Apple prefixes some targets with `p:0/`, so the match is on the tail. */
  it("finds a reaction whose target carries a part prefix", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "hi" });
      addMessage(db, {
        rowid: 2,
        guid: "B",
        chat: 1,
        reactionType: 2000,
        reactionTarget: "p:0/A",
      });
    });
    expect(s.reactionsFor("A").map((r) => r.label)).toEqual(["loved"]);
  });

  it("labels the ranges it knows and stays honest about the rest", () => {
    expect(reactionLabel(2001)).toBe("liked");
    expect(reactionLabel(3001)).toBe("removed liked");
    // An unrecognised value is still excluded from conversations — the safe
    // direction — and labelled rather than guessed at.
    expect(reactionLabel(2999)).toBe("reaction 2999");
  });
});

describe("range", () => {
  it("filters to one chat", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "one-to-one" });
      addMessage(db, { rowid: 2, guid: "B", chat: 2, text: "group" });
    });
    expect(s.range({ chatGuid: "iMessage;+;chat9001", limit: 10 }).map((m) => m.guid)).toEqual([
      "B",
    ]);
  });

  it("filters by date window, half-open at the end", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "OLD", chat: 1, text: "a", iso: "2026-07-01T00:00:00Z" });
      addMessage(db, { rowid: 2, guid: "NEW", chat: 1, text: "b", iso: "2026-08-15T00:00:00Z" });
    });
    const from = toAppleSeconds(new Date("2026-08-01T00:00:00Z"));
    expect(s.range({ fromApple: from, limit: 10 }).map((m) => m.guid)).toEqual(["NEW"]);
  });

  it("returns newest first", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "OLD", chat: 1, text: "a", iso: "2026-07-01T00:00:00Z" });
      addMessage(db, { rowid: 2, guid: "NEW", chat: 1, text: "b", iso: "2026-08-15T00:00:00Z" });
    });
    expect(s.range({ limit: 10 }).map((m) => m.guid)).toEqual(["NEW", "OLD"]);
  });
});

describe("search", () => {
  it("finds text in the column", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "lunch on tuesday" });
      addMessage(db, { rowid: 2, guid: "B", chat: 1, text: "dinner on friday" });
    });
    expect(s.search("lunch", 10).map((m) => m.guid)).toEqual(["A"]);
  });

  /**
   * The second pass, and the reason it exists: no amount of SQL reaches inside a
   * blob, so a column-only search silently omits one message in thirty-two.
   */
  it("finds text that exists only inside the blob", () => {
    const s = store((db) =>
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: null, blob: HELLO_BLOB }),
    );
    const hits = s.search("world", 10);
    expect(hits.map((m) => m.guid)).toEqual(["A"]);
    expect(hits[0]?.textSource).toBe("decoded");
  });

  /** `escapeLike`, so a literal wildcard searches for itself. */
  it("does not let a percent sign match everything", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "100% agreed" });
      addMessage(db, { rowid: 2, guid: "B", chat: 1, text: "nothing to see" });
    });
    expect(s.search("100%", 10).map((m) => m.guid)).toEqual(["A"]);
  });

  it("excludes tapbacks from search too", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "see you at 8" });
      addMessage(db, {
        rowid: 2,
        guid: "B",
        chat: 1,
        text: 'Liked "see you at 8"',
        reactionType: 2001,
        reactionTarget: "A",
      });
    });
    expect(s.search("see you", 10).map((m) => m.guid)).toEqual(["A"]);
  });
});

describe("chats", () => {
  it("lists participants and counts, most recent first", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "a", iso: "2026-07-01T00:00:00Z" });
      addMessage(db, { rowid: 2, guid: "B", chat: 2, text: "b", iso: "2026-08-15T00:00:00Z" });
      addMessage(db, { rowid: 3, guid: "C", chat: 2, text: "c", iso: "2026-08-16T00:00:00Z" });
    });
    const chats = s.chats(10);
    expect(chats[0]?.displayName).toBe("Book club");
    expect(chats[0]?.messages).toBe(2);
    expect(chats[0]?.isGroup).toBe(true);
    expect(chats[0]?.participants.toSorted()).toEqual(["+15551234567", "friend@example.com"]);
    expect(chats[1]?.isGroup).toBe(false);
  });
});

describe("counts", () => {
  it("reports what is in the store", () => {
    const s = store((db) => addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "hi" }));
    const counts = s.counts();
    expect(counts.messages).toBe(1);
    expect(counts.chats).toBe(2);
    expect(counts.handles).toBe(2);
  });
});

/** Narrow the union the way a caller who passed a `groupBy` already has. */
const grouped = (result: ReturnType<MessagesStore["countMessages"]>) => {
  if (!("groups" in result)) throw new Error("expected a grouped result");
  return result;
};

const totals = (result: ReturnType<MessagesStore["countMessages"]>) => {
  if ("groups" in result) throw new Error("expected a plain total");
  return result;
};

describe("countMessages", () => {
  const seeded = (): MessagesStore =>
    store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "a", fromMe: 1 });
      addMessage(db, { rowid: 2, guid: "B", chat: 1, text: "b", fromMe: 0 });
      addMessage(db, { rowid: 3, guid: "C", chat: 2, text: "c", fromMe: 0, handle: 2 });
      // A tapback: a row in the same table that nobody typed.
      addMessage(db, {
        rowid: 4,
        guid: "D",
        chat: 1,
        text: null,
        reactionType: 2000,
        reactionTarget: "A",
      });
    });

  it("counts every match and splits sent from received", () => {
    const result = totals(seeded().countMessages({ limit: 25 }));
    expect(result.total).toBe(3);
    expect(result.sent).toBe(1);
    expect(result.received).toBe(2);
  });

  /**
   * Tapbacks inflate a count with something nobody wrote, and 2,788 of them sit
   * in the probed store. Excluding them is the same call `list_messages` makes.
   */
  it("excludes tapbacks unless asked for them", () => {
    const s = seeded();
    expect(totals(s.countMessages({ limit: 25 })).total).toBe(3);
    expect(totals(s.countMessages({ limit: 25, includeReactions: true })).total).toBe(4);
  });

  it("narrows by direction, chat and handle", () => {
    const s = seeded();
    expect(totals(s.countMessages({ limit: 25, direction: "sent" })).total).toBe(1);
    expect(totals(s.countMessages({ limit: 25, chatGuid: "iMessage;+;chat9001" })).total).toBe(1);
    expect(totals(s.countMessages({ limit: 25, handle: "friend@" })).total).toBe(1);
  });

  it("groups by chat, labelled with the chat's name", () => {
    const groups = grouped(seeded().countMessages({ limit: 25 }, "chat")).groups;
    expect(groups.map((g) => [g.key, g.total])).toEqual([
      ["iMessage;-;+15551234567", 2],
      ["iMessage;+;chat9001", 1],
    ]);
    expect(groups[1]?.label).toBe("Book club");
  });

  /**
   * The question the tool exists for: one person across several conversations.
   * `list_chats` reports per-CHAT totals and cannot add these two together.
   */
  it("groups by handle across chats", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "a", handle: 1 });
      addMessage(db, { rowid: 2, guid: "B", chat: 2, text: "b", handle: 1 });
      addMessage(db, { rowid: 3, guid: "C", chat: 2, text: "c", handle: 2 });
    });
    const groups = grouped(s.countMessages({ limit: 25 }, "handle")).groups;
    expect(groups[0]).toMatchObject({ key: "+15551234567", total: 2 });
    expect(groups[1]).toMatchObject({ key: "friend@example.com", total: 1 });
  });

  /**
   * THE RULE, same as Mail's query lane: `limit` caps the GROUPS, never what was
   * counted. A top-N over a truncated page is shaped exactly like a real top-N.
   */
  it("caps the number of groups without capping what was counted", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "a", iso: "2026-08-01T12:00:00Z" });
      addMessage(db, { rowid: 2, guid: "B", chat: 1, text: "b", iso: "2026-08-02T12:00:00Z" });
      addMessage(db, { rowid: 3, guid: "C", chat: 1, text: "c", iso: "2026-08-03T12:00:00Z" });
    });
    const result = grouped(s.countMessages({ limit: 1 }, "day"));
    expect(result.groups).toHaveLength(1);
    expect(result.totalGroups).toBe(3);
    expect(result.totalRows).toBe(3);
  });

  /**
   * A message filed in two chats is one message. The chat join makes a row per
   * (chat, message) pair, so a plain COUNT(*) would report two.
   */
  it("counts a message in two chats once", () => {
    const s = store((db) => {
      addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "a" });
      db.prepare(
        `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (2, 1, 0)`,
      ).run();
    });
    expect(totals(s.countMessages({ limit: 25, chatGuid: "iMessage;-;+15551234567" })).total).toBe(
      1,
    );
    expect(grouped(s.countMessages({ limit: 25 }, "chat")).totalRows).toBe(1);
  });

  /**
   * Buckets are LOCAL calendar days, which is what "how many on the 3rd" means.
   * Asserted against the same instant formatted locally in JS, so this holds in
   * whatever zone the suite runs in — including the zones where the UTC bucket
   * would land on the previous day.
   */
  it("buckets days and months on the local calendar", () => {
    const iso = "2026-08-03T23:30:00Z";
    const local = new Date(iso);
    const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(
      local.getDate(),
    ).padStart(2, "0")}`;
    const s = store((db) => addMessage(db, { rowid: 1, guid: "A", chat: 1, text: "a", iso }));
    expect(grouped(s.countMessages({ limit: 25 }, "day")).groups[0]?.key).toBe(day);
    expect(grouped(s.countMessages({ limit: 25 }, "month")).groups[0]?.key).toBe(day.slice(0, 7));
  });
});
