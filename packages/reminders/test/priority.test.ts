import { describe, expect, it } from "vitest";

import {
  PRIORITY_NAMES,
  rank,
  toPriorityName,
  toPriorityValue,
  type PriorityName,
} from "../src/client/priority.js";

/**
 * The dictionary documents `0: no priority, 1–4: high, 5: medium, 6–9: low`.
 * These tests pin the whole range, not just the four values the UI writes,
 * because a reminder synced from another CalDAV client can hold any of them.
 */
describe("toPriorityName", () => {
  it.each([
    [0, "none"],
    [1, "high"],
    [2, "high"],
    [3, "high"],
    [4, "high"],
    [5, "medium"],
    [6, "low"],
    [7, "low"],
    [8, "low"],
    [9, "low"],
  ] as const)("buckets %i as %s", (value, name) => {
    expect(toPriorityName(value)).toBe(name);
  });

  it("treats a missing priority as none", () => {
    expect(toPriorityName(null)).toBe("none");
    expect(toPriorityName(undefined)).toBe("none");
    expect(toPriorityName(Number.NaN)).toBe("none");
  });

  /**
   * A value above the documented range means something was set. Reporting it as
   * "none" would claim the opposite of what the data says, so it buckets low.
   */
  it("does not report an out-of-range value as none", () => {
    expect(toPriorityName(42)).toBe("low");
  });

  it("clamps a negative value to none", () => {
    expect(toPriorityName(-1)).toBe("none");
  });
});

describe("toPriorityValue", () => {
  it("writes the values Reminders itself writes", () => {
    expect(toPriorityValue("none")).toBe(0);
    expect(toPriorityValue("high")).toBe(1);
    expect(toPriorityValue("medium")).toBe(5);
    expect(toPriorityValue("low")).toBe(9);
  });

  /**
   * The property that matters: reading a reminder and writing it straight back
   * must not change its priority. If the canonical values drifted from the
   * bucket boundaries, a round trip would silently rewrite the field.
   */
  it.each(PRIORITY_NAMES)("round-trips %s unchanged", (name: PriorityName) => {
    expect(toPriorityName(toPriorityValue(name))).toBe(name);
  });
});

describe("rank", () => {
  /**
   * Lower is more urgent, except 0 which means "no priority" — so sorting by
   * the raw field puts unprioritised items ahead of high ones.
   */
  it("orders high before medium before low before none", () => {
    const sorted = [5, 0, 9, 1].toSorted((a, b) => rank(a) - rank(b));
    expect(sorted).toEqual([1, 5, 9, 0]);
  });

  it("sorts none last even against an out-of-range value", () => {
    expect(rank(0)).toBeGreaterThan(rank(42));
  });
});
