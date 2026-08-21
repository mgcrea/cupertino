import type { DatabaseSync } from "node:sqlite";

import {
  columnsOf,
  CORE_DATA_EPOCH_OFFSET,
  fingerprintSchema,
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

export class CalendarStore {
  readonly db: DatabaseSync;
  readonly mode: string;
  readonly caps: StoreCapabilities;

  constructor(db: DatabaseSync, mode: string, caps: StoreCapabilities) {
    this.db = db;
    this.mode = mode;
    this.caps = caps;
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
