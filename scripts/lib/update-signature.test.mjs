// Tests for the update-signature check `make appcast` runs before writing a feed.
// Identical in armada, bastion and cupertino, like the two files they test.
//
// The failure this guards against ships green. A signature made by the wrong key
// is still 88 characters of base64, the feed still passes xmllint, the release
// still publishes, and only an installed copy notices, by refusing the update.
// A verifier that answers true for everything, or wraps the raw key wrongly and
// throws for everything, looks the same from the Makefile until the day it
// matters. So the fixtures are known answers from RFC 8032, fresh keypairs
// generated per run (a private key in a fixture is a private key in the
// repository), and the mismatches the check exists to catch.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_KEY_PATTERN,
  SIGNATURE_PATTERN,
  verifyUpdateSignature,
} from "./update-signature.mjs";

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(scripts);

const hex = (value) => Buffer.from(value, "hex");
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/** A fresh keypair: the public half as SUPublicEDKey carries it, and a signer. */
const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = /** @type {string} */ (publicKey.export({ format: "jwk" }).x);
  return {
    publicKey: base64(Buffer.from(x, "base64url")),
    sign: (/** @type {Uint8Array} */ data) => base64(sign(null, data, privateKey)),
  };
};

describe("verifyUpdateSignature", () => {
  const archive = Buffer.from("not a real zip, but bytes all the same");
  const ours = keypair();
  const theirs = keypair();

  it("accepts RFC 8032's first two Ed25519 test vectors, raw key and all", () => {
    // Bytes no code in this process produced, so a wrong SPKI header cannot hide
    // behind Node exporting and re-importing its own key. Section 7.1, TEST 1
    // (the empty message) and TEST 2 (one byte, 0x72).
    const vectors = [
      {
        data: Buffer.alloc(0),
        publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        signature:
          "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
          "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
      },
      {
        data: hex("72"),
        publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
        signature:
          "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
          "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
      },
    ];
    for (const vector of vectors) {
      const valid = verifyUpdateSignature({
        data: vector.data,
        publicKey: base64(hex(vector.publicKey)),
        signature: base64(hex(vector.signature)),
      });
      assert.equal(valid, true, vector.publicKey);
    }
  });

  it("accepts a signature made by the matching key", () => {
    const signature = ours.sign(archive);
    assert.equal(
      verifyUpdateSignature({ data: archive, signature, publicKey: ours.publicKey }),
      true,
    );
  });

  it("refuses the right key's signature over different bytes", () => {
    const signature = ours.sign(archive);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] ^= 1;
    assert.equal(
      verifyUpdateSignature({ data: tampered, signature, publicKey: ours.publicKey }),
      false,
    );
  });

  it("refuses a well-formed signature made by any other key", () => {
    // The case this exists for: CI handed a private key that is not the other
    // half of the SUPublicEDKey compiled into the app.
    const signature = theirs.sign(archive);
    assert.equal(
      verifyUpdateSignature({ data: archive, signature, publicKey: ours.publicKey }),
      false,
    );
  });

  it("throws on a signature or a key that is not one, rather than answering false", () => {
    const signature = ours.sign(archive);
    for (const bad of [
      `${signature}\n${signature}`,
      `${signature}\n`,
      `sparkle:edSignature="${signature}" length="${archive.length}"`,
      signature.slice(0, -2),
      "",
    ]) {
      assert.throws(
        () => verifyUpdateSignature({ data: archive, signature: bad, publicKey: ours.publicKey }),
        TypeError,
        JSON.stringify(bad),
      );
    }
    for (const bad of [
      ours.publicKey.slice(0, -1),
      `${ours.publicKey}\n`,
      base64(Buffer.alloc(33)),
      "REPLACE_WITH_REAL_KEY",
      "",
    ]) {
      assert.throws(
        () => verifyUpdateSignature({ data: archive, signature, publicKey: bad }),
        TypeError,
        JSON.stringify(bad),
      );
    }
  });
});

describe("the shapes", () => {
  it("anchors both patterns to the whole value", () => {
    const signature = `${"A".repeat(86)}==`;
    assert.match(signature, SIGNATURE_PATTERN);
    assert.doesNotMatch(`${signature}\n${signature}`, SIGNATURE_PATTERN);
    assert.doesNotMatch(`x${signature}`, SIGNATURE_PATTERN);
    assert.doesNotMatch(`${"A".repeat(43)}==`, PUBLIC_KEY_PATTERN);
  });

  it("accepts the SUPublicEDKey committed in this repository's Info.plist", () => {
    // Found by suffix, so the same file works in all three repositories.
    const apple = join(root, "apps/apple");
    const plist = readdirSync(apple).find((name) => name.endsWith("-Info.plist"));
    assert.ok(plist, `no *-Info.plist in ${apple}`);
    const text = readFileSync(join(apple, plist), "utf8");
    const key = /<key>SUPublicEDKey<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
    assert.ok(key, `no SUPublicEDKey in ${plist}`);
    assert.match(key, PUBLIC_KEY_PATTERN);
  });
});

describe("verify-update-signature.mjs", () => {
  const cli = join(scripts, "verify-update-signature.mjs");
  const dir = mkdtempSync(join(tmpdir(), "verify-update-signature-"));
  const zip = join(dir, "App.zip");
  const data = Buffer.from("the stapled zip");
  writeFileSync(zip, data);
  after(() => rmSync(dir, { recursive: true, force: true }));

  const ours = keypair();
  const theirs = keypair();
  const run = (/** @type {string[]} */ ...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }).status;

  it("exits 0 for the app's own key and 1 for any other key", () => {
    const signature = ours.sign(data);
    assert.equal(run(zip, signature, ours.publicKey), 0);
    assert.equal(run(zip, signature, theirs.publicKey), 1);
  });

  it("exits 2 on a malformed value, an unreadable archive, or a missing argument", () => {
    const signature = ours.sign(data);
    assert.equal(run(zip, "not-a-signature", ours.publicKey), 2);
    assert.equal(run(zip, signature, "not-a-key"), 2);
    assert.equal(run(join(dir, "missing.zip"), signature, ours.publicKey), 2);
    assert.equal(run(zip, signature), 2);
    assert.equal(run(), 2);
  });
});
