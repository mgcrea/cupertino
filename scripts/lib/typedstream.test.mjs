import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeAttributedBody, outline } from "./typedstream.mjs";

/**
 * Ground truth, not guesswork.
 *
 * `NSArchiver` is deprecated but still ships on macOS 26, and it is what wrote
 * every `attributedBody` in `chat.db`. So these blobs were produced by archiving
 * an `NSAttributedString` with a KNOWN plaintext:
 *
 *     let d = NSArchiver.archivedData(withRootObject: NSAttributedString(string: "Hello, world"))
 *
 * That matters because the alternative was hand-writing bytes from a reading of
 * the format, which would have tested this decoder against its own assumptions.
 * It also means the suite is hermetic and carries nobody's messages: every
 * string below was written here, not read off a machine.
 *
 * Regenerate with `scripts/lib/typedstream.fixtures.swift` if the format ever
 * moves.
 */
const BLOBS = {
  plain:
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472" +
    "696e67008484084e534f626a656374008592848484084e53537472696e67019484012b0c4865" +
    "6c6c6f2c20776f726c648684026949010c928484840c4e5344696374696f6e61727900948401" +
    "69008686",
  unicode:
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472" +
    "696e67008484084e534f626a656374008592848484084e53537472696e67019484012b244361" +
    "66c3a920e29895efb88f2064c3a96ac3a020767520e2809420e697a5e69cace8aa9e86840269" +
    "490115928484840c4e5344696374696f6e6172790094840169008686",
  long:
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472" +
    "696e67008484084e534f626a656374008592848484084e53537472696e67019484012b819001" +
    "6162636465666768696a6162636465666768696a6162636465666768696a6162636465666768" +
    "696a6162636465666768696a6162636465666768696a6162636465666768696a616263646566" +
    "6768696a6162636465666768696a6162636465666768696a6162636465666768696a61626364" +
    "65666768696a6162636465666768696a6162636465666768696a6162636465666768696a6162" +
    "636465666768696a6162636465666768696a6162636465666768696a6162636465666768696a" +
    "6162636465666768696a6162636465666768696a6162636465666768696a6162636465666768" +
    "696a6162636465666768696a6162636465666768696a6162636465666768696a616263646566" +
    "6768696a6162636465666768696a6162636465666768696a6162636465666768696a61626364" +
    "65666768696a6162636465666768696a6162636465666768696a6162636465666768696a6162" +
    "636465666768696a6162636465666768696a6162636465666768696a6162636465666768696a" +
    "6162636465666768696a6162636465666768696a868402694901819001928484840c4e534469" +
    "6374696f6e6172790094840169008686",
  empty:
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472" +
    "696e67008484084e534f626a656374008592848484084e53537472696e67019484012b008686",
  newlines:
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472" +
    "696e67008484084e534f626a656374008592848484084e53537472696e67019484012b186c69" +
    "6e65206f6e650a6c696e652074776f0974616262656486840269490118928484840c4e534469" +
    "6374696f6e6172790094840169008686",
  attachment:
    "040b73747265616d747970656481e803840140848484194e534d757461626c65417474726962" +
    "75746564537472696e67008484124e5341747472696275746564537472696e67008484084e53" +
    "4f626a6563740085928484840f4e534d757461626c65537472696e67018484084e5353747269" +
    "6e67019584012b03efbfbc86840269490101928484840c4e5344696374696f6e617279009584" +
    "01690192849898225f5f6b494d46696c655472616e7366657247554944417474726962757465" +
    "4e616d6586928498982961745f305f41424344454631322d333435362d373839302d41424344" +
    "2d454631323334353637383930868686",
  runs:
    "040b73747265616d747970656481e803840140848484194e534d757461626c65417474726962" +
    "75746564537472696e67008484124e5341747472696275746564537472696e67008484084e53" +
    "4f626a6563740085928484840f4e534d757461626c65537472696e67018484084e5353747269" +
    "6e67019584012b116265666f726520424f4c4420616674657286840269490107928484840c4e" +
    "5344696374696f6e617279009584016901928498981d5f5f6b494d4d65737361676550617274" +
    "4174747269627574654e616d658692848484084e534e756d626572008484074e5356616c7565" +
    "009584012a848401719f00868699020492849a9b02929b929c928498980a4e53466f6e745369" +
    "7a658692849d9e84840164a0830000000000803140868699030692849a9b01929b929c8686",
  link:
    "040b73747265616d747970656481e803840140848484194e534d757461626c65417474726962" +
    "75746564537472696e67008484124e5341747472696275746564537472696e67008484084e53" +
    "4f626a6563740085928484840f4e534d757461626c65537472696e67018484084e5353747269" +
    "6e67019584012b1b7365652068747470733a2f2f6578616d706c652e636f6d206e6f77868402" +
    "69490104928484840c4e5344696374696f6e6172790095840169008699021392849a9b019284" +
    "9898165f5f6b494d4c696e6b4174747269627574654e616d6586928498981368747470733a2f" +
    "2f6578616d706c652e636f6d868699010486",
};

const blob = (name) => Buffer.from(BLOBS[name], "hex");

/** What each blob was archived FROM. */
const EXPECTED = {
  plain: "Hello, world",
  unicode: "Café ☕️ déjà vu — 日本語",
  long: "abcdefghij".repeat(40),
  empty: "",
  newlines: "line one\nline two\ttabbed",
  attachment: "￼",
  runs: "before BOLD after",
  link: "see https://example.com now",
};

describe("decodeAttributedBody", () => {
  for (const [name, want] of Object.entries(EXPECTED)) {
    it(`decodes ${name}`, () => {
      const r = decodeAttributedBody(blob(name));
      assert.equal(r.ok, true, r.error ?? "");
      assert.equal(r.text, want);
    });
  }

  /**
   * The length is in BYTES of UTF-8, not characters. A 22-character string of
   * accents and kana declares 36, and slicing by character count would
   * desynchronise the walk and corrupt everything after it.
   */
  it("reads lengths as bytes, not characters", () => {
    const r = decodeAttributedBody(blob("unicode"));
    // The blob declares 0x24 = 36. The string is 21 UTF-16 units, so a reader
    // that took the length as a character count would stop 15 bytes early and
    // desynchronise everything after it.
    assert.equal(Buffer.byteLength(r.text, "utf8"), 36);
    assert.equal(r.text.length, 21);
    assert.ok(r.text.length < Buffer.byteLength(r.text, "utf8"));
  });

  /** Past 127 the length takes the 0x81 int16 form — measured at 0x81 90 01. */
  it("reads a payload longer than a single-byte length", () => {
    assert.equal(decodeAttributedBody(blob("long")).text.length, 400);
  });

  /** An empty message is a valid decode, not a failure. */
  it("distinguishes an empty string from a failure", () => {
    const r = decodeAttributedBody(blob("empty"));
    assert.equal(r.ok, true);
    assert.equal(r.text, "");
    assert.equal(r.hasAttributes, false);
  });

  /**
   * An attachment is the object-replacement character in the text, with its
   * GUID in an attribute run. The character must survive — it is what marks
   * WHERE the attachment sat — even though the run itself is not decoded.
   */
  it("keeps the attachment placeholder", () => {
    const r = decodeAttributedBody(blob("attachment"));
    assert.equal(r.text, "￼");
    assert.equal(r.hasAttributes, true);
  });

  /**
   * The desync risk. A float-valued attribute sits between runs here, and a
   * parser that mis-consumes it returns truncated text for everything after.
   */
  it("stays in sync across a float-valued attribute run", () => {
    assert.equal(decodeAttributedBody(blob("runs")).text, "before BOLD after");
  });

  /**
   * Only the classes reached BEFORE the text, because the walk stops there.
   * `NSDictionary` and friends live in the attribute runs after it, which are
   * deliberately not decoded — see `hasAttributes`.
   */
  it("reports the classes it walked past on the way to the text", () => {
    const r = decodeAttributedBody(blob("plain"));
    assert.deepEqual(r.classes, ["NSAttributedString", "NSObject", "NSString"]);
    assert.equal(r.hasAttributes, true);
  });

  /**
   * REGRESSION: the two real-world failures this decoder had.
   *
   * Measured over 97,094 blobs from a live store, it failed exactly twice — both
   * "token limit exceeded", and both had ALREADY read their text (936 and 2,095
   * bytes) before exhausting the walk on attribute runs whose result is
   * discarded anyway. Two real messages were being thrown away for work nobody
   * wanted.
   *
   * The fix is to stop at the first payload, and this is what proves it: take a
   * known-good blob and bury it in an arbitrary amount of trailing rubbish. What
   * follows the text must not be able to affect the text — a property no amount
   * of attribute runs can break. (Verified separately against a real 13,861-byte
   * blob carrying 525 attribute runs, archived by NSArchiver.)
   */
  it("ignores everything after the text, however much of it there is", () => {
    const good = blob("plain");
    const buried = Buffer.concat([good, Buffer.alloc(200_000, 0x84)]);
    const r = decodeAttributedBody(buried);
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.text, "Hello, world");
    assert.equal(r.hasAttributes, true);
  });

  describe("refuses rather than guessing", () => {
    it("rejects a non-typedstream blob", () => {
      const r = decodeAttributedBody(Buffer.from("bplist00 and then some padding bytes"));
      assert.equal(r.ok, false);
      // The signature-length check fires first here ("bplist00"'s second byte
      // is 0x70), which is the same refusal reached one step sooner.
      assert.match(r.error, /signature/);
    });

    it("rejects an empty buffer", () => {
      assert.equal(decodeAttributedBody(Buffer.alloc(0)).ok, false);
    });

    it("rejects a truncated blob without throwing", () => {
      const r = decodeAttributedBody(blob("plain").subarray(0, 20));
      assert.equal(r.ok, false);
    });

    /**
     * There is deliberately no "longest printable run" fallback. Three surfaces
     * have now been bitten by a heuristic that produced a plausible wrong
     * answer, and `text` already answers for the 96.5% of rows that have one.
     */
    it("does not invent text from a corrupt payload", () => {
      const bytes = blob("plain");
      bytes[bytes.indexOf(0x2b) + 1] = 0x7f; // a length past the end of the buffer
      const r = decodeAttributedBody(bytes);
      assert.equal(r.ok, false);
    });
  });
});

describe("outline", () => {
  /** The redacted form: Apple's constants survive, a message becomes a shape. */
  it("never prints message content", () => {
    const tokens = outline(blob("plain")).join(" ");
    assert.match(tokens, /NSAttributedString/);
    assert.match(tokens, /<str len=12 ascii>/);
    assert.doesNotMatch(tokens, /Hello/);
  });
});
