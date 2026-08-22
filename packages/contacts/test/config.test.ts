import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to a read-only, nine-digit, auto-index server", () => {
    const c = loadConfig({});
    expect(c.indexMode).toBe("auto");
    expect(c.phoneSuffixDigits).toBe(9);
    expect(c.allowWrites).toBe(false);
  });

  it("reads every APPLE_CONTACTS_ variable", () => {
    const c = loadConfig({
      APPLE_CONTACTS_INDEX_MODE: "immutable",
      APPLE_CONTACTS_PHONE_SUFFIX_DIGITS: "7",
      APPLE_CONTACTS_STORE: "/tmp/a.abcddb",
      APPLE_CONTACTS_MAX_RESULTS: "25",
    });
    expect(c.indexMode).toBe("immutable");
    expect(c.phoneSuffixDigits).toBe(7);
    expect(c.storePath).toBe("/tmp/a.abcddb");
    expect(c.maxResults).toBe(25);
  });

  /**
   * A key shorter than six digits would match on almost nothing but the tail of
   * a shortcode; longer than fifteen is past E.164's own maximum. Both ends are
   * refused at startup rather than producing silent nonsense per lookup.
   */
  it("refuses a suffix length that cannot work", () => {
    expect(() => loadConfig({ APPLE_CONTACTS_PHONE_SUFFIX_DIGITS: "3" })).toThrow();
    expect(() => loadConfig({ APPLE_CONTACTS_PHONE_SUFFIX_DIGITS: "20" })).toThrow();
  });
});
