import type { DatabaseSync } from "node:sqlite";

import {
  columnsOf,
  CORE_DATA_EPOCH_OFFSET,
  escapeLike,
  fingerprintSchema,
  openReadOnly,
  SchemaDriftError,
  type Logger,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

/**
 * The index lane: Reminders' Core Data store, read-only.
 *
 * Every fact encoded here was measured by `scripts/probe-reminders.mjs` against
 * a real store on macOS 26.6 — see docs/reminders.md. The three that matter:
 *
 * 1. **The bridge is `ZREMCDREMINDER.ZCKIDENTIFIER`**, which holds the bare
 *    UUID from the Apple Events id `x-apple-reminder://<uuid>`. Found by
 *    scanning all 139 TEXT columns for a known id rather than by guessing a
 *    name — the guess would have been plausible and wrong, which is how the
 *    Notes body decoder passed at 51% accuracy.
 *
 * 2. **The live predicate is `ZMARKEDFORDELETION` falsy.** Verified by
 *    comparing ID SETS against Apple Events, not counts: all rows gave 338 with
 *    21 extra, the filtered set gave exactly 317 with 0 missing and 0 extra. A
 *    matching count is not a matching set.
 *
 * 3. **`ZALLDAY` is the authoritative all-day flag**, and it exists nowhere
 *    else. Apple Events populates both `due date` and `allday due date` for
 *    every dated reminder — 144 of 144 carried both — so presence discriminates
 *    nothing there. This column is the whole reason the index improves
 *    correctness and not merely speed.
 *
 * Writes never come here. The Apple Events lane is the authority for mutation,
 * as in Mail and Notes; this store is opened read-only and `PRAGMA query_only`
 * is set on top.
 */

/** Tables the lane cannot work without. Anything else degrades to a null field. */
const REQUIRED = ["ZREMCDREMINDER", "ZREMCDBASELIST"] as const;

export type StoreCapabilities = {
  fingerprint: string;
  /** Present columns, so an Apple rename degrades one field instead of the lane. */
  reminderColumns: Set<string>;
  listColumns: Set<string>;
  hasAttachments: boolean;
  hasObjects: boolean;
  epochOffset: number;
};

export type IndexReminder = {
  primaryKey: number;
  /** The bridge to an Apple Events id. Null rows cannot be joined to the app. */
  uuid: string | null;
  title: string | null;
  notes: string | null;
  completed: boolean;
  /** The one thing Apple Events genuinely cannot tell you. */
  allDay: boolean;
  due: string | null;
  completionDate: string | null;
  created: string | null;
  modified: string | null;
  priority: number | null;
  flagged: boolean;
  listPk: number | null;
  listName: string | null;
  parentPk: number | null;
  parentUuid: string | null;
};

export type IndexList = {
  primaryKey: number;
  uuid: string | null;
  name: string | null;
  isGroup: boolean;
  parentListPk: number | null;
  smartListType: string | null;
};

export type IndexAttachment = {
  primaryKey: number;
  uuid: string | null;
  reminderPk: number | null;
  filename: string | null;
  uti: string | null;
  sha512: string | null;
};

/** Enrichment the scripting dictionary has no class for at all. */
export type IndexEnrichment = {
  alarmCount: number;
  hasRecurrence: boolean;
  location: { latitude: number; longitude: number; proximity: number | null } | null;
};

export type ReminderQuery = {
  query?: string | undefined;
  scope?: "title" | "full" | undefined;
  listPk?: number | undefined;
  includeCompleted?: boolean | undefined;
  limit: number;
  offset?: number | undefined;
};

/** SQLite hands back unknown; only a real number is a value. */
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Core Data seconds -> ISO, or null. Guards the 31-year offset mistake. */
const toIso = (seconds: number | null, offset: number): string | null => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const d = new Date((seconds + offset) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export class ReminderStore {
  readonly db: DatabaseSync;
  readonly mode: string;
  readonly caps: StoreCapabilities;

  constructor(db: DatabaseSync, mode: string, caps: StoreCapabilities) {
    this.db = db;
    this.mode = mode;
    this.caps = caps;
  }

  /** Only select columns this store actually has, so a rename degrades one field. */
  #col(table: "reminder" | "list", name: string, as = name): string {
    const set = table === "reminder" ? this.caps.reminderColumns : this.caps.listColumns;
    return set.has(name) ? `r."${name}" AS ${as}` : `NULL AS ${as}`;
  }

  /**
   * The live-reminder predicate, verified by set comparison against Apple
   * Events. `ZMARKEDFORDELETION` is a tombstone Reminders leaves behind until
   * the CloudKit sync settles; without this filter the store reports 21 rows
   * the user deleted and cannot see.
   */
  #live(): string {
    return this.caps.reminderColumns.has("ZMARKEDFORDELETION")
      ? `(r."ZMARKEDFORDELETION" IS NULL OR r."ZMARKEDFORDELETION" = 0)`
      : "1 = 1";
  }

  #selectList(): string {
    return this.caps.listColumns.has("ZNAME") ? `l."ZNAME"` : "NULL";
  }

  #rowToReminder = (row: Record<string, unknown>): IndexReminder => {
    const o = this.caps.epochOffset;
    return {
      primaryKey: row.pk as number,
      uuid: row.uuid === null || row.uuid === undefined ? null : String(row.uuid).toUpperCase(),
      title: (row.title as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      completed: Boolean(row.completed),
      allDay: Boolean(row.allday),
      due: toIso(num(row.due), o),
      completionDate: toIso(num(row.completionDate), o),
      created: toIso(num(row.created), o),
      modified: toIso(num(row.modified), o),
      priority: num(row.priority),
      flagged: Boolean(row.flagged),
      listPk: num(row.listPk),
      listName: (row.listName as string | null) ?? null,
      parentPk: num(row.parentPk),
      parentUuid:
        row.parentUuid === null || row.parentUuid === undefined
          ? null
          : String(row.parentUuid).toUpperCase(),
    };
  };

  #baseSelect(): string {
    return `SELECT r."Z_PK" AS pk,
              ${this.#col("reminder", "ZCKIDENTIFIER", "uuid")},
              ${this.#col("reminder", "ZTITLE", "title")},
              ${this.#col("reminder", "ZNOTES", "notes")},
              ${this.#col("reminder", "ZCOMPLETED", "completed")},
              ${this.#col("reminder", "ZALLDAY", "allday")},
              ${this.#col("reminder", "ZDUEDATE", "due")},
              ${this.#col("reminder", "ZCOMPLETIONDATE", "completionDate")},
              ${this.#col("reminder", "ZCREATIONDATE", "created")},
              ${this.#col("reminder", "ZLASTMODIFIEDDATE", "modified")},
              ${this.#col("reminder", "ZPRIORITY", "priority")},
              ${this.#col("reminder", "ZFLAGGED", "flagged")},
              ${this.#col("reminder", "ZLIST", "listPk")},
              ${this.#col("reminder", "ZPARENTREMINDER", "parentPk")},
              ${this.#col("reminder", "ZCKPARENTREMINDERIDENTIFIER", "parentUuid")},
              ${this.#selectList()} AS listName
       FROM ZREMCDREMINDER r
       LEFT JOIN ZREMCDBASELIST l ON l."Z_PK" = r."ZLIST"`;
  }

  search(q: ReminderQuery): IndexReminder[] {
    const where: string[] = [this.#live()];
    const params: (string | number)[] = [];

    if (!q.includeCompleted && this.caps.reminderColumns.has("ZCOMPLETED")) {
      where.push(`(r."ZCOMPLETED" IS NULL OR r."ZCOMPLETED" = 0)`);
    }
    if (q.listPk !== undefined) {
      where.push(`r."ZLIST" = ?`);
      params.push(q.listPk);
    }
    if (q.query) {
      // ESCAPE is not optional: a reminder called "100% rye" would otherwise
      // make every query containing % match everything.
      const needle = `%${escapeLike(q.query)}%`;
      const full = (q.scope ?? "full") === "full" && this.caps.reminderColumns.has("ZNOTES");
      where.push(
        full
          ? `(r."ZTITLE" LIKE ? ESCAPE '\\' OR r."ZNOTES" LIKE ? ESCAPE '\\')`
          : `r."ZTITLE" LIKE ? ESCAPE '\\'`,
      );
      params.push(needle);
      if (full) params.push(needle);
    }

    // Undated reminders sort last: ZDUEDATE is NULL for them, and NULL sorts
    // first in SQLite, which would bury everything that actually has a deadline.
    const rows = this.db
      .prepare(
        `${this.#baseSelect()} WHERE ${where.join(" AND ")}
         ORDER BY (r."ZDUEDATE" IS NULL), r."ZDUEDATE" ASC, r."ZTITLE" ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset ?? 0) as Record<string, unknown>[];
    return rows.map(this.#rowToReminder);
  }

  byUuid(uuid: string): IndexReminder | null {
    if (!this.caps.reminderColumns.has("ZCKIDENTIFIER")) return null;
    // Stored case is not guaranteed to match the id Apple Events hands out.
    const row = this.db
      .prepare(
        `${this.#baseSelect()} WHERE ${this.#live()} AND UPPER(r."ZCKIDENTIFIER") = ? LIMIT 1`,
      )
      .get(uuid.toUpperCase()) as Record<string, unknown> | undefined;
    return row ? this.#rowToReminder(row) : null;
  }

  /**
   * Subtasks, which Apple Events cannot reach at all — `container()` throws on
   * every reminder, so this column is the only way to know a reminder has a
   * parent.
   */
  subtasksOf(parentPk: number): IndexReminder[] {
    if (!this.caps.reminderColumns.has("ZPARENTREMINDER")) return [];
    const rows = this.db
      .prepare(
        // Same tiebreaker as search(): subtasks are usually all undated, so
        // without the title they come back in whatever order the table gives.
        `${this.#baseSelect()} WHERE ${this.#live()} AND r."ZPARENTREMINDER" = ?
         ORDER BY (r."ZDUEDATE" IS NULL), r."ZDUEDATE" ASC, r."ZTITLE" ASC`,
      )
      .all(parentPk) as Record<string, unknown>[];
    return rows.map(this.#rowToReminder);
  }

  lists(): IndexList[] {
    const c = this.caps.listColumns;
    const pick = (n: string, as: string) => (c.has(n) ? `"${n}" AS ${as}` : `NULL AS ${as}`);
    const live = c.has("ZMARKEDFORDELETION")
      ? `WHERE ("ZMARKEDFORDELETION" IS NULL OR "ZMARKEDFORDELETION" = 0)`
      : "";
    const rows = this.db
      .prepare(
        `SELECT "Z_PK" AS pk, ${pick("ZCKIDENTIFIER", "uuid")}, ${pick("ZNAME", "name")},
                ${pick("ZISGROUP", "isGroup")}, ${pick("ZPARENTLIST", "parentListPk")},
                ${pick("ZSMARTLISTTYPE", "smartListType")}
         FROM ZREMCDBASELIST ${live} ORDER BY "ZNAME"`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      primaryKey: r.pk as number,
      uuid: r.uuid === null || r.uuid === undefined ? null : String(r.uuid).toUpperCase(),
      name: (r.name as string | null) ?? null,
      isGroup: Boolean(r.isGroup),
      parentListPk: typeof r.parentListPk === "number" ? r.parentListPk : null,
      smartListType: (r.smartListType as string | null) ?? null,
    }));
  }

  attachmentsOf(reminderPk: number): IndexAttachment[] {
    if (!this.caps.hasAttachments) return [];
    const rows = this.db
      .prepare(
        `SELECT "Z_PK" AS pk, "ZCKIDENTIFIER" AS uuid, "ZREMINDER" AS reminderPk,
                "ZFILENAME" AS filename, "ZUTI" AS uti, "ZSHA512SUM" AS sha512
         FROM ZREMCDSAVEDATTACHMENT
         WHERE "ZREMINDER" = ? AND ("ZMARKEDFORDELETION" IS NULL OR "ZMARKEDFORDELETION" = 0)`,
      )
      .all(reminderPk) as Record<string, unknown>[];
    return rows.map((r) => ({
      primaryKey: r.pk as number,
      uuid: r.uuid === null || r.uuid === undefined ? null : String(r.uuid).toUpperCase(),
      reminderPk: typeof r.reminderPk === "number" ? r.reminderPk : null,
      filename: (r.filename as string | null) ?? null,
      uti: (r.uti as string | null) ?? null,
      sha512: (r.sha512 as string | null) ?? null,
    }));
  }

  /**
   * Alarms, recurrence and location for one reminder.
   *
   * `ZREMCDOBJECT` is polymorphic — alarm rows and recurrence rows share it and
   * are told apart by which columns are populated, not by a type column we can
   * rely on. So this reports presence and counts rather than pretending to
   * reconstruct an RFC 5545 rule from columns nobody has documented.
   */
  enrichmentOf(reminderPk: number): IndexEnrichment {
    const empty: IndexEnrichment = { alarmCount: 0, hasRecurrence: false, location: null };
    if (!this.caps.hasObjects) return empty;
    const rows = this.db
      .prepare(
        `SELECT "ZFREQUENCY" AS frequency, "ZLATITUDE" AS latitude, "ZLONGITUDE" AS longitude,
                "ZPROXIMITY" AS proximity, "ZALARMUID" AS alarmUid
         FROM ZREMCDOBJECT WHERE "ZREMINDER" = ?`,
      )
      .all(reminderPk) as Record<string, unknown>[];
    if (!rows.length) return empty;

    let alarmCount = 0;
    let hasRecurrence = false;
    let location: IndexEnrichment["location"] = null;
    for (const r of rows) {
      if (r.alarmUid !== null && r.alarmUid !== undefined) alarmCount += 1;
      if (typeof r.frequency === "number") hasRecurrence = true;
      if (typeof r.latitude === "number" && typeof r.longitude === "number" && !location) {
        location = {
          latitude: r.latitude,
          longitude: r.longitude,
          proximity: typeof r.proximity === "number" ? r.proximity : null,
        };
      }
    }
    return { alarmCount, hasRecurrence, location };
  }
}

/** Read the store's shape once, so every query can degrade per column. */
export const introspect = (db: DatabaseSync): StoreCapabilities => {
  const reminderColumns = new Set(columnsOf(db, "ZREMCDREMINDER"));
  const listColumns = new Set(columnsOf(db, "ZREMCDBASELIST"));
  for (const t of REQUIRED) {
    const cols = t === "ZREMCDREMINDER" ? reminderColumns : listColumns;
    if (cols.size === 0) {
      throw new SchemaDriftError(
        `This Reminders store has no ${t} table. It was probed on macOS 26.6 with schema ` +
          `fingerprint 278b001e3c55; re-run \`pnpm probe:reminders\` to see what changed.`,
      );
    }
  }
  return {
    fingerprint: fingerprintSchema(db),
    reminderColumns,
    listColumns,
    hasAttachments: columnsOf(db, "ZREMCDSAVEDATTACHMENT").length > 0,
    hasObjects: columnsOf(db, "ZREMCDOBJECT").length > 0,
    // Measured at 978307200 on this store, but detected rather than assumed:
    // being 31 years out is the classic Core Data date bug.
    epochOffset: CORE_DATA_EPOCH_OFFSET,
  };
};

export const openStore = (
  path: string | null,
  mode: ReadOnlyMode,
  logger?: Logger,
): ReminderStore | null => {
  if (!path) return null;
  const {
    db,
    mode: used,
    validated,
  } = openReadOnly<StoreCapabilities>(path, mode, {
    label: "Reminders store",
    envVar: "APPLE_REMINDERS_INDEX_MODE",
    validate: introspect,
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () =>
      logger?.debug?.(
        "opened the Reminders store with immutable=1, which skips the write-ahead log — " +
          "very recent changes may be missing until Reminders checkpoints.",
      ),
  });
  return new ReminderStore(db, used, validated);
};
