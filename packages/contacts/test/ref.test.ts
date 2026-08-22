import { describe, expect, it } from "vitest";

import { decodeRef, encodeRef, InvalidContactRefError, REF_VERSION } from "../src/client/ref.js";

describe("contact refs", () => {
  it("round-trips", () => {
    expect(decodeRef(encodeRef("icloud", 42))).toEqual({ source: "icloud", recordPk: 42 });
  });

  it("carries the version prefix", () => {
    expect(encodeRef("icloud", 1).startsWith(`${REF_VERSION}:`)).toBe(true);
  });

  /**
   * The account label is a directory name — a UUID on the probed machine — and a
   * rowid is unique only within one database. Anchoring the pk as the tail is
   * what lets the label contain anything, including a separator.
   */
  it("survives an account label containing a slash", () => {
    expect(decodeRef(encodeRef("weird/label", 7))).toEqual({ source: "weird/label", recordPk: 7 });
  });

  it("handles the UUID labels the sources actually use", () => {
    const uuid = "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5A6B";
    expect(decodeRef(encodeRef(uuid, 420)).source).toBe(uuid);
  });

  it("rejects malformed refs", () => {
    for (const bad of ["", "k1:", "k1:acct/", "k1:acct/abc", "k1:acct/0", "acct/1"]) {
      expect(() => decodeRef(bad)).toThrow(InvalidContactRefError);
    }
  });

  /** A ref from another surface gets told which one, rather than a bare parse error. */
  it("recognises refs belonging to other surfaces", () => {
    expect(() => decodeRef("c1:cal/-/uid")).toThrow(/Calendar/);
    expect(() => decodeRef("r1:123")).toThrow(/Reminders/);
  });
});
