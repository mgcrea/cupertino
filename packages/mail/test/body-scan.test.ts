import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scanBodies } from "../src/client/body-scan.js";
import { readEmlxBodyText, shardPath } from "../src/client/emlx.js";

/**
 * The scan lane, against real `.emlx` files on disk.
 *
 * Nothing here is mocked: the container format, the MIME parse and the
 * truncated read are exactly what runs against a live mail store, because those
 * three are where this lane can be quietly wrong. What is NOT here is Mail, the
 * Envelope Index or Full Disk Access — the candidate set arrives as rowids, so
 * a machine with no grant runs the whole file.
 */

let root: string;

/** The Apple container: a byte count, a newline, the MIME payload, a plist. */
const emlx = (mime: string): string =>
  `${Buffer.byteLength(mime, "utf8")}\n${mime}<?xml version="1.0"?><plist></plist>`;

const plain = (body: string) =>
  emlx(
    ["From: sam@example.com", "Subject: Lunch", "Content-Type: text/plain", "", body].join("\n"),
  );

const write = (rowid: number, content: string, suffix = ".emlx") => {
  const path = join(
    root,
    "INBOX.mbox",
    "uuid",
    "Data",
    shardPath(rowid),
    "Messages",
    `${rowid}${suffix}`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const paths = new Map<number, string>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-apple-mail-scan-"));
  paths.set(1, write(1, plain("The invoice is attached, please pay by Friday.")));
  paths.set(2, write(2, plain("Lunch on Friday works for me.")));
  paths.set(3, write(3, plain("Nothing relevant in this one at all.")));

  // Multipart: the term lives in the text/plain part, which is what bestBody
  // picks. A scan that matched raw file bytes would also "find" it in the
  // base64 below, which is the bug this case exists to catch.
  paths.set(
    4,
    write(
      4,
      emlx(
        [
          "From: billing@domaine.fr",
          "Subject: Statement",
          'Content-Type: multipart/mixed; boundary="b1"',
          "",
          "--b1",
          "Content-Type: text/plain",
          "",
          "Your remittance advice follows.",
          "--b1",
          "Content-Type: application/pdf",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from("remittance remittance remittance").toString("base64"),
          "--b1--",
        ].join("\n"),
      ),
    ),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const scan = (term: string, candidates: number[], bound = 100, maxBytes = 65_536) =>
  scanBodies({
    candidates,
    term,
    bound,
    maxBytes,
    locate: (rowid) => paths.get(rowid) ?? null,
  });

describe("readEmlxBodyText", () => {
  it("returns the text part, not the container or the headers", () => {
    const text = readEmlxBodyText(paths.get(1)!, { maxBytes: 65_536 });
    expect(text).toContain("invoice is attached");
    expect(text).not.toContain("Subject:");
    expect(text).not.toContain("plist");
  });

  it("prefers text/plain over an attachment's base64", () => {
    const text = readEmlxBodyText(paths.get(4)!, { maxBytes: 65_536 });
    expect(text).toContain("remittance advice");
    // The base64 blob decodes to the same word; matching it would be a false
    // positive on every message carrying an attachment.
    expect(text).not.toContain("cmVtaXR0YW5jZQ");
  });

  it("returns null for a file that is not there, rather than throwing", () => {
    expect(readEmlxBodyText(join(root, "nope.emlx"), { maxBytes: 1_024 })).toBeNull();
  });
});

describe("scanBodies", () => {
  it("matches on body text that appears in no subject or sender", () => {
    const out = scan("invoice", [1, 2, 3]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.matched).toEqual([1]);
    expect(out.scanned).toBe(3);
  });

  it("is case-insensitive, like the subject search it sits beside", () => {
    const out = scan("INVOICE", [1, 2, 3]);
    expect(out.status === "ok" && out.matched).toEqual([1]);
  });

  it("preserves the index's ordering of the survivors", () => {
    const out = scan("friday", [3, 2, 1]);
    expect(out.status === "ok" && out.matched).toEqual([2, 1]);
  });

  it("counts unreadable candidates instead of failing the whole query", () => {
    const out = scan("invoice", [1, 999]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.matched).toEqual([1]);
    expect(out.unreadable).toBe(1);
    expect(out.scanned).toBe(1);
  });

  /**
   * The load-bearing test. A silent cap answers "not found" for older mail
   * indistinguishably from a real absence — so over the bound this must refuse,
   * naming both numbers, and must NOT return the matches it would have found in
   * a truncated prefix.
   */
  it("refuses over the bound rather than scanning a prefix", () => {
    const out = scan("invoice", [1, 2, 3, 4], 3);
    expect(out.status).toBe("over-bound");
    if (out.status !== "over-bound") return;
    expect(out.candidates).toBe(4);
    expect(out.bound).toBe(3);
    expect(out).not.toHaveProperty("matched");
  });

  it("scans exactly at the bound", () => {
    expect(scan("invoice", [1, 2, 3], 3).status).toBe("ok");
  });

  /**
   * The read cap is a deliberate trade, so pin it rather than discover it: a
   * term past `maxBytes` is missed. 79% of a real store's bytes are base64 the
   * scan would never match anyway, and MIME puts text parts first — but a
   * message with a very long body can hide a word past the cap, and that is
   * what APPLE_MAIL_BODY_SCAN_BYTES exists to raise.
   */
  it("misses a term sitting past the read cap", () => {
    const long = write(5, plain(`${"padding ".repeat(4_000)}needle-past-the-cap`));
    paths.set(5, long);
    const capped = scan("needle-past-the-cap", [5], 100, 1_024);
    expect(capped.status === "ok" && capped.matched).toEqual([]);

    const generous = scan("needle-past-the-cap", [5], 100, 65_536);
    expect(generous.status === "ok" && generous.matched).toEqual([5]);
  });

  it("finds nothing when nothing matches, and says it scanned", () => {
    const out = scan("zzzz-no-such-word", [1, 2, 3]);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.matched).toEqual([]);
    expect(out.scanned).toBe(3);
  });
});
