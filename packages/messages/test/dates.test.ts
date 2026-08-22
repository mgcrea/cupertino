import { describe, expect, it } from "vitest";

import {
  appleSecondsSql,
  CORE_DATA_EPOCH_OFFSET,
  fromAppleSeconds,
  renderInstant,
  toAppleSeconds,
} from "../src/client/dates.js";

/**
 * The trap this module exists for, from docs/messages.md: every date column is
 * nanoseconds since 2001 — eighteen digits, ~7.9e17, two orders of magnitude
 * past Number.MAX_SAFE_INTEGER. `node:sqlite` THROWS on those, and swallowed by
 * a try/catch the throw is indistinguishable from "this column is empty". The
 * probe reported exactly that for all seven columns across 97,414 messages on
 * its first granted run.
 */
describe("appleSecondsSql", () => {
  it("divides in SQL so the raw integer never reaches JavaScript", () => {
    const sql = appleSecondsSql('m."date"');
    expect(sql).toContain("CAST");
    expect(sql).toContain("1000000000.0");
  });

  /**
   * Messages switched from seconds to nanoseconds around macOS 10.13 and did not
   * rewrite old rows, so a store with history from both eras carries both.
   */
  it("handles both units, because one store holds both", () => {
    const sql = appleSecondsSql("x");
    expect(sql).toContain("CASE WHEN");
    expect(sql).toContain("ELSE CAST(x AS REAL) END");
  });

  it("passes NULL through rather than turning it into 1970", () => {
    expect(appleSecondsSql("x")).toContain("WHEN x IS NULL THEN NULL");
  });
});

describe("apple-seconds conversion", () => {
  it("round-trips a date", () => {
    const d = new Date("2026-08-22T12:34:56.000Z");
    expect(fromAppleSeconds(toAppleSeconds(d))?.toISOString()).toBe(d.toISOString());
  });

  /**
   * The 31-year error. Reading an apple-seconds value as Unix seconds lands in
   * 1995 and still renders as a plausible date, which is what makes it so easy
   * to ship.
   */
  it("anchors on 2001, not 1970", () => {
    expect(CORE_DATA_EPOCH_OFFSET).toBe(978_307_200);
    expect(fromAppleSeconds(0)).toBeNull();
    expect(fromAppleSeconds(1)?.getUTCFullYear()).toBe(2001);
  });

  it("treats null, zero and nonsense as no date", () => {
    expect(fromAppleSeconds(null)).toBeNull();
    expect(fromAppleSeconds(Number.NaN)).toBeNull();
    expect(renderInstant(null)).toBeNull();
  });

  it("renders ISO-8601", () => {
    expect(renderInstant(toAppleSeconds(new Date("2026-01-02T03:04:05.000Z")))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
});
