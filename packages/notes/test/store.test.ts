import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { CORE_DATA_EPOCH_OFFSET } from "@mgcrea/mcp-apple-core";
import { beforeEach, describe, expect, it } from "vitest";

import { introspect, NoteStore } from "../src/client/store.js";

/**
 * The schema is the real one, captured from a live NoteStore.sqlite by
 * `scripts/probe-notes.mjs --write` (fingerprint 5ae59272bcf9, 61 tables). Only
 * the rows are synthetic — which is the point: these tests exercise the actual
 * column names and types Apple ships, so a rename shows up here.
 */
const DDL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "note-store.sql"),
  "utf8",
);

const NOTE_ENT = 12;
const STORE_UUID = "B1FD1F1B-0000-0000-0000-000000000000";

// ── protobuf assembly, mirroring what Notes actually stores ──────────────────
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
/** document(2) -> note(3) -> note_text(2), gzipped, as measured. */
const zdata = (body: string): Buffer =>
  gzipSync(
    Buffer.concat([
      int(1, 0),
      len(2, Buffer.concat([int(1, 0), len(3, len(2, Buffer.from(body, "utf8")))])),
    ]),
  );

const CORE_DATA_2026 = Date.parse("2026-08-19T12:00:00Z") / 1000 - CORE_DATA_EPOCH_OFFSET;

let db: DatabaseSync;

const insertNote = (
  pk: number,
  opts: {
    title?: string | null;
    snippet?: string | null;
    trashed?: boolean;
    deleted?: boolean;
    locked?: boolean;
    ent?: number;
  } = {},
): void => {
  db.prepare(
    `INSERT INTO ZICCLOUDSYNCINGOBJECT
       (Z_PK, Z_ENT, ZTITLE1, ZWIDGETSNIPPET, ZMODIFICATIONDATE1, ZCREATIONDATE1,
        ZISRECOVERINGFROMTRASH, ZMARKEDFORDELETION, ZISPASSWORDPROTECTED)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pk,
    opts.ent ?? NOTE_ENT,
    opts.title === undefined ? `Note ${pk}` : opts.title,
    opts.snippet ?? `snippet for ${pk}`,
    CORE_DATA_2026 - pk,
    CORE_DATA_2026 - pk,
    opts.trashed ? 1 : 0,
    opts.deleted ? 1 : 0,
    opts.locked ? 1 : 0,
  );
};

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-apple-notes-store-"));
  db = new DatabaseSync(join(dir, "NoteStore.sqlite"));
  db.exec(DDL);
  db.prepare("INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)").run(
    NOTE_ENT,
    "ICNote",
  );
  db.prepare("INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, ?)").run(STORE_UUID);
});

describe("introspect", () => {
  it("finds ICNote by name rather than hardcoding an entity number", () => {
    const caps = introspect(db);
    expect(caps.noteEnt).toBe(NOTE_ENT);
    expect(caps.missing).toEqual([]);
  });

  it("reads the persistent store UUID, so refs need no Apple Event", () => {
    expect(introspect(db).storeUuid).toBe(STORE_UUID);
  });

  it("spots the deletion columns this schema actually has", () => {
    expect(introspect(db).deletionColumns).toEqual([
      "ZISRECOVERINGFROMTRASH",
      "ZMARKEDFORDELETION",
    ]);
  });
});

describe("the note predicate", () => {
  /**
   * The 1191-versus-921 trap. `Z_ENT` alone matched 1191 rows on a real store
   * against 921 notes Apple Events reported, and the deletion columns explained
   * none of it — the extras are title-less rows. An index lane keyed on Z_ENT
   * would serve 270 notes that do not exist as far as the user is concerned.
   */
  it("excludes title-less rows", () => {
    insertNote(1);
    insertNote(2, { title: null });
    insertNote(3);
    const store = new NoteStore(db, introspect(db), "ro");
    expect(store.count()).toBe(2);
    expect(store.search({ limit: 10, offset: 0 }).map((r) => r.primaryKey)).toEqual([1, 3]);
  });

  it("excludes trashed and deletion-marked rows", () => {
    insertNote(1);
    insertNote(2, { trashed: true });
    insertNote(3, { deleted: true });
    const store = new NoteStore(db, introspect(db), "ro");
    expect(store.count()).toBe(1);
  });

  it("excludes rows belonging to other entities", () => {
    insertNote(1);
    insertNote(2, { ent: 99 });
    expect(new NoteStore(db, introspect(db), "ro").count()).toBe(1);
  });
});

describe("search", () => {
  beforeEach(() => {
    insertNote(1, { title: "Shopping list", snippet: "milk, eggs" });
    insertNote(2, { title: "Meeting notes", snippet: "quarterly review" });
    insertNote(3, { title: "Recipe", snippet: "100% rye bread" });
  });

  it("matches the title", () => {
    const store = new NoteStore(db, introspect(db), "ro");
    expect(store.search({ query: "shopping", limit: 10, offset: 0 })).toHaveLength(1);
  });

  it("matches the snippet too", () => {
    const store = new NoteStore(db, introspect(db), "ro");
    expect(store.search({ query: "quarterly", limit: 10, offset: 0 })).toHaveLength(1);
  });

  it("treats LIKE wildcards in the query as literal text", () => {
    const store = new NoteStore(db, introspect(db), "ro");
    // Unescaped, "100%" would be a prefix wildcard and "%" would match all three.
    // Escaped, each matches only the row whose text really contains a percent sign.
    expect(store.search({ query: "100%", limit: 10, offset: 0 }).map((r) => r.primaryKey)).toEqual([
      3,
    ]);
    expect(store.search({ query: "%", limit: 10, offset: 0 }).map((r) => r.primaryKey)).toEqual([
      3,
    ]);
    expect(store.search({ query: "_", limit: 10, offset: 0 })).toHaveLength(0);
  });

  it("returns newest first and pages", () => {
    const store = new NoteStore(db, introspect(db), "ro");
    const all = store.search({ limit: 10, offset: 0 });
    expect(all.map((r) => r.primaryKey)).toEqual([1, 2, 3]);
    expect(store.search({ limit: 1, offset: 1 }).map((r) => r.primaryKey)).toEqual([2]);
  });

  it("converts Core Data seconds, not unix seconds", () => {
    const [row] = new NoteStore(db, introspect(db), "ro").search({ limit: 1, offset: 0 });
    // 31 years out is what using the wrong epoch looks like.
    expect(row?.modified?.slice(0, 4)).toBe("2026");
  });
});

describe("bodyOf", () => {
  it("decodes the gzipped protobuf at the measured path", () => {
    insertNote(1);
    db.prepare("INSERT INTO ZICNOTEDATA (Z_PK, Z_ENT, ZNOTE, ZDATA) VALUES (1, 13, 1, ?)").run(
      zdata("Shopping list\nmilk\neggs"),
    );
    const body = new NoteStore(db, introspect(db), "ro").bodyOf(1);
    expect(body).toMatchObject({
      text: "Shopping list\nmilk\neggs",
      via: "pinned",
      encrypted: false,
    });
  });

  /**
   * Password-protected notes hold AES ciphertext, flagged by a non-null
   * ZCRYPTOTAG. Saying "encrypted" is the useful answer; no permission changes it.
   */
  it("reports encrypted rather than returning nothing", () => {
    insertNote(1, { locked: true });
    db.prepare(
      "INSERT INTO ZICNOTEDATA (Z_PK, Z_ENT, ZNOTE, ZDATA, ZCRYPTOTAG) VALUES (1, 13, 1, ?, ?)",
    ).run(Buffer.from([1, 2, 3]), Buffer.from([9, 9]));
    expect(new NoteStore(db, introspect(db), "ro").bodyOf(1)).toMatchObject({
      text: null,
      encrypted: true,
    });
  });

  it("is null rather than throwing when a note has no data row", () => {
    insertNote(1);
    expect(new NoteStore(db, introspect(db), "ro").bodyOf(1).text).toBeNull();
  });

  it("ignores a blob that is not gzip", () => {
    insertNote(1);
    db.prepare("INSERT INTO ZICNOTEDATA (Z_PK, Z_ENT, ZNOTE, ZDATA) VALUES (1, 13, 1, ?)").run(
      Buffer.from("bplist00garbage", "utf8"),
    );
    expect(new NoteStore(db, introspect(db), "ro").bodyOf(1).text).toBeNull();
  });
});
