import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { CORE_DATA_EPOCH_OFFSET, type OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppleNotesClient } from "../src/client/notes.js";
import { loadConfig } from "../src/config.js";

/**
 * Which lane answers, and when.
 *
 * `tools.test.ts` runs with no store on disk, so every test there takes the
 * Apple Events lane and cannot see a setting the index lane ignores. That was
 * the gap: with Full Disk Access, `APPLE_NOTES_ACCOUNTS` and the `folder`
 * argument were both dropped on the floor — the allowlist because an index row
 * carries no account name, and `folder` because it resolved through a stub that
 * always answered `undefined`. Both failed open, on exactly the machines where
 * the setting matters.
 */
const DDL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "note-store.sql"),
  "utf8",
);

const NOTE_ENT = 12;
const STORE_UUID = "B1FD1F1B-0000-0000-0000-000000000000";
const CORE_DATA_2026 = Date.parse("2026-08-19T12:00:00Z") / 1000 - CORE_DATA_EPOCH_OFFSET;

const varint = (n: number): Buffer => {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};
const len = (f: number, p: Buffer): Buffer =>
  Buffer.concat([varint(f * 8 + 2), varint(p.length), p]);
const int = (f: number, v: number): Buffer => Buffer.concat([varint(f * 8), varint(v)]);
const zdata = (body: string): Buffer =>
  gzipSync(
    Buffer.concat([
      int(1, 0),
      len(2, Buffer.concat([int(1, 0), len(3, len(2, Buffer.from(body, "utf8")))])),
    ]),
  );

let dir: string;
let storePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-notes-lanes-"));
  storePath = join(dir, "NoteStore.sqlite");
  const db = new DatabaseSync(storePath);
  db.exec(DDL);
  db.prepare("INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)").run(
    NOTE_ENT,
    "ICNote",
  );
  db.prepare("INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, ?)").run(STORE_UUID);
  db.prepare(
    `INSERT INTO ZICCLOUDSYNCINGOBJECT
       (Z_PK, Z_ENT, ZTITLE1, ZWIDGETSNIPPET, ZMODIFICATIONDATE1, ZCREATIONDATE1,
        ZISRECOVERINGFROMTRASH, ZMARKEDFORDELETION, ZISPASSWORDPROTECTED)
     VALUES (1, ?, 'From the index', 'indexed snippet', ?, ?, 0, 0, 0)`,
  ).run(NOTE_ENT, CORE_DATA_2026, CORE_DATA_2026);
  db.prepare(`INSERT INTO ZICNOTEDATA (Z_PK, Z_ENT, ZNOTE, ZDATA) VALUES (1, 13, 1, ?)`).run(
    zdata("indexed body text"),
  );
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One note, in a named folder and a named account, from Apple Events. */
const AE_NOTE = {
  id: "x-coredata://B1FD1F1B-0000-0000-0000-000000000000/ICNote/p9",
  name: "From Apple Events",
  modified: "2026-08-19T10:00:00.000Z",
  created: "2026-08-01T10:00:00.000Z",
  locked: false,
  folder: "Archive",
  account: "iCloud",
};

const runner = (): OsascriptRunner =>
  ({
    run: vi.fn(async (script: string) => {
      if (script.includes("a.defaultFolder.name()")) {
        return [{ id: "acct-1", name: "iCloud", defaultFolder: "Notes" }];
      }
      if (script.includes("folders[j].accountName")) {
        return [
          { id: "f1", name: "Notes", accountName: "iCloud" },
          { id: "f2", name: "Archive", accountName: "iCloud" },
        ];
      }
      if (script.includes("folderOf[row.id]")) return { count: 1, notes: [AE_NOTE] };
      if (script.includes("N.notes.plaintext()") && script.includes("ids:")) {
        return { ids: [AE_NOTE.id], texts: ["apple events body text"] };
      }
      if (script.includes("out.push({ id: id, found: false })")) {
        return [
          {
            id: AE_NOTE.id,
            found: true,
            locked: false,
            name: AE_NOTE.name,
            plaintext: "apple events body text",
            body: "<h1>From Apple Events</h1>",
            modified: AE_NOTE.modified,
            created: AE_NOTE.created,
          },
        ];
      }
      return [];
    }),
  }) as unknown as OsascriptRunner;

const client = (env: NodeJS.ProcessEnv = {}) =>
  new AppleNotesClient({
    config: loadConfig({ APPLE_NOTES_STORE: storePath, ...env }),
    osascript: runner(),
  });

describe("lane selection", () => {
  it("prefers the index when nothing stops it", async () => {
    const out = await client().listNotes({ limit: 10 });
    expect(out.map((n) => n.title)).toEqual(["From the index"]);
  });

  /**
   * The allowlist bug. `#fromIndex` sets `account: null`, so no index row can
   * be tested against the list — and answering from the index anyway ignored
   * the one setting whose whole job is limiting what gets read.
   */
  it("falls back to Apple Events when an account allowlist is set", async () => {
    const out = await client({ APPLE_NOTES_ACCOUNTS: "iCloud" }).listNotes({ limit: 10 });
    expect(out.map((n) => n.title)).toEqual(["From Apple Events"]);
  });

  it("actually filters on that allowlist rather than merely switching lane", async () => {
    const out = await client({ APPLE_NOTES_ACCOUNTS: "SomeoneElse" }).listNotes({ limit: 10 });
    expect(out).toEqual([]);
  });

  /**
   * The folder bug. `#folderPk` always returned `undefined`, and the index
   * branch was taken anyway — so `folder` named a folder and got every folder.
   */
  it("falls back to Apple Events when a folder is named", async () => {
    const out = await client().listNotes({ folder: "Archive", limit: 10 });
    expect(out.map((n) => n.title)).toEqual(["From Apple Events"]);
  });

  it("actually filters on that folder", async () => {
    const out = await client().listNotes({ folder: "NoSuchFolder", limit: 10 });
    expect(out).toEqual([]);
  });

  it("applies the same rule to a title search", async () => {
    const indexed = await client().searchNotes({
      query: "index",
      scope: "title",
      limit: 10,
      offset: 0,
    });
    expect(indexed.source).toBe("index");

    const scoped = await client({ APPLE_NOTES_ACCOUNTS: "iCloud" }).searchNotes({
      query: "Apple",
      scope: "title",
      limit: 10,
      offset: 0,
    });
    expect(scoped.source).toBe("apple-events");
  });

  it("applies it to a full-text search too", async () => {
    const scoped = await client({ APPLE_NOTES_ACCOUNTS: "iCloud" }).searchNotes({
      query: "apple events body",
      scope: "full",
      limit: 10,
      offset: 0,
    });
    expect(scoped.source).toBe("apple-events");
    expect(scoped.notes.map((n) => n.title)).toEqual(["From Apple Events"]);
  });

  it("reports the index lane as live in diagnostics either way", async () => {
    const lanes = await client({ APPLE_NOTES_ACCOUNTS: "iCloud" }).lanes();
    // The store is readable; what changed is whether this request may use it.
    expect(lanes.index).toBe("live");
  });
});
