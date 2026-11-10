import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AudioParseError,
  MAX_TRANSCRIPT_BYTES,
  type ReadAt,
  scanAudio,
  scanAudioFile,
} from "../src/client/mp4.js";
import {
  box,
  concat,
  m4aWithTranscript,
  MDAT_PAYLOAD,
  qtaWithTranscript,
  readerOf,
  utf8,
} from "./helpers/audio.js";

const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

describe("scanAudio", () => {
  it("finds the tsrp box in an M4A", () => {
    const file = m4aWithTranscript({ a: 1 });
    const scan = scanAudio(readerOf(file), file.length);
    expect(scan.brand).toBe("M4A");
    expect(scan.format).toBe("m4a");
    expect(scan.transcript?.container).toBe("tsrp-box");
    expect(json(scan.transcript!.bytes)).toEqual({ a: 1 });
  });

  it("finds the keyed item in a QTA", () => {
    const file = qtaWithTranscript({ b: [2] });
    const scan = scanAudio(readerOf(file), file.length);
    expect(scan.brand).toBe("qt");
    expect(scan.format).toBe("qta");
    expect(scan.transcript?.container).toBe("qt-keyed-item");
    expect(json(scan.transcript!.bytes)).toEqual({ b: [2] });
  });

  it("reads a QuickTime meta without a version header and an ISO meta with one", () => {
    // Both carry a meta; the M4A's is a FullBox under moov/udta, the QTA's a plain box.
    for (const file of [m4aWithTranscript(null), qtaWithTranscript({ c: 3 })]) {
      expect(() => scanAudio(readerOf(file), file.length)).not.toThrow();
    }
    const qta = qtaWithTranscript({ c: 3 });
    expect(scanAudio(readerOf(qta), qta.length).transcript).not.toBeNull();
  });

  it("returns transcript null when there is none", () => {
    for (const file of [m4aWithTranscript(null), qtaWithTranscript(null)]) {
      expect(scanAudio(readerOf(file), file.length).transcript).toBeNull();
    }
  });

  it("never reads mdat", () => {
    for (const file of [m4aWithTranscript({ a: 1 }), qtaWithTranscript({ a: 1 })]) {
      const reads: [number, number][] = [];
      const inner = readerOf(file);
      const spy: ReadAt = (position, length) => {
        reads.push([position, length]);
        return inner(position, length);
      };
      scanAudio(spy, file.length);
      const payloadStart = file.length - MDAT_PAYLOAD.length;
      // The header may be read (8 bytes, or 16 for a 64-bit size); the payload never.
      for (const [position, length] of reads) {
        expect(position + length).toBeLessThanOrEqual(payloadStart + 8);
      }
    }
  });

  it("handles a 64-bit box size and a size-0 last box", () => {
    const tsrpPayload = utf8(JSON.stringify({ wide: true }));
    // A tsrp box written with size 1 and a 64-bit largesize.
    const wide = concat(u32(1), utf8("tsrp"), u32(0), u32(16 + tsrpPayload.length), tsrpPayload);
    const moov = box("moov", box("trak", box("udta", wide)));
    // A last box of size 0 runs to the end of the file.
    const tail = concat(u32(0), utf8("mdat"), MDAT_PAYLOAD);
    const file = concat(box("ftyp", utf8("M4A "), u32(0)), moov, tail);
    const scan = scanAudio(readerOf(file), file.length);
    expect(json(scan.transcript!.bytes)).toEqual({ wide: true });

    // And a size-0 moov reaching the end still parses.
    const open = concat(
      box("ftyp", utf8("M4A "), u32(0)),
      u32(0),
      utf8("moov"),
      box("trak", box("udta", box("tsrp", tsrpPayload))),
    );
    expect(json(scanAudio(readerOf(open), open.length).transcript!.bytes)).toEqual({ wide: true });
  });

  it("throws AudioParseError on a box that overruns its parent", () => {
    const file = m4aWithTranscript({ a: 1 });
    // Cut inside moov: mdat is 72 bytes, so 82 lands 10 bytes into the end of moov.
    const cut = file.subarray(0, file.length - 72 - 10);
    expect(() => scanAudio(readerOf(cut), cut.length)).toThrow(AudioParseError);
  });

  it("refuses a transcript over MAX_TRANSCRIPT_BYTES", () => {
    const declared = 17 * 1024 * 1024;
    expect(declared).toBeGreaterThan(MAX_TRANSCRIPT_BYTES);
    // Only the header exists; a reader that honoured the size would read 17 MiB.
    const tsrpHeader = concat(u32(8 + declared), utf8("tsrp"));
    const udta = concat(u32(8 + 8 + declared), utf8("udta"), tsrpHeader);
    const trak = concat(u32(8 + udta.length + declared), utf8("trak"), udta);
    const moov = concat(u32(8 + trak.length + declared), utf8("moov"), trak);
    const file = concat(box("ftyp", utf8("M4A "), u32(0)), moov);
    const size = file.length + declared;
    expect(() => scanAudio(readerOf(file), size)).toThrow(AudioParseError);
    expect(() => scanAudio(readerOf(file), size)).toThrow(String(declared));
  });
});

describe("scanAudioFile", () => {
  it("scans a file on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-mp4-"));
    try {
      const path = join(dir, "a.qta");
      writeFileSync(path, qtaWithTranscript({ d: 4 }));
      const scan = scanAudioFile(path);
      expect(scan.format).toBe("qta");
      expect(json(scan.transcript!.bytes)).toEqual({ d: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
