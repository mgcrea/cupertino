import type { DatabaseSync } from "node:sqlite";

import {
  columnsOf,
  CORE_DATA_EPOCH_OFFSET,
  fingerprintSchema,
  escapeLike,
  openReadOnly,
  SchemaDriftError,
  type Logger,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

/**
 * Calendar's file lane.
 *
 * ## Why there is a file lane at all
 *
 * Unlike Notes and Reminders, this one is justified on SPEED rather than
 * capability. `docs/calendar.md` measured a ±90-day range query over Apple
 * Events at 3.4 s across 1,349 events, with the cost falling per round trip
 * rather than per event (~1.8-2.2 s per property, flat), so no amount of
 * batching rescues it. Calendar's scripting dictionary is unusually complete —
 * attendees, alarms and recurrence are all in it — so the usual "the store buys
 * you the rich stuff" argument is much weaker here than elsewhere. The store is
 * how a range query returns before the caller gives up.
 *
 * ## What is measured, and what is not
 *
 * Measured (`docs/calendar.md`): the store is
 * `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`, it is
 * plain Core Data with no `Z_PRIMARYKEY`, the main table is `CalendarItem`, and
 * the id bridge to Apple Events is exact — `CalendarItem.UUID` against the `uid`
 * Calendar hands back, 198/198 sampled.
 *
 * NOT yet measured, and the reason this file introspects but does not query:
 * `OccurrenceCache` (1,946 rows) and `OccurrenceCacheDays` (2,630) both out-row
 * `CalendarItem` (1,350), which means expanded recurrences live outside the main
 * table and a naive `SELECT ... FROM CalendarItem` returns a weekly standup
 * once. `scripts/probe-calendar.mjs` was extended to settle that with a set diff
 * against Apple Events; until it has run on a machine with Full Disk Access,
 * shipping a range query would be guessing at the one thing that fails silently.
 * A short list is indistinguishable from a free afternoon.
 */

/** Tables the lane cannot work without. Anything else degrades to a null field. */
const REQUIRED = ["CalendarItem", "Calendar"] as const;

/**
 * The schema this was written against. Named in the drift error, not enforced.
 *
 * CAUTION: this is the PROBE's fingerprint and it is NOT comparable to the one
 * `diagnostics` reports. `fingerprintSchema` in packages/core orders
 * sqlite_master by `type, name`; `dumpSchema` in scripts/lib/probe-kit.mjs
 * orders it by a CASE expression putting tables before indexes, so the same
 * schema hashes to two different values. Measured here: this store reports
 * cd2424fea732 at runtime against the 2bf4e34ff75f docs/calendar.md recorded
 * from the probe, and Reminders shows the same split (510062aad004 at runtime
 * against the 278b001e3c55 in its own drift message and in docs/verify.md).
 *
 * So compare a probe fingerprint with a probe fingerprint. Reconciling the two
 * orderings is a one-line change in packages/core, but it moves the value for
 * every surface at once and is therefore its own decision.
 */
const PROBED_FINGERPRINT = "2bf4e34ff75f";
const PROBED_MACOS = "26.6";

export type StoreCapabilities = {
  fingerprint: string;
  /** Present columns, so an Apple rename degrades one field instead of the lane. */
  itemColumns: Set<string>;
  calendarColumns: Set<string>;
  occurrenceColumns: Set<string>;
  recurrenceColumns: Set<string>;
  storeColumns: Set<string>;
  /**
   * Whether recurrences can be expanded at all.
   *
   * False is a capability downgrade, never a throw: leg 1 of a range query
   * (items carrying no recurrence rule) stays correct at any horizon, so the
   * honest degradation is to answer with it and say that repeating events were
   * not expanded — not to fail, and above all not to quietly return fewer rows.
   */
  hasOccurrenceCache: boolean;
  hasOccurrenceDays: boolean;
  hasRecurrence: boolean;
  hasExceptionDates: boolean;
  hasLocation: boolean;
  hasAttachments: boolean;
  hasParticipants: boolean;
  hasAlarms: boolean;
  epochOffset: number;
};

/** One row of the union, still in store units. Rendering happens above this. */
export type EventRow = {
  itemPk: number;
  uuid: string | null;
  calendarPk: number | null;
  calendarUuid: string | null;
  calendarTitle: string | null;
  summary: string | null;
  description: string | null;
  url: string | null;
  conferenceUrl: string | null;
  locationTitle: string | null;
  startApple: number | null;
  endApple: number | null;
  allDay: boolean;
  startTz: string | null;
  endTz: string | null;
  status: number | null;
  invitationStatus: number | null;
  availability: number | null;
  hasRecurrences: boolean;
  hasAttendees: boolean;
  /** Set on a detached occurrence: which series it broke away from, and when. */
  origItemPk: number | null;
  origDateApple: number | null;
  /** Which leg produced this row. Reported so a caller can see the expansion working. */
  source: "item" | "occurrence";
};

export type RangeQuery = {
  /** Apple-seconds, inclusive lower bound. */
  fromApple: number;
  /** Apple-seconds, exclusive upper bound. */
  toApple: number;
  /** `Calendar.UUID` values. Empty means every calendar. */
  calendarUuids?: readonly string[];
  limit: number;
};

export type SearchQuery = RangeQuery & {
  text: string;
  scope: "summary" | "full";
};

/** How far the cached expansion actually reaches, in Apple-seconds. */
export type Coverage = { fromApple: number; toApple: number; rows: number } | null;

export type IndexCalendar = {
  uuid: string | null;
  title: string | null;
  color: string | null;
  type: string | null;
  accountName: string | null;
  isSubscribed: boolean;
  isPublished: boolean;
  sharingStatus: number | null;
};

export type IndexAccount = { name: string | null; type: number | null; calendars: number };

const bool = (v: unknown): boolean => v === 1 || v === true;
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class CalendarStore {
  readonly db: DatabaseSync;
  readonly mode: string;
  readonly caps: StoreCapabilities;

  constructor(db: DatabaseSync, mode: string, caps: StoreCapabilities) {
    this.db = db;
    this.mode = mode;
    this.caps = caps;
  }

  /**
   * Project a column, or a typed NULL when this store does not have it.
   *
   * The same guard `packages/reminders/src/client/store.ts` uses, and for the
   * same reason: the schema is reverse-engineered and unversioned, so an Apple
   * rename should cost one field rather than the whole lane.
   */
  #col(present: Set<string>, table: string, name: string, alias = name): string {
    return present.has(name) ? `${table}."${name}" AS ${alias}` : `NULL AS ${alias}`;
  }

  #itemColumns(): string {
    const c = this.caps.itemColumns;
    return [
      `ci."ROWID" AS itemPk`,
      this.#col(c, "ci", "UUID", "uuid"),
      this.#col(c, "ci", "summary", "summary"),
      this.#col(c, "ci", "description", "description"),
      this.#col(c, "ci", "url", "url"),
      this.#col(c, "ci", "conference_url", "conferenceUrl"),
      this.#col(c, "ci", "all_day", "allDay"),
      this.#col(c, "ci", "start_tz", "startTz"),
      this.#col(c, "ci", "end_tz", "endTz"),
      this.#col(c, "ci", "status", "status"),
      this.#col(c, "ci", "invitation_status", "invitationStatus"),
      this.#col(c, "ci", "availability", "availability"),
      this.#col(c, "ci", "has_recurrences", "hasRecurrences"),
      this.#col(c, "ci", "has_attendees", "hasAttendees"),
      this.#col(c, "ci", "orig_item_id", "origItemPk"),
      this.#col(c, "ci", "orig_date", "origDateApple"),
      this.#col(c, "ci", "calendar_id", "calendarPk"),
      `cal."UUID" AS calendarUuid`,
      `cal."title" AS calendarTitle`,
      this.caps.hasLocation ? `loc."title" AS locationTitle` : `NULL AS locationTitle`,
    ].join(",\n         ");
  }

  #joins(): string {
    const location =
      this.caps.hasLocation && this.caps.itemColumns.has("location_id")
        ? `\n    LEFT JOIN "Location" loc ON loc."ROWID" = ci."location_id"`
        : "";
    return `JOIN "Calendar" cal ON cal."ROWID" = ci."calendar_id"${location}`;
  }

  /**
   * Rows this lane must never return, whichever leg found them.
   *
   * `entity_type` is 2 for events. The probed store holds nothing else — 0 rows
   * carry a due date or a completion date — but `CalendarItem` shares its schema
   * with Reminders, so the predicate is cheap insurance rather than dead code.
   *
   * `hidden` and `phantom_master` are INFERRED rather than measured. A phantom
   * master is the placeholder row EventKit keeps for a series whose occurrences
   * have all been detached; showing it would put an event on the calendar that
   * Calendar.app does not draw. Both are excluded conservatively, and both are
   * on the list for the next probe run to confirm.
   */
  #excluded(alias = "ci"): string {
    const c = this.caps.itemColumns;
    const out: string[] = [];
    if (c.has("entity_type")) out.push(`${alias}."entity_type" = 2`);
    if (c.has("hidden")) out.push(`(${alias}."hidden" IS NULL OR ${alias}."hidden" = 0)`);
    if (c.has("phantom_master")) {
      out.push(`(${alias}."phantom_master" IS NULL OR ${alias}."phantom_master" = 0)`);
    }
    return out.length ? `AND ${out.join("\n            AND ")}` : "";
  }

  #calendarFilter(uuids: readonly string[] | undefined): { sql: string; params: string[] } {
    if (!uuids?.length) return { sql: "", params: [] };
    const marks = uuids.map(() => "?").join(", ");
    return { sql: `AND cal."UUID" IN (${marks})`, params: [...uuids] };
  }

  #rowsFrom(sql: string, params: unknown[], source: EventRow["source"]): EventRow[] {
    const raw = this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return raw.map((r) => ({
      itemPk: Number(r.itemPk),
      uuid: text(r.uuid),
      calendarPk: num(r.calendarPk),
      calendarUuid: text(r.calendarUuid),
      calendarTitle: text(r.calendarTitle),
      summary: text(r.summary),
      description: text(r.description),
      url: text(r.url),
      conferenceUrl: text(r.conferenceUrl),
      locationTitle: text(r.locationTitle),
      startApple: num(r.startApple),
      endApple: num(r.endApple),
      allDay: bool(r.allDay),
      startTz: text(r.startTz),
      endTz: text(r.endTz),
      status: num(r.status),
      invitationStatus: num(r.invitationStatus),
      availability: num(r.availability),
      hasRecurrences: bool(r.hasRecurrences),
      hasAttendees: bool(r.hasAttendees),
      origItemPk: num(r.origItemPk),
      origDateApple: num(r.origDateApple),
      source,
    }));
  }

  /**
   * LEG 1 — items carried by the table itself.
   *
   * Overlap, not containment: `start < to AND COALESCE(end, start) > from`. A
   * naive `BETWEEN` on the start silently drops the all-hands that began at
   * 09:00 when the caller asked about 10:00 onward.
   *
   * Items whose occurrences are expanded in the cache are excluded here and
   * picked up by leg 2, so a repeating event is not also returned once at its
   * master start.
   */
  rangeItems(q: RangeQuery): EventRow[] {
    const c = this.caps.itemColumns;
    if (!c.has("start_date")) return [];
    const cal = this.#calendarFilter(q.calendarUuids);
    const endExpr = c.has("end_date")
      ? `COALESCE(ci."end_date", ci."start_date")`
      : `ci."start_date"`;
    // `has_recurrences` is the table's own flag. When it is missing, fall back
    // to asking the Recurrence table directly rather than dropping the guard —
    // without one, every repeating event doubles.
    const notExpanded = c.has("has_recurrences")
      ? `AND (ci."has_recurrences" IS NULL OR ci."has_recurrences" = 0)`
      : this.caps.hasRecurrence
        ? `AND NOT EXISTS (SELECT 1 FROM "Recurrence" r WHERE r."owner_id" = ci."ROWID")`
        : "";
    const sql = `
      SELECT ci."start_date" AS startApple,
             ${c.has("end_date") ? `ci."end_date"` : `NULL`} AS endApple,
             ${this.#itemColumns()}
        FROM "CalendarItem" ci
        ${this.#joins()}
       WHERE ci."start_date" < ?
         AND ${endExpr} > ?
         ${notExpanded}
         ${this.#excluded()}
         ${cal.sql}
       ORDER BY ci."start_date" ASC
       LIMIT ?`;
    return this.#rowsFrom(sql, [q.toApple, q.fromApple, ...cal.params, q.limit], "item");
  }

  /**
   * LEG 2 — expanded occurrences.
   *
   * `OccurrenceCache.event_id` -> `CalendarItem.ROWID` was measured at a 100%
   * resolve rate. `occurrence_date` is the start; `occurrence_start_date` exists
   * too and reaches only +256 days against `occurrence_date`'s +724, so using it
   * would silently truncate the far half of the window.
   */
  rangeOccurrences(q: RangeQuery): EventRow[] {
    if (!this.caps.hasOccurrenceCache) return [];
    const o = this.caps.occurrenceColumns;
    if (!o.has("occurrence_date") || !o.has("event_id")) return [];
    const cal = this.#calendarFilter(q.calendarUuids);
    const endExpr = o.has("occurrence_end_date")
      ? `COALESCE(oc."occurrence_end_date", oc."occurrence_date")`
      : `oc."occurrence_date"`;
    const sql = `
      SELECT oc."occurrence_date" AS startApple,
             ${o.has("occurrence_end_date") ? `oc."occurrence_end_date"` : `NULL`} AS endApple,
             ${this.#itemColumns()}
        FROM "OccurrenceCache" oc
        JOIN "CalendarItem" ci ON ci."ROWID" = oc."event_id"
        ${this.#joins()}
       WHERE oc."occurrence_date" < ?
         AND ${endExpr} > ?
         ${this.#excluded()}
         ${cal.sql}
       ORDER BY oc."occurrence_date" ASC
       LIMIT ?`;
    return this.#rowsFrom(sql, [q.toApple, q.fromApple, ...cal.params, q.limit], "occurrence");
  }

  /**
   * Text search, unbounded in time by default.
   *
   * Searching is the one place a caller legitimately wants all of history, so
   * the window is the caller's to set rather than a default. Runs over items
   * only: an occurrence carries no text of its own, and matching the series once
   * is what a search result should be.
   */
  searchItems(q: SearchQuery): EventRow[] {
    const c = this.caps.itemColumns;
    const cal = this.#calendarFilter(q.calendarUuids);
    const needle = `%${escapeLike(q.text)}%`;
    const fields = ["summary"];
    if (q.scope === "full") {
      if (c.has("description")) fields.push("description");
      if (this.caps.hasLocation) fields.push("__location");
    }
    const match = fields
      .map((f) =>
        f === "__location" ? `loc."title" LIKE ? ESCAPE '\\'` : `ci."${f}" LIKE ? ESCAPE '\\'`,
      )
      .join(" OR ");
    const sql = `
      SELECT ci."start_date" AS startApple,
             ${c.has("end_date") ? `ci."end_date"` : `NULL`} AS endApple,
             ${this.#itemColumns()}
        FROM "CalendarItem" ci
        ${this.#joins()}
       WHERE (${match})
         AND ci."start_date" < ?
         AND COALESCE(ci."end_date", ci."start_date") > ?
         ${this.#excluded()}
         ${cal.sql}
       ORDER BY ci."start_date" DESC
       LIMIT ?`;
    const params = [...fields.map(() => needle), q.toApple, q.fromApple, ...cal.params, q.limit];
    return this.#rowsFrom(sql, params, "item");
  }

  /** One event by its Apple Events uid. The bridge measured 198/198 exact. */
  byUuid(uuid: string): EventRow | null {
    const c = this.caps.itemColumns;
    if (!c.has("UUID")) return null;
    const sql = `
      SELECT ci."start_date" AS startApple,
             ${c.has("end_date") ? `ci."end_date"` : `NULL`} AS endApple,
             ${this.#itemColumns()}
        FROM "CalendarItem" ci
        ${this.#joins()}
       WHERE UPPER(ci."UUID") = ?
         ${this.#excluded()}
       LIMIT 1`;
    return this.#rowsFrom(sql, [uuid.toUpperCase()], "item")[0] ?? null;
  }

  /**
   * How far the expansion reaches.
   *
   * Published with every range result. Measured at -732 to +724 days on the
   * probed store, which is a real expansion rather than a month-view cache —
   * but it is still an edge, and nothing guarantees the next machine's is as
   * deep. A range running past it must say so rather than return a short list.
   */
  coverage(): Coverage {
    if (!this.caps.hasOccurrenceCache || !this.caps.occurrenceColumns.has("occurrence_date")) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT MIN("occurrence_date") AS lo, MAX("occurrence_date") AS hi, COUNT(*) AS n
           FROM "OccurrenceCache" WHERE "occurrence_date" IS NOT NULL`,
      )
      .get() as { lo: unknown; hi: unknown; n: unknown } | undefined;
    const lo = num(row?.lo);
    const hi = num(row?.hi);
    if (lo === null || hi === null) return null;
    return { fromApple: lo, toApple: hi, rows: Number(row?.n ?? 0) };
  }

  calendars(): IndexCalendar[] {
    const c = this.caps.calendarColumns;
    const store = this.caps.storeColumns.size > 0;
    const sql = `
      SELECT ${this.#col(c, "cal", "UUID", "uuid")},
             ${this.#col(c, "cal", "title", "title")},
             ${this.#col(c, "cal", "color", "color")},
             ${this.#col(c, "cal", "type", "type")},
             ${this.#col(c, "cal", "sharing_status", "sharingStatus")},
             ${this.#col(c, "cal", "is_published", "isPublished")},
             ${this.#col(c, "cal", "subcal_url", "subcalUrl")},
             ${store ? `st."name"` : `NULL`} AS accountName
        FROM "Calendar" cal
        ${store ? `LEFT JOIN "Store" st ON st."ROWID" = cal."store_id"` : ""}
       ORDER BY ${c.has("display_order") ? `cal."display_order" ASC,` : ""} cal."title" ASC`;
    const rows = this.db.prepare(sql).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      uuid: text(r.uuid),
      title: text(r.title),
      color: text(r.color),
      type: text(r.type),
      accountName: text(r.accountName),
      // A subscribed calendar is read-only, which is what a write tool needs to
      // know. Derived from the presence of a subscription URL rather than from a
      // flags bit whose meaning has not been measured.
      isSubscribed: Boolean(text(r.subcalUrl)),
      isPublished: bool(r.isPublished),
      sharingStatus: num(r.sharingStatus),
    }));
  }

  accounts(): IndexAccount[] {
    if (!this.caps.storeColumns.size) return [];
    const rows = this.db
      .prepare(
        `SELECT st."name" AS name, st."type" AS type, COUNT(cal."ROWID") AS calendars
           FROM "Store" st
           LEFT JOIN "Calendar" cal ON cal."store_id" = st."ROWID"
          GROUP BY st."ROWID"
          ORDER BY st."name" ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      name: text(r.name),
      type: num(r.type),
      calendars: Number(r.calendars ?? 0),
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing a database that already failed is not worth reporting.
    }
  }
}

export const introspect = (db: DatabaseSync): StoreCapabilities => {
  const itemColumns = new Set(columnsOf(db, "CalendarItem"));
  const calendarColumns = new Set(columnsOf(db, "Calendar"));

  for (const t of REQUIRED) {
    const cols = t === "CalendarItem" ? itemColumns : calendarColumns;
    if (cols.size === 0) {
      throw new SchemaDriftError(
        `This Calendar store has no ${t} table. It was probed on macOS ${PROBED_MACOS} with ` +
          `schema fingerprint ${PROBED_FINGERPRINT} (a PROBE fingerprint — compare it against ` +
          `another probe run, not against the one diagnostics reports); re-run ` +
          `\`pnpm probe:calendar\` to see what changed.`,
      );
    }
  }

  const occurrenceColumns = new Set(columnsOf(db, "OccurrenceCache"));

  return {
    fingerprint: fingerprintSchema(db),
    itemColumns,
    calendarColumns,
    occurrenceColumns,
    recurrenceColumns: new Set(columnsOf(db, "Recurrence")),
    storeColumns: new Set(columnsOf(db, "Store")),
    hasOccurrenceCache: occurrenceColumns.size > 0,
    hasOccurrenceDays: columnsOf(db, "OccurrenceCacheDays").length > 0,
    hasRecurrence: columnsOf(db, "Recurrence").length > 0,
    hasExceptionDates: columnsOf(db, "ExceptionDate").length > 0,
    hasLocation: columnsOf(db, "Location").length > 0,
    hasAttachments: columnsOf(db, "Attachment").length > 0,
    hasParticipants: columnsOf(db, "Participant").length > 0,
    hasAlarms: columnsOf(db, "Alarm").length > 0,
    // Measured as apple-seconds on this store, but taken from core rather than
    // written out again: being 31 years out is the classic Core Data date bug.
    epochOffset: CORE_DATA_EPOCH_OFFSET,
  };
};

export const openStore = (
  path: string | null,
  mode: ReadOnlyMode,
  logger?: Logger,
): CalendarStore | null => {
  if (!path) return null;
  const {
    db,
    mode: used,
    validated,
  } = openReadOnly<StoreCapabilities>(path, mode, {
    label: "Calendar store",
    envVar: "APPLE_CALENDAR_INDEX_MODE",
    validate: introspect,
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () =>
      logger?.debug?.(
        "opened the Calendar store with immutable=1, which skips the write-ahead log — " +
          "very recent changes may be missing until Calendar checkpoints.",
      ),
  });
  return new CalendarStore(db, used, validated);
};
