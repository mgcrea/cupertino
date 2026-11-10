// Finds Apple's transcript inside a Voice Memos recording without reading its audio.
//
// Two containers, measured in docs/voice-memos.md:
//   M4A  (brand "M4A "): a `tsrp` box at moov/trak/udta/tsrp.
//   QTA  (brand "qt  "): a keyed metadata item `com.apple.VoiceMemos.tsrp` in moov/trak/meta,
//        resolved through the sibling `keys` box, its payload inside a `data` box.
//
// Only box headers and the transcript payload are read, through positioned reads, so a
// recording of hundreds of MB costs a few small reads. `mdat` is skipped by its size.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Reads `length` bytes at `position`. A short read at the end of the file is allowed. */
export type ReadAt = (position: number, length: number) => Uint8Array;
export type TranscriptContainer = "tsrp-box" | "qt-keyed-item";
export type AudioScan = {
  /** The ftyp major brand, trimmed: "M4A", "qt". */
  brand: string | null;
  format: "m4a" | "qta" | "unknown";
  transcript: { container: TranscriptContainer; bytes: Uint8Array } | null;
};

export class AudioParseError extends Error {
  override name = "AudioParseError";
}

/** The largest measured transcript is 342 KB; anything this size is not a transcript. */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/** `keys` boxes hold a handful of names; a large one is corrupt. */
const MAX_KEYS_BYTES = 1024 * 1024;
const TSRP_KEY = "com.apple.VoiceMemos.tsrp";

/** Boxes worth descending into on the way to a transcript. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "udta", "edts"]);

type Box = { type: string; start: number; payload: number; end: number };

const fourcc = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const readExact = (read: ReadAt, position: number, length: number, what: string): Uint8Array => {
  const bytes = read(position, length);
  if (bytes.length < length) {
    throw new AudioParseError(
      `truncated ${what} at byte ${position}: wanted ${length}, got ${bytes.length}`,
    );
  }
  return bytes;
};

const readBox = (read: ReadAt, start: number, limit: number): Box => {
  const head = readExact(read, start, 8, "box header");
  const size32 = view(head).getUint32(0);
  const type = fourcc(head, 4);
  let payload = start + 8;
  let end: number;
  if (size32 === 1) {
    const large = view(readExact(read, start + 8, 8, `${type} box size`)).getBigUint64(0);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AudioParseError(`${type} box at byte ${start} declares an impossible size`);
    }
    payload = start + 16;
    end = start + Number(large);
  } else if (size32 === 0) {
    end = limit;
  } else {
    end = start + size32;
  }
  if (end < payload) {
    throw new AudioParseError(`${type} box at byte ${start} is smaller than its own header`);
  }
  if (end > limit) {
    throw new AudioParseError(
      `${type} box at byte ${start} overruns its parent (ends at ${end}, parent at ${limit})`,
    );
  }
  return { type, start, payload, end };
};

function* children(read: ReadAt, from: number, to: number): Generator<Box> {
  let at = from;
  while (at < to) {
    if (to - at < 8) throw new AudioParseError(`${to - at} stray bytes at byte ${at}`);
    const b = readBox(read, at, to);
    yield b;
    at = b.end;
  }
}

const readPayload = (read: ReadAt, from: number, to: number, what: string): Uint8Array => {
  const length = to - from;
  if (length > MAX_TRANSCRIPT_BYTES) {
    throw new AudioParseError(
      `${what} declares ${length} bytes, over the ${MAX_TRANSCRIPT_BYTES}-byte limit for a transcript`,
    );
  }
  return readExact(read, from, length, what);
};

/** The names in a QuickTime `keys` box, 1-indexed as `ilst` item types refer to them. */
const readKeys = (read: ReadAt, b: Box): string[] => {
  if (b.end - b.payload > MAX_KEYS_BYTES) {
    throw new AudioParseError(`keys box at byte ${b.start} is ${b.end - b.payload} bytes`);
  }
  const bytes = readExact(read, b.payload, b.end - b.payload, "keys box");
  const dv = view(bytes);
  if (bytes.length < 8) throw new AudioParseError(`keys box at byte ${b.start} has no entry count`);
  const count = dv.getUint32(4);
  const names: string[] = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 8 > bytes.length)
      throw new AudioParseError(`keys box at byte ${b.start} ends inside entry ${i + 1}`);
    const size = dv.getUint32(at);
    if (size < 8 || at + size > bytes.length) {
      throw new AudioParseError(`keys entry ${i + 1} at byte ${b.start} has a bad size`);
    }
    names.push(new TextDecoder().decode(bytes.subarray(at + 8, at + size)));
    at += size;
  }
  return names;
};

/** A QuickTime `meta` is a plain box; an ISO one has a 4-byte version header first. */
const metaChildrenStart = (read: ReadAt, b: Box): number => {
  if (b.end - b.payload >= 8) {
    const peek = read(b.payload + 4, 4);
    if (peek.length === 4 && fourcc(peek, 0) === "hdlr") return b.payload;
  }
  return b.payload + 4;
};

const scanMeta = (read: ReadAt, meta: Box): AudioScan["transcript"] => {
  const start = metaChildrenStart(read, meta);
  let keys: string[] = [];
  let ilst: Box | null = null;
  for (const c of children(read, start, meta.end)) {
    if (c.type === "keys") keys = readKeys(read, c);
    else if (c.type === "ilst") ilst = c;
  }
  if (!ilst) return null;
  const index = keys.indexOf(TSRP_KEY) + 1;
  if (index === 0) return null;
  for (const item of children(read, ilst.payload, ilst.end)) {
    const head = read(item.start + 4, 4);
    if (head.length < 4 || view(head).getUint32(0) !== index) continue;
    for (const d of children(read, item.payload, item.end)) {
      if (d.type !== "data") continue;
      // data: u32 type indicator, u32 locale, then the value.
      if (d.end - d.payload < 8)
        throw new AudioParseError(`data box at byte ${d.start} has no header`);
      return {
        container: "qt-keyed-item",
        bytes: readPayload(read, d.payload + 8, d.end, `transcript item at byte ${d.start}`),
      };
    }
  }
  return null;
};

const walk = (read: ReadAt, from: number, to: number): AudioScan["transcript"] => {
  for (const b of children(read, from, to)) {
    let found: AudioScan["transcript"] = null;
    if (b.type === "tsrp") {
      found = {
        container: "tsrp-box",
        bytes: readPayload(read, b.payload, b.end, `tsrp box at byte ${b.start}`),
      };
    } else if (b.type === "meta") {
      found = scanMeta(read, b);
    } else if (CONTAINERS.has(b.type)) {
      found = walk(read, b.payload, b.end);
    }
    if (found) return found;
  }
  return null;
};

export const scanAudio = (read: ReadAt, size: number): AudioScan => {
  let brand: string | null = null;
  let transcript: AudioScan["transcript"] = null;
  for (const b of children(read, 0, size)) {
    if (b.type === "ftyp" && brand === null && b.end - b.payload >= 4) {
      brand = fourcc(readExact(read, b.payload, 4, "ftyp brand"), 0).trim();
    } else if (b.type === "moov") {
      transcript = walk(read, b.payload, b.end);
      if (transcript) break;
    }
  }
  const format = brand === "M4A" ? "m4a" : brand === "qt" ? "qta" : "unknown";
  return { brand, format, transcript };
};

export const scanAudioFile = (path: string): AudioScan => {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read: ReadAt = (position, length) => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, position);
      return buf.subarray(0, n);
    };
    return scanAudio(read, size);
  } finally {
    closeSync(fd);
  }
};
