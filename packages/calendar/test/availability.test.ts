import { describe, expect, it } from "vitest";

import {
  alignUp,
  dayWindows,
  localDay,
  mergeIntervals,
  nextLocalDayMs,
  parseClock,
  startOfLocalDayMs,
  subtractBusy,
  weekdaySet,
  type Interval,
} from "../src/client/availability.js";

/**
 * The interval math, with no store anywhere near it.
 *
 * Every case here is one of the two ways this module can be wrong, and they are
 * not symmetric: reporting time that is booked hands a model a slot to double-
 * book, while hiding time that is free merely makes it ask again. The first is
 * what the assertions are aimed at.
 */

const local = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number =>
  new Date(y, m - 1, d, hh, mm, ss, 0).getTime();

const span = (a: number, b: number): Interval => ({ from: a, to: b });
const render = (list: readonly Interval[]): string[] =>
  list.map(
    (i) =>
      `${new Date(i.from).toTimeString().slice(0, 5)}-${new Date(i.to).toTimeString().slice(0, 5)}`,
  );

describe("parseClock", () => {
  it("reads a time of day", () => {
    expect(parseClock("dayStart", "09:00")).toEqual({ hours: 9, minutes: 0 });
    expect(parseClock("dayStart", "9:30")).toEqual({ hours: 9, minutes: 30 });
  });

  /** The end of the day is a legal end, and the only hour that may exceed 23. */
  it("accepts 24:00 and rejects anything past it", () => {
    expect(parseClock("dayEnd", "24:00")).toEqual({ hours: 24, minutes: 0 });
    expect(() => parseClock("dayEnd", "24:30")).toThrow(/latest time of day/);
    expect(() => parseClock("dayEnd", "25:00")).toThrow(/not a time of day/);
  });

  it("names the field it was given when the value is not a time", () => {
    expect(() => parseClock("dayStart", "morning")).toThrow(/dayStart/);
  });
});

describe("mergeIntervals", () => {
  it("collapses overlapping and touching blocks", () => {
    const merged = mergeIntervals([
      span(local(2026, 8, 24, 10), local(2026, 8, 24, 11)),
      span(local(2026, 8, 24, 10, 30), local(2026, 8, 24, 12)),
      // Touching, not overlapping: no gap exists between these two.
      span(local(2026, 8, 24, 12), local(2026, 8, 24, 13)),
      span(local(2026, 8, 24, 15), local(2026, 8, 24, 16)),
    ]);
    expect(render(merged)).toEqual(["10:00-13:00", "15:00-16:00"]);
  });

  it("sorts input it was given out of order", () => {
    const merged = mergeIntervals([
      span(local(2026, 8, 24, 15), local(2026, 8, 24, 16)),
      span(local(2026, 8, 24, 9), local(2026, 8, 24, 10)),
    ]);
    expect(render(merged)).toEqual(["09:00-10:00", "15:00-16:00"]);
  });

  it("drops zero-length and inverted blocks rather than emitting them", () => {
    const at = local(2026, 8, 24, 10);
    expect(mergeIntervals([span(at, at), span(at + 60_000, at)])).toEqual([]);
  });

  /** A whole meeting inside another one must not extend it. */
  it("does not let a contained block lengthen its container", () => {
    const merged = mergeIntervals([
      span(local(2026, 8, 24, 9), local(2026, 8, 24, 17)),
      span(local(2026, 8, 24, 11), local(2026, 8, 24, 12)),
    ]);
    expect(render(merged)).toEqual(["09:00-17:00"]);
  });
});

describe("subtractBusy", () => {
  const day = span(local(2026, 8, 24, 9), local(2026, 8, 24, 18));

  it("returns the whole window when nothing is booked", () => {
    expect(render(subtractBusy(day, []))).toEqual(["09:00-18:00"]);
  });

  it("cuts a hole for a meeting in the middle", () => {
    const busy = mergeIntervals([span(local(2026, 8, 24, 11), local(2026, 8, 24, 12))]);
    expect(render(subtractBusy(day, busy))).toEqual(["09:00-11:00", "12:00-18:00"]);
  });

  it("clips a meeting that starts before the window opens", () => {
    const busy = mergeIntervals([span(local(2026, 8, 24, 7), local(2026, 8, 24, 10))]);
    expect(render(subtractBusy(day, busy))).toEqual(["10:00-18:00"]);
  });

  it("clips a meeting that runs past the window's close", () => {
    const busy = mergeIntervals([span(local(2026, 8, 24, 17), local(2026, 8, 24, 20))]);
    expect(render(subtractBusy(day, busy))).toEqual(["09:00-17:00"]);
  });

  it("returns nothing when one meeting covers the whole window", () => {
    const busy = mergeIntervals([span(local(2026, 8, 24, 8), local(2026, 8, 24, 19))]);
    expect(subtractBusy(day, busy)).toEqual([]);
  });

  /** Blocks entirely outside the window must not consume any of it. */
  it("ignores blocks on other days", () => {
    const busy = mergeIntervals([
      span(local(2026, 8, 23, 10), local(2026, 8, 23, 11)),
      span(local(2026, 8, 25, 10), local(2026, 8, 25, 11)),
    ]);
    expect(render(subtractBusy(day, busy))).toEqual(["09:00-18:00"]);
  });

  it("leaves no gap between back-to-back meetings", () => {
    const busy = mergeIntervals([
      span(local(2026, 8, 24, 10), local(2026, 8, 24, 11)),
      span(local(2026, 8, 24, 11), local(2026, 8, 24, 12)),
    ]);
    expect(render(subtractBusy(day, busy))).toEqual(["09:00-10:00", "12:00-18:00"]);
  });
});

describe("dayWindows", () => {
  const weekdays = weekdaySet(["mon", "tue", "wed", "thu", "fri"]);
  const hours = { dayStart: { hours: 9, minutes: 0 }, dayEnd: { hours: 18, minutes: 0 } };

  it("emits one window per admitted weekday and skips the weekend", () => {
    // 2026-08-21 is a Friday; 22 and 23 are the weekend.
    const windows = dayWindows({
      from: new Date(local(2026, 8, 21)),
      to: new Date(local(2026, 8, 25, 23, 59)),
      weekdays,
      ...hours,
    });
    expect(windows.map((w) => localDay(w.from))).toEqual([
      "2026-08-21",
      "2026-08-24",
      "2026-08-25",
    ]);
  });

  /** A window opening mid-morning must not reach back to 09:00. */
  it("clips the first window to the requested start", () => {
    const windows = dayWindows({
      from: new Date(local(2026, 8, 24, 11, 20)),
      to: new Date(local(2026, 8, 24, 23, 59)),
      weekdays,
      ...hours,
    });
    expect(render(windows)).toEqual(["11:20-18:00"]);
  });

  it("clips the last window to the requested end", () => {
    const windows = dayWindows({
      from: new Date(local(2026, 8, 24)),
      to: new Date(local(2026, 8, 24, 14, 0)),
      weekdays,
      ...hours,
    });
    expect(render(windows)).toEqual(["09:00-14:00"]);
  });

  it("emits nothing for a day whose working hours are already over", () => {
    const windows = dayWindows({
      from: new Date(local(2026, 8, 24, 19, 0)),
      to: new Date(local(2026, 8, 24, 23, 59)),
      weekdays,
      ...hours,
    });
    expect(windows).toEqual([]);
  });

  /** Overnight hours are not expressible, and must not wrap into the next day. */
  it("emits nothing when dayEnd is not after dayStart", () => {
    const windows = dayWindows({
      from: new Date(local(2026, 8, 24)),
      to: new Date(local(2026, 8, 25, 23, 59)),
      weekdays,
      dayStart: { hours: 22, minutes: 0 },
      dayEnd: { hours: 6, minutes: 0 },
    });
    expect(windows).toEqual([]);
  });

  it("runs to the following midnight when dayEnd is 24:00", () => {
    const windows = dayWindows({
      from: new Date(local(2026, 8, 24)),
      to: new Date(local(2026, 8, 24, 23, 59, 59)),
      weekdays,
      dayStart: { hours: 22, minutes: 0 },
      dayEnd: { hours: 24, minutes: 0 },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.to).toBe(local(2026, 8, 24, 23, 59, 59));
  });
});

describe("alignUp", () => {
  it("rounds a ragged start up to the next boundary", () => {
    expect(alignUp(local(2026, 8, 24, 9, 7), 15)).toBe(local(2026, 8, 24, 9, 15));
    expect(alignUp(local(2026, 8, 24, 9, 31), 30)).toBe(local(2026, 8, 24, 10, 0));
  });

  it("leaves an instant already on a boundary alone", () => {
    expect(alignUp(local(2026, 8, 24, 9, 30), 15)).toBe(local(2026, 8, 24, 9, 30));
  });

  it("drops stray seconds, which are never a meeting start", () => {
    const ragged = new Date(local(2026, 8, 24, 9, 0)).getTime() + 1_000;
    expect(alignUp(ragged, 15)).toBe(local(2026, 8, 24, 9, 15));
  });
});

describe("day boundaries", () => {
  it("finds local midnight either side of an instant", () => {
    const noon = local(2026, 8, 24, 12, 30);
    expect(startOfLocalDayMs(noon)).toBe(local(2026, 8, 24));
    expect(nextLocalDayMs(noon)).toBe(local(2026, 8, 25));
  });

  /**
   * Calendar arithmetic, not +86_400_000. On the day a zone springs forward the
   * next midnight is 23 hours away, and adding a fixed day lands at 01:00 — an
   * hour of the following day that would read as free.
   */
  it("crosses a daylight-saving boundary by day, not by elapsed time", () => {
    const before = startOfLocalDayMs(nextLocalDayMs(local(2026, 3, 28, 12)));
    expect(new Date(before).getHours()).toBe(0);
    expect(new Date(nextLocalDayMs(before)).getHours()).toBe(0);
  });
});
