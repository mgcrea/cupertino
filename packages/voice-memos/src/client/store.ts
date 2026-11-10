import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { columnsOf, CORE_DATA_EPOCH_OFFSET } from "@mgcrea/mcp-apple-core";

/**
 * Reads `ZCLOUDRECORDING` and `ZFOLDER` from `CloudRecordings.db`.
 *
 * Every column is in docs/voice-memos.md, measured on macOS 27.2. Two of them mislead by
 * name: `ZENCRYPTEDTITLE` is the title in plaintext, and `ZCUSTOMLABEL` is not a title at all
 * but the date-shaped default label. Columns are looked up before they are selected, so a
 * release that drops one degrades that field to null rather than failing the query.
 */

/** The schema `docs/voice-memos.md` was measured on. Any other store works, unverified. */
export const VERIFIED_FINGERPRINT = "fb804d4a4d59";

export type RecordingRow = {
  id: string;
  title: string | null;
  /** The default label Voice Memos shows when a memo was never named: a date string. */
  label: string | null;
  recordedAt: string | null;
  duration: number | null;
  folderId: string | null;
  favorite: boolean;
  /** When the memo went to Recently Deleted; null when it has not. */
  deletedAt: string | null;
  /** Absolute, and inside the Recordings directory, or null. */
  audioPath: string | null;
  /** `Z_OPT`, bumped by Core Data on every edit of the row. */
  changeToken: number;
};

export type FolderRow = { id: string; name: string | null; rank: number | null; count: number };

/** Old releases are believed to keep the title in ZCUSTOMLABEL; a date-shaped one is not a title. */
const DATE_SHAPED = /^[0-9TZ:.\- ]+$/;

const iso = (coreDataSeconds: unknown): string | null =>
  typeof coreDataSeconds === "number" && Number.isFinite(coreDataSeconds)
    ? new Date((coreDataSeconds + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString()
    : null;

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class VoiceMemosStore {
  private readonly recordingColumns: Set<string>;
  private readonly folderColumns: Set<string>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly recordingsDir: string,
  ) {
    this.recordingColumns = new Set(columnsOf(db, "ZCLOUDRECORDING"));
    this.folderColumns = new Set(columnsOf(db, "ZFOLDER"));
  }

  /** `r.<column>` when the column exists, else NULL, aliased to the column name either way. */
  private rec(column: string): string {
    return this.recordingColumns.has(column)
      ? `r."${column}" AS "${column}"`
      : `NULL AS "${column}"`;
  }

  /** Every recording, Recently Deleted included, newest first; undated ones last. */
  listRecordings(): RecordingRow[] {
    if (!this.recordingColumns.has("ZUNIQUEID")) return [];
    const joinFolder =
      this.recordingColumns.has("ZFOLDER") &&
      this.folderColumns.has("ZUUID") &&
      this.folderColumns.has("Z_PK");
    const select = [
      this.rec("ZUNIQUEID"),
      this.rec("ZENCRYPTEDTITLE"),
      this.rec("ZCUSTOMLABEL"),
      this.rec("ZDATE"),
      this.rec("ZDURATION"),
      this.rec("ZSHAREDFLAGS"),
      this.rec("ZEVICTIONDATE"),
      this.rec("ZPATH"),
      this.rec("Z_OPT"),
      joinFolder ? `f."ZUUID" AS "FOLDERUUID"` : `NULL AS "FOLDERUUID"`,
    ].join(", ");
    const order = this.recordingColumns.has("ZDATE")
      ? `ORDER BY r."ZDATE" IS NULL, r."ZDATE" DESC`
      : "";
    const rows = this.db
      .prepare(
        `SELECT ${select} FROM ZCLOUDRECORDING r ` +
          (joinFolder ? `LEFT JOIN ZFOLDER f ON f."Z_PK" = r."ZFOLDER" ` : "") +
          order,
      )
      .all() as Record<string, unknown>[];
    const hasTitleColumn = this.recordingColumns.has("ZENCRYPTEDTITLE");
    return rows.flatMap((r): RecordingRow[] => {
      const id = text(r["ZUNIQUEID"]);
      if (!id) return [];
      const label = text(r["ZCUSTOMLABEL"]);
      const title = hasTitleColumn
        ? text(r["ZENCRYPTEDTITLE"])
        : label && !DATE_SHAPED.test(label)
          ? label
          : null;
      return [
        {
          id,
          title,
          label,
          recordedAt: iso(r["ZDATE"]),
          duration: num(r["ZDURATION"]),
          folderId: text(r["FOLDERUUID"]),
          favorite: ((num(r["ZSHAREDFLAGS"]) ?? 0) & 1) === 1,
          deletedAt: iso(r["ZEVICTIONDATE"]),
          audioPath: this.confine(r["ZPATH"]),
          changeToken: num(r["Z_OPT"]) ?? 0,
        },
      ];
    });
  }

  /** Folders in sidebar order (`ZRANK`), unranked last. */
  listFolders(): FolderRow[] {
    if (!this.folderColumns.has("ZUUID")) return [];
    const col = (c: string): string => (this.folderColumns.has(c) ? `"${c}"` : "NULL");
    const rows = this.db
      .prepare(
        `SELECT ${col("ZUUID")} AS id, ${col("ZENCRYPTEDNAME")} AS name, ${col("ZRANK")} AS rank, ` +
          `${col("ZCOUNTOFRECORDINGS")} AS count FROM ZFOLDER ORDER BY rank IS NULL, rank, id`,
      )
      .all() as Record<string, unknown>[];
    return rows.flatMap((r): FolderRow[] => {
      const id = text(r["id"]);
      return id
        ? [{ id, name: text(r["name"]), rank: num(r["rank"]), count: num(r["count"]) ?? 0 }]
        : [];
    });
  }

  /**
   * sha256 of the DDL, first 12 hex characters, ordered tables, indexes, views, then the rest.
   * The same algorithm as `scripts/lib/probe-kit.mjs` `dumpSchema`, so the value compares
   * against what the probe measured. Core's `fingerprintSchema` orders differently.
   */
  schemaFingerprint(): string {
    const ddl = (
      this.db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL
             ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
        )
        .all() as { name: string; sql: string }[]
    ).filter((r) => !/^sqlite_/i.test(r.name));
    return createHash("sha256")
      .update(ddl.map((r) => r.sql).join("\n"))
      .digest("hex")
      .slice(0, 12);
  }

  /** `ZPATH` resolved inside the Recordings directory; anything that escapes it is missing. */
  private confine(path: unknown): string | null {
    if (typeof path !== "string" || !path) return null;
    const root = resolve(this.recordingsDir);
    const full = resolve(root, path);
    return full.startsWith(root + sep) ? full : null;
  }
}
