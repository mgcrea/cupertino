/**
 * Date handling for the Safari tools.
 *
 * ## Two halves, and the second one is the interesting one
 *
 * INPUT reuses the grammar `packages/reminders/src/client/dates.ts` established
 * and `packages/calendar` repeated, deliberately unchanged where it overlaps: an
 * ISO date names a day, an ISO date-time names an instant, day and week offsets
 * are calendar arithmetic while hour and minute offsets are elapsed time. That
 * last split is not cosmetic — reversing it drifts every bound by an hour twice
 * a year.
 *
 * It differs in one respect, because this surface points the other way. Every
 * other surface here is about the future: a reminder is due, an event is
 * scheduled. **History is only ever the past**, so the grammar accepts a
 * NEGATIVE offset (`-7d`) and the words `yesterday` and `last monday`, and
 * `parseRange` defaults to a window that ends now and reaches backwards. A
 * caller asking for "the last week" should not have to write it as a
 * subtraction from a date it has to compute first.
 *
 * (This is now the third copy of the grammar. Reminders' comment declined to
 * hoist it into `packages/core` on the grounds that two consumers with
 * different output types were not enough evidence for a shared abstraction.
 * Three is arguably the trigger, and the three have since diverged in exactly
 * the way that makes hoisting harder. Recorded here rather than done here:
 * refactoring two shipped surfaces is not part of adding a third.)
 *
 * ## OUTPUT: the epoch is DETECTED, never assumed
 *
 * This is the part that is specific to Safari, and it exists because of a
 * measured near-miss. docs/safari.md records that the first granted probe run
 * reported `visit_time` as apple-NANOseconds. That was wrong — a probe bug, in
 * which a plausibility window accepted a degenerate reading anchored at 2001 —
 * and the corrected expectation is apple-seconds. See docs/calendar.md for the
 * full account.
 *
 * The lesson is not "hardcode the corrected value". A wrong epoch produces
 * dates that are perfectly well-formed and wrong by 31 years, which no test on
 * synthetic data can catch and no reader notices until something important
 * turns out to have been visited in 1995. So the offset is resolved from the
 * store's own data at open time, and when it cannot be resolved the dates are
 * WITHHELD rather than guessed. An absent timestamp is a visible gap somebody
 * can report; a confident wrong one is not.
 */

import { CORE_DATA_EPOCH_OFFSET, detectEpoch } from "@mgcrea/mcp-apple-core";

import { InvalidDateError } from "./errors.js";

export { CORE_DATA_EPOCH_OFFSET };

/**
 * How this store's timestamps map onto real time.
 *
 * `confident` is the field that matters. `detectEpoch` always returns an
 * offset — it falls back to unix when nothing fits — so the offset alone cannot
 * distinguish "measured as unix" from "gave up and assumed unix". Rendering the
 * second as though it were the first is the exact failure this module is built
 * around, so the two are kept apart.
 */
export type Epoch = {
  offset: number;
  reason: string;
  confident: boolean;
};

/** What `detectEpoch` says when it has matched nothing. */
const GAVE_UP = /^(no dated rows|neither epoch)/;

/**
 * Decide the epoch from the largest timestamp in the store.
 *
 * @param maxTimestamp The maximum `visit_time`, or null when there are no rows.
 */
export const resolveEpoch = (maxTimestamp: number | null, now: number = Date.now()): Epoch => {
  const { offset, reason } = detectEpoch(maxTimestamp, now);
  return { offset, reason, confident: !GAVE_UP.test(reason) };
};

/** The expectation docs/safari.md carries, used only where no store is open. */
export const APPLE_SECONDS: Epoch = {
  offset: CORE_DATA_EPOCH_OFFSET,
  reason: "assumed apple-seconds; no store was opened to measure against",
  confident: false,
};

/** A stored timestamp to a JS Date, or null when it cannot be placed. */
export const fromStoreTime = (value: number | null, epoch: Epoch): Date | null => {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  if (!epoch.confident) return null;
  const ms = (value + epoch.offset) * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A JS Date to the store's own units, for range bounds. */
export const toStoreTime = (date: Date, epoch: Epoch): number =>
  date.getTime() / 1000 - epoch.offset;

/** ISO-8601, or null. What every date field on a result carries. */
export const renderInstant = (value: number | null, epoch: Epoch): string | null =>
  fromStoreTime(value, epoch)?.toISOString() ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// Input grammar
// ─────────────────────────────────────────────────────────────────────────────

export type DateKind = "allDay" | "timed";

export type ParsedDate = {
  kind: DateKind;
  /** The absolute instant, for comparisons and for range bounds. */
  at: Date;
  /**
   * ISO-8601 **with an explicit offset**, e.g. `2026-08-20T09:00:00+02:00`.
   *
   * Always carries the offset so the value is unambiguous once it leaves this
   * process — a bare local string reinterpreted in another zone is the silent
   * failure this module exists to prevent.
   */
  iso: string;
  /** Echoed back in tool results so a caller can see how its input was read. */
  raw: string;
};

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
/** Signed, unlike the forward-only surfaces: `-7d` is the common case here. */
const OFFSET =
  /^([+-])(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/;
const DAY_WORD = /^(today|tomorrow|yesterday)(?:\s+(\d{1,2}):(\d{2}))?$/;
const RELATIVE_DAY = /^(next|last)\s+([a-z]+)(?:\s+(\d{1,2}):(\d{2}))?$/;

/** `+02:00` / `-05:00` / `Z` for a given instant, in the system zone. */
const offsetOf = (d: Date): string => {
  const mins = -d.getTimezoneOffset();
  if (mins === 0) return "Z";
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/**
 * Local wall-clock time rendered with its offset.
 *
 * Deliberately not `toISOString()`, which converts to UTC and would report a
 * 09:00 bound as `07:00Z` — correct as an instant, but unreadable in a tool
 * result whose purpose is confirming what the caller asked for.
 */
export const toLocalIso = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offsetOf(d)}`;

/** Local midnight on the given calendar day. */
export const startOfDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

/** The last representable instant of the given calendar day, local. */
export const endOfDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** Calendar-aware day arithmetic: same wall-clock time, n days later. */
export const addDays = (d: Date, n: number): Date => {
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

/**
 * Parse one date argument.
 *
 * @param field Named in the error, so a failure says *which* argument was bad.
 * @param raw   The caller's string.
 * @param now   Injected for hermetic tests, mirroring `loadConfig(env)`.
 */
export const parseDate = (field: string, raw: string, now: Date = new Date()): ParsedDate => {
  const text = String(raw ?? "").trim();
  if (!text) throw new InvalidDateError(field, String(raw), "it is empty");
  const lower = text.toLowerCase();

  // ── ISO date-time. An explicit offset means the caller named an instant. ──
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

  // ── ISO date. Names a day, so it is all-day. ──
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

  // ── Signed offset. Names a duration, so it is timed. ──
  const off = OFFSET.exec(lower);
  if (off) {
    const sign = off[1] === "-" ? -1 : 1;
    const n = Number(off[2]) * sign;
    const unit = String(off[3]);
    if (!Number.isFinite(n)) throw new InvalidDateError(field, text, "the amount is not a number");
    // Days and weeks are calendar arithmetic; hours and minutes are elapsed time.
    if (unit.startsWith("d")) return result("timed", addDays(now, n), text);
    if (unit.startsWith("w")) return result("timed", addDays(now, n * 7), text);
    const ms = unit.startsWith("h") ? n * 3_600_000 : n * 60_000;
    return result("timed", new Date(now.getTime() + ms), text);
  }

  // ── today / yesterday / tomorrow, an optional time promoting it to timed. ──
  const word = DAY_WORD.exec(lower);
  if (word) {
    const shift = word[1] === "tomorrow" ? 1 : word[1] === "yesterday" ? -1 : 0;
    const day = addDays(now, shift);
    if (word[2] === undefined) return result("allDay", startOfDay(day), text);
    const [hh, mm] = [Number(word[2]), Number(word[3])];
    if (hh > 23 || mm > 59) {
      throw new InvalidDateError(field, text, `${hh}:${word[3]} is not a time`);
    }
    return result("timed", at(day, hh, mm), text);
  }

  // ── next/last <weekday>, strictly in that direction: "last monday" on a
  //    Monday is -7, matching "next monday" on a Monday being +7. ──
  const rel = RELATIVE_DAY.exec(lower);
  if (rel) {
    const idx = DAY_NAMES.findIndex((n) => n === rel[2] || n.slice(0, 3) === rel[2]);
    if (idx === -1) {
      throw new InvalidDateError(field, text, `"${rel[2]}" is not a day of the week`);
    }
    const forward = rel[1] === "next";
    const delta = forward
      ? (idx - now.getDay() + 7) % 7 || 7
      : -((now.getDay() - idx + 7) % 7 || 7);
    const day = addDays(now, delta);
    if (rel[3] === undefined) return result("allDay", startOfDay(day), text);
    const [hh, mm] = [Number(rel[3]), Number(rel[4])];
    if (hh > 23 || mm > 59) {
      throw new InvalidDateError(field, text, `${hh}:${rel[4]} is not a time`);
    }
    return result("timed", at(day, hh, mm), text);
  }

  throw new InvalidDateError(field, text, "it matches none of the accepted forms");
};

/**
 * Parse a bound for a range filter.
 *
 * A bare day means the whole day, so the edge it resolves to depends on which
 * side of the range it is: `to: "2026-08-20"` includes everything up to that
 * evening, and `from: "2026-08-20"` everything from that morning. Resolving
 * both to midnight would make `to` quietly exclude the day the caller named.
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
 * Resolve a query window over history.
 *
 * Backwards by default, which is the difference from Calendar's version. A
 * browser history has a natural "now" edge and stretches indefinitely into the
 * past, so an omitted `to` means this moment and an omitted `from` means
 * `defaultRangeDays` before it. Calendar defaults forward for the mirror-image
 * reason.
 *
 * `clamped` is reported rather than silently applied: a caller that asked for a
 * decade and received a year needs to know the answer is partial, or it will
 * read an empty tail as an absence of browsing.
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
  const to = opts.to ? parseBound("to", opts.to, "end", now) : now;
  const from = opts.from
    ? parseBound("from", opts.from, "start", now)
    : startOfDay(addDays(to, -(opts.defaultRangeDays - 1)));

  if (to.getTime() < from.getTime()) {
    throw new InvalidDateError(
      "to",
      String(opts.to ?? ""),
      `it resolves to ${toLocalIso(to)}, which is before from (${toLocalIso(from)})`,
    );
  }

  const maxMs = opts.maxRangeDays * 86_400_000;
  if (to.getTime() - from.getTime() > maxMs) {
    // Keep the RECENT edge and move the far one. A history query that is too
    // wide almost always wants the newest rows, and truncating the other way
    // would answer "what did I read this week" with results from last year.
    return { from: new Date(to.getTime() - maxMs), to, clamped: true };
  }
  return { from, to, clamped: false };
};
