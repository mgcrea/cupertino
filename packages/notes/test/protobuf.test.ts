import { describe, expect, it } from "vitest";

import {
  extractNoteText,
  NOTE_TEXT_PATH,
  parseFields,
  readVarint,
} from "../src/client/protobuf.js";

const varint = (n: number): Buffer => {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};
const len = (field: number, payload: Buffer): Buffer =>
  Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
const int = (field: number, value: number): Buffer =>
  Buffer.concat([varint(field * 8), varint(value)]);
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

/** document(2) -> note(3) -> note_text(2), the shape measured on a real store. */
const noteBlob = (body: string, decoy?: string): Buffer => {
  const note = Buffer.concat([
    len(2, utf8(body)),
    ...(decoy ? [len(5, len(12, utf8(decoy)))] : []),
  ]);
  return Buffer.concat([int(1, 0), len(2, Buffer.concat([int(1, 0), int(2, 1), len(3, note)]))]);
};

describe("readVarint", () => {
  it("reads a multi-byte value", () => {
    expect(readVarint(varint(300), 0)).toEqual({ value: 300, next: 2 });
  });

  it("returns null on a truncated varint rather than throwing", () => {
    expect(readVarint(Buffer.from([0x80]), 0)).toBeNull();
  });
});

describe("parseFields", () => {
  it("rejects trailing garbage instead of misparsing it", () => {
    expect(parseFields(Buffer.concat([int(1, 1), Buffer.from([0xff])]))).toBeNull();
  });

  it("rejects legacy group wire types", () => {
    expect(parseFields(Buffer.from([0x0b]))).toBeNull();
  });
});

describe("extractNoteText", () => {
  it("reads the body from the measured path", () => {
    const got = extractNoteText(noteBlob("Shopping list\nmilk\neggs"));
    expect(got.path).toBe(NOTE_TEXT_PATH);
    expect(got.via).toBe("pinned");
    expect(got.text).toBe("Shopping list\nmilk\neggs");
  });

  /**
   * The regression that made the pin necessary: on ~half a real library an
   * attribute-run field is longer than the body, so "take the longest string"
   * returns plausible, wrong text — 27/53 agreement instead of 53/53.
   */
  it("prefers the pinned path over a longer decoy", () => {
    const blob = noteBlob("Real body", "x".repeat(200));
    expect(extractNoteText(blob).text).toBe("Real body");
    expect(extractNoteText(blob, null).text).toBe("x".repeat(200));
  });

  /**
   * Apple renumbering `note_text` is what this simulates. The fallback still
   * finds the body, but note what it returns: the *parent* message, whose tag
   * and length bytes happen to be printable, so the text comes back with a
   * couple of bytes of framing glued on.
   *
   * That is the fallback being approximate, and it is the whole argument for
   * pinning: `longest` recovers something usable when the schema moves, but it
   * is not what you would want to serve as a note body.
   */
  it("falls back to the longest string, and says so, when the path is gone", () => {
    const note = len(9, utf8("Body in a moved field"));
    const blob = Buffer.concat([int(1, 0), len(2, len(3, note))]);
    const got = extractNoteText(blob);
    expect(got.via).toBe("longest");
    expect(got.text).toContain("Body in a moved field");
    expect(got.text).not.toBe("Body in a moved field");
  });

  it("returns nulls for an empty blob", () => {
    expect(extractNoteText(Buffer.alloc(0))).toMatchObject({ text: null, via: null });
  });

  it("does not mistake binary for text", () => {
    const binary = len(1, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]));
    expect(extractNoteText(binary).text).toBeNull();
  });
});
