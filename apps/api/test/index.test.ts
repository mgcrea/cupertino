// The handlers, end to end, against real SQLite and the real migrations.
//
// Everything else under test/ checks a part: the HMAC, the key bytes, a schema.
// This is where the decisions are checked, the ones that decide whether a
// paying customer gets one email, none, or two, and whether a refunded key is
// handed out again. Each describe block is a behaviour that has been wrong at
// least once, in this Worker or in a sibling's.
//
// It runs in Node rather than workerd: the pool that would run it inside workerd
// is not a dependency here, and the handlers only need what Node also provides
// (fetch primitives, WebCrypto with Ed25519). D1 is test/d1.mjs, and the Email
// Service is a recorder that takes long enough to send for two requests to
// overlap.

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { generateKeypair } from "../../../scripts/lib/license.mjs";
import worker from "../src/index";
import { createD1 } from "./d1.mjs";

const keys = generateKeypair();
const SECRET = "whsec_handlers_0123456789";
const PRICE = "price_cupertino";
const BUYER = "buyer@example.com";

/** WebCrypto rather than node:crypto, so this file needs no Node type roots. */
const hmacHex = async (secret: string, message: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const setup = (overrides: Record<string, unknown> = {}) => {
  const d1 = createD1();
  const sent: string[] = [];
  const waiting: Promise<unknown>[] = [];
  const state = { failSends: false };
  const env = {
    DB: d1.binding,
    EMAIL: {
      send: async (message: { to: string }) => {
        // Long enough that a second request reaches its own send first.
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (state.failSends) throw new Error("E_SENDER_NOT_VERIFIED");
        sent.push(message.to);
        return { messageId: `m${sent.length}` };
      },
    },
    CURRENT_MAJOR: "1",
    EXPECTED_PRICE_ID: PRICE,
    LICENSE_FROM_EMAIL: "licences@example.com",
    SITE_URL: "https://example.com",
    LICENSE_SIGNING_KEY: keys.privateKey,
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_SECRET_KEY: "",
    ...overrides,
  } as unknown as Env;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void waiting.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const call = (request: Request) => worker.fetch(request, env, ctx);

  const post = async (body: string, secret = SECRET): Promise<Response> => {
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
    return call(
      new Request("https://api.test/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body,
      }),
    );
  };

  const event = (type: string, object: unknown) =>
    post(JSON.stringify({ id: `evt_${Math.random()}`, type, livemode: true, data: { object } }));

  return { d1, sent, waiting, state, env, call, post, event };
};

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_1",
  amount_total: 1499,
  currency: "eur",
  payment_status: "paid",
  payment_intent: "pi_1",
  customer_details: { email: BUYER },
  metadata: { price_id: PRICE },
  ...overrides,
});

const fullRefund = { id: "ch_1", payment_intent: "pi_1", amount: 1499, amount_refunded: 1499 };

/** Move the last send out of the cooldown, as if Stripe redelivered an hour later. */
const anHourLater = (d1: ReturnType<typeof createD1>) =>
  d1.sql("UPDATE licenses SET last_sent_at = ?", new Date(Date.now() - 3_600_000).toISOString());

const revocation = (t: ReturnType<typeof setup>) =>
  t.d1.sql("SELECT revoked_at IS NOT NULL AS revoked, revoked_reason FROM licenses")[0];

const thanks = (t: ReturnType<typeof setup>, id = "cs_1") =>
  t.call(new Request(`https://api.test/thanks?session_id=${id}`));

const resend = (t: ReturnType<typeof setup>, email: string, type = "application/json") =>
  t.call(
    new Request("https://api.test/license/resend", {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify({ email }),
    }),
  );

let errors: MockInstance<(...data: unknown[]) => void>;

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const logged = (): string =>
  errors.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");

describe("fulfilment", () => {
  it("mints, records and mails a paid session", async () => {
    const t = setup();
    const response = await t.event("checkout.session.completed", session());
    expect(response.status).toBe(200);
    expect(t.sent).toEqual([BUYER]);
    expect(t.d1.sql("SELECT email, payment_intent, price_id FROM licenses")).toEqual([
      { email: BUYER, payment_intent: "pi_1", price_id: PRICE },
    ]);
  });

  it("sends ONE email when two deliveries of the same session race", async () => {
    const t = setup();
    const answers = await Promise.all([
      t.event("checkout.session.completed", session()),
      t.event("checkout.session.completed", session()),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(t.d1.sql("SELECT id FROM licenses")).toHaveLength(1);
    expect(t.sent).toEqual([BUYER]);
  });

  it("gives the send back when the email fails, so Stripe's retry sends it", async () => {
    const t = setup();
    t.state.failSends = true;
    expect((await t.event("checkout.session.completed", session())).status).toBe(500);
    expect(t.d1.sql("SELECT last_sent_at FROM licenses")).toEqual([{ last_sent_at: null }]);

    t.state.failSends = false;
    expect((await t.event("checkout.session.completed", session())).status).toBe(200);
    expect(t.sent).toEqual([BUYER]);
  });

  it("does not re-send a licence that has been refunded", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    await t.event("charge.refunded", fullRefund);
    anHourLater(t.d1);

    const redelivered = await t.event("checkout.session.completed", session());
    expect(redelivered.status).toBe(200);
    expect(await redelivered.text()).toMatch(/revoked/);
    expect(t.sent).toEqual([BUYER]);
  });

  it("ignores another product's sale without minting", async () => {
    const t = setup();
    const response = await t.event(
      "checkout.session.completed",
      session({ metadata: { price_id: "price_bastion" } }),
    );
    expect(response.status).toBe(200);
    expect(t.d1.sql("SELECT id FROM licenses")).toHaveLength(0);
    expect(t.sent).toEqual([]);
  });
});

describe("price lookup", () => {
  const noPrice = session({ metadata: {} });

  it("answers 500 and mints nothing when the lookup throws with a key configured", async () => {
    const t = setup({ STRIPE_SECRET_KEY: "rk_live_lookup" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network connection lost");
    });
    const response = await t.event("checkout.session.completed", noPrice);
    expect(response.status).toBe(500);
    expect(t.d1.sql("SELECT id FROM licenses")).toHaveLength(0);
    expect(t.sent).toEqual([]);
    expect(logged()).not.toContain("rk_live_lookup");
  });

  it("answers 500 when Stripe answers with an error, then fulfils on the retry", async () => {
    const t = setup({ STRIPE_SECRET_KEY: "rk_live_lookup" });
    vi.stubGlobal("fetch", async () => new Response("overloaded", { status: 503 }));
    expect((await t.event("checkout.session.completed", noPrice)).status).toBe(500);

    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ data: [{ price: { id: PRICE } }] })),
    );
    expect((await t.event("checkout.session.completed", noPrice)).status).toBe(200);
    expect(t.d1.sql("SELECT price_id FROM licenses")).toEqual([{ price_id: PRICE }]);
    expect(t.sent).toEqual([BUYER]);
  });

  it("still refuses another product's price once the lookup answers", async () => {
    const t = setup({ STRIPE_SECRET_KEY: "rk_live_lookup" });
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ data: [{ price: { id: "price_bastion" } }] })),
    );
    expect((await t.event("checkout.session.completed", noPrice)).status).toBe(200);
    expect(t.d1.sql("SELECT id FROM licenses")).toHaveLength(0);
  });

  it("with no key configured, fulfils a session whose price is unknown, as before", async () => {
    const t = setup({ STRIPE_SECRET_KEY: "" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("no key is configured, so nothing should be fetched");
    });
    expect((await t.event("checkout.session.completed", noPrice)).status).toBe(200);
    expect(t.d1.sql("SELECT price_id FROM licenses")).toEqual([{ price_id: "" }]);
    expect(t.sent).toEqual([BUYER]);
  });
});

describe("signed payloads that no retry can fix answer 200", () => {
  const cases: [string, string][] = [
    ["a body that is not JSON", "this is not json"],
    ["JSON that is not a Stripe event", JSON.stringify({ hello: "world" })],
    [
      "a session with no id",
      JSON.stringify({ type: "checkout.session.completed", data: { object: { amount_total: 1 } } }),
    ],
    [
      "a paid session with no email",
      JSON.stringify({
        type: "checkout.session.completed",
        data: { object: session({ customer_details: null }) },
      }),
    ],
    ["a charge with no id", JSON.stringify({ type: "charge.refunded", data: { object: {} } })],
    [
      "a dispute with no id",
      JSON.stringify({ type: "charge.dispute.created", data: { object: {} } }),
    ],
    [
      "a closed dispute with no id",
      JSON.stringify({ type: "charge.dispute.closed", data: { object: {} } }),
    ],
  ];

  for (const [label, body] of cases) {
    it(label, async () => {
      const t = setup();
      const response = await t.post(body);
      expect(response.status).toBe(200);
      expect(errors).toHaveBeenCalled();
      expect(t.d1.sql("SELECT id FROM licenses")).toHaveLength(0);
    });
  }

  it("while a bad signature is still a 400, and says nothing about why", async () => {
    const t = setup();
    const response = await t.post(JSON.stringify({ type: "x", data: { object: {} } }), "whsec_no");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid signature");
    expect(logged()).toMatch(/no signature matches/);
  });
});

describe("revocation", () => {
  it("restores a licence a won dispute had revoked", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    await t.event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1" });
    expect(revocation(t)).toEqual({ revoked: 1, revoked_reason: "disputed" });

    await t.event("charge.dispute.closed", { id: "dp_1", payment_intent: "pi_1", status: "won" });
    expect(revocation(t)).toEqual({ revoked: 0, revoked_reason: null });
  });

  it("keeps a REFUNDED licence revoked when a dispute on the same charge is won", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    await t.event("charge.refunded", fullRefund);
    await t.event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1" });
    await t.event("charge.dispute.closed", { id: "dp_1", payment_intent: "pi_1", status: "won" });
    expect(revocation(t)).toEqual({ revoked: 1, revoked_reason: "refunded" });
  });

  it("keeps a licence revoked when the dispute is lost", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    await t.event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1" });
    await t.event("charge.dispute.closed", { id: "dp_1", payment_intent: "pi_1", status: "lost" });
    expect(revocation(t)).toEqual({ revoked: 1, revoked_reason: "disputed" });
  });

  it("never matches a licence recorded with no payment intent", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session({ payment_intent: null }));
    const response = await t.event("charge.refunded", { ...fullRefund, payment_intent: null });
    expect(await response.text()).toMatch(/nothing revoked/);
    expect(t.d1.sql("SELECT payment_intent, revoked_at FROM licenses")).toEqual([
      { payment_intent: "", revoked_at: null },
    ]);
  });
});

describe("/thanks", () => {
  it("waits when the webhook has not landed yet", async () => {
    expect((await thanks(setup())).status).toBe(202);
  });

  it("shows the key of a live licence", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    const [row] = t.d1.sql("SELECT key FROM licenses");
    const response = await thanks(t);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(String(row?.key));
  });

  it("hides the key of a refunded licence and says why", async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    await t.event("charge.refunded", fullRefund);
    const [row] = t.d1.sql("SELECT key FROM licenses");
    const page = await (await thanks(t)).text();
    expect(page).not.toContain(String(row?.key));
    expect(page).toMatch(/refunded/);
  });
});

describe("configuration", () => {
  it("answers 500 naming a missing webhook secret, before reading anything", async () => {
    const t = setup({ STRIPE_WEBHOOK_SECRET: "" });
    const response = await t.post(JSON.stringify({ type: "x", data: { object: {} } }), SECRET);
    expect(response.status).toBe(500);
    expect(logged()).toMatch(/STRIPE_WEBHOOK_SECRET is not set/);
  });

  it("answers 500 naming a malformed webhook secret, without its value", async () => {
    const malformed = "sk_live_pasted_into_the_wrong_slot";
    const t = setup({ STRIPE_WEBHOOK_SECRET: malformed });
    const response = await t.post(JSON.stringify({ type: "x", data: { object: {} } }), malformed);
    expect(response.status).toBe(500);
    expect(logged()).toMatch(/STRIPE_WEBHOOK_SECRET/);
    expect(logged()).not.toContain(malformed);
    expect(await response.text()).not.toContain(malformed);
  });

  it("answers 500 naming a missing signing key, and mints nothing", async () => {
    const t = setup({ LICENSE_SIGNING_KEY: "" });
    const response = await t.event("checkout.session.completed", session());
    expect(response.status).toBe(500);
    expect(logged()).toMatch(/LICENSE_SIGNING_KEY is not set/);
    expect(t.d1.sql("SELECT id FROM licenses")).toHaveLength(0);
  });

  it("answers 500 naming a malformed signing key, without its value", async () => {
    const malformed = "not*base64*at*all";
    const t = setup({ LICENSE_SIGNING_KEY: malformed });
    const response = await t.event("checkout.session.completed", session());
    expect(response.status).toBe(500);
    expect(logged()).toMatch(/LICENSE_SIGNING_KEY/);
    expect(logged()).not.toContain(malformed);
    expect(await response.text()).not.toContain(malformed);
  });
});

describe("/license/resend", () => {
  const customer = async () => {
    const t = setup();
    await t.event("checkout.session.completed", session());
    anHourLater(t.d1);
    t.sent.length = 0;
    return t;
  };

  it("refuses a body that is not declared as JSON with 415", async () => {
    const t = await customer();
    const response = await resend(t, BUYER, "text/plain");
    expect(response.status).toBe(415);
    await Promise.all(t.waiting);
    expect(t.sent).toEqual([]);
  });

  it("answers before the send, and sends after", async () => {
    const t = await customer();
    const response = await resend(t, BUYER, "application/json; charset=utf-8");
    expect(await response.json()).toEqual({ ok: true });
    expect(t.sent).toEqual([]);
    await Promise.all(t.waiting);
    expect(t.sent).toEqual([BUYER]);
  });

  it("answers a stranger exactly as it answers a customer", async () => {
    const t = await customer();
    const response = await resend(t, "stranger@example.com");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await Promise.all(t.waiting);
    expect(t.sent).toEqual([]);
  });

  it("keeps the per-address cooldown, even for requests that overlap", async () => {
    const t = await customer();
    await Promise.all([resend(t, BUYER), resend(t, BUYER)]);
    await Promise.all(t.waiting);
    await resend(t, BUYER);
    await Promise.all(t.waiting);
    expect(t.sent).toEqual([BUYER]);
  });
});
