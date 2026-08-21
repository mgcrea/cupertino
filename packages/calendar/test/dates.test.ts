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

/** Apple-seconds for a given UTC instant, which is how the store holds them. */
const appleUtc = (iso: string) => Math.round(new Date(iso).getTime() / 1000) - EPOCH;

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
   * THE ALL-DAY TRAP, and the single most likely way this surface goes quietly
   * wrong. An all-day event names a DAY, and the stored value is anchored at
   * midnight UTC — so local getters land on the PREVIOUS day for every zone at a
   * negative offset, which is the whole Americas. The day string is therefore
   * derived from UTC components, never local ones.
   *
   * This assertion proves nothing on a machine already in UTC, which is why the
   * suite is run under four zones:
   *
   *     for tz in UTC America/Los_Angeles Pacific/Auckland Asia/Kolkata; do
   *       TZ=$tz npx vitest run test/dates.test.ts
   *     done
   */
  it("gives an all-day event a bare day and no zone", () => {
    const got = renderInstant(appleUtc("2026-08-21T00:00:00Z"), "_float", true, EPOCH);
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
