import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { CORE_DATA_EPOCH_OFFSET, type OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppleNotesClient } from "../src/client/notes.js";
import { loadConfig } from "../src/config.js";

/**
 * What a short list means.
 *
 * Both lanes cut their results, for different reasons, and neither could say
 * so: `listNotes` handed back a bare array, and an array of 200 looks exactly
 * like a library of 200. The Apple Events lane is the worse of the two, because
 * its cap is independent of `limit` — asking for 500 and receiving 200 was
 * indistinguishable from asking for 500 and there being 200.
 */
const DDL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "note-store.sql"),
  "utf8",
);

const NOTE_ENT = 12;
const STORE_UUID = "B1FD1F1B-0000-0000-0000-000000000000";
const AT = Date.parse("2026-08-19T12:00:00Z") / 1000 - CORE_DATA_EPOCH_OFFSET;

/** Five notes in the index, so a limit below that leaves something behind. */
const INDEXED = 5;

let dir: string;
let storePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-notes-truncation-"));
  storePath = join(dir, "NoteStore.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(DDL);
  db.prepare("INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)").run(
    NOTE_ENT,
    "ICNote",
  );
  db.prepare("INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, ?)").run(STORE_UUID);
  for (let i = 1; i <= INDEXED; i++) {
    db.prepare(
      `INSERT INTO ZICCLOUDSYNCINGOBJECT
         (Z_PK, Z_ENT, ZTITLE1, ZWIDGETSNIPPET, ZMODIFICATIONDATE1, ZCREATIONDATE1,
          ZISRECOVERINGFROMTRASH, ZMARKEDFORDELETION, ZISPASSWORDPROTECTED)
       VALUES (?, ?, ?, 'snippet', ?, ?, 0, 0, 0)`,
    ).run(i, NOTE_ENT, `Indexed note ${i}`, AT, AT);
  }
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Three notes over Apple Events, all in the one allowed account. */
const AE_NOTES = [1, 2, 3].map((i) => ({
  id: `x-coredata://${STORE_UUID}/ICNote/p${i}`,
  name: `Apple Events note ${i}`,
  modified: "2026-08-19T10:00:00.000Z",
  created: "2026-08-01T10:00:00.000Z",
  locked: false,
  folder: "Notes",
  account: "iCloud",
}));

const runner = (): OsascriptRunner =>
  ({
    run: vi.fn(async (script: string) => {
      if (script.includes("a.defaultFolder.name()")) {
        return [{ id: "acct-1", name: "iCloud", defaultFolder: "Notes" }];
      }
      if (script.includes("folderOf[row.id]")) {
        return { count: AE_NOTES.length, notes: AE_NOTES };
      }
      return [];
    }),
  }) as unknown as OsascriptRunner;

const client = (env: NodeJS.ProcessEnv = {}) =>
  new AppleNotesClient({
    config: loadConfig({ APPLE_NOTES_STORE: storePath, ...env }),
    osascript: runner(),
  });

/** An account allowlist is what pushes a request onto the Apple Events lane. */
const appleEvents = (env: NodeJS.ProcessEnv = {}) =>
  client({ APPLE_NOTES_ACCOUNTS: "iCloud", ...env });

describe("the index lane", () => {
  it("says there is more when the page fills", async () => {
    const out = await client().listNotes({ limit: 2 });
    expect(out.source).toBe("index");
    expect(out.hasMore).toBe(true);
  });

  /**
   * The over-fetch must not leak. `hasMore` is learned by asking SQL for one
   * row past the page, and that row is a probe — returning it would hand the
   * caller `limit + 1` notes and quietly break paging.
   */
  it("returns exactly the page, not the row it peeked at", async () => {
    const out = await client().listNotes({ limit: 2 });
    expect(out.notes).toHaveLength(2);
  });

  it("says there is no more when the library is exhausted", async () => {
    const out = await client().listNotes({ limit: 50 });
    expect(out.notes).toHaveLength(INDEXED);
    expect(out.hasMore).toBe(false);
    expect(out.note).toBeUndefined();
  });

  it("reports a full page of title-search hits the same way", async () => {
    const hit = await client().searchNotes({
      query: "Indexed",
      scope: "title",
      limit: 2,
      offset: 0,
    });
    expect(hit.notes).toHaveLength(2);
    expect(hit.hasMore).toBe(true);

    const rest = await client().searchNotes({
      query: "Indexed",
      scope: "title",
      limit: 2,
      offset: 4,
    });
    expect(rest.hasMore).toBe(false);
  });
});

describe("the Apple Events lane", () => {
  /**
   * The case this file exists for. The cap is 1, the caller asked for 50, and
   * three notes matched — so the list is short for a reason that has nothing to
   * do with what was asked, and the caller can do something about it.
   */
  it("says so when its own cap, not the limit, ended the list", async () => {
    const out = await appleEvents({ APPLE_NOTES_DEGRADED_MAX_NOTES: "1" }).listNotes({ limit: 50 });
    expect(out.source).toBe("apple-events");
    expect(out.notes).toHaveLength(1);
    expect(out.hasMore).toBe(true);
    expect(out.note).toMatch(/capped at 1 notes and you asked for 50/);
    expect(out.note).toMatch(/APPLE_NOTES_DEGRADED_MAX_NOTES/);
  });

  /**
   * The counterpart, and the reason the note is conditional: a caller whose own
   * `limit` ran out first is getting exactly what it asked for. Saying "capped"
   * there would train a reader to ignore the field.
   */
  it("stays quiet when the caller's own limit ended the list", async () => {
    const out = await appleEvents().listNotes({ limit: 1 });
    expect(out.notes).toHaveLength(1);
    expect(out.hasMore).toBe(true);
    expect(out.note).toBeUndefined();
  });

  it("stays quiet when nothing was left behind at all", async () => {
    const out = await appleEvents().listNotes({ limit: 50 });
    expect(out.notes).toHaveLength(AE_NOTES.length);
    expect(out.hasMore).toBe(false);
    expect(out.note).toBeUndefined();
  });
});
