/**
 * Date parsing for the Reminders tools.
 *
 * ## Why this module exists at all
 *
 * The scripting dictionary carries two separate due-date properties:
 *
 *   due date          "will set both date and time"
 *   allday due date   "will only set a date"
 *
 * So the *shape of the input* has to pick the property. A caller that writes
 * "2026-08-20" means a day; one that writes "2026-08-20T09:00" means an instant.
 * Collapsing those into one field is how a reminder ends up silently due at
 * midnight, which Reminders then renders as an all-day item anyway — the bug is
 * invisible until someone misses something.
 *
 * ## The rule
 *
 * | Input names a…      | Examples                              | Result   |
 * | ------------------- | ------------------------------------- | -------- |
 * | day                 | `2026-08-20`, `today`, `next monday`  | all-day  |
 * | instant             | `2026-08-20T09:00`, `+3h`, `+2d`      | timed    |
 * | day *and* a time    | `tomorrow 09:00`                      | timed    |
 *
 * `+2d` is timed rather than all-day on purpose: it names a duration from now,
 * and the natural reading of "in two days" keeps the current time of day.
 *
 * ## Time zone
 *
 * Everything without an explicit offset resolves in **system local time**.
 * Reminders is a local-calendar app: a reminder due "09:00" is due at nine
 * o'clock where the person is, not at nine UTC. An input that *does* carry an
 * offset (`…T09:00Z`, `…T09:00+02:00`) is honoured as the absolute instant it
 * names.
 *
 * ## DST
 *
 * Day and week offsets are **calendar** arithmetic (`setDate`), so `+2d` across
 * a clock change lands at the same wall-clock time — which is what "in two
 * days" means to a person. Hour and minute offsets are **absolute** durations,
 * so `+3h` is always three hours of elapsed time. That split is deliberate and
 * pinned by tests; getting it backwards makes reminders drift by an hour twice
 * a year.
 *
 * ## Testability
 *
 * `now` is an injected parameter with a `new Date()` default, mirroring how
 * `loadConfig(env)` takes its environment — so tests are hermetic rather than
 * having to freeze a global clock.
 */

import { InvalidDateError } from "./errors.js";

/** What a parsed date turned out to be, which selects the Reminders property. */
export type DueKind = "allDay" | "timed";

export type ParsedDate = {
  kind: DueKind;
  /** The absolute instant, for comparisons and for handing to JXA. */
  at: Date;
  /**
   * ISO-8601 **with an explicit offset**, e.g. `2026-08-20T09:00:00+02:00`.
   *
   * Always carries the offset so the value is unambiguous once it leaves this
   * process — a bare local string reinterpreted in another zone is exactly the
   * silent failure this module exists to prevent.
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
  /^\+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/;
const DAY_WORD = /^(today|tomorrow)(?:\s+(\d{1,2}):(\d{2}))?$/;
const NEXT_DAY = /^next\s+([a-z]+)(?:\s+(\d{1,2}):(\d{2}))?$/;

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
 * 09:00 reminder as `07:00Z` — correct as an instant, but unreadable in a tool
 * result where the whole point is confirming what the caller asked for.
 */
export const toLocalIso = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offsetOf(d)}`;

/** Local midnight on the given calendar day. */
const startOfDay = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

/** The last representable instant of the given calendar day, local. */
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

const result = (kind: DueKind, when: Date, raw: string): ParsedDate => ({
  kind,
  at: when,
  iso: toLocalIso(when),
  raw,
});

/**
 * Parse one date argument.
 *
 * @param field  Named in the error, so a failure says *which* argument was bad.
 * @param raw    The caller's string.
 * @param now    Injected for hermetic tests.
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

  // ── Relative offset. Names a duration, so it is timed. ──
  const off = OFFSET.exec(lower);
  if (off) {
    const n = Number(off[1]);
    const unit = String(off[2]);
    if (!Number.isFinite(n)) throw new InvalidDateError(field, text, "the amount is not a number");
    // Days and weeks are calendar arithmetic; hours and minutes are elapsed time.
    if (unit.startsWith("d")) return result("timed", addDays(now, n), text);
    if (unit.startsWith("w")) return result("timed", addDays(now, n * 7), text);
    const ms = unit.startsWith("h") ? n * 3_600_000 : n * 60_000;
    return result("timed", new Date(now.getTime() + ms), text);
  }

  // ── today / tomorrow, with an optional time that promotes it to timed. ──
  const word = DAY_WORD.exec(lower);
  if (word) {
    const day = word[1] === "tomorrow" ? addDays(now, 1) : now;
    if (word[2] === undefined) return result("allDay", startOfDay(day), text);
    const [hh, mm] = [Number(word[2]), Number(word[3])];
    if (hh > 23 || mm > 59)
      throw new InvalidDateError(field, text, `${hh}:${word[3]} is not a time`);
    return result("timed", at(day, hh, mm), text);
  }

  // ── next <weekday>, strictly in the future: "next monday" on a Monday is +7. ──
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
 * Parse a bound for a range filter (`dueBefore` / `dueAfter`).
 *
 * A bare day means the whole day, so the edge it resolves to depends on which
 * side of the range it is: `dueBefore: "2026-08-20"` includes everything up to
 * that evening, and `dueAfter: "2026-08-20"` includes everything from that
 * morning. Resolving both to midnight would make `dueBefore` quietly exclude
 * the day the caller named.
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
