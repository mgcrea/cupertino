import { describe, expect, it } from "vitest";

import { SUFFIX_DIGITS } from "../src/client/phone.js";
import { resolveHandle, resolveHandles, summarise } from "../src/client/resolve.js";
import type { HandleLookup, IndexContact } from "../src/client/store.js";

const contact = (over: Partial<IndexContact> & { recordPk: number }): IndexContact => ({
  uniqueId: `u${over.recordPk}`,
  firstName: null,
  lastName: null,
  nickname: null,
  organization: null,
  jobTitle: null,
  displayName: "(no name)",
  source: "acct",
  linkId: null,
  isMe: false,
  ...over,
});

/** A lookup built by hand, so these tests need no database and no fixture. */
const lookupOf = (
  people: IndexContact[],
  phones: Record<string, string[]>,
  emails: Record<string, string[]> = {},
): HandleLookup => ({
  byPhone: new Map(Object.entries(phones).map(([k, v]) => [k, new Set(v)])),
  byEmail: new Map(Object.entries(emails).map(([k, v]) => [k, new Set(v)])),
  contacts: new Map(people.map((p) => [`${p.source}:${p.recordPk}`, p])),
  suffixDigits: SUFFIX_DIGITS,
});

describe("resolveHandle", () => {
  const alice = contact({ recordPk: 1, firstName: "Alice", displayName: "Alice" });
  const bob = contact({ recordPk: 2, firstName: "Bob", displayName: "Bob" });

  it("names a handle carried by exactly one contact", () => {
    const lookup = lookupOf([alice], { "612345678": ["acct:1"] });
    const r = resolveHandle("+33612345678", lookup);
    expect(r.status).toBe("resolved");
    expect(r.name).toBe("Alice");
    expect(r.matches).toBe(1);
  });

  /**
   * The headline caveat from docs/contacts.md: about one in six of even the
   * busiest correspondents does not resolve. Unknown must be a normal outcome —
   * not a throw, and not an empty name that reads as a bug.
   */
  it("reports unknown without throwing, and says so in the status", () => {
    const r = resolveHandle("+33600000000", lookupOf([alice], { "612345678": ["acct:1"] }));
    expect(r.status).toBe("unknown");
    expect(r.name).toBeNull();
    expect(r.matches).toBe(0);
  });

  /**
   * Six handles collided at nine digits on the probed store. Guessing one would
   * put the wrong person's name on someone's messages, which is worse than no
   * name because it does not look wrong.
   */
  it("refuses to pick when two different people share a number", () => {
    const lookup = lookupOf([alice, bob], { "612345678": ["acct:1", "acct:2"] });
    const r = resolveHandle("+33612345678", lookup);
    expect(r.status).toBe("ambiguous");
    expect(r.name).toBeNull();
    expect(r.matches).toBe(2);
  });

  /**
   * Contacts routinely stores one number twice — "mobile" and "iPhone". Two rows
   * for one person is not ambiguity, and treating it as such would break the
   * common case.
   */
  it("is not confused by one contact holding the same number twice", () => {
    const lookup = lookupOf([alice], { "612345678": ["acct:1", "acct:1"] });
    expect(resolveHandle("+33612345678", lookup).status).toBe("resolved");
  });

  /**
   * A person in iCloud and in Google is ONE unified card in Contacts.app.
   * Reporting two names would contradict what the user sees.
   */
  it("folds a person held in two accounts on their link id", () => {
    const icloud = contact({ recordPk: 1, displayName: "Alice", source: "icloud", linkId: 77 });
    const google = contact({ recordPk: 9, displayName: "Alice", source: "google", linkId: 77 });
    const lookup: HandleLookup = {
      byPhone: new Map([["612345678", new Set(["icloud:1", "google:9"])]]),
      byEmail: new Map(),
      contacts: new Map([
        ["icloud:1", icloud],
        ["google:9", google],
      ]),
      suffixDigits: SUFFIX_DIGITS,
    };
    const r = resolveHandle("+33612345678", lookup);
    expect(r.status).toBe("resolved");
    expect(r.name).toBe("Alice");
  });

  it("does not fold two different people who merely lack link ids", () => {
    const lookup = lookupOf([alice, bob], { "612345678": ["acct:1", "acct:2"] });
    expect(resolveHandle("+33612345678", lookup).matches).toBe(2);
  });

  it("marks a shortcode rather than calling it unknown", () => {
    const r = resolveHandle("38600", lookupOf([alice], {}));
    expect(r.status).toBe("shortcode");
    expect(r.kind).toBe("shortcode");
  });

  it("resolves an email case-insensitively", () => {
    const lookup = lookupOf([alice], {}, { "alice@example.com": ["acct:1"] });
    expect(resolveHandle("Alice@Example.COM", lookup).name).toBe("Alice");
  });

  /**
   * The index and the query must use the same key length. Binding it to the
   * lookup object is what makes divergence impossible — a mismatch would return
   * nothing and look exactly like an empty address book.
   */
  it("queries with the key length the index was built at", () => {
    const lookup: HandleLookup = {
      ...lookupOf([alice], { "2345678": ["acct:1"] }),
      suffixDigits: 7,
    };
    expect(resolveHandle("+33612345678", lookup).status).toBe("resolved");
  });
});

describe("summarise", () => {
  it("counts every status, including the ones that are not failures", () => {
    const alice = contact({ recordPk: 1, displayName: "Alice" });
    const lookup = lookupOf([alice], { "612345678": ["acct:1"] });
    const out = summarise(resolveHandles(["+33612345678", "+33600000000", "38600"], lookup));
    expect(out).toEqual({ resolved: 1, unknown: 1, ambiguous: 0, shortcode: 1 });
  });
});
