import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rtfToPlainText, rtfToText, titleOf } from "./rtf.mjs";

/**
 * Ground truth, not guesswork.
 *
 * Every document in COCOA below was produced by asking Cocoa itself to write it,
 * from a KNOWN plaintext:
 *
 *     let s = NSAttributedString(string: text)
 *     s.rtf(from: NSRange(location: 0, length: s.length), documentAttributes: [:])
 *
 * That matters because the alternative was hand-writing RTF from a reading of the
 * spec, which would have tested this reader against its own assumptions. What
 * Stickies puts on disk is what `NSAttributedString` writes, so this is the
 * dialect that has to work — and three of these cases are ones a spec-first
 * reader gets wrong:
 *
 *   * `cjk` and `emoji` show that Cocoa emits `\uc0`, NOT the `\uc1` the spec's
 *     examples use. A reader that hardcodes a skip of 1 eats the character after
 *     every escape.
 *   * `emoji` shows that astral characters arrive as two SEPARATE `\u` escapes
 *     holding a UTF-16 surrogate PAIR, not as one codepoint.
 *   * `multiline` shows that a paragraph break is `\` followed by a real newline,
 *     not `\par` — while the bare newlines in the preamble are formatting and
 *     must be dropped. The same byte means both things depending on what precedes
 *     it.
 *
 * The suite is hermetic and carries nobody's notes: every string here was written
 * here. Regenerate against a newer macOS by re-running the snippet above.
 */
const COCOA_PREAMBLE =
  "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n" +
  "\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n" +
  "{\\colortbl;\\red255\\green255\\blue255;}\n" +
  "{\\*\\expandedcolortbl;;}\n" +
  "\\pard\\tx560\\tx1120\\tx1680\\tx2240\\tx2800\\tx3360\\tx3920\\tx4480\\tx5040" +
  "\\tx5600\\tx6160\\tx6720\\pardirnatural\\partightenfactor0\n\n\\f0\\fs24 \\cf0 ";

/** A minimal well-formed document, for the hand-written cases below. */
const doc = (body) => `{\\rtf1\\ansi\\ansicpg1252 ${body}}`;

/** [expected plaintext, the body Cocoa wrote after the shared preamble] */
const COCOA = {
  plain: ["Hello, world", "Hello, world}"],
  accents: ["café — naïve « déjà »", "caf\\'e9 \\'97 na\\'efve \\'ab d\\'e9j\\'e0 \\'bb}"],
  curly: ["it’s a “quote”", "it\\'92s a \\'93quote\\'94}"],
  cjk: ["会議 15:00", "\\uc0\\u20250 \\u35696  15:00}"],
  emoji: ["ship it 🚀", "ship it \\uc0\\u55357 \\u56960 }"],
  multiline: ["Groceries\nMilk\nBread", "Groceries\\\nMilk\\\nBread}"],
  braces: ["a {b} c \\ d", "a \\{b\\} c \\\\ d}"],
  tabs: ["a\tb", "a\tb}"],
};

describe("rtfToPlainText — against what Cocoa actually writes", () => {
  for (const [name, [want, body]] of Object.entries(COCOA)) {
    it(`round-trips ${name}`, () => {
      assert.equal(rtfToPlainText(Buffer.from(COCOA_PREAMBLE + body, "latin1")), want);
    });
  }

  it("accepts a latin1 string as readily as bytes", () => {
    const document = COCOA_PREAMBLE + COCOA.accents[1];
    assert.equal(rtfToPlainText(document), rtfToPlainText(Buffer.from(document, "latin1")));
  });

  it("does not read past the end of a pooled Buffer", () => {
    // Small Buffers are carved out of a shared allocation pool, so `.buffer` is
    // several kilobytes of unrelated memory. Reading it produced a note with the
    // right first line and this file's own source appended to it.
    const bytes = Buffer.from(COCOA_PREAMBLE + COCOA.plain[1], "latin1");
    assert.equal(rtfToPlainText(bytes), "Hello, world");
    assert.ok(bytes.byteLength < bytes.buffer.byteLength, "fixture must be pool-allocated");
  });
});

describe("the empty note Stickies writes", () => {
  // Copied from a real, untouched sticky on macOS 26.6. Note the EMPTY `\fonttbl`
  // — a new note has no font run at all, so the document ends immediately after
  // the metadata groups and there is no text token anywhere in it.
  const EMPTY =
    "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n" +
    "\\cocoatextscaling0\\cocoaplatform0{\\fonttbl}\n" +
    "{\\colortbl;\\red255\\green255\\blue255;}\n" +
    "{\\*\\expandedcolortbl;;}\n}";

  it("decodes to the empty string, not to its own colour table", () => {
    assert.equal(rtfToPlainText(EMPTY), "");
  });

  it("titles as the empty string rather than throwing", () => {
    assert.equal(titleOf(rtfToPlainText(EMPTY)), "");
  });
});

/**
 * Hand-written, and labelled as such.
 *
 * Cocoa never emits `\uc1`, so the trap the RTF spec spends the most words on is
 * the one the ground-truth fixtures above CANNOT reach. These documents are
 * written by hand to exercise it, which is a weaker kind of evidence and is why
 * they are kept apart from the Cocoa set rather than mixed in with it.
 */
describe("the three traps", () => {
  it("obeys \\uc1 by swallowing the ANSI fallback after \\u", () => {
    // Written for readers that cannot do Unicode: `\u233` then the cp1252 byte
    // for the same character. Emitting both gives "cafeé".
    assert.equal(rtfToPlainText(doc("\\uc1 caf\\u233 \\'e9")), "café");
  });

  it("obeys \\uc0 by swallowing nothing", () => {
    assert.equal(rtfToPlainText(doc("\\uc0 caf\\u233 x")), "caféx");
  });

  it("restores \\uc when a group closes", () => {
    assert.equal(rtfToPlainText(doc("\\uc0 {\\uc1 caf\\u233 \\'e9}caf\\u233 x")), "cafécaféx");
  });

  it("reads \\'hh in the declared codepage, not as Latin-1", () => {
    // U+0092 is an unassigned control character; cp1252 says right single quote.
    assert.equal(rtfToPlainText(doc("it\\'92s")), "it’s");
  });

  it("skips a \\* destination whole, including nested groups", () => {
    assert.equal(
      rtfToPlainText(doc("{\\*\\expandedcolortbl;;}{\\*\\outer{\\inner deep}}kept")),
      "kept",
    );
  });

  it("skips known destinations that carry no \\* marker", () => {
    assert.equal(rtfToPlainText(doc("{\\fonttbl{\\f0 Helvetica;}}{\\colortbl;}kept")), "kept");
  });

  it("renders an RTFD attachment as U+FFFC, as Cocoa does", () => {
    // The filename belongs in list_attachments, but the attachment itself IS a
    // character. Measured against NSAttributedString on a real note: "DEF-" plus
    // an image decodes to 5 characters ending in U+FFFC.
    assert.equal(
      rtfToPlainText(doc("before {{\\NeXTGraphic photo.png \\width200}\u00ac}after")),
      "before \uFFFCafter",
    );
  });

  it("swallows the attachment placeholder byte rather than printing it", () => {
    // 0xAC is "¬" in cp1252. Emitting it gives text of the RIGHT LENGTH and the
    // wrong content, which is the failure mode a length assertion cannot catch.
    assert.ok(!rtfToPlainText(doc("{{\\NeXTGraphic p.jpg}\u00ac}")).includes("¬"));
  });
});

describe("degrading rather than throwing", () => {
  it("drops an unknown control word instead of printing it", () => {
    // The single space after a control word is its DELIMITER and is consumed,
    // which is why this is "ab" and not "a b". Cocoa depends on that rule: the
    // preamble ends `\\cf0 Hello`, and a reader that kept the delimiter would
    // give every note a leading space.
    assert.equal(rtfToPlainText(doc("a\\notarealword b")), "ab");
    assert.equal(rtfToPlainText(doc("a\\notarealword  b")), "a b");
  });

  it("skips the payload of \\bin", () => {
    assert.equal(rtfToPlainText(doc("a\\bin5 12345b")), "ab");
  });

  it("survives unbalanced braces", () => {
    assert.equal(rtfToPlainText("{\\rtf1 unclosed"), "unclosed");
    assert.equal(rtfToPlainText("{\\rtf1 extra}}}"), "extra");
  });

  it("returns nothing useful, and does not throw, for input that is not RTF", () => {
    assert.doesNotThrow(() => rtfToPlainText(Buffer.from([0x00, 0x01, 0x02])));
    assert.equal(rtfToPlainText(""), "");
  });
});

describe("rtfToText vs rtfToPlainText", () => {
  it("rtfToText keeps the writer's trailing break, rtfToPlainText does not", () => {
    const withBreak = "{\\rtf1\\ansi\\ansicpg1252 line\\par }";
    assert.equal(rtfToText(withBreak), "line\n");
    assert.equal(rtfToPlainText(withBreak), "line");
  });
});

describe("titleOf", () => {
  it("takes the first non-empty line, as Notes derives ZTITLE1", () => {
    assert.equal(titleOf("\n\n  Groceries  \nMilk"), "Groceries");
  });

  it("is empty for an empty note", () => {
    assert.equal(titleOf(""), "");
    assert.equal(titleOf("\n \n"), "");
  });

  it("truncates with an ellipsis rather than running to the full line", () => {
    const long = "x".repeat(200);
    const title = titleOf(long);
    assert.equal(title.length, 120);
    assert.ok(title.endsWith("…"));
  });
});
