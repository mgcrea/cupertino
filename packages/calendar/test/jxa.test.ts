import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertStaticScript } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import * as write from "../src/client/jxa/write.js";

/**
 * JXA scripts are strings, so nothing else in the toolchain looks at them. A
 * typo becomes a runtime failure against a live Calendar — the most expensive
 * place to find one, and here it would mean a half-written event on a real
 * calendar. `osacompile` catches it for free.
 */
const SCRIPTS = Object.entries(write).filter(([, v]) => typeof v === "string") as [
  string,
  string,
][];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "jxa");

describe("JXA scripts", () => {
  it("found every script", () => {
    expect(SCRIPTS.length).toBe(4);
  });

  it.each(SCRIPTS)("%s passes the interpolation tripwire", (_name, source) => {
    // The guarantee: no caller input is ever interpolated into script text.
    expect(source).not.toContain("${");
    expect(() => assertStaticScript(source)).not.toThrow();
  });

  it.each(SCRIPTS)("%s declares the envelope contract", (_name, source) => {
    expect(source).toContain("function run(argv)");
    expect(source).toContain("JSON.parse(argv[0]");
  });

  /**
   * THE ONE THIS SURFACE GETS WRONG.
   *
   * Calendar.app kept the bundle id it shipped with as iCal, so the display
   * name and the identifier disagree — uniquely among the four surfaces.
   * `runningApplicationsWithBundleIdentifier` does not fold case and
   * `com.apple.Calendar` does not exist, so the plausible spelling makes every
   * write report "Calendar is not running".
   */
  it.each(SCRIPTS)("%s gates on com.apple.iCal, not com.apple.Calendar", (_name, source) => {
    expect(source).toContain('"com.apple.iCal"');
    expect(source).not.toContain("com.apple.Calendar");
    // The scripting name is still "Calendar" — both spellings are correct, in
    // their own places, which is exactly why this is worth pinning.
    expect(source).toContain('Application("Calendar")');
  });

  /**
   * `whose` on events was measured slower AND unstable — 4,564 / 5,290 /
   * 7,303 ms across three runs of the same query — against a steady 3.4 s for a
   * bulk scan. Encoding that as a test rather than a comment means the next
   * person to reach for the "obvious" specifier fails CI instead of shipping it.
   *
   * `whose` on CALENDARS is fine and deliberately allowed: eight of them, not
   * 1,349, so the per-item bridge cost is negligible.
   */
  it.each(SCRIPTS)("%s never uses a whose specifier on events", (_name, source) => {
    expect(source).not.toContain("events.whose");
  });

  /** Writes are deliberate side effects, so they may launch Calendar. */
  it.each(SCRIPTS)("%s is allowed to launch Calendar", (_name, source) => {
    expect(source).toContain("if (!isCalendarRunning() && !true)");
  });

  /**
   * Adding an attendee emails a human. That is not something to do behind a
   * tool call, so it is absent from the scripts as well as from the schemas —
   * two places to remove it rather than one to forget.
   */
  it.each(SCRIPTS)("%s cannot set attendees", (_name, source) => {
    expect(source).not.toContain("attendees");
    expect(source).not.toContain("AttendeeS");
  });

  /**
   * A delete that reports success without deleting is the worst lie this
   * surface could tell, so the exclusion path reads its own work back.
   */
  it("verifies an exclusion actually took, rather than trusting the assignment", () => {
    expect(write.EXCLUDE_OCCURRENCE).toContain("EXCLUSION_NOT_APPLIED");
    expect(write.EXCLUDE_OCCURRENCE).toContain("ev.excludedDates = next");
  });

  /**
   * STRUCTURAL. docs/distribution.md sets the lane policy for new surfaces —
   * file-lane reads, Apple Events for writes only — and docs/calendar.md
   * measured why: 3.4 s for one range query, priced per round trip. A future
   * contributor adding `jxa/read.ts` out of helpfulness would reintroduce a
   * path that cannot work, so the absence is asserted rather than assumed.
   */
  it("has no Apple Events read lane", () => {
    expect(existsSync(join(SRC, "write.ts"))).toBe(true);
    expect(existsSync(join(SRC, "read.ts"))).toBe(false);
  });

  // osacompile only exists on macOS; the rest of the suite is portable.
  const onDarwin = process.platform === "darwin";
  it.skipIf(!onDarwin).each(SCRIPTS)("%s compiles", (name, source) => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-apple-calendar-jxa-"));
    const file = join(dir, `${name}.js`);
    writeFileSync(file, source);
    expect(() =>
      execFileSync("osacompile", ["-l", "JavaScript", "-o", join(dir, "out.scpt"), file], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
