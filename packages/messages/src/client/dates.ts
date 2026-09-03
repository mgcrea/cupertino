/**
 * Messages' dates, which do not fit in a JavaScript number.
 *
 * `docs/messages.md` measured every populated date column as **nanoseconds since
 * 2001-01-01** — eighteen digits, about 7.9e17, two orders of magnitude past
 * `Number.MAX_SAFE_INTEGER`. `node:sqlite` throws on those rather than
 * truncating, which is correct of it and fatal to a naive `SELECT date`.
 *
 * The failure mode is what makes this worth its own module. Wrapped in the usual
 * try/catch the throw is swallowed and the column reports as EMPTY — the probe
 * did exactly that on its first granted run and announced "no dates present" for
 * all seven columns across 97,414 messages. A section written to catch a silent
 * 31-year error was itself silently wrong.
 *
 * ## The fix: divide in SQL, not in JavaScript
 *
 * `CAST(date AS REAL) / 1e9` never materialises the integer on the JS side, so
 * there is nothing to throw. Precision is fine: 7.9e8 seconds with a fractional
 * part is comfortably inside a double, and this surface has no use for
 * nanosecond resolution anyway.
 *
 * Every query in `store.ts` uses `APPLE_SECONDS_SQL`. Reading one of these
 * columns any other way is the bug.
 */

/** Seconds between 1970-01-01 and 2001-01-01. Same constant as `packages/core`. */
import { CORE_DATA_EPOCH_OFFSET } from "@mgcrea/mcp-apple-core";

/**
 * Below this, a value is seconds rather than nanoseconds.
 *
 * Messages switched around macOS 10.13 and old rows were not rewritten, so a
 * store with history from both eras carries both. 1e12 apple-seconds is the year
 * 33,658 and 1e12 apple-nanoseconds is 2001 — no real timestamp is near it in
 * either reading, which is what makes the split safe.
 */
const NANOSECOND_FLOOR = 1e12;

/**
 * SQL that yields apple-SECONDS as a REAL, whichever unit the row holds.
 *
 * Done in SQL rather than in JS because the point is to never let the raw
 * integer reach `node:sqlite`'s value conversion.
 */
export const appleSecondsSql = (column: string): string =>
  `CASE WHEN ${column} IS NULL THEN NULL` +
  ` WHEN ABS(CAST(${column} AS REAL)) > ${NANOSECOND_FLOOR} THEN CAST(${column} AS REAL) / 1000000000.0` +
  ` ELSE CAST(${column} AS REAL) END`;

/**
 * SQL that buckets an apple-date column into a LOCAL calendar day or month.
 *
 * Local, not UTC, and that is a deliberate divergence from Mail's equivalent in
 * `packages/mail/src/client/envelope.ts`. "How many messages on the 3rd" is a
 * question about the calendar the person was living in, and texting peaks late:
 * with a UTC bucket, every message a user in CEST sends after 02:00 lands in the
 * previous day. Mail's buckets are UTC and answering that is a separate call.
 *
 * `format` is a literal from this module's callers, never caller text.
 */
export const appleDateBucketSql = (column: string, format: "%Y-%m-%d" | "%Y-%m"): string =>
  `strftime('${format}', datetime(${appleSecondsSql(column)} + ${CORE_DATA_EPOCH_OFFSET}, ` +
  `'unixepoch', 'localtime'))`;

/** Apple-seconds to a JS Date. Null in, null out. */
export const fromAppleSeconds = (value: number | null): Date | null => {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  return new Date((value + CORE_DATA_EPOCH_OFFSET) * 1000);
};

/** A JS Date to apple-seconds, for range bounds. */
export const toAppleSeconds = (date: Date): number =>
  date.getTime() / 1000 - CORE_DATA_EPOCH_OFFSET;

/** ISO-8601, or null. What every date field on a result carries. */
export const renderInstant = (value: number | null): string | null =>
  fromAppleSeconds(value)?.toISOString() ?? null;

export { CORE_DATA_EPOCH_OFFSET };
