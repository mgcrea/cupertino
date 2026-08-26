/**
 * Free-time arithmetic: turning a set of events into the times nothing is on.
 *
 * ## Why this is its own module, and why it is pure
 *
 * `recurrence.ts` set the precedent — the piece whose correctness rests on a
 * measurement lives apart from the SQL. This is the mirror image. Nothing here
 * rests on a measurement at all; it is interval arithmetic and calendar-day
 * iteration, and it is separated for the opposite reason: it is the only part
 * of an availability answer that can be tested without a store, and the part
 * where an off-by-one books a meeting on top of another meeting.
 *
 * ## The rule that governs every decision below
 *
 * A gap reported here is an assertion that NOTHING is on the calendar then.
 * `docs/calendar.md` already names why that is dangerous: "a short list of
 * events is indistinguishable from a free afternoon". Every other read tool on
 * this surface can afford to return a short list and flag it. This one cannot —
 * shortening the busy set does not shorten the answer, it INVENTS free time.
 * So the caller of this module must hand it a complete busy set or refuse, and
 * everything here assumes that contract has already been checked.
 *
 * ## Local wall clock, deliberately
 *
 * Working hours are a human's, not UTC's: "09:00 to 18:00" means those numbers
 * on the office wall, on both sides of a daylight-saving change. So day
 * boundaries are built with local date components — the same choice, for the
 * same reason, as `at()` in `dates.ts` — and a day that loses an hour simply
 * has one fewer hour in it, which is what actually happened.
 */

import { InvalidDateError } from "./errors.js";

/** Half-open `[from, to)`, in milliseconds since the Unix epoch. */
export type Interval = { from: number; to: number };

/** A wall-clock time of day. `24:00` is legal and means the following midnight. */
export type Clock = { hours: number; minutes: number };

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** Monday to Friday, the default working week. */
export const DEFAULT_WEEKDAYS: readonly WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri"];

const CLOCK = /^(\d{1,2}):(\d{2})$/;

const pad = (n: number): string => String(n).padStart(2, "0");

export const parseClock = (field: string, raw: string): Clock => {
  const text = String(raw ?? "").trim();
  const m = CLOCK.exec(text);
  if (!m) throw new InvalidDateError(field, text, 'expected a time of day like "09:00"');
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59) {
    throw new InvalidDateError(field, text, `${hours}:${m[2]} is not a time of day`);
  }
  // 24:00 names the end of the day and nothing past it; 24:30 names nothing.
  if (hours === 24 && minutes !== 0) {
    throw new InvalidDateError(
      field,
      text,
      '24:00 is the latest time of day, so "24:30" is not one',
    );
  }
  return { hours, minutes };
};

export const weekdaySet = (keys: readonly WeekdayKey[]): Set<number> =>
  new Set(keys.map((k) => WEEKDAY_KEYS.indexOf(k)).filter((i) => i !== -1));

const startOfLocalDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

/** Same wall-clock time, n days later. Calendar arithmetic, so DST-safe. */
const addDays = (d: Date, n: number): Date => {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
};

/**
 * A time of day on a given local date.
 *
 * `new Date(y, m, d, 24, 0)` rolls to the next midnight on purpose, which is
 * what makes `dayEnd: "24:00"` mean "to the end of this day" rather than an
 * error case the caller has to special-case.
 */
const atClock = (day: Date, c: Clock): number =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), c.hours, c.minutes, 0, 0).getTime();

/**
 * Overlapping and touching intervals collapsed into the fewest that cover the
 * same time, in order.
 *
 * Touching counts as overlapping (`<=`, not `<`): two meetings that end and
 * begin on the same minute leave no gap, and emitting a zero-length one would
 * put "you are free from 10:00 to 10:00" in front of a model.
 */
export const mergeIntervals = (input: readonly Interval[]): Interval[] => {
  const sorted = input.filter((i) => i.to > i.from).toSorted((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out.at(-1);
    if (last && cur.from <= last.to) {
      if (cur.to > last.to) last.to = cur.to;
      continue;
    }
    out.push({ from: cur.from, to: cur.to });
  }
  return out;
};

/**
 * What is left of `window` once every busy interval is taken out of it.
 *
 * `busy` MUST already be merged and sorted — pass it through `mergeIntervals`
 * first. Taking unsorted input here would silently under-subtract and hand back
 * time that is booked, which is the one error this module exists to prevent, so
 * the precondition is stated rather than defended against: a defensive re-sort
 * would hide the caller's mistake instead of making it impossible.
 */
export const subtractBusy = (window: Interval, busy: readonly Interval[]): Interval[] => {
  const out: Interval[] = [];
  let cursor = window.from;
  for (const b of busy) {
    if (b.to <= cursor) continue;
    if (b.from >= window.to) break;
    if (b.from > cursor) out.push({ from: cursor, to: b.from });
    cursor = b.to;
    if (cursor >= window.to) return out;
  }
  if (cursor < window.to) out.push({ from: cursor, to: window.to });
  return out;
};

/**
 * The working windows inside `[from, to]`, one per admitted weekday.
 *
 * A `dayEnd` at or before `dayStart` yields no window for that day rather than
 * a negative one. Overnight working hours are not expressible, and saying so
 * with an empty result is better than wrapping around midnight and reporting
 * free time on a day the caller never asked about.
 */
export const dayWindows = (opts: {
  from: Date;
  to: Date;
  dayStart: Clock;
  dayEnd: Clock;
  weekdays: ReadonlySet<number>;
}): Interval[] => {
  const out: Interval[] = [];
  const last = opts.to.getTime();
  for (let day = startOfLocalDay(opts.from); day.getTime() <= last; day = addDays(day, 1)) {
    if (!opts.weekdays.has(day.getDay())) continue;
    const open = atClock(day, opts.dayStart);
    const close = atClock(day, opts.dayEnd);
    if (close <= open) continue;
    const from = Math.max(open, opts.from.getTime());
    const to = Math.min(close, last);
    if (to > from) out.push({ from, to });
  }
  return out;
};

/**
 * Round an instant up to the next granularity boundary of its own hour.
 *
 * Anchored to the top of the hour rather than to the window, so a slot lands on
 * 09:15 and not on 09:07 because that is when the previous meeting happened to
 * end. Callers restrict granularity to a divisor of 60, which is what keeps the
 * per-hour restart invisible.
 */
export const alignUp = (ms: number, granularityMinutes: number): number => {
  const d = new Date(ms);
  const topOfHour = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    0,
    0,
    0,
  ).getTime();
  const step = granularityMinutes * 60_000;
  const past = ms - topOfHour;
  return topOfHour + Math.ceil(past / step) * step;
};

/** Local midnight at the start of the day an instant falls on. */
export const startOfLocalDayMs = (ms: number): number => startOfLocalDay(new Date(ms)).getTime();

/** The following local midnight. Calendar arithmetic, so a DST day is 23h or 25h. */
export const nextLocalDayMs = (ms: number): number =>
  addDays(startOfLocalDay(new Date(ms)), 1).getTime();

/** `2026-08-24`, in local components — the day a slot falls on. */
export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
