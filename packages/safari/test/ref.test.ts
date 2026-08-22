import { describe, expect, it } from "vitest";

import {
  decodeBookmarkRef,
  decodeHistoryRef,
  encodeBookmarkRef,
  encodeHistoryRef,
  InvalidSafariRefError,
} from "../src/client/ref.js";

/**
 * The history ref carries a URL, which makes this codec's tolerance the whole
 * test: a URL is made of exactly the characters a ref format would want to use
 * as separators.
 */
describe("history refs", () => {
  const URLS = [
    "https://example.com/",
    // Query strings: the reason 5 of 28 tabs only matched after stripping one.
    "https://example.com/search?q=a%20b&page=2",
    // A colon after the scheme, and a port. A non-greedy tail would truncate.
    "https://example.com:8443/path",
    // A fragment, and an @ — which is why `@` cannot be a separator here any
    // more than it could be in Calendar's Google-style event uids.
    "https://user@example.com/p#section",
    // Percent-encoding, unicode, and a trailing slash-heavy path.
    "https://en.wikipedia.org/wiki/Caf%C3%A9",
    "https://例え.jp/ページ",
    "file:///Users/someone/Documents/a%20file.html",
    // Pathological but legal: something that looks like another surface's ref.
    "https://example.com/r1:12345",
  ];

  it.each(URLS)("round-trips %s", (url) => {
    expect(decodeHistoryRef(encodeHistoryRef(url))).toBe(url);
  });

  it("tolerates a ref pasted with surrounding whitespace", () => {
    expect(decodeHistoryRef("  s1:https://example.com/  ")).toBe("https://example.com/");
  });

  /**
   * The payload is NOT parsed. A ref whose URL contains something that looks
   * like structure must survive intact rather than being split on it.
   */
  it("never parses inside the payload", () => {
    const weird = "https://example.com/a/b/c?x=s1:nested";
    expect(decodeHistoryRef(encodeHistoryRef(weird))).toBe(weird);
  });

  it.each(["", "s1:", "https://example.com/", "S1:https://example.com/"])("rejects %s", (raw) => {
    expect(() => decodeHistoryRef(raw)).toThrow(InvalidSafariRefError);
  });
});

describe("bookmark refs", () => {
  it("round-trips a UUID", () => {
    const uuid = "1D0F9E2A-4B5C-4D6E-8F70-112233445566";
    expect(decodeBookmarkRef(encodeBookmarkRef(uuid))).toBe(uuid);
  });

  it("round-trips the URL fallback used when a node has no UUID", () => {
    const url = "https://example.com/no-uuid?a=b";
    expect(decodeBookmarkRef(encodeBookmarkRef(url))).toBe(url);
  });

  it("rejects a history ref", () => {
    expect(() => decodeBookmarkRef("s1:https://example.com/")).toThrow(InvalidSafariRefError);
  });
});

/**
 * Refs from other surfaces must not decode here, and the error has to SAY so.
 * A model handed "that is not a history ref" retries with a search; one handed
 * a generic parse failure tries the same ref again.
 */
describe("cross-surface refs", () => {
  const FOREIGN: [string, string][] = [
    ["c1:cal/-/evt", "Calendar"],
    ["r1:12345", "Reminders"],
    ["k1:acct/42", "Contacts"],
    ["m1:ABC-DEF", "Messages"],
    ["mc1:iMessage;-;+15551234567", "Messages"],
  ];

  it.each(FOREIGN)("%s is refused and named as %s", (ref, surface) => {
    expect(() => decodeHistoryRef(ref)).toThrow(InvalidSafariRefError);
    try {
      decodeHistoryRef(ref);
    } catch (err) {
      expect((err as Error).message).toContain(surface);
    }
  });

  it("tells the two Safari kinds apart by name", () => {
    try {
      decodeHistoryRef("sb1:1D0F9E2A");
    } catch (err) {
      expect((err as Error).message).toContain("BOOKMARK ref");
    }
    try {
      decodeBookmarkRef("s1:https://example.com/");
    } catch (err) {
      expect((err as Error).message).toContain("HISTORY ref");
    }
  });
});
