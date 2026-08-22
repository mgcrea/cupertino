import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertStaticScript } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import * as bookmarks from "../src/client/jxa/bookmarks.js";
import * as tabs from "../src/client/jxa/tabs.js";

/**
 * JXA scripts are strings, so nothing else in the toolchain looks at them. A
 * typo becomes a runtime failure against a live Safari — the most expensive
 * place to find one. `osacompile` catches it for free.
 */
const SCRIPTS = [
  ...Object.entries(tabs).filter(([, v]) => typeof v === "string"),
  ...Object.entries(bookmarks).filter(([, v]) => typeof v === "string"),
] as [string, string][];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "jxa");

describe("JXA scripts", () => {
  it("found every script", () => {
    // Two: live tabs, and the bookmark walk. See the write test below for why
    // there is no third.
    expect(SCRIPTS.length).toBe(2);
  });

  it.each(SCRIPTS)("%s passes the interpolation tripwire", (_name, source) => {
    // The guarantee: no caller input is ever interpolated into script text.
    expect(source).not.toContain("${");
    expect(() => assertStaticScript(source)).not.toThrow();
  });

  it.each(SCRIPTS)("%s declares the envelope contract", (_name, source) => {
    expect(source).toContain("function run(argv)");
  });

  // osacompile only exists on macOS; the rest of the suite is portable.
  const onDarwin = process.platform === "darwin";
  it.skipIf(!onDarwin).each(SCRIPTS)("%s compiles", (name, source) => {
    const dir = mkdtempSync(join(tmpdir(), "safari-jxa-"));
    const file = join(dir, `${name}.js`);
    writeFileSync(file, source);
    expect(() =>
      execFileSync(
        "/usr/bin/osacompile",
        ["-l", "JavaScript", "-o", join(dir, `${name}.scpt`), file],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  /**
   * `com.apple.Safari` really is the bundle id — this is one of the few Apple
   * apps whose id matches its display name, unlike `com.apple.iCal`,
   * `com.apple.AddressBook` and `com.apple.MobileSMS`. Pinned anyway, because
   * this repo has been caught by the opposite three times.
   */
  it("uses the scripting name Safari, never a wrong bundle id", () => {
    expect(tabs.LIVE_TABS).toContain('Application("Safari")');
    expect(tabs.LIVE_TABS).not.toContain("com.apple.safari");
  });

  /** Bulk-fetch and filter in JS; never `whose`. Measured on three surfaces. */
  it("never uses whose()", () => {
    for (const [, source] of SCRIPTS) expect(source).not.toContain("whose(");
  });

  /**
   * The third permission state, kept out of the product by keeping the verb
   * out of the code.
   *
   * `do JavaScript` needs "Allow JavaScript from Apple Events" — a Safari
   * developer-menu toggle, not a TCC grant, which `Permissions.swift` has no
   * concept of and whose own state cannot be read (`defaults read
   * com.apple.Safari AllowJavaScriptFromAppleEvents` is itself TCC-protected
   * and returned nothing on the probed machine). A server that shipped this
   * verb would report a healthy surface whose most powerful capability
   * silently fails.
   *
   * The probe attempts it deliberately, to characterise the error. The SERVER
   * must not, and this is what keeps that true.
   */
  it("never calls do JavaScript", () => {
    for (const [, source] of SCRIPTS) {
      expect(source).not.toMatch(/doJavaScript/i);
      expect(source).not.toMatch(/\bdo JavaScript\b/i);
    }
  });

  /**
   * v1 is read-only, and these are the verbs that would change something. All
   * of them navigate a real, visible browser, and docs/safari.md records that
   * no write on this surface was ever probed.
   */
  it("never navigates or mutates", () => {
    for (const [, source] of SCRIPTS) {
      expect(source).not.toMatch(/\.close\(/);
      expect(source).not.toMatch(/setValue|\.delete\(/i);
      // Assigning to a tab's URL is how you navigate somebody's browser.
      expect(source).not.toMatch(/\.url\s*=/);
      expect(source).not.toMatch(/\bmake\b|\bopenLocation\b/i);
    }
  });

  /**
   * The bookmark walk talks to Foundation, not to Safari. That is why it works
   * with Safari closed and needs no Automation grant — it is the file lane,
   * spelled in JXA. If it ever grew an `Application(...)` call that would
   * silently become false.
   */
  it("reads bookmarks without touching Safari", () => {
    expect(bookmarks.BOOKMARKS_WALK).toContain("NSDictionary");
    expect(bookmarks.BOOKMARKS_WALK).not.toContain("Application(");
  });

  /**
   * The Reading List is found by a fixed identifier, never a localised name.
   * Matching a translated "Reading List" would work on exactly one Mac.
   */
  it("identifies the Reading List by its literal key", () => {
    expect(bookmarks.BOOKMARKS_WALK).toContain("com.apple.ReadingList");
  });

  /**
   * Reads are the file lane's job, and adding the tabs lane did not change
   * that. This is what keeps it a decision rather than something that erodes:
   * the history reader needs indexed SQL over 19,329 visits, which no number of
   * Apple Events round trips can produce.
   */
  it("has no history.ts", () => {
    expect(existsSync(join(SRC, "history.ts"))).toBe(false);
  });
});
