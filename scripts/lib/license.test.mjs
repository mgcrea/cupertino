// Tests for the licence key format.
//
// These matter more than most tests here, because the failure modes are silent
// in both directions and both directions are expensive. A verifier that is too
// strict refuses a key somebody paid for, at the exact moment they are least
// willing to be patient. A verifier that is too lax mints money for anyone who
// notices — and since apps/apple/LICENSE §1(c) hands out the source, "anyone"
// includes people reading the algorithm rather than guessing at it.
//
// So every rejection path gets a row, not just the happy one. The tampering
// cases in particular re-encode a payload the way an attacker would — valid
// JSON, plausible claims, original signature — rather than corrupting bytes at
// random, because random corruption fails at JSON.parse and proves nothing about
// the signature check.
//
// `node --test`, no framework: the library is dependency-free on purpose and its
// tests should not be the thing that changes that.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  generateKeypair,
  KEY_PREFIX,
  mint,
  parse,
  PUBLIC_KEY,
  publicKeyOf,
  ulid,
  verifyKey,
} from "./license.mjs";

const keys = generateKeypair();
const other = generateKeypair();

const valid = mint({ email: "buyer@example.com", major: 1, privateKey: keys.privateKey });

/** Re-encode a key's claims without re-signing — what forging one actually looks like. */
const tamper = (key, changes) => {
  const { claims, signature } = parse(key);
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
  return `${KEY_PREFIX}.${payload}.${signature}`;
};

describe("verifyKey accepts what it should", () => {
  it("accepts a freshly minted key", () => {
    const result = verifyKey(valid, { major: 1, publicKey: keys.publicKey });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.claims.email, "buyer@example.com");
    assert.equal(result.claims.major, 1);
  });

  it("accepts a key pasted with surrounding whitespace", () => {
    const pasted = `\n  ${valid}  \n`;
    assert.equal(verifyKey(pasted, { major: 1, publicKey: keys.publicKey }).ok, true);
  });

  it("accepts without a major when the caller does not care", () => {
    assert.equal(verifyKey(valid, { publicKey: keys.publicKey }).ok, true);
  });

  it("round-trips the public key derived from the private half", () => {
    assert.equal(publicKeyOf(keys.privateKey), keys.publicKey);
  });
});

describe("verifyKey refuses what it should", () => {
  const cases = [
    ["a forged email", tamper(valid, { email: "thief@example.com" }), "signature does not match"],
    ["a forged major", tamper(valid, { major: 2 }), "signature does not match"],
    ["a forged id", tamper(valid, { id: "0000000000000000000000000" }), "signature does not match"],
    [
      "a signature from another keypair",
      mint({ email: "buyer@example.com", major: 1, privateKey: other.privateKey }),
      "signature does not match",
    ],
    ["a truncated key", valid.slice(0, valid.length - 10), "signature does not match"],
    ["an empty string", "", "expected three dot-separated parts"],
    ["two segments", "cup1.abc", "expected three dot-separated parts"],
    ["an unknown prefix", valid.replace(/^cup1\./, "cup2."), "unknown key format 'cup2'"],
    ["an empty payload", "cup1..abc", "empty payload or signature"],
  ];

  for (const [label, key, reason] of cases) {
    it(`refuses ${label}`, () => {
      const result = verifyKey(key, { major: 1, publicKey: keys.publicKey });
      assert.equal(result.ok, false, `${label} was accepted`);
      assert.equal(result.reason, reason);
    });
  }

  it("refuses a key verified against the wrong public key", () => {
    const result = verifyKey(valid, { major: 1, publicKey: other.publicKey });
    assert.equal(result.ok, false, "a key verified under a foreign public key was accepted");
    assert.equal(result.reason, "signature does not match");
  });

  it("refuses a revoked licence, and names it", () => {
    const { claims } = parse(valid);
    const result = verifyKey(valid, {
      major: 1,
      publicKey: keys.publicKey,
      revoked: ["some-other-id", claims.id],
    });
    assert.equal(result.ok, false, "a revoked licence was accepted");
    assert.equal(result.reason, `licence ${claims.id} was revoked`);
  });

  it("refuses a key for a different major, and says which", () => {
    const result = verifyKey(valid, { major: 2, publicKey: keys.publicKey });
    assert.equal(result.ok, false, "a 1.x key unlocked a 2.x build");
    assert.equal(result.reason, "key covers 1.x, this build is 2.x");
  });

  it("checks the signature before the revocation list", () => {
    // Otherwise a forged id could be waved through by simply not being on it.
    const forged = tamper(valid, { id: "FORGEDFORGEDFORGEDFORGEDFO" });
    const result = verifyKey(forged, { major: 1, publicKey: keys.publicKey, revoked: [] });
    assert.equal(result.ok, false, "a forged id was accepted because it was not revoked");
  });
});

describe("ulid", () => {
  it("is 26 characters of Crockford base32", () => {
    assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts by issue time", () => {
    const early = ulid(1_000_000_000_000);
    const late = ulid(2_000_000_000_000);
    assert.ok(early < late, `${early} should sort before ${late}`);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => ulid()));
    assert.equal(seen.size, 500);
  });
});

describe("the Swift twin", () => {
  // apps/apple/Cupertino/License.swift makes the same four checks in the same
  // order, against a public key it carries as its own constant. Nothing at build
  // time forces the two to agree, and the failure when they stop agreeing is not
  // subtle — every paid key refused, in a release, with no way to fix it from
  // the server side. So it gets asserted rather than remembered.
  const swift = readFileSync(
    join(import.meta.dirname, "../../apps/apple/Cupertino/License.swift"),
    "utf8",
  );

  it("compiles in the same public key as this file exports", () => {
    const found = swift.match(/static let publicKey = "([^"]*)"/);
    assert.ok(found, "License.swift has no `static let publicKey` to compare against");
    assert.equal(
      found[1],
      PUBLIC_KEY,
      "License.swift and scripts/lib/license.mjs disagree about the public key",
    );
  });

  it("uses the same format prefix", () => {
    const found = swift.match(/static let prefix = "([^"]*)"/);
    assert.ok(found, "License.swift has no `static let prefix`");
    assert.equal(found[1], KEY_PREFIX);
  });
});
