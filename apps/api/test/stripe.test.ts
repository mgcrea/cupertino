// Everything a forged webhook could try.
//
// This endpoint mints licences from an unauthenticated POST, so the signature
// check is the only thing between a stranger and free keys. It is also hand-
// written rather than taken from the Stripe SDK, which means the usual comfort
// of "the library handles it" does not apply and each rule needs its own row.

import { describe, expect, it } from "vitest";

import { verifySignature } from "../src/stripe";

const SECRET = "whsec_test_0123456789";
const BODY = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const NOW = 1_800_000_000_000;

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

const sign = async (body: string, secret: string, atMs: number): Promise<string> => {
  const t = Math.floor(atMs / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
};

describe("verifySignature", () => {
  it("matches an HMAC computed outside this file", async () => {
    // Everything else here signs with the same primitive it verifies with, which
    // would pass even if both sides were wrong in the same way. This vector was
    // produced independently and pins the scheme to real HMAC-SHA256 over
    // `<timestamp>.<body>`.
    const header =
      "t=1800000000,v1=faa576380036361b78ae4433782fa5440b4f26d5b735d272cfe3c9873e3d3af7";
    expect(await verifySignature(BODY, header, SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts a genuine signature", async () => {
    const result = await verifySignature(BODY, await sign(BODY, SECRET, NOW), SECRET, NOW);
    expect(result).toEqual({ ok: true });
  });

  it("accepts when several v1 signatures are present and one matches", async () => {
    const header = `${await sign(BODY, SECRET, NOW)},v1=${"0".repeat(64)}`;
    expect((await verifySignature(BODY, header, SECRET, NOW)).ok).toBe(true);
  });

  const refusals: [string, () => Promise<string | null> | string | null, string][] = [
    ["a missing header", () => null, "no Stripe-Signature header"],
    [
      "a header with no timestamp",
      () => `v1=${"0".repeat(64)}`,
      "no timestamp in the signature header",
    ],
    ["a header with no v1", () => "t=1800000000", "no v1 signature in the header"],
    ["a non-numeric timestamp", () => `t=soon,v1=${"0".repeat(64)}`, "timestamp is not a number"],
    ["a wrong signature", () => sign(BODY, "whsec_wrong", NOW), "no signature matches"],
    [
      "a v0 signature only",
      async () => (await sign(BODY, SECRET, NOW)).replace("v1=", "v0="),
      "no v1 signature in the header",
    ],
  ];

  for (const [label, header, reason] of refusals) {
    it(`refuses ${label}`, async () => {
      const result = await verifySignature(BODY, await header(), SECRET, NOW);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe(reason);
    });
  }

  it("refuses a replayed signature outside the tolerance", async () => {
    const result = await verifySignature(
      BODY,
      await sign(BODY, SECRET, NOW - 400_000),
      SECRET,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/tolerance is 300s/);
  });

  it("refuses a body edited after signing", async () => {
    const header = await sign(BODY, SECRET, NOW);
    const tampered = BODY.replace("evt_1", "evt_2");
    expect((await verifySignature(tampered, header, SECRET, NOW)).ok).toBe(false);
  });
});
