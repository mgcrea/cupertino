import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertStaticScript } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import * as read from "../src/client/jxa/read.js";
import * as write from "../src/client/jxa/write.js";

/**
 * JXA scripts are strings, so nothing else in the toolchain looks at them. A
 * typo becomes a runtime failure against a live Reminders, which is the most
 * expensive place to discover one — `osacompile` catches it here for free.
 */
const SCRIPTS = Object.entries({ ...read, ...write }).filter(([, v]) => typeof v === "string") as [
  string,
  string,
][];

describe("JXA scripts", () => {
  it("found every script", () => {
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(9);
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
   * The liveness gate has to name the bundle identifier exactly.
   * `runningApplicationsWithBundleIdentifier` does not fold case, and Notes'
   * neighbouring package uses the capitalised `com.apple.Notes` — copying that
   * spelling here would make every read report "Reminders is not running".
   */
  it.each(SCRIPTS)("%s gates on the correct bundle identifier", (_name, source) => {
    expect(source).toContain('"com.apple.reminders"');
    expect(source).not.toContain("com.apple.Reminders");
  });

  /** Reads must not launch Reminders; writes are allowed to. */
  it.each(Object.entries(read).filter(([, v]) => typeof v === "string") as [string, string][])(
    "%s refuses to launch Reminders",
    (_name, source) => {
      expect(source).toContain("if (!isRemindersRunning() && !false)");
    },
  );

  // osacompile only exists on macOS; the rest of the suite is portable.
  const onDarwin = process.platform === "darwin";
  it.skipIf(!onDarwin).each(SCRIPTS)("%s compiles", (name, source) => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-apple-reminders-jxa-"));
    const file = join(dir, `${name}.js`);
    writeFileSync(file, source);
    expect(() =>
      execFileSync("osacompile", ["-l", "JavaScript", "-o", join(dir, "out.scpt"), file], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
