// Tests for the encryption verdict.
//
// This file exists because of the asymmetry in what it decides. `classifySamples`
// returning ENCRYPTED on a legible store kills the `home` surface before anyone
// writes a line of it, and the failure is INVISIBLE: a verdict is a word, it
// looks equally confident either way, and nobody re-derives it by hand. That is
// the same shape as the three Maps failures — a negative produced by a broken
// instrument, read as a fact about the store.
//
// So every threshold in blob-stats.mjs gets a fixture here with a KNOWN answer.
//
// `node --test`, no framework, matching probe-kit.test.mjs.

import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import { describe, it } from "node:test";
import { gzipSync, deflateSync } from "node:zlib";

import {
  byteStats,
  classifySamples,
  containerOf,
  entropyOf,
  longestPrintableRun,
  magicPolicy,
  printableRatio,
  RANDOM_PRINTABLE_BASELINE,
  MIN_ENTROPY_BYTES,
  expectedEntropy,
} from "./blob-stats.mjs";

/**
 * Prose, the thing a legible accessory record looks like from the outside.
 *
 * Deliberately NOT one phrase repeated: gzip crushes a repeated phrase to a
 * hundred bytes, and a hundred-byte fixture cannot exercise the high-entropy
 * path it was written to exercise.
 */
const WORDS =
  "the kitchen ceiling light bedroom thermostat front door lock garage sensor hallway lamp office fan porch camera attic heater studio blind patio switch cellar plug landing outlet nursery shade pantry".split(
    " ",
  );
let seed = 12_345;
const nextRandom = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
const prose = (n) => {
  seed = 12_345;
  let s = "";
  while (s.length < n) s += `${WORDS[Math.floor(nextRandom() * WORDS.length)]} `;
  return Buffer.from(s.slice(0, n), "utf8");
};

/** A bplist-shaped payload: a real header, names in the clear, binary framing. */
const bplistish = (n) => {
  const body = prose(n);
  const out = Buffer.alloc(body.length + 8);
  Buffer.from("bplist00", "ascii").copy(out, 0);
  body.copy(out, 8);
  // The object headers and offset table a real bplist interleaves between its
  // string values. The strings themselves stay contiguous, which is the point.
  for (let i = 8; i < out.length; i += 48) out[i] = 0xd1;
  return out;
};

/** Genuine AES-CTR ciphertext, not randomBytes pretending to be some. */
const ciphertext = (n) => {
  const cipher = createCipheriv("aes-256-ctr", randomBytes(32), randomBytes(16));
  return Buffer.concat([cipher.update(prose(n)), cipher.final()]);
};

describe("byte statistics", () => {
  it("puts the random printable baseline where the maths does", () => {
    // 95 graphic bytes + tab, newline, carriage return = 98 of 256.
    assert.equal(RANDOM_PRINTABLE_BASELINE, 98 / 256);
    const r = printableRatio(randomBytes(20_000));
    assert.ok(Math.abs(r - RANDOM_PRINTABLE_BASELINE) < 0.02, `ratio ${r}`);
  });

  it("reports entropy near 8 for random bytes and low for prose", () => {
    assert.ok(entropyOf(randomBytes(8192)) > 7.9);
    assert.ok(entropyOf(prose(8192)) < 5);
  });

  it("is bounded by length, which is why short blobs cannot be judged", () => {
    // THE TRAP: an 8-byte buffer cannot exceed 3 bits however random it is.
    assert.ok(entropyOf(randomBytes(8)) <= 3);
    assert.equal(byteStats(randomBytes(8)).tooShortForEntropy, true);
    assert.equal(byteStats(randomBytes(MIN_ENTROPY_BYTES)).tooShortForEntropy, false);
  });

  it("separates prose from ciphertext by run EXCESS, not by a flat run length", () => {
    // The flat threshold this replaced was wrong: random data's longest run
    // grows with length, so ciphertext at 32 KB routinely beats any constant a
    // 512-byte sample would suggest.
    assert.ok(longestPrintableRun(prose(4096)) > 40);
    assert.ok(
      longestPrintableRun(ciphertext(32_768)) > 6,
      "the flat <=6 rule would have failed here",
    );
    assert.ok(byteStats(ciphertext(32_768)).runExcess < 8);
    assert.ok(byteStats(prose(4096)).runExcess > 1000);
  });

  it("expects less than 8 bits of entropy from a short random sample", () => {
    // 7.28, not 8, at 256 bytes — a classifier demanding 7.8 calls real
    // ciphertext "unknown" at every small size.
    assert.ok(Math.abs(expectedEntropy(256) - 7.28) < 0.02);
    assert.ok(byteStats(ciphertext(512)).entropyDeficit < 0.15);
  });

  it("recognises the containers this repo already decodes", () => {
    assert.equal(containerOf(gzipSync(prose(512))), "gzip");
    assert.equal(containerOf(deflateSync(prose(512))), "zlib");
    assert.equal(containerOf(bplistish(512)), "bplist");
    assert.equal(containerOf(ciphertext(4096).subarray(0, 8)), null);
  });
});

const many = (make, n = 12) => Array.from({ length: n }, () => make());

describe("classifySamples", () => {
  it("calls real ciphertext ENCRYPTED", () => {
    const r = classifySamples(many(() => ciphertext(4096)));
    assert.equal(r.verdict, "ENCRYPTED");
    assert.equal(r.compressed, false);
  });

  it("calls prose PLAINTEXT", () => {
    assert.equal(classifySamples(many(() => prose(2048))).verdict, "PLAINTEXT");
  });

  it("calls a bplist carrying names PLAINTEXT", () => {
    assert.equal(classifySamples(many(() => bplistish(2048))).verdict, "PLAINTEXT");
  });

  it("does NOT call gzipped prose encrypted — the caveat this file exists for", () => {
    // Gzipped text sits at the same entropy as ciphertext. Without the inflate
    // attempt this is the verdict that would kill a perfectly legible surface.
    const samples = many(() => gzipSync(prose(65_536)));
    assert.ok(entropyOf(samples[0]) > 7.0, "fixture must actually be high-entropy");
    const r = classifySamples(samples);
    assert.equal(r.verdict, "COMPRESSED-NOT-ENCRYPTED");
    assert.equal(r.compressed, true);
    assert.match(r.reason, /INFLATED/);
  });

  it("re-verdicts on the inflated bytes, so compressed ciphertext still reads ENCRYPTED", () => {
    const r = classifySamples(many(() => gzipSync(ciphertext(4096))));
    assert.equal(r.verdict, "ENCRYPTED");
  });

  it("calls uniform short blobs SHORT-FIXED-WIDTH, not UNKNOWN", () => {
    // Core Data stores a uuid as 16 raw bytes. On the first real HomeKit run
    // dozens of columns were exactly this, and reporting them as UNKNOWN buried
    // the few columns that genuinely had not decided.
    const r = classifySamples(many(() => randomBytes(16)));
    assert.equal(r.verdict, "SHORT-FIXED-WIDTH");
    assert.match(r.reason, /exactly 16 B/);
  });

  it("still returns UNKNOWN for short samples of RAGGED width", () => {
    const r = classifySamples([randomBytes(9), randomBytes(31), randomBytes(17)]);
    assert.equal(r.verdict, "UNKNOWN");
    assert.match(r.reason, /short/);
  });

  it("returns UNKNOWN when the samples disagree", () => {
    const r = classifySamples([prose(2048), ciphertext(4096), prose(2048)]);
    assert.equal(r.verdict, "UNKNOWN");
  });

  it("has no verdict at all without samples", () => {
    assert.equal(classifySamples([]).verdict, "UNKNOWN");
  });
});

describe("magicPolicy — the privacy guard on first bytes", () => {
  it("shows a magic that is uniform across the sample", () => {
    const p = magicPolicy([byteStats(bplistish(512)), byteStats(bplistish(600))]);
    assert.equal(p.show, true);
    assert.match(p.reason, /uniform/);
  });

  it("WITHHOLDS differing magics — they are user data or an IV", () => {
    const p = magicPolicy([byteStats(ciphertext(4096)), byteStats(ciphertext(4096))]);
    assert.equal(p.show, false);
    assert.equal(p.magic, undefined);
    assert.match(p.reason, /withheld/);
  });
});
