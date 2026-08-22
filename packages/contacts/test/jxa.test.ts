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
 * typo becomes a runtime failure against a live Contacts — the most expensive
 * place to find one, and here it would mean a half-written card in a real
 * person's address book. `osacompile` catches it for free.
 */
const SCRIPTS = Object.entries(write).filter(([, v]) => typeof v === "string") as [
  string,
  string,
][];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "jxa");

describe("JXA scripts", () => {
  it("found every script", () => {
    // Two, and the third's absence is the point — see the delete test below.
    expect(SCRIPTS.length).toBe(2);
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

  it.each(SCRIPTS)("%s compiles", (name, source) => {
    const dir = mkdtempSync(join(tmpdir(), "contacts-jxa-"));
    const file = join(dir, `${name}.js`);
    writeFileSync(file, source);
    expect(() =>
      execFileSync(
        "/usr/bin/osacompile",
        ["-l", "JavaScript", "-o", join(dir, `${name}.scpt`), file],
        {
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });

  /**
   * MEASURED, macOS 26.6: `sdef /System/Applications/Contacts.app` contains the
   * string "delete" ZERO times. The whole command list is make, add, remove and
   * save, and `remove` only takes a person out of a group.
   *
   * Writes go through Apple Events on every surface here because the store is
   * opened `PRAGMA query_only` — Contacts owns it and reconciles it against
   * iCloud. So no dictionary verb means no capability, and a delete script would
   * either not work or work by an undocumented route, on a real person's card.
   */
  it.each(SCRIPTS)("%s never attempts a delete", (_name, source) => {
    expect(source).not.toMatch(/\bdelete\b/i);
  });

  /**
   * The finding that makes this surface unlike Calendar and Reminders: Contacts
   * keeps edits in an unsaved buffer, so a script that mutates and returns
   * without saving reports a success that never reached the store — and its own
   * read-back agrees, because the live object did change.
   */
  it.each(SCRIPTS)("%s saves before it verifies", (_name, source) => {
    expect(source).toContain("C.save()");
    const save = source.indexOf("C.save()");
    const verify = source.lastIndexOf("findPerson(C,");
    expect(verify).toBeGreaterThan(save);
  });

  /**
   * Reads are the file lane's job. Adding writes did not add a read lane, and
   * this is what keeps that a decision rather than something that erodes: the
   * resolver needs a suffix-keyed index over every stored number, which no
   * number of Apple Events round trips can produce.
   */
  it("has no read.ts", () => {
    expect(existsSync(join(SRC, "read.ts"))).toBe(false);
  });

  /**
   * `com.apple.AddressBook`, not `com.apple.Contacts` — the same display-name /
   * bundle-id mismatch Calendar has with `com.apple.iCal`, and a trap this repo
   * has already been caught by once.
   */
  it("targets the right bundle id", () => {
    for (const [, source] of SCRIPTS) {
      expect(source).toContain("com.apple.AddressBook");
      expect(source).not.toContain("com.apple.Contacts");
    }
  });

  /** Bulk-fetch and filter in JS; never `whose`. Measured on three surfaces. */
  it("never uses whose()", () => {
    for (const [, source] of SCRIPTS) expect(source).not.toContain("whose(");
  });
});
