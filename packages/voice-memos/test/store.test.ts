import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERIFIED_FINGERPRINT, VoiceMemosStore } from "../src/client/store.js";
import { build, FIXTURE, insertFolder, insertRecording, RECORDINGS } from "./helpers/store.js";

const withoutColumn = (sql: string, column: string): string =>
  sql.replace(new RegExp(`, ${column} VARCHAR`), "");

describe("VoiceMemosStore.listRecordings", () => {
  it("maps a recording row", () => {
    const db = build();
    insertFolder(db, { pk: 7, uuid: "F-1", name: "Work", rank: 0, count: 1 });
    insertRecording(db, {
      pk: 1,
      id: "U-1",
      title: "  Standup notes ",
      label: "2025-11-05T01:46:40Z",
      date: 784_000_000,
      duration: 61.5,
      folder: 7,
      shared: 1,
      path: "2025-11-05 01.46.40.qta",
      opt: 9,
    });
    const [row] = new VoiceMemosStore(db, RECORDINGS).listRecordings();
    expect(row).toEqual({
      id: "U-1",
      title: "Standup notes",
      label: "2025-11-05T01:46:40Z",
      recordedAt: "2025-11-05T01:46:40.000Z",
      duration: 61.5,
      folderId: "F-1",
      favorite: true,
      deletedAt: null,
      audioPath: `${RECORDINGS}/2025-11-05 01.46.40.qta`,
      changeToken: 9,
    });
  });

  it("lists newest first, deleted included", () => {
    const db = build();
    insertRecording(db, { pk: 1, id: "old", date: 100 });
    insertRecording(db, { pk: 2, id: "new", date: 300, evicted: 400 });
    insertRecording(db, { pk: 3, id: "mid", date: 200 });
    insertRecording(db, { pk: 4, id: "undated" });
    const ids = new VoiceMemosStore(db, RECORDINGS).listRecordings().map((r) => r.id);
    expect(ids).toEqual(["new", "mid", "old", "undated"]);
  });

  it("title is null, not the label, when ZENCRYPTEDTITLE is empty", () => {
    const db = build();
    insertRecording(db, { pk: 1, id: "a", title: "", label: "2025-11-05T01:46:40Z" });
    insertRecording(db, { pk: 2, id: "b", title: "   ", label: "x" });
    insertRecording(db, { pk: 3, id: "c", title: null, label: "x" });
    const rows = new VoiceMemosStore(db, RECORDINGS).listRecordings();
    expect(rows.map((r) => r.title)).toEqual([null, null, null]);
    expect(rows.find((r) => r.id === "a")?.label).toBe("2025-11-05T01:46:40Z");
  });

  it("falls back to ZCUSTOMLABEL for title when ZENCRYPTEDTITLE is absent", () => {
    const db = build(withoutColumn(FIXTURE, "ZENCRYPTEDTITLE"));
    insertRecording(db, { pk: 1, id: "named", label: "Interview with Ana", date: 2 });
    insertRecording(db, { pk: 2, id: "dated", label: "2025-11-05T01:46:40Z", date: 1 });
    const rows = new VoiceMemosStore(db, RECORDINGS).listRecordings();
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ["named", "Interview with Ana"],
      ["dated", null],
    ]);
  });

  it("favorite reads bit 0x1 of ZSHAREDFLAGS", () => {
    const db = build();
    for (const [pk, shared] of [
      [1, null],
      [2, 0],
      [3, 1],
      [4, 3],
      [5, 2],
    ] as const) {
      insertRecording(db, { pk, id: `r${pk}`, shared, date: 10 - pk });
    }
    const rows = new VoiceMemosStore(db, RECORDINGS).listRecordings();
    expect(rows.map((r) => [r.id, r.favorite])).toEqual([
      ["r1", false],
      ["r2", false],
      ["r3", true],
      ["r4", true],
      ["r5", false],
    ]);
  });

  it("deletedAt is set only when ZEVICTIONDATE is", () => {
    const db = build();
    insertRecording(db, { pk: 1, id: "kept", date: 2 });
    insertRecording(db, { pk: 2, id: "binned", date: 1, evicted: 784_000_000 });
    const rows = new VoiceMemosStore(db, RECORDINGS).listRecordings();
    expect(rows.map((r) => [r.id, r.deletedAt])).toEqual([
      ["kept", null],
      ["binned", "2025-11-05T01:46:40.000Z"],
    ]);
  });

  it('audioPath is null for a null ZPATH, "../x.m4a" and "/etc/passwd"', () => {
    const db = build();
    insertRecording(db, { pk: 1, id: "none", path: null, date: 5 });
    insertRecording(db, { pk: 2, id: "up", path: "../x.m4a", date: 4 });
    insertRecording(db, { pk: 3, id: "abs", path: "/etc/passwd", date: 3 });
    insertRecording(db, { pk: 4, id: "self", path: ".", date: 2 });
    insertRecording(db, { pk: 5, id: "ok", path: "a.m4a", date: 1 });
    const rows = new VoiceMemosStore(db, RECORDINGS).listRecordings();
    expect(rows.map((r) => [r.id, r.audioPath])).toEqual([
      ["none", null],
      ["up", null],
      ["abs", null],
      ["self", null],
      ["ok", `${RECORDINGS}/a.m4a`],
    ]);
  });
});

describe("VoiceMemosStore.listFolders", () => {
  it("lists folders in ZRANK order with ZCOUNTOFRECORDINGS", () => {
    const db = build();
    insertFolder(db, { pk: 1, uuid: "B", name: "Second", rank: 2, count: 0 });
    insertFolder(db, { pk: 2, uuid: "A", name: "First", rank: 1, count: 3 });
    insertFolder(db, { pk: 3, uuid: "C", name: null, rank: null, count: 1 });
    expect(new VoiceMemosStore(db, RECORDINGS).listFolders()).toEqual([
      { id: "A", name: "First", rank: 1, count: 3 },
      { id: "B", name: "Second", rank: 2, count: 0 },
      { id: "C", name: null, rank: null, count: 1 },
    ]);
  });
});

describe("VoiceMemosStore.schemaFingerprint", () => {
  it("fingerprint is stable and differs when a column is added", () => {
    const a = new VoiceMemosStore(build(), RECORDINGS).schemaFingerprint();
    const b = new VoiceMemosStore(build(), RECORDINGS).schemaFingerprint();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
    const wider = build();
    wider.exec("ALTER TABLE ZCLOUDRECORDING ADD COLUMN ZNEWTHING INTEGER");
    expect(new VoiceMemosStore(wider, RECORDINGS).schemaFingerprint()).not.toBe(a);
  });

  it("computes what the probe computed, so VERIFIED_FINGERPRINT can match a real store", async () => {
    // A non-literal specifier keeps tsc from resolving the untyped .mjs.
    const kitPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../scripts/lib/probe-kit.mjs",
    );
    const kit = (await import(kitPath)) as {
      dumpSchema: (db: DatabaseSync) => { fingerprint: string };
    };
    const db = build();
    db.exec("CREATE TRIGGER ZT AFTER INSERT ON ZFOLDER BEGIN SELECT 1; END");
    db.exec("CREATE VIEW ZV AS SELECT 1");
    expect(new VoiceMemosStore(db, RECORDINGS).schemaFingerprint()).toBe(
      kit.dumpSchema(db).fingerprint,
    );
    // The fixture omits five Core Data triggers, so it never passes as the verified store.
    expect(VERIFIED_FINGERPRINT).toBe("fb804d4a4d59");
    expect(new VoiceMemosStore(build(), RECORDINGS).schemaFingerprint()).not.toBe(
      VERIFIED_FINGERPRINT,
    );
  });
});
