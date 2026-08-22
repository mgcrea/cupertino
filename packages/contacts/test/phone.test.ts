import { describe, expect, it } from "vitest";

import {
  digitsOf,
  emailKey,
  handleKind,
  isShortcode,
  SUFFIX_DIGITS,
  suffixKey,
} from "../src/client/phone.js";

describe("suffixKey", () => {
  /**
   * The measurement, encoded. `docs/contacts.md`: exact string equality resolved
   * 3.7% of message traffic and a nine-digit suffix resolved 97.6%, because
   * Contacts stores what the user typed and Messages stores E.164.
   *
   * These three spellings of ONE French mobile must all produce one key. If this
   * ever fails, the resolver silently stops finding anybody.
   */
  it("gives one key to the same number written three ways", () => {
    const keys = new Set(["+33612345678", "06 12 34 56 78", "0612345678"].map((v) => suffixKey(v)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("612345678");
  });

  it("matches a US number across E.164 and national formatting", () => {
    expect(suffixKey("+15551234567")).toBe(suffixKey("(555) 123-4567"));
  });

  /**
   * Nine, not ten. A national French number is ten digits and the same number in
   * E.164 is eleven, so a ten-digit key takes `0612345678` from one side and
   * `3612345678` from the other — which is exactly why the probe measured
   * `last-10` doing no better than plain digits.
   */
  it("explains why ten digits is too many", () => {
    expect(suffixKey("0612345678", 10)).not.toBe(suffixKey("+33612345678", 10));
    expect(suffixKey("0612345678", 9)).toBe(suffixKey("+33612345678", 9));
  });

  it("defaults to nine digits", () => {
    expect(SUFFIX_DIGITS).toBe(9);
    expect(suffixKey("+33612345678")).toHaveLength(9);
  });

  /**
   * A short value gets NO key rather than a short one. A three-digit key would
   * match every number ending in those digits — the exact failure the suffix
   * approach has to be defended against.
   */
  it("refuses to build a key it cannot trust", () => {
    expect(suffixKey("911")).toBeNull();
    expect(suffixKey("38600")).toBeNull();
    expect(suffixKey("")).toBeNull();
  });

  it("ignores punctuation and spacing entirely", () => {
    expect(digitsOf("+33 (0)6-12.34.56.78")).toBe("330612345678");
  });
});

describe("handleKind", () => {
  it("reads an email before it reads digits", () => {
    // An address can contain digits; a phone number can never contain an "@".
    expect(handleKind("user2024@example.com")).toBe("email");
  });

  it("separates shortcodes, which can never be a contact", () => {
    expect(handleKind("38600")).toBe("shortcode");
    expect(isShortcode("38600")).toBe(true);
    // 115 of 958 measured handles were these. Counting them as misses is how a
    // working resolver reports a much worse rate than it earns.
    expect(handleKind("+33612345678")).toBe("phone");
    expect(isShortcode("+33612345678")).toBe(false);
  });
});

describe("emailKey", () => {
  it("folds case and trims", () => {
    expect(emailKey("  User@Example.COM ")).toBe("user@example.com");
  });
});
