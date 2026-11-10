// Synthetic Voice Memos audio, built box by box to the layouts measured in docs/voice-memos.md.
// No real recording goes in the repo: every byte here is made up.
import type { ReadAt } from "../../src/client/mp4.js";

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

// A four-character code, one byte per character, so "\0\0\0\x01" spells the u32 index 1.
const fourcc = (type: string): Uint8Array => {
  if (type.length !== 4) throw new Error(`box type must be 4 characters: ${JSON.stringify(type)}`);
  return Uint8Array.from(type, (c) => c.charCodeAt(0));
};

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
  const body = concat(...payload);
  return concat(u32(8 + body.length), fourcc(type), body);
};

const ftyp = (major: string): Uint8Array =>
  box("ftyp", fourcc(major), u32(0), fourcc(major), fourcc("isom"));

const hdlr = (handler: string): Uint8Array =>
  box("hdlr", u32(0), u32(0), fourcc(handler), u32(0), u32(0), u32(0), new Uint8Array(1));

// 64 bytes of stand-in audio: tests check that none of it is ever read.
export const MDAT_PAYLOAD = new Uint8Array(64).fill(0xaa);
const mdat = (): Uint8Array => box("mdat", MDAT_PAYLOAD);

const payloadOf = (json: unknown): Uint8Array => utf8(JSON.stringify(json));

// ISO layout: ftyp · moov[mvhd, trak[udta[tsrp]], udta[meta(FullBox)[hdlr, ilst]]] · mdat
export const m4aWithTranscript = (json: unknown | null): Uint8Array => {
  const trakUdta = json === null ? box("udta") : box("udta", box("tsrp", payloadOf(json)));
  return concat(
    ftyp("M4A "),
    box(
      "moov",
      box("mvhd", new Uint8Array(100)),
      box("trak", box("tkhd", new Uint8Array(84)), trakUdta),
      box("udta", box("meta", u32(0), hdlr("mdir"), box("ilst"))),
    ),
    mdat(),
  );
};

const TSRP_KEY = "com.apple.VoiceMemos.tsrp";

// QuickTime layout: ftyp · moov[trak[meta(plain)[hdlr, keys, ilst[<u32 1>[data]]]]] · mdat
export const qtaWithTranscript = (json: unknown | null): Uint8Array => {
  const keyName = utf8(TSRP_KEY);
  const keys = box("keys", u32(0), u32(1), u32(8 + keyName.length), fourcc("mdta"), keyName);
  const ilst =
    json === null
      ? box("ilst")
      : box("ilst", box("\0\0\0\x01", box("data", u32(0), u32(0), payloadOf(json))));
  return concat(
    ftyp("qt  "),
    box(
      "moov",
      box("mvhd", new Uint8Array(100)),
      box("trak", box("meta", hdlr("mdta"), keys, ilst)),
    ),
    mdat(),
  );
};

export const readerOf =
  (bytes: Uint8Array): ReadAt =>
  (position, length) =>
    bytes.subarray(position, Math.min(bytes.length, position + length));
