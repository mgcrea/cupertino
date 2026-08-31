import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertStaticScript } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import * as bookmarks from "../src/client/jxa/bookmarks.js";
import * as tabs from "../src/client/jxa/tabs.js";
import * as writes from "../src/client/jxa/writes.js";

/**
 * JXA scripts are strings, so nothing else in the toolchain looks at them. A
 * typo becomes a runtime failure against a live Safari — the most expensive
 * place to find one. `osacompile` catches it for free.
 */
const strings = (mod: object): [string, string][] =>
  Object.entries(mod).filter(([, v]) => typeof v === "string") as [string, string][];

/**
 * Split, because one assertion below is true of one half and false of the
 * other. Everything else in this file applies to every script.
 */
const READ_SCRIPTS = [...strings(tabs), ...strings(bookmarks)];
const WRITE_SCRIPTS = strings(writes);
const SCRIPTS = [...READ_SCRIPTS, ...WRITE_SCRIPTS];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "jxa");

describe("JXA scripts", () => {
  it("found every script", () => {
    // Two reads — live tabs and the bookmark walk — and two writes: open a URL
    // and add a Reading List item. A fifth appearing without this number
    // changing means a script is not being checked by anything below.
    expect(READ_SCRIPTS.length).toBe(2);
    expect(WRITE_SCRIPTS.length).toBe(2);
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
   * The read scripts stay reads. This used to cover every script in the
   * package, and the write lane is the deliberate exception rather than a
   * relaxation: the same verbs are still forbidden everywhere they were, and
   * are now REQUIRED to appear only in `jxa/writes.ts`.
   */
  it("never navigates or mutates, outside the write scripts", () => {
    for (const [, source] of READ_SCRIPTS) {
      expect(source).not.toMatch(/\.close\(/);
      expect(source).not.toMatch(/setValue|\.delete\(/i);
      // Assigning to a tab's URL is how you navigate somebody's browser.
      expect(source).not.toMatch(/\.url\s*=/);
      expect(source).not.toMatch(/\bmake\b|\bopenLocation\b/i);
    }
  });

  /**
   * The scheme gate, asserted in the script itself and not only in TypeScript.
   *
   * `safari.ts` refuses a non-http(s) URL before any Apple Event is sent, and
   * that is the check which produces a good error message. This is the one that
   * still holds if a future caller reaches these scripts by another path — a
   * `javascript:` URL through a navigation verb is `do JavaScript` by another
   * name, which is the capability this whole surface declines to offer.
   */
  it.each(WRITE_SCRIPTS)("%s refuses a non-http scheme in the script", (_name, source) => {
    expect(source).toContain("BAD_SCHEME");
    expect(source).toContain('indexOf("https://")');
  });

  /**
   * Safari is launched by any Apple Event sent to it, and both write verbs are
   * disclosed as doing so. That disclosure is only honest if the scripts read
   * `running` BEFORE the command that would launch it.
   */
  it.each(WRITE_SCRIPTS)("%s measures whether Safari was already running", (_name, source) => {
    const asked = source.indexOf("S.running()");
    expect(asked).toBeGreaterThan(-1);
    // The first verb that would launch Safari. Read `running` after any of
    // these and the answer is always true, so the disclosure would be a lie
    // that no test on payloads could catch.
    const launches = ["openLocation", "addReadingListItem", "S.Tab(", "currentTab.url ="]
      .map((verb) => source.indexOf(verb))
      .filter((at) => at > -1);
    expect(launches.length).toBeGreaterThan(0);
    expect(asked).toBeLessThan(Math.min(...launches));
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
