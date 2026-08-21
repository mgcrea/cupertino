import { describe, expect, it } from "vitest";

import {
  parseBound,
  parseDate,
  parseDuration,
  parseRange,
  renderInstant,
  resolveZone,
} from "../src/client/dates.js";
import { InvalidDateError } from "../src/client/errors.js";

/** Core Data seconds since 2001, from `StoreCapabilities.epochOffset`. */
const EPOCH = 978_307_200;
/** A Friday, so "next monday" has an unambiguous answer. */
const NOW = new Date(2026, 7, 21, 14, 30, 0);

/** Apple-seconds for a given UTC instant. Correct for TIMED events, which are true instants. */
const appleUtc = (iso: string) => Math.round(new Date(iso).getTime() / 1000) - EPOCH;

/**
 * Apple-seconds for LOCAL midnight on a day — how an all-day event is really
 * stored, measured against a live calendar.
 *
 * The suite previously built these with `appleUtc(...T00:00:00Z)`, which agreed
 * with the implementation's own wrong assumption and passed under all four
 * zones while the surface reported every all-day event a day early.
 */
const appleLocalMidnight = (y: number, m: number, d: number) =>
  Math.round(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000) - EPOCH;

describe("parseDate", () => {
  it("reads a bare day as a whole day", () => {
    expect(parseDate("from", "2026-08-20", NOW).kind).toBe("allDay");
  });

  it("reads a date-time as an instant", () => {
    expect(parseDate("from", "2026-08-20T09:00", NOW).kind).toBe("timed");
  });

  it("honours an explicit offset as the instant it names", () => {
    expect(parseDate("from", "2026-08-20T09:00+02:00", NOW).at.toISOString()).toBe(
      "2026-08-20T07:00:00.000Z",
    );
  });

  it("promotes a day word to timed when a time comes with it", () => {
    expect(parseDate("from", "tomorrow", NOW).kind).toBe("allDay");
    expect(parseDate("from", "tomorrow 09:00", NOW).kind).toBe("timed");
  });

  it("reads next monday as strictly in the future", () => {
    // NOW is a Friday; the following Monday is the 24th.
    expect(parseDate("from", "next monday", NOW).at.getDate()).toBe(24);
  });

  /**
   * The DST split, inherited from Reminders and pinned again here because
   * getting it backwards drifts every event by an hour twice a year. Days and
   * weeks are calendar arithmetic — "in two days" keeps the wall clock. Hours
   * are elapsed time.
   */
  it("treats day offsets as calendar arithmetic and hour offsets as elapsed time", () => {
    const twoDays = parseDate("from", "+2d", NOW).at;
    expect(twoDays.getHours()).toBe(NOW.getHours());
    const threeHours = parseDate("from", "+3h", NOW).at;
    expect(threeHours.getTime() - NOW.getTime()).toBe(3 * 3_600_000);
  });

  it("catches a day that does not exist rather than rolling it over", () => {
    // new Date(2026, 1, 30) is silently 2 March.
    expect(() => parseDate("from", "2026-02-30", NOW)).toThrow(InvalidDateError);
  });

  it("names the field and the grammar when it gives up", () => {
    try {
      parseDate("to", "whenever", NOW);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/Could not read to/);
      expect((err as Error).message).toMatch(/next monday/);
    }
  });
});

describe("parseBound", () => {
  /**
   * A bare day means the WHOLE day, so the two edges resolve differently.
   * Resolving both to midnight makes an end bound exclude the day it names.
   */
  it("expands a bare day to the whole day, edge-aware", () => {
    const start = parseBound("from", "2026-08-20", "start", NOW);
    const end = parseBound("to", "2026-08-20", "end", NOW);
    expect(start.getHours()).toBe(0);
    expect(end.getHours()).toBe(23);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});

describe("parseRange", () => {
  const opts = { defaultRangeDays: 7, maxRangeDays: 366 };

  it("defaults to a week starting today", () => {
    const r = parseRange({ ...opts }, NOW);
    expect(r.from.getDate()).toBe(21);
    expect(r.to.getDate()).toBe(27);
    expect(r.clamped).toBe(false);
  });

  it("gives one whole day when from and to name the same day", () => {
    const r = parseRange({ ...opts, from: "2026-08-21", to: "2026-08-21" }, NOW);
    expect(r.to.getTime() - r.from.getTime()).toBeGreaterThan(86_000_000);
  });

  it("clamps a range that reaches too far rather than scanning a decade", () => {
    const r = parseRange({ ...opts, from: "2026-01-01", to: "2036-01-01" }, NOW);
    expect(r.clamped).toBe(true);
  });

  it("refuses a range that runs backwards", () => {
    expect(() => parseRange({ ...opts, from: "2026-08-21", to: "2026-08-01" }, NOW)).toThrow(
      InvalidDateError,
    );
  });
});

describe("parseDuration", () => {
  it.each([
    ["90", 90],
    ["90m", 90],
    ["2h", 120],
    [45, 45],
  ])("reads %s as %i minutes", (raw, mins) => {
    expect(parseDuration("durationMinutes", raw as string | number)).toBe(mins);
  });

  it.each([["0"], ["-5"], ["soon"], [""]])("refuses %s", (raw) => {
    expect(() => parseDuration("durationMinutes", raw)).toThrow(InvalidDateError);
  });
});

describe("resolveZone", () => {
  it("passes a real IANA name through", () => {
    expect(resolveZone("Europe/Paris")).toBe("Europe/Paris");
  });

  /**
   * MEASURED: this store holds `_float` AND `GMT+0200`, and they mean opposite
   * things. `_float` is deliberately zoneless; `GMT+0200` is a perfectly
   * definite offset that merely is not an IANA name. Treating the second as
   * floating silently discards two hours.
   */
  it("treats _float as floating", () => {
    expect(resolveZone("_float")).toBeNull();
    expect(resolveZone(null)).toBeNull();
    expect(resolveZone("")).toBeNull();
  });

  it("resolves a GMT offset to a real zone instead of calling it floating", () => {
    const zone = resolveZone("GMT+0200");
    expect(zone).not.toBeNull();
    // Etc/GMT signs are inverted by the POSIX convention, so +0200 is Etc/GMT-2.
    expect(zone).toBe("Etc/GMT-2");
  });

  it("actually renders that offset as +02:00", () => {
    const got = renderInstant(appleUtc("2026-08-21T07:00:00Z"), "GMT+0200", false, EPOCH);
    expect(got).toEqual({ allDay: false, iso: "2026-08-21T09:00:00+02:00", timeZone: "Etc/GMT-2" });
  });
});

describe("renderInstant", () => {
  it("renders a timed event in its own zone, not the reader's", () => {
    const got = renderInstant(appleUtc("2026-08-21T00:00:00Z"), "Asia/Tokyo", false, EPOCH);
    expect(got).toEqual({
      allDay: false,
      iso: "2026-08-21T09:00:00+09:00",
      timeZone: "Asia/Tokyo",
    });
  });

  it("reports a floating event as floating rather than inventing a zone", () => {
    const got = renderInstant(appleUtc("2026-08-21T09:00:00Z"), "_float", false, EPOCH);
    expect(got?.allDay).toBe(false);
    expect((got as { timeZone: string | null }).timeZone).toBeNull();
  });

  /**
   * THE ALL-DAY TRAP, and the one this surface actually fell into.
   *
   * Calendar stores an all-day event at midnight in the event's own zone — for a
   * floating date, the local one. Reading it with UTC getters lands a day early
   * for every zone at a POSITIVE offset, which is how a Paris calendar reported
   * every birthday on the day before.
   *
   * Run under four zones. That matrix passed while the code was wrong, because
   * the fixture was built on the same assumption as the implementation — so the
   * fixture is now built the way the store really holds it.
   */
  it("gives an all-day event the day it is stored on, and no zone", () => {
    const got = renderInstant(appleLocalMidnight(2026, 8, 21), "_float", true, EPOCH);
    expect(got).toEqual({ allDay: true, day: "2026-08-21", timeZone: null });
  });

  /**
   * REGRESSION, from a live calendar. A birthday stored at 2026-08-20T22:00Z
   * (midnight in Paris) is a 21 August birthday, and was rendered as the 20th.
   */
  it("reads a Paris midnight as that day, not the one before", () => {
    const stored = Math.round(Date.parse("2026-08-21T00:00:00+02:00") / 1000) - EPOCH;
    const got = renderInstant(stored, "_float", true, EPOCH) as { day: string };
    // In Paris this is the 21st. Elsewhere the local day differs, which is the
    // honest answer for a FLOATING date and is asserted per-zone below.
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Paris") {
      expect(got.day).toBe("2026-08-21");
    }
    expect(got.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /** An all-day event carrying a real zone is read in THAT zone, not the reader's. */
  it("honours an explicit zone on an all-day event", () => {
    const stored = Math.round(Date.parse("2026-08-21T00:00:00+09:00") / 1000) - EPOCH;
    const got = renderInstant(stored, "Asia/Tokyo", true, EPOCH);
    expect(got).toEqual({ allDay: true, day: "2026-08-21", timeZone: null });
  });

  it("never infers all-day from the timezone merely being absent", () => {
    // A floating TIMED event is a real thing and must not become all-day.
    const got = renderInstant(appleUtc("2026-08-21T09:00:00Z"), null, false, EPOCH);
    expect(got?.allDay).toBe(false);
  });

  it("returns null for an absent date instead of a bogus 2001 one", () => {
    expect(renderInstant(null, "Europe/Paris", false, EPOCH)).toBeNull();
  });

  /** A calendar's newest row is not "now" — MAX(start_date) reads 2030 here. */
  it("reads a far-future date as that date", () => {
    const got = renderInstant(appleUtc("2030-06-01T10:00:00Z"), "UTC", false, EPOCH);
    expect((got as { iso: string }).iso).toMatch(/^2030-06-01T10:00:00/);
  });
});
