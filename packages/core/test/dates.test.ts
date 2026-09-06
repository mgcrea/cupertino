import { describe, expect, it } from "vitest";

import { addLocalDays, parseBound, parseDate, startOfLocalDay, toLocalIso } from "../src/dates.js";
import { InvalidDateError } from "../src/errors.js";

/**
 * A fixed clock. Every test passes it explicitly rather than freezing a global,
 * which is the same reason `loadConfig` takes an `env` argument.
 *
 * 2026-08-20 is a Thursday, chosen so the weekday arithmetic has to wrap.
 */
const NOW = new Date(2026, 7, 20, 14, 30, 0, 0);

/** Local wall-clock fields, so assertions do not depend on the runner's zone. */
const fields = (d: Date) => ({
  y: d.getFullYear(),
  mo: d.getMonth() + 1,
  d: d.getDate(),
  h: d.getHours(),
  mi: d.getMinutes(),
});

describe("parseDate — ISO", () => {
  it("reads a bare date as all-day at local midnight", () => {
    const got = parseDate("dueDate", "2026-08-20", NOW);
    expect(got.kind).toBe("allDay");
    expect(fields(got.at)).toEqual({ y: 2026, mo: 8, d: 20, h: 0, mi: 0 });
  });

  it("reads a date-time as timed, in local time", () => {
    const got = parseDate("dueDate", "2026-08-20T09:15", NOW);
    expect(got.kind).toBe("timed");
    expect(fields(got.at)).toEqual({ y: 2026, mo: 8, d: 20, h: 9, mi: 15 });
  });

  it("accepts seconds and a space separator", () => {
    expect(fields(parseDate("dueDate", "2026-08-20 09:15:30", NOW).at)).toEqual({
      y: 2026,
      mo: 8,
      d: 20,
      h: 9,
      mi: 15,
    });
  });

  /**
   * The whole reason `iso` carries an offset. An input that names an absolute
   * instant must survive the round trip as that instant, whatever zone the
   * process happens to be in.
   */
  it("honours an explicit offset as the instant it names", () => {
    const got = parseDate("dueDate", "2026-08-20T09:00:00Z", NOW);
    expect(got.kind).toBe("timed");
    expect(got.at.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  /**
   * `new Date(2026, 1, 30)` silently rolls over to 2 March. A due date landing
   * on the wrong day is exactly the failure this module exists to prevent, so
   * the rollover is rejected rather than passed through.
   */
  it("rejects a day that does not exist in its month", () => {
    expect(() => parseDate("dueDate", "2026-02-30", NOW)).toThrow(InvalidDateError);
  });

  /**
   * The guard above existed only on the date-only branch, so every impossible
   * DATE-TIME rolled over silently: "2026-02-30T09:00" became 2 March at 09:00
   * and "2026-08-20T25:00" became the 21st at 01:00.
   */
  it.each([
    ["2026-02-30T09:00", /no day 30 in month 02/],
    ["2026-08-20T25:00", /25:00 is not a time/],
    ["2026-08-20T09:60", /09:60 is not a time/],
  ])("rejects the impossible date-time %s", (raw, why) => {
    expect(() => parseDate("dueDate", raw, NOW)).toThrow(InvalidDateError);
    expect(() => parseDate("dueDate", raw, NOW)).toThrow(why);
  });

  it("rejects an impossible zoned date-time rather than rolling it over", () => {
    expect(() => parseDate("dueDate", "2026-02-30T09:00Z", NOW)).toThrow(InvalidDateError);
  });

  /** The field is named so a caller with several date arguments knows which. */
  it("names the field and the raw value it could not read", () => {
    try {
      parseDate("dueBefore", "sometime soon", NOW);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDateError);
      expect((err as InvalidDateError).message).toMatch(/Could not read dueBefore/);
      expect((err as InvalidDateError).message).toMatch(/ISO-8601/);
      expect((err as { details?: unknown }).details).toMatchObject({
        field: "dueBefore",
        raw: "sometime soon",
      });
    }
  });
});

/**
 * Safari's copy added these because history only ever points backwards. Every
 * surface gets them now: refusing "-7d" in one server while accepting it in
 * another is exactly the drift the shared grammar replaces.
 */
describe("parseDate — the backward forms", () => {
  it("reads a negative offset", () => {
    expect(fields(parseDate("from", "-7d", NOW).at)).toEqual({
      y: 2026,
      mo: 8,
      d: 13,
      h: 14,
      mi: 30,
    });
  });

  it("reads yesterday as a whole day", () => {
    const got = parseDate("from", "yesterday", NOW);
    expect(got.kind).toBe("allDay");
    expect(fields(got.at)).toEqual({ y: 2026, mo: 8, d: 19, h: 0, mi: 0 });
  });

  /** NOW is a Thursday, so "last monday" is three days back. */
  it("reads last <weekday> strictly backwards", () => {
    expect(fields(parseDate("from", "last monday", NOW).at).d).toBe(17);
  });

  it("reads last <weekday> on that same weekday as a full week back", () => {
    const thursday = parseDate("from", "last thursday", NOW);
    expect(fields(thursday.at).d).toBe(13);
  });
});

describe("parseDate — relative offsets", () => {
  it("keeps the current time of day for +2d", () => {
    const got = parseDate("dueDate", "+2d", NOW);
    expect(got.kind).toBe("timed");
    expect(fields(got.at)).toEqual({ y: 2026, mo: 8, d: 22, h: 14, mi: 30 });
  });

  it("adds elapsed time for +3h", () => {
    expect(parseDate("dueDate", "+3h", NOW).at.getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
  });

  it("adds elapsed time for +45m", () => {
    expect(parseDate("dueDate", "+45m", NOW).at.getTime()).toBe(NOW.getTime() + 45 * 60_000);
  });

  it("treats a week as seven calendar days", () => {
    expect(fields(parseDate("dueDate", "+1w", NOW).at)).toEqual({
      y: 2026,
      mo: 8,
      d: 27,
      h: 14,
      mi: 30,
    });
  });

  it("accepts the spelled-out unit names", () => {
    for (const form of ["+2 days", "+2day", "+2days"]) {
      expect(fields(parseDate("dueDate", form, NOW).at).d).toBe(22);
    }
  });
});

/**
 * The split that is wrong by default, and wrong twice a year.
 *
 * These run only where the host zone actually observes DST — asserting a clock
 * change in UTC would be asserting nothing. Europe/Paris springs forward on
 * 2026-03-29.
 */
describe("parseDate — DST", () => {
  const springForward = new Date(2026, 2, 28, 14, 0, 0, 0);
  const observesDst =
    new Date(2026, 0, 1).getTimezoneOffset() !== new Date(2026, 6, 1).getTimezoneOffset();

  it.skipIf(!observesDst)("keeps wall-clock time across a spring-forward for +2d", () => {
    const got = parseDate("dueDate", "+2d", springForward);
    // Calendar arithmetic: still 14:00, even though only 47 hours elapsed.
    expect(fields(got.at)).toEqual({ y: 2026, mo: 3, d: 30, h: 14, mi: 0 });
    expect(got.at.getTime() - springForward.getTime()).not.toBe(48 * 3_600_000);
  });

  it.skipIf(!observesDst)("keeps elapsed time across a spring-forward for +24h", () => {
    const got = parseDate("dueDate", "+24h", springForward);
    // Absolute duration: exactly 24 hours, so the wall clock moves by one hour.
    expect(got.at.getTime() - springForward.getTime()).toBe(24 * 3_600_000);
    expect(fields(got.at).h).toBe(15);
  });
});

describe("parseDate — day words", () => {
  it("reads today as all-day", () => {
    const got = parseDate("dueDate", "today", NOW);
    expect(got.kind).toBe("allDay");
    expect(fields(got.at)).toEqual({ y: 2026, mo: 8, d: 20, h: 0, mi: 0 });
  });

  it("reads tomorrow as all-day", () => {
    expect(fields(parseDate("dueDate", "tomorrow", NOW).at).d).toBe(21);
  });

  it("promotes to timed when a time is given", () => {
    const got = parseDate("dueDate", "tomorrow 09:00", NOW);
    expect(got.kind).toBe("timed");
    expect(fields(got.at)).toEqual({ y: 2026, mo: 8, d: 21, h: 9, mi: 0 });
  });

  it("is case-insensitive", () => {
    expect(parseDate("dueDate", "ToMoRRoW", NOW).kind).toBe("allDay");
  });
});

describe("parseDate — next weekday", () => {
  // NOW is a Thursday.
  it("finds the next occurrence", () => {
    expect(fields(parseDate("dueDate", "next monday", NOW).at).d).toBe(24);
  });

  /** The ambiguous case. "next thursday" on a Thursday must not mean today. */
  it("skips a full week when the day is today", () => {
    const got = parseDate("dueDate", "next thursday", NOW);
    expect(fields(got.at).d).toBe(27);
  });

  it("accepts three-letter abbreviations", () => {
    expect(fields(parseDate("dueDate", "next mon", NOW).at).d).toBe(24);
  });

  it("rejects a word that is not a weekday", () => {
    expect(() => parseDate("dueDate", "next caturday", NOW)).toThrow(/not a day of the week/);
  });
});

describe("parseDate — rejection", () => {
  /**
   * "yesterday" is NOT in this list any more: the shared grammar is Safari's
   * superset, so the backward forms are accepted everywhere.
   */
  it.each(["", "   ", "soon", "2026/08/20", "+2", "+2y", "25:00", "last week"])(
    "rejects %o",
    (raw) => {
      expect(() => parseDate("dueDate", raw, NOW)).toThrow(InvalidDateError);
    },
  );

  /** The caller is usually a model that gets one retry, so the error is the docs. */
  it("names the field and lists the accepted forms", () => {
    expect(() => parseDate("remindMeDate", "soon", NOW)).toThrow(/remindMeDate/);
    expect(() => parseDate("remindMeDate", "soon", NOW)).toThrow(/\+2d/);
  });
});

/**
 * A bare day names a whole day, so which instant it becomes depends on which
 * end of the range it is. Resolving both to midnight would make `dueBefore`
 * quietly exclude everything on the day the caller asked about.
 */
describe("parseBound", () => {
  /**
   * The NEXT day's midnight, not this day's 23:59:59.999. Callers compare with
   * `<`, so the named day is fully included and nothing of the next one is.
   * Two of the three copies this replaced used the end of the same day, which
   * drops the final millisecond and invites the `<=` that then drops the whole
   * day when somebody writes midnight instead.
   */
  it("takes the START OF THE NEXT DAY for an upper bound", () => {
    const got = parseBound("dueBefore", "2026-08-20", "end", NOW);
    expect(fields(got)).toEqual({ y: 2026, mo: 8, d: 21, h: 0, mi: 0 });
  });

  it("takes the start of the day for a lower bound", () => {
    expect(fields(parseBound("dueAfter", "2026-08-20", "start", NOW))).toEqual({
      y: 2026,
      mo: 8,
      d: 20,
      h: 0,
      mi: 0,
    });
  });

  it("brackets exactly the named day, with an exclusive upper edge", () => {
    const from = parseBound("from", "2026-08-20", "start", NOW).getTime();
    const to = parseBound("to", "2026-08-20", "end", NOW).getTime();
    const onTheDay = new Date(2026, 7, 20, 23, 59, 59, 999).getTime();
    const nextMidnight = new Date(2026, 7, 21, 0, 0, 0, 0).getTime();
    expect(onTheDay >= from && onTheDay < to).toBe(true);
    expect(nextMidnight < to).toBe(false);
  });

  /**
   * `new Date("2026-08-20")` is UTC midnight while `new Date("2026-08-20T00:00")`
   * is local midnight. Mail and Messages both parsed bare days the first way and
   * bucketed results the second, so a query was off by the zone offset.
   */
  it("reads a bare day as LOCAL midnight, never UTC", () => {
    expect(parseBound("from", "2026-08-20", "start", NOW).getTime()).toBe(
      new Date(2026, 7, 20).getTime(),
    );
  });

  it("leaves an explicit time alone at either edge", () => {
    for (const edge of ["start", "end"] as const) {
      expect(fields(parseBound("dueBefore", "2026-08-20T09:15", edge, NOW)).h).toBe(9);
    }
  });
});

describe("the day helpers", () => {
  it("addLocalDays keeps the wall-clock time", () => {
    expect(fields(addLocalDays(new Date(2026, 7, 20, 9, 15), 2))).toEqual({
      y: 2026,
      mo: 8,
      d: 22,
      h: 9,
      mi: 15,
    });
  });

  it("startOfLocalDay drops the time", () => {
    expect(fields(startOfLocalDay(new Date(2026, 7, 20, 9, 15)))).toEqual({
      y: 2026,
      mo: 8,
      d: 20,
      h: 0,
      mi: 0,
    });
  });
});

describe("toLocalIso", () => {
  /**
   * Not `toISOString()`: that reports a 09:00 local reminder as 07:00Z, which is
   * the right instant and the wrong answer to "what did you set it to".
   */
  it("renders local wall-clock time with an explicit offset", () => {
    const iso = toLocalIso(new Date(2026, 7, 20, 9, 15, 0, 0));
    expect(iso).toMatch(/^2026-08-20T09:15:00(Z|[+-]\d{2}:\d{2})$/);
  });

  it("round-trips back to the same instant", () => {
    const d = new Date(2026, 7, 20, 9, 15, 0, 0);
    expect(new Date(toLocalIso(d)).getTime()).toBe(d.getTime());
  });
});
