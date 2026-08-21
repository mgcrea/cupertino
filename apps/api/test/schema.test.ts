// The envelope-first rule, mostly.
//
// The subtle failure this guards is not a malformed payload — it is a perfectly
// good one for an event type we do not handle. Validating the whole event with a
// single schema would call `payment_intent.succeeded` malformed, answer 400, and
// put Stripe into the same three-day retry loop that a genuinely broken payload
// deserves. So the envelope must accept anything Stripe sends, and only the
// session shape may be strict.

import { describe, expect, it } from "vitest";

import { checkoutSession, eventEnvelope, resendRequest } from "../src/schema";

describe("eventEnvelope", () => {
  it("accepts an event type this Worker does not handle", () => {
    const other = { type: "payment_intent.succeeded", data: { object: { id: "pi_1", odd: true } } };
    expect(eventEnvelope.safeParse(other).success).toBe(true);
  });

  it("rejects something that is not an event at all", () => {
    expect(eventEnvelope.safeParse({ hello: "world" }).success).toBe(false);
    expect(eventEnvelope.safeParse(null).success).toBe(false);
  });
});

describe("checkoutSession", () => {
  const good = {
    id: "cs_test_1",
    amount_total: 1499,
    currency: "eur",
    payment_status: "paid",
    customer_details: { email: "buyer@example.com" },
  };

  it("accepts a full session", () => {
    expect(checkoutSession.safeParse(good).success).toBe(true);
  });

  it("accepts one with everything optional missing", () => {
    expect(checkoutSession.safeParse({ id: "cs_test_2" }).success).toBe(true);
  });

  it("names the field when the id is missing", () => {
    const result = checkoutSession.safeParse({ ...good, id: undefined });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(["id"]);
  });
});

describe("resendRequest", () => {
  it("lowercases and trims, so it matches how the webhook stored it", () => {
    const result = resendRequest.safeParse({ email: "  Buyer@Example.COM " });
    expect(result.success && result.data.email).toBe("buyer@example.com");
  });

  const bad: [string, unknown][] = [
    ['a bare at-sign, which includes("@") used to accept', { email: "@" }],
    ["an address over the RFC 5321 limit", { email: `${"a".repeat(320)}@example.com` }],
    ["a non-string", { email: 42 }],
    ["a missing field", {}],
    ["ten megabytes of nonsense", { email: "x".repeat(10_000_000) }],
  ];

  for (const [label, input] of bad) {
    it(`refuses ${label}`, () => {
      expect(resendRequest.safeParse(input).success).toBe(false);
    });
  }
});
