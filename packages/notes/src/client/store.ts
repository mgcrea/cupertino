import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

import {
  columnsOf,
  CORE_DATA_EPOCH_OFFSET,
  escapeLike,
  fingerprintSchema,
  openReadOnly,
  type Logger,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

import { SchemaDriftError } from "./errors.js";
import { extractNoteText } from "./protobuf.js";

/**
 * Read-only access to `NoteStore.sqlite`.
 *
 * Everything here is measured against a real store — see `docs/notes.md`. Three
 * facts do most of the work:
 *
 * 1. **`Z_ENT` alone is not "a note the user sees".** On the probed library it
 *    matched 1191 rows against 921 notes reported by Apple Events, and the two
 *    deletion columns explained none of the difference. `ZTITLE1 IS NOT NULL`
 *    reconciles them **exactly** — verified by comparing `Z_PK` sets, not counts.
 * 2. **No column holds the body.** `ZTITLE1` is the title (100% coverage) and
 *    `ZWIDGETSNIPPET` a ~86-character preview; the text lives in a gzipped
 *    protobuf in `ZICNOTEDATA.ZDATA`.
 * 3. **Dates are Core Data seconds**, offset 978307200.
 */

/** Every column this module reads, so a missing one is named rather than thrown at. */
const REQUIRED_COLUMNS = ["Z_PK", "Z_ENT", "ZTITLE1", "ZMODIFICATIONDATE1", "ZCREATIONDATE1"];

export type NoteRow = {
  primaryKey: number;
  title: string | null;
  snippet: string | null;
  modified: string | null;
  created: string | null;
  folderPk: number | null;
  locked: boolean;
};

export type StoreCapabilities = {
  fingerprint: string;
  /**
   * The persistent store UUID, which is the middle segment of every note's
   * Apple Events id (`x-coredata://<uuid>/ICNote/p<N>`). Reading it here lets an
   * index row be turned into a ref without asking Notes anything.
   */
  storeUuid: string | null;
  /** `Z_ENT` for `ICNote`, looked up by name rather than hardcoded to 12. */
  noteEnt: number | null;
  /** Present on this schema, so the queries can use them. */
  has: {
    title: boolean;
    snippet: boolean;
    widgetSnippet: boolean;
    folder: boolean;
    locked: boolean;
  };
  deletionColumns: string[];
  missing: string[];
};

const OPTIONAL = {
  snippet: "ZSNIPPET",
  widgetSnippet: "ZWIDGETSNIPPET",
  folder: "ZFOLDER",
  locked: "ZISPASSWORDPROTECTED",
} as const;

export const introspect = (db: DatabaseSync): StoreCapabilities => {
  const cols = columnsOf(db, "ZICCLOUDSYNCINGOBJECT");
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));

  let noteEnt: number | null = null;
  try {
    const row = db.prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote'").get() as
      | { Z_ENT: number }
      | undefined;
    noteEnt = row?.Z_ENT ?? null;
  } catch {
    noteEnt = null;
  }
  if (noteEnt === null) missing.push("Z_PRIMARYKEY row for ICNote");

  let storeUuid: string | null = null;
  try {
    const row = db.prepare("SELECT Z_UUID FROM Z_METADATA LIMIT 1").get() as
      | { Z_UUID: string }
      | undefined;
    storeUuid = row?.Z_UUID ?? null;
  } catch {
    storeUuid = null;
  }

  return {
    fingerprint: fingerprintSchema(db),
    storeUuid,
    noteEnt,
    has: {
      title: cols.includes("ZTITLE1"),
      snippet: cols.includes(OPTIONAL.snippet),
      widgetSnippet: cols.includes(OPTIONAL.widgetSnippet),
      folder: cols.includes(OPTIONAL.folder),
      locked: cols.includes(OPTIONAL.locked),
    },
    // Kept in the predicate even though the probed library had nothing in the
    // trash: that clause was never exercised, which makes it untested rather
    // than proven redundant, and a library with trashed notes is exactly where
    // its absence would show up as phantom results.
    deletionColumns: cols.filter((c) => /^Z(ISRECOVERINGFROMTRASH|MARKEDFORDELETION)$/.test(c)),
    missing,
  };
};

export const assertUsable = (caps: StoreCapabilities): void => {
  if (caps.missing.length) {
    throw new SchemaDriftError(
      `NoteStore.sqlite is not the schema this server knows how to read (fingerprint ` +
        `${caps.fingerprint}). Missing: ${caps.missing.join(", ")}. The index lane is unavailable; ` +
        `the Apple Events lane still works.`,
    );
  }
};

const toIso = (coreDataSeconds: number | null): string | null => {
  if (coreDataSeconds === null || !Number.isFinite(coreDataSeconds)) return null;
  return new Date((coreDataSeconds + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
};

export type SearchFilters = {
  query?: string | undefined;
  folderPk?: number | undefined;
  modifiedAfter?: string | undefined;
  modifiedBefore?: string | undefined;
  limit: number;
  offset: number;
};

export class NoteStore {
  readonly #db: DatabaseSync;
  readonly caps: StoreCapabilities;
  readonly mode: "ro" | "immutable";

  constructor(db: DatabaseSync, caps: StoreCapabilities, mode: "ro" | "immutable") {
    this.#db = db;
    this.caps = caps;
    this.mode = mode;
  }

  /**
   * The predicate for "a note the user sees".
   *
   * `Z_ENT` picks note rows; `ZTITLE1 IS NOT NULL` drops the title-less rows
   * that Apple Events does not report. Verified by set equality against the
   * 921 ids Apple Events returned — a matching count would not have been
   * evidence, as the first ZDATA decoder demonstrated.
   */
  #where(): string {
    const deletion = this.caps.deletionColumns
      .map((c) => ` AND (o."${c}" IS NULL OR o."${c}" = 0)`)
      .join("");
    return `o.Z_ENT = ? AND o.ZTITLE1 IS NOT NULL${deletion}`;
  }

  #select(): string {
    const snippet = this.caps.has.widgetSnippet
      ? "o.ZWIDGETSNIPPET"
      : this.caps.has.snippet
        ? "o.ZSNIPPET"
        : "NULL";
    const folder = this.caps.has.folder ? "o.ZFOLDER" : "NULL";
    const locked = this.caps.has.locked ? "o.ZISPASSWORDPROTECTED" : "0";
    return `SELECT o.Z_PK AS pk, o.ZTITLE1 AS title, ${snippet} AS snippet,
                   o.ZMODIFICATIONDATE1 AS modified, o.ZCREATIONDATE1 AS created,
                   ${folder} AS folderPk, ${locked} AS locked
            FROM ZICCLOUDSYNCINGOBJECT o`;
  }

  #toRow(r: Record<string, unknown>): NoteRow {
    return {
      primaryKey: r.pk as number,
      title: (r.title as string | null) ?? null,
      snippet: (r.snippet as string | null) ?? null,
      modified: toIso((r.modified as number | null) ?? null),
      created: toIso((r.created as number | null) ?? null),
      folderPk: (r.folderPk as number | null) ?? null,
      locked: Boolean(r.locked),
    };
  }

  count(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS c FROM ZICCLOUDSYNCINGOBJECT o WHERE ${this.#where()}`)
      .get(this.caps.noteEnt) as { c: number };
    return row.c;
  }

  /**
   * Title and snippet search.
   *
   * Deliberately not full text: no indexed column carries the body. Callers that
   * need body matching combine this with `bodyOf` or fall back to the Apple
   * Events bulk scan.
   */
  search(filters: SearchFilters): NoteRow[] {
    const clauses = [this.#where()];
    const params: unknown[] = [this.caps.noteEnt];

    if (filters.query) {
      const like = `%${escapeLike(filters.query)}%`;
      const snippetCol = this.caps.has.widgetSnippet
        ? "o.ZWIDGETSNIPPET"
        : this.caps.has.snippet
          ? "o.ZSNIPPET"
          : null;
      clauses.push(
        snippetCol
          ? `(o.ZTITLE1 LIKE ? ESCAPE '\\' OR ${snippetCol} LIKE ? ESCAPE '\\')`
          : `o.ZTITLE1 LIKE ? ESCAPE '\\'`,
      );
      params.push(like);
      if (snippetCol) params.push(like);
    }
    if (filters.folderPk !== undefined && this.caps.has.folder) {
      clauses.push("o.ZFOLDER = ?");
      params.push(filters.folderPk);
    }
    if (filters.modifiedAfter) {
      clauses.push("o.ZMODIFICATIONDATE1 >= ?");
      params.push(Date.parse(filters.modifiedAfter) / 1000 - CORE_DATA_EPOCH_OFFSET);
    }
    if (filters.modifiedBefore) {
      clauses.push("o.ZMODIFICATIONDATE1 <= ?");
      params.push(Date.parse(filters.modifiedBefore) / 1000 - CORE_DATA_EPOCH_OFFSET);
    }

    const sql = `${this.#select()} WHERE ${clauses.join(" AND ")}
                 ORDER BY o.ZMODIFICATIONDATE1 DESC LIMIT ? OFFSET ?`;
    params.push(filters.limit, filters.offset);
    return (this.#db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map(
      (r) => this.#toRow(r),
    );
  }

  byPrimaryKey(pk: number): NoteRow | null {
    const row = this.#db
      .prepare(`${this.#select()} WHERE ${this.#where()} AND o.Z_PK = ?`)
      .get(this.caps.noteEnt, pk) as Record<string, unknown> | undefined;
    return row ? this.#toRow(row) : null;
  }

  /**
   * The note body, decoded from the gzipped protobuf.
   *
   * Returns null for password-protected notes: their `ZDATA` is AES ciphertext,
   * flagged by a non-null `ZCRYPTOTAG`. No permission makes that readable.
   */
  bodyOf(pk: number): { text: string | null; via: string | null; encrypted: boolean } {
    const row = this.#db
      .prepare("SELECT ZDATA AS data, ZCRYPTOTAG AS tag FROM ZICNOTEDATA WHERE ZNOTE = ?")
      .get(pk) as { data: Uint8Array | null; tag: Uint8Array | null } | undefined;
    if (!row?.data) return { text: null, via: null, encrypted: false };
    if (row.tag) return { text: null, via: null, encrypted: true };

    const blob = Buffer.from(row.data);
    if (blob[0] !== 0x1f || blob[1] !== 0x8b) return { text: null, via: null, encrypted: false };
    let inflated: Buffer;
    try {
      inflated = gunzipSync(blob);
    } catch {
      return { text: null, via: null, encrypted: false };
    }
    const decoded = extractNoteText(inflated);
    return { text: decoded.text, via: decoded.via, encrypted: false };
  }

  close(): void {
    this.#db.close();
  }
}

export const openStore = (path: string, mode: ReadOnlyMode, logger?: Logger): NoteStore => {
  const {
    db,
    mode: opened,
    validated: caps,
  } = openReadOnly<StoreCapabilities>(path, mode, {
    envVar: "APPLE_NOTES_INDEX_MODE",
    label: "Notes' store",
    hint: "If this is a permission error, grant Full Disk Access to the app running this server.",
    validate: (conn) => {
      const found = introspect(conn);
      assertUsable(found);
      return found;
    },
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () =>
      logger?.warn?.("opened the store with immutable=1; results may omit notes still in the -wal"),
  });
  return new NoteStore(db, caps, opened);
};
