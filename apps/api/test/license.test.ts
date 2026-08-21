// The Worker mints; Node and Swift verify. This is where that is proved.
//
// Three implementations of one format is a standing invitation to drift, and
// drift here is expensive in a specific way: keys minted after the drift verify
// fine, keys minted before it stop, and nobody notices until a customer writes
// in. So the assertion is not "the Node side accepts what the Worker made" — it
// is the stronger one, that both produce the SAME BYTES from the same inputs.
// Anything weaker would pass while the two quietly diverged on field order.

import { describe, expect, it } from "vitest";

import { generateKeypair, mint as mintOnNode, verifyKey } from "../../../scripts/lib/license.mjs";
import { mint, ulid } from "../src/license";

const keys = generateKeypair();
const fixed = {
  email: "buyer@example.com",
  id: "01M0J9C6A6FAPTWE8BJB0D0Z1R",
  issuedAt: "2026-08-21T12:00:00.000Z",
  major: 1,
};

describe("mint", () => {
  it("produces a key the Node implementation accepts", async () => {
    const minted = await mint({ ...fixed, privateKey: keys.privateKey });
    const check = verifyKey(minted.key, { major: 1, publicKey: keys.publicKey });
    expect(check.reason).toBe("");
    expect(check.ok).toBe(true);
    expect(check.claims?.email).toBe("buyer@example.com");
  });

  it("produces byte-identical output to the Node implementation", async () => {
    const here = await mint({ ...fixed, privateKey: keys.privateKey });
    const there = mintOnNode({ ...fixed, privateKey: keys.privateKey });
    expect(here.key).toBe(there);
  });

  it("carries the id and issuedAt it was given", async () => {
    const minted = await mint({ ...fixed, privateKey: keys.privateKey });
    expect(minted.id).toBe(fixed.id);
    expect(minted.issuedAt).toBe(fixed.issuedAt);
  });

  it("generates its own id and timestamp when not given them", async () => {
    const minted = await mint({ email: "a@b.c", major: 1, privateKey: keys.privateKey });
    expect(minted.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Number.isFinite(Date.parse(minted.issuedAt))).toBe(true);
    expect(verifyKey(minted.key, { major: 1, publicKey: keys.publicKey }).ok).toBe(true);
  });

  it("is refused by the wrong public key", async () => {
    const other = generateKeypair();
    const minted = await mint({ ...fixed, privateKey: keys.privateKey });
    expect(verifyKey(minted.key, { major: 1, publicKey: other.publicKey }).ok).toBe(false);
  });
});

describe("ulid", () => {
  it("matches the Node alphabet and length", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts by issue time", () => {
    expect(ulid(1_000_000_000_000) < ulid(2_000_000_000_000)).toBe(true);
  });
});
