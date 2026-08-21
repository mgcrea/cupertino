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

export type DateKind = "allDay" | "timed";

export type ParsedDate = {
  kind: DateKind;
  /** The absolute instant, for comparisons and for handing to JXA. */
  at: Date;
  /** ISO-8601 with an explicit offset, so the value survives leaving this process. */
  iso: string;
  /** Echoed back in tool results so a caller can see how its input was read. */
  raw: string;
};

/**
 * What a tool reports for an event's start or end.
 *
 * A union rather than one struct with an `allDay` flag: an all-day event names
 * a DAY and has no instant, and giving it an `iso` field would invite callers to
 * read one. The type makes that impossible instead of merely discouraged.
 */
export type EventInstant =
  | { allDay: true; day: string; timeZone: null }
  | { allDay: false; iso: string; timeZone: string | null };

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const OFFSET =
  /^\+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/;
const DAY_WORD = /^(today|tomorrow)(?:\s+(\d{1,2}):(\d{2}))?$/;
const NEXT_DAY = /^next\s+([a-z]+)(?:\s+(\d{1,2}):(\d{2}))?$/;
const DURATION = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/;

/** `GMT+0200`, `UTC-05:00`. A definite zone that is simply not an IANA name. */
const FIXED_OFFSET = /^(?:GMT|UTC)([+-])(\d{2}):?(\d{2})$/i;

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** `+02:00` / `-05:00` / `Z` for a given instant, in the system zone. */
const offsetOf = (d: Date): string => {
  const mins = -d.getTimezoneOffset();
  if (mins === 0) return "Z";
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

/**
 * Local wall-clock time rendered with its offset.
 *
 * Deliberately not `toISOString()`, which converts to UTC and would report a
 * 09:00 meeting as `07:00Z` — correct as an instant, unreadable in a result
 * whose purpose is confirming what the caller asked for.
 */
export const toLocalIso = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offsetOf(d)}`;

const startOfDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

const endOfDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** Calendar-aware day arithmetic: same wall-clock time, n days later. */
const addDays = (d: Date, n: number): Date => {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
};

const at = (day: Date, hours: number, minutes: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);

const result = (kind: DateKind, when: Date, raw: string): ParsedDate => ({
  kind,
  at: when,
  iso: toLocalIso(when),
  raw,
});

// ─── input ───────────────────────────────────────────────────────────────────

/**
 * Parse one date argument.
 *
 * @param field Named in the error, so a failure says WHICH argument was bad.
 * @param raw   The caller's string.
 * @param now   Injected for hermetic tests.
 */
export const parseDate = (field: string, raw: string, now: Date = new Date()): ParsedDate => {
  const text = String(raw ?? "").trim();
  if (!text) throw new InvalidDateError(field, String(raw), "it is empty");
  const lower = text.toLowerCase();

  const dt = ISO_DATETIME.exec(text);
  if (dt) {
    const [, y, mo, d, hh, mm, ss, zone] = dt;
    const when = zone
      ? new Date(text.replace(" ", "T"))
      : new Date(
          Number(y),
          Number(mo) - 1,
          Number(d),
          Number(hh),
          Number(mm),
          Number(ss ?? "0"),
          0,
        );
    if (Number.isNaN(when.getTime())) {
      throw new InvalidDateError(field, text, "it is not a real date");
    }
    return result("timed", when, text);
  }

  const only = ISO_DATE.exec(text);
  if (only) {
    const [, y, mo, d] = only;
    const when = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
    if (Number.isNaN(when.getTime())) {
      throw new InvalidDateError(field, text, "it is not a real date");
    }
    // Guard against JS's silent rollover: new Date(2026, 1, 30) is 2 March.
    if (when.getMonth() !== Number(mo) - 1 || when.getDate() !== Number(d)) {
      throw new InvalidDateError(field, text, `there is no day ${d} in month ${mo}`);
    }
    return result("allDay", when, text);
  }

  const off = OFFSET.exec(lower);
  if (off) {
    const n = Number(off[1]);
    const unit = String(off[2]);
    if (!Number.isFinite(n)) throw new InvalidDateError(field, text, "the amount is not a number");
    if (unit.startsWith("d")) return result("timed", addDays(now, n), text);
    if (unit.startsWith("w")) return result("timed", addDays(now, n * 7), text);
    const ms = unit.startsWith("h") ? n * 3_600_000 : n * 60_000;
    return result("timed", new Date(now.getTime() + ms), text);
  }

  const word = DAY_WORD.exec(lower);
  if (word) {
    const day = word[1] === "tomorrow" ? addDays(now, 1) : now;
    if (word[2] === undefined) return result("allDay", startOfDay(day), text);
    const [hh, mm] = [Number(word[2]), Number(word[3])];
    if (hh > 23 || mm > 59)
      throw new InvalidDateError(field, text, `${hh}:${word[3]} is not a time`);
    return result("timed", at(day, hh, mm), text);
  }

  // "next monday" on a Monday is +7, never today.
  const next = NEXT_DAY.exec(lower);
  if (next) {
    const idx = DAY_NAMES.findIndex((n) => n === next[1] || n.slice(0, 3) === next[1]);
    if (idx === -1) {
      throw new InvalidDateError(field, text, `"${next[1]}" is not a day of the week`);
    }
    const ahead = (idx - now.getDay() + 7) % 7 || 7;
    const day = addDays(now, ahead);
    if (next[2] === undefined) return result("allDay", startOfDay(day), text);
    const [hh, mm] = [Number(next[2]), Number(next[3])];
    if (hh > 23 || mm > 59)
      throw new InvalidDateError(field, text, `${hh}:${next[3]} is not a time`);
    return result("timed", at(day, hh, mm), text);
  }

  throw new InvalidDateError(field, text, "it matches none of the accepted forms");
};

/**
 * Parse a bound for a range filter.
 *
 * A bare day means the WHOLE day, so which edge it resolves to depends on which
 * side of the range it is. Resolving both to midnight would make an end bound
 * quietly exclude the day the caller named.
 */
export const parseBound = (
  field: string,
  raw: string,
  edge: "start" | "end",
  now: Date = new Date(),
): Date => {
  const parsed = parseDate(field, raw, now);
  if (parsed.kind !== "allDay") return parsed.at;
  return edge === "end" ? endOfDay(parsed.at) : startOfDay(parsed.at);
};

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
  const from = opts.from ? parseBound("from", opts.from, "start", now) : startOfDay(now);
  const to = opts.to
    ? parseBound("to", opts.to, "end", now)
    : endOfDay(addDays(from, opts.defaultRangeDays - 1));

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
 * ## Why all-day is derived in UTC
 *
 * An all-day event names a DAY. The stored value is anchored at midnight UTC,
 * so reading it with local getters lands on the PREVIOUS day for every zone at a
 * negative offset — the whole Americas. Verified rather than reasoned about:
 *
 *   TZ=America/Los_Angeles   local 2026-08-20   utc 2026-08-21   <- shifted
 *   TZ=UTC                   local 2026-08-21   utc 2026-08-21
 *   TZ=Asia/Kolkata          local 2026-08-21   utc 2026-08-21
 *   TZ=Pacific/Auckland      local 2026-08-21   utc 2026-08-21
 *
 * (Reminders documents the mirror-image bug for its own storage, which is
 * anchored the other way round — see docs/reminders.md. The direction is a
 * property of the anchor, not a general rule, which is exactly why it is
 * measured here rather than carried over.)
 *
 * So the day string comes from UTC components, never local ones. `dates.test.ts`
 * runs under four zones to keep it that way.
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
    return {
      allDay: true,
      day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
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
