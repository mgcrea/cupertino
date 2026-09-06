/**
 * Date handling for the Calendar tools.
 *
 * ## Two halves
 *
 * INPUT is the grammar `packages/reminders/src/client/dates.ts` established, and
 * it is deliberately identical: a caller writing `2026-08-20` names a day, one
 * writing `2026-08-20T09:00` names an instant, `+2d` names a duration, and day
 * and week offsets are calendar arithmetic while hour and minute offsets are
 * elapsed time. That split is not cosmetic — getting it backwards drifts every
 * date by an hour twice a year.
 *
 * OUTPUT is Calendar's own problem and has no analogue in Reminders. An event
 * carries a start AND an end, a timezone of its own, and an all-day flag that
 * changes what the stored number even means. Rendering that wrongly is the
 * quietest bug on this surface, so `EventInstant` makes the caller's two cases
 * two different shapes rather than one shape with a boolean to remember.
 *
 * ## The timezone rules, measured rather than assumed
 *
 * `docs/calendar.md` records 8 distinct `start_tz` values across 1,350 rows,
 * with no nulls, of which two are not IANA names and mean OPPOSITE things:
 *
 *   `_float`     a floating date — an instant deliberately without a zone
 *   `GMT+0200`   a perfectly definite fixed offset that is merely not IANA
 *
 * Collapsing the second into the first silently discards two hours, so they are
 * classified apart here. Anything matching `GMT±HHMM` is honoured as an offset;
 * only what is left over floats.
 */

import { InvalidDateError } from "./errors.js";

/**
 * The input grammar comes from core, which is where the three copies of it were
 * merged. This surface's own half is everything BELOW: rendering an instant in
 * a calendar's zone, which is specific to a store that keeps floating dates.
 *
 * One behaviour changed with the hoist, and the store SQL was already right for
 * it: a bare day used as an upper bound resolves to the next day's midnight
 * rather than to 23:59:59.999, and `store.ts` has always compared `start_date <
 * ?`. `parseRange`'s default `to` follows suit below.
 */
export {
  addLocalDays,
  parseBound,
  parseDate,
  startOfLocalDay,
  toLocalIso,
  type DateKind,
  type ParsedDate,
} from "@mgcrea/mcp-apple-core";

import { addLocalDays, parseBound, startOfLocalDay, toLocalIso } from "@mgcrea/mcp-apple-core";

/** `90`, `"90"`, `"90m"`, `"2h"` — the duration half, which core has no view on. */
const DURATION = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/;

/** `GMT+02:00` and friends, which Calendar stores alongside real IANA names. */
const FIXED_OFFSET = /^(?:GMT|UTC)([+-])(\d{2}):?(\d{2})$/i;

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

export type EventInstant =
  | { allDay: true; day: string; timeZone: null }
  | { allDay: false; iso: string; timeZone: string | null };

export type Range = { from: Date; to: Date; clamped: boolean };

/**
 * Resolve a query window.
 *
 * Unlike a note list, a calendar has no natural "everything": it stretches
 * indefinitely in both directions and `MAX(start_date)` on the probed store
 * already reads 2030. So an unbounded default would scan a decade to report
 * next Tuesday, and every window is bounded on both ends.
 */
export const parseRange = (
  opts: {
    from?: string | undefined;
    to?: string | undefined;
    defaultRangeDays: number;
    maxRangeDays: number;
  },
  now: Date = new Date(),
): Range => {
  const from = opts.from ? parseBound("from", opts.from, "start", now) : startOfLocalDay(now);
  // The exclusive next-day midnight, matching what an explicit `to` resolves to.
  // `defaultRangeDays` days starting at `from` ends at the start of the day
  // after the last one, and store.ts compares `start_date < ?`.
  const to = opts.to
    ? parseBound("to", opts.to, "end", now)
    : startOfLocalDay(addLocalDays(from, opts.defaultRangeDays));

  if (to.getTime() < from.getTime()) {
    throw new InvalidDateError(
      "to",
      String(opts.to ?? ""),
      `it resolves to ${toLocalIso(to)}, which is before from (${toLocalIso(from)})`,
    );
  }

  const maxMs = opts.maxRangeDays * 86_400_000;
  if (to.getTime() - from.getTime() > maxMs) {
    return { from, to: new Date(from.getTime() + maxMs), clamped: true };
  }
  return { from, to, clamped: false };
};

/** `90`, `"90"`, `"90m"`, `"2h"` -> minutes. */
export const parseDuration = (field: string, raw: string | number): number => {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) throw new InvalidDateError(field, String(raw), "it is empty");
  const m = DURATION.exec(text);
  if (!m)
    throw new InvalidDateError(field, text, 'expected minutes, or a value like "90m" or "2h"');
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidDateError(field, text, "the amount must be a positive number");
  }
  return m[2]?.startsWith("h") ? n * 60 : n;
};

// ─── output ──────────────────────────────────────────────────────────────────

/** Whether a stored `start_tz` names a zone this process can actually resolve. */
export const isIanaZone = (tz: string): boolean => {
  try {
    // Called, not `new`ed — it returns an instance either way, and the throw on
    // an unknown zone is the whole test.
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * A stored timezone string, classified.
 *
 * `null` means floating, and floating is a real state rather than missing data:
 * the event names a wall-clock time that is correct wherever you open it.
 */
export const resolveZone = (tz: string | null | undefined): string | null => {
  if (!tz) return null;
  const text = String(tz).trim();
  if (!text || text === "_float") return null;
  if (isIanaZone(text)) return text;
  const fixed = FIXED_OFFSET.exec(text);
  // Re-expressed as an Etc/GMT name so Intl can use it. Etc/GMT signs are
  // INVERTED by the POSIX convention — Etc/GMT-2 is two hours AHEAD of UTC —
  // which is a trap worth naming rather than a detail.
  if (fixed) {
    const [, sign, hh, mm] = fixed;
    if (mm === "00") {
      const flipped = sign === "+" ? "-" : "+";
      const name = `Etc/GMT${flipped}${Number(hh)}`;
      if (isIanaZone(name)) return name;
    }
  }
  return null;
};

const partsIn = (d: Date, tz: string): Record<string, string> => {
  const fmt = Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
};

/**
 * Render a stored instant as an event start or end.
 *
 * ## Why all-day is derived in the event's own zone, falling back to local
 *
 * An all-day event names a DAY, and the day you get depends entirely on which
 * frame you read the stored instant in. MEASURED against a live store:
 *
 *   stored          2026-08-20T22:00:00Z
 *   UTC getters     2026-08-20    <- a day early
 *   local getters   2026-08-21    <- what Calendar.app shows
 *
 * Calendar anchors an all-day event at midnight in the event's own zone, which
 * for a floating date is the local one. So the day comes from local components,
 * or from `start_tz` when that names a real zone.
 *
 * THIS WAS ORIGINALLY WRITTEN THE OTHER WAY ROUND, and the mistake is worth
 * keeping on the record. `docs/reminders.md` documents that REMINDERS' store
 * holds UTC midnight while its Apple Events lane holds local midnight; that was
 * generalised to Calendar without measuring, and the unit tests agreed because
 * their fixtures were built on the same wrong assumption. It survived a
 * four-timezone test matrix and was caught only by reading a real calendar,
 * where the rendered day disagreed with the ref in the same result.
 *
 * The anchor is a property of the store, not a general rule. Measure it per
 * surface. `dates.test.ts` now builds its fixtures at LOCAL midnight, which is
 * what the data actually looks like.
 *
 * @param appleSeconds Core Data seconds, straight from the column.
 * @param tz           The row's `start_tz` / `end_tz`, unclassified.
 * @param allDay       The row's all-day flag. Authoritative; never inferred.
 * @param epochOffset  From `StoreCapabilities`, so the 31-year bug has one home.
 */
export const renderInstant = (
  appleSeconds: number | null,
  tz: string | null | undefined,
  allDay: boolean,
  epochOffset: number,
): EventInstant | null => {
  if (appleSeconds === null || appleSeconds === undefined || !Number.isFinite(appleSeconds)) {
    return null;
  }
  const d = new Date((appleSeconds + epochOffset) * 1000);
  if (Number.isNaN(d.getTime())) return null;

  if (allDay) {
    const zone = resolveZone(tz);
    if (zone) {
      const p = partsIn(d, zone);
      return { allDay: true, day: `${p.year}-${p.month}-${p.day}`, timeZone: null };
    }
    // Floating: the stored instant is midnight where the event was written, and
    // for a floating date that is the local zone. `timeZone` stays null either
    // way — an all-day event names a day, and reporting a zone would invite a
    // caller to read it as an instant.
    return {
      allDay: true,
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      timeZone: null,
    };
  }

  const zone = resolveZone(tz);
  if (!zone) {
    // Floating: report the wall clock the system would show, and say plainly
    // that no zone backs it by returning timeZone: null.
    return { allDay: false, iso: toLocalIso(d), timeZone: null };
  }

  const p = partsIn(d, zone);
  // "GMT+02:00" -> "+02:00"; bare "GMT" is UTC.
  const raw = p.timeZoneName ?? "";
  const offset = raw === "GMT" ? "Z" : raw.replace(/^GMT/, "");
  return {
    allDay: false,
    iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`,
    timeZone: zone,
  };
};
