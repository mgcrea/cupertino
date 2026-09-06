/**
 * The one grammar every surface reads its date arguments with.
 *
 * ## Why it is here
 *
 * This shipped as three copies. Reminders wrote it, Calendar repeated it
 * verbatim, and Safari repeated it again with signed offsets and `yesterday`
 * added — that third copy's header says outright that three is the trigger for
 * hoisting and that the copies had already diverged. Meanwhile Mail, Messages
 * and Notes never got a grammar at all: they called `Date.parse` or
 * `new Date()` directly, which is where the bugs were.
 *
 * They were not small bugs, and they were all the same shape — a date argument
 * that produced a confident, plausible, wrong answer:
 *
 *   - `Date.parse("last week")` is `NaN`, node:sqlite binds `NaN` as `NULL`,
 *     and `date_received >= NULL` matches nothing. A model that wrote a date in
 *     words got zero results and no error.
 *   - `new Date("2026-08-20")` is UTC midnight but `new Date("2026-08-20T00:00")`
 *     is LOCAL midnight, so two spellings a tool description treated as the
 *     same thing bounded a query an hour or five apart.
 *   - `"2026-02-30T09:00"` silently became 2 March, because the rollover guard
 *     existed on the date branch and not on the date-time one.
 *
 * ## The rule
 *
 * 1. `YYYY-MM-DD` names a **local calendar day**. As a start bound it is local
 *    00:00 of that day; as an end bound it is local 00:00 of the NEXT day, and
 *    every consumer compares with `<`. So `to: "2026-08-20"` includes all of
 *    the 20th and nothing of the 21st. Resolving it to midnight of the same day
 *    is how an end bound quietly excludes the day it names.
 * 2. `YYYY-MM-DD[T ]HH:MM[:SS]` is local wall-clock; with `Z` or `±HH:MM` it is
 *    the instant named. A timed bound is used as given, and is exclusive at the
 *    end edge like everything else.
 * 3. Relative forms: `±N m|h|d|w`, `today` / `yesterday` / `tomorrow` with an
 *    optional `HH:MM`, and `next|last <weekday>`. Days and weeks are calendar
 *    arithmetic; hours and minutes are elapsed time. That split is not
 *    cosmetic — reversing it drifts every bound by an hour twice a year.
 * 4. Anything else, an empty string, or an instant that does not exist
 *    (`2026-02-30`, `T25:00`, `T09:60`) throws `InvalidDateError`. **Nothing
 *    here ever returns `NaN`**, because a `NaN` reaches SQLite as `NULL` and a
 *    `NULL` bound is an empty result rather than a complaint.
 *
 * The forward-only surfaces inherit the backward forms too. A reminder cannot
 * be due `-7d`, but accepting it costs nothing and refusing it in one surface
 * while accepting it in another is exactly the drift this file replaces.
 */

import { InvalidDateError } from "./errors.js";

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
export const startOfLocalDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

/**
 * The last representable instant of the given calendar day, local.
 *
 * Kept for surfaces that genuinely want an inclusive edge. It is NOT what an
 * end bound resolves to — see `parseBound`.
 */
export const endOfLocalDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** Calendar-aware day arithmetic: same wall-clock time, n days later. */
export const addLocalDays = (d: Date, n: number): Date => {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
};

const at = (day: Date, hours: number, minutes: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const daysInMonth = (y: number, mo: number): number =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;

/**
 * Reject an instant that does not exist, BEFORE building a Date from it.
 *
 * Checking afterwards does not work, for two reasons found the hard way. An
 * out-of-range hour rolls the DAY over, so `2026-08-20T25:00` comes back as the
 * 21st at 01:00 and a naive date comparison blames the day the caller got
 * right. And a zoned string does not answer `NaN` at all:
 * `new Date("2026-02-30T09:00Z")` is 2 March, so there is nothing to catch.
 *
 * Arithmetic on the components has neither problem and does not depend on the
 * zone. The order matters — time first, because that is what rolled the date.
 */
const assertReal = (
  field: string,
  text: string,
  y: number,
  mo: number,
  d: number,
  hh = 0,
  mm = 0,
  ss = 0,
): void => {
  if (hh > 23 || mm > 59 || ss > 59) {
    throw new InvalidDateError(field, text, `${pad(hh)}:${pad(mm)} is not a time`);
  }
  if (mo < 1 || mo > 12) {
    throw new InvalidDateError(field, text, `there is no month ${pad(mo)}`);
  }
  if (d < 1 || d > daysInMonth(y, mo)) {
    throw new InvalidDateError(field, text, `there is no day ${pad(d)} in month ${pad(mo)}`);
  }
};

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
    // Before constructing anything, and for the zoned form too: neither NaN nor
    // a component comparison catches these. See `assertReal`.
    assertReal(
      field,
      text,
      Number(y),
      Number(mo),
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss ?? "0"),
    );
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
    // Guard against JS's silent rollover: new Date(2026, 1, 30) is 2 March.
    assertReal(field, text, Number(y), Number(mo), Number(d));
    const when = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
    if (Number.isNaN(when.getTime())) {
      throw new InvalidDateError(field, text, "it is not a real date");
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
    if (unit.startsWith("d")) return result("timed", addLocalDays(now, n), text);
    if (unit.startsWith("w")) return result("timed", addLocalDays(now, n * 7), text);
    const ms = unit.startsWith("h") ? n * 3_600_000 : n * 60_000;
    return result("timed", new Date(now.getTime() + ms), text);
  }

  // ── today / yesterday / tomorrow, an optional time promoting it to timed. ──
  const word = DAY_WORD.exec(lower);
  if (word) {
    const shift = word[1] === "tomorrow" ? 1 : word[1] === "yesterday" ? -1 : 0;
    const day = addLocalDays(now, shift);
    if (word[2] === undefined) return result("allDay", startOfLocalDay(day), text);
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
    const day = addLocalDays(now, delta);
    if (rel[3] === undefined) return result("allDay", startOfLocalDay(day), text);
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
 * A bare day names the WHOLE day, so which instant it resolves to depends on
 * which edge it is. The start edge is that day's local midnight. The end edge
 * is the NEXT day's local midnight, and every caller compares with `<` — which
 * makes the bound exclusive and the named day fully included.
 *
 * The alternative, 23:59:59.999, was what two of the three copies did, and it
 * is wrong twice: it drops the last millisecond of the day, and more to the
 * point it invites the `<=` that then drops the whole day when somebody writes
 * midnight instead.
 */
export const parseBound = (
  field: string,
  raw: string,
  edge: "start" | "end",
  now: Date = new Date(),
): Date => {
  const parsed = parseDate(field, raw, now);
  if (parsed.kind !== "allDay") return parsed.at;
  return edge === "end" ? startOfLocalDay(addLocalDays(parsed.at, 1)) : startOfLocalDay(parsed.at);
};
