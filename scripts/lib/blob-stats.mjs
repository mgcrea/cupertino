// Byte-level statistics for deciding whether a store's payload is legible.
//
// This lives in its own tested file rather than inside `scripts/probe-home.mjs`
// because of what it decides. For the prospective `home` surface the question
// "is this ciphertext" is the whole go/no-go: if HomeKit keeps accessory and
// room names as sealed blobs with the key in the keychain, there is no surface,
// and this repo does not touch the keychain. An untested entropy function that
// reads plaintext as ciphertext kills a surface by arithmetic — which is the
// "declared impossible three times" failure that nearly lost Maps, wearing a
// new costume.
//
// THE CENTRAL CAVEAT, stated once here and repeated in every report that uses
// this file: HIGH ENTROPY DOES NOT DISTINGUISH ENCRYPTED FROM COMPRESSED. Both
// sit at 7.9-8.0 bits per byte. The only thing that separates them is a
// recognised container header and a successful inflate, which is why
// `classifySamples` tries to decompress before it concludes anything.
//
// Nothing here ever returns the bytes it was given. Callers report statistics.

import { gunzipSync, inflateSync } from "node:zlib";

/** Printable ASCII, plus the three whitespace bytes real text actually contains. */
const isPrintable = (b) => (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * A random byte string is ~37% printable by chance: 98 of 256 values pass the
 * test above. So "more than a third printable" is the NULL hypothesis, not
 * evidence of text, and any threshold has to sit well clear of it.
 */
export const RANDOM_PRINTABLE_BASELINE = 98 / 256;

/**
 * Containers worth naming on sight. A magic on this list is Apple's or the
 * format's, never the user's, so it is safe to print even when it differs
 * between rows.
 */
const CONTAINERS = [
  { name: "bplist", bytes: [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30] },
  { name: "gzip", bytes: [0x1f, 0x8b] },
  { name: "zlib", bytes: [0x78, 0x9c] },
  { name: "zlib-best", bytes: [0x78, 0xda] },
  { name: "typedstream", bytes: [0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61] },
  { name: "sqlite", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65] },
  { name: "xml", bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c] },
  { name: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { name: "protobuf-ish", bytes: [0x0a] },
];

const startsWith = (buf, bytes) =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

export const containerOf = (buf) => CONTAINERS.find((c) => startsWith(buf, c.bytes))?.name ?? null;

/**
 * Shannon entropy in bits per byte.
 *
 * BOUNDED BY LENGTH, which is the trap: an 8-byte buffer cannot exceed 3 bits
 * however random it is, so a short blob always reads as low-entropy and a naive
 * caller concludes "plaintext". `classifySamples` refuses to call anything
 * encrypted below MIN_ENTROPY_BYTES for exactly this reason.
 */
export const entropyOf = (buf) => {
  if (!buf.length) return 0;
  const hist = new Uint32Array(256);
  for (const b of buf) hist[b] += 1;
  let bits = 0;
  for (const n of hist) {
    if (!n) continue;
    const p = n / buf.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * The longest unbroken run of printable bytes — the most discriminating cheap
 * statistic there is, and the one that survives when entropy cannot decide.
 *
 * A protobuf or bplist carrying names has long runs, because the names are in
 * there verbatim. Ciphertext only reaches a long run by chance.
 *
 * BUT THE THRESHOLD CANNOT BE A CONSTANT, which is what the first version of
 * this file got wrong. The longest run in random data GROWS WITH LENGTH —
 * measured over 200 AES-CTR samples per size, the median ran 6 at 512 B, 8 at
 * 4 KB and 10 at 32 KB, with a maximum of 18. A flat "<= 6 means encrypted"
 * therefore reads a 32 KB ciphertext blob as legible. Every threshold here is
 * instead expressed as a distance from what random data would do at THAT length
 * (see `expectedLongestRun`), so the test is the same test at every size.
 */
export const longestPrintableRun = (buf) => {
  let best = 0;
  let run = 0;
  for (const b of buf) {
    if (isPrintable(b)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
};

export const printableRatio = (buf) => {
  if (!buf.length) return 0;
  let n = 0;
  for (const b of buf) if (isPrintable(b)) n += 1;
  return n / buf.length;
};

export const distinctBytes = (buf) => {
  const seen = new Uint8Array(256);
  let n = 0;
  for (const b of buf) {
    if (!seen[b]) {
      seen[b] = 1;
      n += 1;
    }
  }
  return n;
};

/**
 * What random bytes would score, at this length. Both statistics below are
 * length-dependent, and comparing a short blob against a long blob's expectation
 * is how a classifier invents a finding.
 */
const P_PRINTABLE = RANDOM_PRINTABLE_BASELINE;

/** Expected longest printable run in n random bytes: log base (1/p) of n(1-p). */
export const expectedLongestRun = (n) =>
  n < 2 ? 0 : Math.log(n * (1 - P_PRINTABLE)) / Math.log(1 / P_PRINTABLE);

/**
 * Expected Shannon entropy of n random bytes, which is NOT 8 — a finite sample
 * under-counts by roughly (k-1)/(2n ln2) for k=256 symbols. At 256 bytes that
 * is 7.28, not 8, and a classifier demanding 7.8 calls real ciphertext
 * "unknown" for every short blob.
 */
export const expectedEntropy = (n) => (n < 2 ? 0 : 8 - 255 / (2 * n * Math.LN2));

/** Below this, entropy and byte-coverage are measuring the length, not the content. */
export const MIN_ENTROPY_BYTES = 256;
/** Byte coverage only saturates for ciphertext once there are enough bytes to cover with. */
const MIN_COVERAGE_BYTES = 1024;

export const byteStats = (input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  const distinct = distinctBytes(buf);
  return {
    length: buf.length,
    entropy: Number(entropyOf(buf).toFixed(3)),
    printableRatio: Number(printableRatio(buf).toFixed(3)),
    longestPrintableRun: longestPrintableRun(buf),
    // How far past chance that run is. ~0 means "exactly what random data does".
    runExcess: Number((longestPrintableRun(buf) - expectedLongestRun(buf.length)).toFixed(1)),
    // How far BELOW the random-data expectation the entropy sits, at this length.
    entropyDeficit: Number((expectedEntropy(buf.length) - entropyOf(buf)).toFixed(3)),
    distinctBytes: distinct,
    distinctRatio: Number((distinct / 256).toFixed(3)),
    container: containerOf(buf),
    // Kept as hex, never as the bytes themselves, and the CALLER decides whether
    // it may be printed — see `magicPolicy`.
    magicHex: buf.subarray(0, 8).toString("hex"),
    tooShortForEntropy: buf.length < MIN_ENTROPY_BYTES,
    tooShortForCoverage: buf.length < MIN_COVERAGE_BYTES,
  };
};

/** Try every decompressor we recognise; return the inflated bytes or null. */
const inflateIfPossible = (buf) => {
  const container = containerOf(buf);
  if (container === "gzip") {
    try {
      return { bytes: gunzipSync(buf), how: "gzip" };
    } catch {
      return null;
    }
  }
  if (container === "zlib" || container === "zlib-best") {
    try {
      return { bytes: inflateSync(buf), how: "zlib" };
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Indistinguishable from random, at this length: entropy at the expectation, a
 * printable ratio sitting in the chance band around 0.383, no run beyond chance,
 * and no container header to explain any of it.
 */
const looksEncrypted = (s) =>
  !s.tooShortForEntropy &&
  s.container === null &&
  s.entropyDeficit <= 0.15 &&
  s.printableRatio >= 0.3 &&
  s.printableRatio <= 0.46 &&
  s.runExcess <= 8;

/** Carries text: mostly printable, or a run far past chance, or a known container. */
const looksPlain = (s) =>
  s.printableRatio >= 0.6 ||
  s.runExcess >= 12 ||
  (s.container !== null && !["gzip", "zlib", "zlib-best"].includes(s.container) && s.entropy < 7.0);

/**
 * Whether the first bytes of a sample may be printed.
 *
 * A magic that is IDENTICAL across every sampled row is a header — a property of
 * the format, safe to show. A magic that differs per row is either user data or
 * an initialisation vector, and printing it leaks the thing this probe exists
 * not to leak. So: uniform, or on the container allow-list, or nothing.
 */
export const magicPolicy = (samples) => {
  const magics = [...new Set(samples.map((s) => s.magicHex))];
  if (magics.length === 1)
    return { show: true, reason: "uniform across samples", magic: magics[0] };
  const containers = [...new Set(samples.map((s) => s.container).filter(Boolean))];
  if (containers.length && containers.length === magics.length) {
    return { show: true, reason: "recognised containers", containers };
  }
  return {
    show: false,
    reason: `${magics.length} distinct magics — withheld`,
    distinct: magics.length,
  };
};

/**
 * The verdict, from several samples of one column.
 *
 * Deliberately four-valued. `UNKNOWN` is a real answer and is never rounded
 * toward either side: a surface should not be killed, or shipped, by a statistic
 * that did not actually decide.
 */
export const classifySamples = (buffers) => {
  const raw = buffers.map((b) => byteStats(b));
  if (!raw.length) return { verdict: "UNKNOWN", reason: "no samples", samples: [] };

  /**
   * SHORT AND ALL THE SAME WIDTH — an identifier, a hash or a key, not a payload.
   *
   * Reported separately because on the first real HomeKit run this was most of
   * the store: Core Data keeps uuids as 16 raw bytes, so dozens of `ZMODELID`
   * columns came back UNKNOWN and buried the handful of columns that actually
   * had not decided. UNKNOWN should mean "the statistics did not separate this",
   * not "this was never long enough to ask".
   */
  const widths = new Set(raw.map((s) => s.length));
  if (widths.size === 1 && raw[0].length < MIN_ENTROPY_BYTES && raw.every((s) => !s.container)) {
    return {
      verdict: "SHORT-FIXED-WIDTH",
      reason: `every sample is exactly ${raw[0].length} B — too short for entropy to mean anything, and one fixed width is what an identifier, hash or key looks like`,
      compressed: false,
      samples: raw,
      magic: magicPolicy(raw),
    };
  }

  // Compression first. Until an inflate has been tried, entropy cannot tell
  // compressed from encrypted and any verdict is a coin toss with a decimal
  // point on it.
  const inflated = buffers.map((b) => inflateIfPossible(Buffer.isBuffer(b) ? b : Buffer.from(b)));
  if (inflated.every(Boolean)) {
    const inner = inflated.map((r) => byteStats(r.bytes));
    const innerVerdict = inner.every(looksPlain)
      ? "PLAINTEXT"
      : inner.every(looksEncrypted)
        ? "ENCRYPTED"
        : "UNKNOWN";
    return {
      verdict: innerVerdict === "PLAINTEXT" ? "COMPRESSED-NOT-ENCRYPTED" : innerVerdict,
      reason:
        `every sample inflated (${inflated[0].how}); statistics below are of the INFLATED bytes` +
        (innerVerdict === "UNKNOWN" ? ", and did not decide" : ""),
      compressed: true,
      samples: inner,
      outerSamples: raw,
      magic: magicPolicy(raw),
    };
  }

  const verdict = raw.every(looksEncrypted)
    ? "ENCRYPTED"
    : raw.every(looksPlain)
      ? "PLAINTEXT"
      : "UNKNOWN";
  const shortest = Math.min(...raw.map((s) => s.length));
  return {
    verdict,
    reason:
      verdict === "UNKNOWN"
        ? shortest < MIN_ENTROPY_BYTES
          ? `samples are short (min ${shortest} B) — entropy measures the length, not the content`
          : "samples did not agree, or matched neither profile"
        : verdict === "ENCRYPTED"
          ? "indistinguishable from random at this length, no container — and no inflate succeeded"
          : "printable runs and entropy well below the random-data expectation",
    compressed: false,
    samples: raw,
    magic: magicPolicy(raw),
  };
};
