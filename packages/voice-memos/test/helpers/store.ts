import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * Replayed from the real schema, captured by `scripts/probe-voice-memos.mjs --write`: 77
 * objects, no rows. Every row below is made up, so these prove the mapping rules, not what a
 * real library holds. The live check (`scripts/check-voice-memos-live.mjs`) covers that.
 */
export const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cloud-recordings.sql"),
  "utf8",
);

export const RECORDINGS =
  "/Users/someone/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings";

export const build = (sql: string = FIXTURE): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
};

type Row = {
  pk: number;
  id: string;
  title?: string | null;
  label?: string | null;
  date?: number | null;
  duration?: number | null;
  folder?: number | null;
  shared?: number | null;
  evicted?: number | null;
  path?: string | null;
  opt?: number;
};

export const insertRecording = (db: DatabaseSync, r: Row): void => {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info("ZCLOUDRECORDING")`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const values: Record<string, unknown> = {
    Z_PK: r.pk,
    Z_ENT: 1,
    Z_OPT: r.opt ?? 1,
    ZUNIQUEID: r.id,
    ZENCRYPTEDTITLE: r.title ?? null,
    ZCUSTOMLABEL: r.label ?? null,
    ZDATE: r.date ?? null,
    ZDURATION: r.duration ?? null,
    ZFOLDER: r.folder ?? null,
    ZSHAREDFLAGS: r.shared ?? null,
    ZEVICTIONDATE: r.evicted ?? null,
    ZPATH: r.path ?? null,
  };
  const keys = Object.keys(values).filter((k) => cols.has(k));
  db.prepare(
    `INSERT INTO ZCLOUDRECORDING (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
  ).run(...(keys.map((k) => values[k]) as (string | number | null)[]));
};

export const insertFolder = (
  db: DatabaseSync,
  f: { pk: number; uuid: string; name: string | null; rank: number | null; count: number },
): void => {
  db.prepare(
    `INSERT INTO ZFOLDER (Z_PK, Z_ENT, Z_OPT, ZUUID, ZENCRYPTEDNAME, ZRANK, ZCOUNTOFRECORDINGS)
     VALUES (?, 2, 1, ?, ?, ?, ?)`,
  ).run(f.pk, f.uuid, f.name, f.rank, f.count);
};
