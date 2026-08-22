import { describe, expect, it } from "vitest";

import { mergeRange } from "../src/client/recurrence.js";
import type { EventRow } from "../src/client/store.js";

const DAY = 86_400;
const T = 800_000_000;

const row = (
  over: Partial<EventRow> & Pick<EventRow, "uuid" | "startApple" | "source">,
): EventRow =>
  ({
    itemPk: 1,
    calendarPk: 1,
    calendarUuid: "CAL-1",
    calendarTitle: "Work",
    summary: "event",
    description: null,
    url: null,
    conferenceUrl: null,
    locationTitle: null,
    endApple: (over.startApple ?? 0) + 3600,
    allDay: false,
    startTz: "_float",
    endTz: null,
    status: null,
    invitationStatus: null,
    availability: null,
    hasRecurrences: false,
    hasAttendees: false,
    origItemPk: null,
    origDateApple: null,
    ...over,
  }) as EventRow;

const merge = (over: Partial<Parameters<typeof mergeRange>[0]> = {}) =>
  mergeRange({
    items: [],
    occurrences: [],
    coverage: { fromApple: T - 400 * DAY, toApple: T + 400 * DAY, rows: 10 },
    hasOccurrenceCache: true,
    fromApple: T,
    toApple: T + 7 * DAY,
    limit: 200,
    epochOffset: 978_307_200,
    ...over,
  });

describe("mergeRange", () => {
  it("keeps every occurrence of a series", () => {
    const got = merge({
      occurrences: [
        row({ uuid: "S", startApple: T, source: "occurrence" }),
        row({ uuid: "S", startApple: T + 7 * DAY, source: "occurrence" }),
        row({ uuid: "S", startApple: T + 14 * DAY, source: "occurrence" }),
      ],
    });
    // Collapsing by uuid would return the weekly standup once. That is the bug
    // the whole two-leg design exists to prevent.
    expect(got.rows).toHaveLength(3);
  });

  /**
   * MEASURED: 456 of 489 cached parents carry NO recurrence rule, so the cache
   * holds ordinary one-shot events too. A plain union double-counts most of a
   * calendar, which makes this dedupe load-bearing rather than defensive.
   */
  it("does not double-count an ordinary event that is also in the cache", () => {
    const got = merge({
      items: [row({ uuid: "E1", startApple: T, source: "item" })],
      occurrences: [row({ uuid: "E1", startApple: T, source: "occurrence" })],
    });
    expect(got.rows).toHaveLength(1);
    // Leg 1 wins: the item row is the current truth, the cache row may be stale.
    expect(got.rows[0]!.source).toBe("item");
  });

  it("sorts the merged result by start", () => {
    const got = merge({
      items: [row({ uuid: "B", startApple: T + 2 * DAY, source: "item" })],
      occurrences: [row({ uuid: "A", startApple: T, source: "occurrence" })],
    });
    expect(got.rows.map((r) => r.uuid)).toEqual(["A", "B"]);
  });

  /**
   * THE DETACHED-OCCURRENCE CASE, and the one a naive key misses.
   *
   * Drag one instance of a series to a new time and Calendar writes a detached
   * item carrying orig_item_id and orig_date. The stale cache row for the
   * ORIGINAL slot may still be there — and because the whole point of the move
   * is that the instants differ, keying on (uuid, start) will not collapse them.
   * Without the orig_date guard the event shows up twice, at both times.
   */
  it("drops the cache row a detached occurrence has replaced", () => {
    const original = T + 2 * DAY;
    const moved = T + 2 * DAY + 3 * 3600;
    const got = merge({
      items: [
        row({
          uuid: "MOVED",
          startApple: moved,
          source: "item",
          itemPk: 42,
          origItemPk: 7,
          origDateApple: original,
        }),
      ],
      occurrences: [row({ uuid: "SERIES", startApple: original, source: "occurrence", itemPk: 7 })],
    });
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]!.uuid).toBe("MOVED");
  });

  it("leaves other occurrences of that same series alone", () => {
    const original = T + 2 * DAY;
    const got = merge({
      items: [
        row({
          uuid: "MOVED",
          startApple: original + 3600,
          source: "item",
          itemPk: 42,
          origItemPk: 7,
          origDateApple: original,
        }),
      ],
      occurrences: [
        row({ uuid: "SERIES", startApple: original, source: "occurrence", itemPk: 7 }),
        row({ uuid: "SERIES", startApple: original + 7 * DAY, source: "occurrence", itemPk: 7 }),
      ],
    });
    expect(got.rows.map((r) => r.uuid).toSorted()).toEqual(["MOVED", "SERIES"]);
  });

  /**
   * REGRESSION, from a live calendar. An all-day event created through this
   * server came back TWICE — once per leg, same uuid, both rendering as the
   * same day, because `start_date` and `occurrence_date` do not hold the
   * identical number for an all-day event. The key renders before comparing.
   */
  it("collapses an all-day event that both legs report with different raw starts", () => {
    const midnight = T;
    const got = merge({
      items: [row({ uuid: "ALLDAY", startApple: midnight, source: "item", allDay: true })],
      occurrences: [
        // Same day, deliberately not the same number.
        row({ uuid: "ALLDAY", startApple: midnight + 37, source: "occurrence", allDay: true }),
      ],
    });
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]!.source).toBe("item");
  });

  /** A timed event still dedupes on the instant, absorbing sub-second wobble. */
  it("collapses a timed duplicate that differs by less than a second", () => {
    const got = merge({
      items: [row({ uuid: "TIMED", startApple: T, source: "item" })],
      occurrences: [row({ uuid: "TIMED", startApple: T + 0.4, source: "occurrence" })],
    });
    expect(got.rows).toHaveLength(1);
  });

  /** But two genuinely different times are still two events. */
  it("keeps two occurrences an hour apart", () => {
    const got = merge({
      occurrences: [
        row({ uuid: "S", startApple: T, source: "occurrence" }),
        row({ uuid: "S", startApple: T + 3600, source: "occurrence" }),
      ],
    });
    expect(got.rows).toHaveLength(2);
  });

  it("counts rows with no usable start instead of losing them quietly", () => {
    const got = merge({
      items: [row({ uuid: "BAD", startApple: null as unknown as number, source: "item" })],
    });
    expect(got.rows).toHaveLength(0);
    expect(got.dropped).toBe(1);
  });
});

describe("the coverage contract", () => {
  it("says nothing is missing when the window sits inside the expansion", () => {
    expect(merge().truncated).toBeUndefined();
    expect(merge().expansion).toBe("expanded");
  });

  /**
   * A short list of events is indistinguishable from a free afternoon, which
   * makes silent truncation the quietest possible failure here. The edge travels
   * with the result instead.
   */
  it("flags a window reaching past the end of the expansion", () => {
    const got = merge({ toApple: T + 900 * DAY });
    expect(got.truncated?.uncoveredToApple).toBe(T + 900 * DAY);
    expect(got.truncated?.affects).toMatch(/repeating events only/);
  });

  it("flags a window reaching before the start of it", () => {
    expect(merge({ fromApple: T - 900 * DAY }).truncated?.uncoveredFromApple).toBe(T - 900 * DAY);
  });

  /**
   * Losing the cache costs the expansion, not the lane. Leg 1 is correct at any
   * horizon, so the honest answer is a degraded result that says so — never a
   * throw, and never a quietly shorter list.
   */
  it("degrades to leg 1 with a reason when there is no cache at all", () => {
    const got = merge({
      hasOccurrenceCache: false,
      items: [row({ uuid: "E1", startApple: T, source: "item" })],
    });
    expect(got.expansion).toBe("unavailable");
    expect(got.rows).toHaveLength(1);
    expect(got.expansionReason).toMatch(/appears once/);
  });

  it("respects the limit after merging, not before", () => {
    const got = merge({
      occurrences: Array.from({ length: 10 }, (_, i) =>
        row({ uuid: "S", startApple: T + i * DAY, source: "occurrence" }),
      ),
      limit: 3,
    });
    expect(got.rows).toHaveLength(3);
  });
});
