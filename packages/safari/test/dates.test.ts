import { CORE_DATA_EPOCH_OFFSET } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import {
  parseDate,
  parseRange,
  renderInstant,
  resolveEpoch,
  toStoreTime,
} from "../src/client/dates.js";
import { InvalidDateError } from "../src/client/errors.js";

/** A Wednesday, so "last monday" and "next monday" are both unambiguous. */
const NOW = new Date(2026, 7, 19, 14, 30, 0, 0); // 2026-08-19T14:30 local

describe("input grammar", () => {
  it("reads an ISO date as a whole day", () => {
    const d = parseDate("from", "2026-08-20", NOW);
    expect(d.kind).toBe("allDay");
    expect(d.at.getFullYear()).toBe(2026);
    expect(d.at.getHours()).toBe(0);
  });

  it("reads an ISO date-time as an instant", () => {
    const d = parseDate("from", "2026-08-20T09:00", NOW);
    expect(d.kind).toBe("timed");
    expect(d.at.getHours()).toBe(9);
  });

  it("honours an explicit offset as the instant it names", () => {
    const d = parseDate("from", "2026-08-20T09:00:00Z", NOW);
    expect(d.at.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("rejects a day that does not exist", () => {
    expect(() => parseDate("from", "2026-02-30", NOW)).toThrow(InvalidDateError);
  });

  /**
   * The difference from every other surface in this repo: history points
   * backwards, so the offset grammar is SIGNED and the past-tense words exist.
   */
  it("accepts a negative offset", () => {
    const d = parseDate("from", "-7d", NOW);
    expect(d.at.getDate()).toBe(12);
    expect(d.at.getMonth()).toBe(7);
  });

  it("still accepts a positive offset", () => {
    expect(parseDate("to", "+1w", NOW).at.getDate()).toBe(26);
  });

  it("reads yesterday", () => {
    const d = parseDate("from", "yesterday", NOW);
    expect(d.kind).toBe("allDay");
    expect(d.at.getDate()).toBe(18);
  });

  /**
   * Symmetry with "next monday", which is +7 on a Monday rather than +0. "last
   * monday" on a Monday is -7 for the same reason: both name a different day
   * from today, or the word does no work.
   */
  it("reads last <weekday> strictly in the past", () => {
    expect(parseDate("from", "last monday", NOW).at.getDate()).toBe(17);
    expect(parseDate("from", "last wednesday", NOW).at.getDate()).toBe(12);
  });

  it("reads next <weekday> strictly in the future", () => {
    expect(parseDate("to", "next monday", NOW).at.getDate()).toBe(24);
    expect(parseDate("to", "next wednesday", NOW).at.getDate()).toBe(26);
  });

  it("names the offending field in the error", () => {
    try {
      parseDate("from", "sometime last year", NOW);
    } catch (err) {
      expect((err as Error).message).toContain("from");
      // The whole grammar travels with the rejection, so a model retrying on
      // the next turn has what it needs rather than guessing again.
      expect((err as Error).message).toContain("-7d");
      expect((err as Error).message).toContain("last monday");
    }
  });
});

/**
 * DST. Day and week offsets are calendar arithmetic; hour and minute offsets
 * are elapsed time. Reversing the two drifts every bound by an hour twice a
 * year, which is the kind of bug nobody reports because it looks like nothing.
 */
describe("DST", () => {
  // Europe/Paris springs forward 2026-03-29. Only meaningful when the suite
  // runs in a zone that observes it, so the assertion is on the RELATIONSHIP
  // rather than on an absolute hour.
  const before = new Date(2026, 2, 30, 12, 0, 0, 0);

  it("keeps wall-clock time across -1d", () => {
    const d = parseDate("from", "-1d", before);
    expect(d.at.getHours()).toBe(before.getHours());
    expect(d.at.getMinutes()).toBe(before.getMinutes());
  });

  it("keeps elapsed time across -24h", () => {
    const d = parseDate("from", "-24h", before);
    expect(before.getTime() - d.at.getTime()).toBe(24 * 3_600_000);
  });
});

describe("parseRange", () => {
  const OPTS = { defaultRangeDays: 30, maxRangeDays: 3_660 };

  /** Backwards by default — the mirror image of Calendar's forward window. */
  it("defaults to a window ending now and reaching back", () => {
    const r = parseRange(OPTS, NOW);
    expect(r.to.getTime()).toBe(NOW.getTime());
    expect(r.from.getTime()).toBeLessThan(NOW.getTime());
    const days = (r.to.getTime() - r.from.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it("resolves a bare day to the whole day on each edge", () => {
    const r = parseRange({ ...OPTS, from: "2026-08-01", to: "2026-08-02" }, NOW);
    expect(r.from.getHours()).toBe(0);
    expect(r.to.getHours()).toBe(23);
  });

  it("refuses a backwards range", () => {
    expect(() => parseRange({ ...OPTS, from: "2026-08-10", to: "2026-08-01" }, NOW)).toThrow(
      InvalidDateError,
    );
  });

  /**
   * Clamping keeps the RECENT edge. A history query that is too wide almost
   * always wants the newest rows; trimming the other way would answer "what did
   * I read this week" with results from a decade ago.
   */
  it("clamps the far edge and says so", () => {
    const r = parseRange({ ...OPTS, from: "1990-01-01", maxRangeDays: 365 }, NOW);
    expect(r.clamped).toBe(true);
    expect(r.to.getTime()).toBe(NOW.getTime());
    expect((r.to.getTime() - r.from.getTime()) / 86_400_000).toBeCloseTo(365, 0);
  });
});

/**
 * The epoch. This is the part specific to Safari, and it exists because the
 * first granted probe run misread `visit_time` by 31 years.
 */
describe("epoch detection", () => {
  const NOW_MS = Date.UTC(2026, 7, 19);

  it("recognises apple-seconds", () => {
    const appleNow = NOW_MS / 1000 - CORE_DATA_EPOCH_OFFSET;
    const e = resolveEpoch(appleNow, NOW_MS);
    expect(e.offset).toBe(CORE_DATA_EPOCH_OFFSET);
    expect(e.confident).toBe(true);
  });

  it("recognises unix seconds", () => {
    const e = resolveEpoch(NOW_MS / 1000, NOW_MS);
    expect(e.offset).toBe(0);
    expect(e.confident).toBe(true);
  });

  /**
   * The load-bearing case. `detectEpoch` always returns an offset — it falls
   * back to unix when nothing fits — so the offset alone cannot distinguish
   * "measured as unix" from "gave up". Rendering the second as the first is
   * precisely the 31-year error this module exists to prevent.
   */
  it("is NOT confident when nothing fits", () => {
    // Nanoseconds: what the buggy probe run reported. Neither reading lands
    // anywhere near now.
    const e = resolveEpoch(7.9e17, NOW_MS);
    expect(e.confident).toBe(false);
  });

  it("is not confident with no rows", () => {
    expect(resolveEpoch(null, NOW_MS).confident).toBe(false);
  });

  it("withholds dates rather than guessing when not confident", () => {
    const e = resolveEpoch(7.9e17, NOW_MS);
    // A perfectly ordinary-looking number still renders as null, because a
    // timestamp wrong by decades reads exactly like a correct one.
    expect(renderInstant(800_000_000, e)).toBeNull();
  });

  it("renders through a confident epoch", () => {
    const e = resolveEpoch(NOW_MS / 1000 - CORE_DATA_EPOCH_OFFSET, NOW_MS);
    const iso = renderInstant(NOW_MS / 1000 - CORE_DATA_EPOCH_OFFSET, e);
    expect(iso).toBe(new Date(NOW_MS).toISOString());
  });

  it("round-trips a bound through toStoreTime", () => {
    const e = resolveEpoch(NOW_MS / 1000 - CORE_DATA_EPOCH_OFFSET, NOW_MS);
    const d = new Date(NOW_MS);
    expect(renderInstant(toStoreTime(d, e), e)).toBe(d.toISOString());
  });
});
