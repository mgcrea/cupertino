import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/** `loadConfig` takes an env object so these are hermetic — no process.env mutation. */
describe("loadConfig", () => {
  it("defaults writes off", () => {
    expect(loadConfig({}).allowWrites).toBe(false);
  });

  it.each([["1"], ["true"], ["yes"], ["on"]])("treats %s as enabling writes", (v) => {
    expect(loadConfig({ APPLE_CALENDAR_ALLOW_WRITES: v }).allowWrites).toBe(true);
  });

  /**
   * A calendar has no natural "everything" answer, so a range query that names
   * only a start needs a bounded default. Seven days is a week's view.
   */
  it("bounds an open-ended range at a week", () => {
    expect(loadConfig({}).defaultRangeDays).toBe(7);
  });

  it("clamps how far a single query may reach", () => {
    expect(loadConfig({}).maxRangeDays).toBe(366);
    expect(loadConfig({ APPLE_CALENDAR_MAX_RANGE_DAYS: "30" }).maxRangeDays).toBe(30);
  });

  /**
   * Calendars are a separate allowlist from accounts on purpose: a work
   * calendar and a personal one routinely live in the same account, so the
   * account is the wrong unit to scope by whenever scoping is the point.
   */
  it("splits the calendar allowlist independently of accounts", () => {
    const c = loadConfig({ APPLE_CALENDAR_CALENDARS: " Work , Personal " });
    expect(c.calendars).toEqual(["Work", "Personal"]);
    expect(c.accounts).toEqual([]);
  });

  it("hides declined and cancelled events by default, matching what Calendar shows", () => {
    const c = loadConfig({});
    expect(c.includeDeclined).toBe(false);
    expect(c.includeCancelled).toBe(false);
  });

  /**
   * Validated at load rather than at render time. A bad zone should fail once,
   * at startup, naming the variable — not once per event, deep in a listing.
   */
  it("accepts a real IANA zone", () => {
    expect(loadConfig({ APPLE_CALENDAR_TIMEZONE: "Europe/Paris" }).timeZone).toBe("Europe/Paris");
  });

  it("rejects a zone that is not one", () => {
    expect(() => loadConfig({ APPLE_CALENDAR_TIMEZONE: "Middle/Earth" })).toThrow();
  });

  it("leaves the zone unset when nothing is given, meaning the system zone", () => {
    expect(loadConfig({}).timeZone).toBeUndefined();
  });
});
