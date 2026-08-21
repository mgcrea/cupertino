// The envelope-first rule, mostly.
//
// The subtle failure this guards is not a malformed payload — it is a perfectly
// good one for an event type we do not handle. Validating the whole event with a
// single schema would call `payment_intent.succeeded` malformed, answer 400, and
// put Stripe into the same three-day retry loop that a genuinely broken payload
// deserves. So the envelope must accept anything Stripe sends, and only the
// session shape may be strict.

import { describe, expect, it } from "vitest";

import {
  charge,
  checkoutSession,
  dispute,
  eventEnvelope,
  isFullyRefunded,
  resendRequest,
} from "../src/schema";

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

describe("isFullyRefunded", () => {
  // The partial case is the whole reason this is a function. `charge.refunded`
  // fires for a two-euro goodwill refund exactly as it does for the full amount,
  // and treating the two alike would take a licence away from someone who still
  // owns it.
  const cases: [string, { amount?: number; amount_refunded?: number }, boolean][] = [
    ["a full refund", { amount: 1499, amount_refunded: 1499 }, true],
    [
      "an over-refund, which Stripe permits with fees",
      { amount: 1499, amount_refunded: 1500 },
      true,
    ],
    ["a partial refund", { amount: 1499, amount_refunded: 200 }, false],
    ["a refund of nothing", { amount: 1499, amount_refunded: 0 }, false],
    ["no refund field at all", { amount: 1499 }, false],
    ["a zero-amount charge", { amount: 0, amount_refunded: 0 }, false],
    ["nothing known", {}, false],
  ];

  for (const [label, input, expected] of cases) {
    it(`${expected ? "revokes" : "leaves alone"}: ${label}`, () => {
      expect(isFullyRefunded({ id: "ch_1", ...input })).toBe(expected);
    });
  }
});

describe("charge and dispute", () => {
  it("accepts a charge carrying the payment intent a licence is matched by", () => {
    const result = charge.safeParse({
      id: "ch_1",
      payment_intent: "pi_1",
      amount: 1499,
      amount_refunded: 1499,
    });
    expect(result.success && result.data.payment_intent).toBe("pi_1");
  });

  it("accepts a charge with no payment intent, so the handler can say so", () => {
    // Refusing here would 400 and make Stripe retry something unfixable. The
    // handler answers 200 with an explanation instead.
    expect(charge.safeParse({ id: "ch_1", amount: 1499 }).success).toBe(true);
  });

  it("reads a dispute outcome", () => {
    const result = dispute.safeParse({ id: "dp_1", payment_intent: "pi_1", status: "won" });
    expect(result.success && result.data.status).toBe("won");
  });

  it("rejects a charge with no id", () => {
    expect(charge.safeParse({ amount: 1499 }).success).toBe(false);
  });
});
