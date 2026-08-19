/**
 * Minimal protobuf wire-format reader, enough to pull the body text out of a
 * `ZICNOTEDATA.ZDATA` blob.
 *
 * ## Why it does not hardcode Apple's schema
 *
 * The usual approach compiles Apple's unpublished `.proto` and reads
 * `document.note.note_text` by field number. That breaks the first time Apple
 * renumbers a field, and this project already budgets for the schema drifting
 * on every macOS release.
 *
 * So this walks the wire format structurally, and the path is *measured* rather
 * than assumed — see `NOTE_TEXT_PATH`.
 *
 * Wire format, for reference:
 *   tag = varint;  field = tag >> 3;  wire type = tag & 7
 *   0 varint · 1 fixed64 · 2 length-delimited · 5 fixed32 · 3/4 groups (legacy)
 *
 * Pure and I/O-free: callers gunzip, callers decide what to do with the result.
 */

/** Depth cap. Notes nests a handful deep; anything past this is a misparse. */
const MAX_DEPTH = 8;
/** Below this, a "string" is more likely coincidence than text. */
const MIN_TEXT_LENGTH = 2;
/** Above this share of control characters, the bytes are not text. */
const MAX_CONTROL_RATIO = 0.05;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Tab, newline and carriage return are text; the rest of C0 and DEL are not. */
const isControl = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;

export type Varint = { value: number; next: number };

/** Read a base-128 varint. Returns null rather than throwing on a truncated one. */
export const readVarint = (buf: Uint8Array, pos: number): Varint | null => {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const byte = buf[p] as number;
    p += 1;
    // Beyond 2^53 the arithmetic stops being exact, and no tag or length we
    // care about is that large, so bail rather than return a wrong number.
    if (shift > 45) return null;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: p };
    shift += 7;
  }
  return null;
};

export type WireField = {
  field: number;
  wire: number;
  value?: number;
  from?: number;
  to?: number;
};

/**
 * Split a buffer into wire-format fields. Returns null if the bytes are not a
 * well-formed message ending exactly on the boundary — that "exactly" is what
 * makes this usable as a test for whether a blob is a nested message.
 */
export const parseFields = (
  buf: Uint8Array,
  start = 0,
  end: number = buf.length,
): WireField[] | null => {
  const fields: WireField[] = [];
  let p = start;
  while (p < end) {
    const tag = readVarint(buf, p);
    if (!tag) return null;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field === 0) return null;
    p = tag.next;
    if (wire === 0) {
      const v = readVarint(buf, p);
      if (!v) return null;
      fields.push({ field, wire, value: v.value });
      p = v.next;
    } else if (wire === 2) {
      const len = readVarint(buf, p);
      if (!len) return null;
      const from = len.next;
      const to = from + len.value;
      if (to > end) return null;
      fields.push({ field, wire, from, to });
      p = to;
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (p + width > end) return null;
      fields.push({ field, wire });
      p += width;
    } else {
      // Groups (3/4) are legacy and Notes does not use them; treating them as a
      // misparse is safer than guessing where the group ends.
      return null;
    }
  }
  return p === end ? fields : null;
};

/** Valid UTF-8 that is mostly not control characters. */
const asText = (bytes: Uint8Array): string | null => {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (text.length < MIN_TEXT_LENGTH) return null;
  let controls = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (isControl(text.charCodeAt(i))) controls += 1;
  }
  return controls / text.length > MAX_CONTROL_RATIO ? null : text;
};

export type StringCandidate = { path: string; text: string; length: number };

/**
 * Every string in the blob, with the field path that reached it.
 *
 * A length-delimited field can be both a valid message and valid text, so both
 * readings are followed. That ambiguity is the normal case, not an error.
 */
export const collectStrings = (buf: Uint8Array, maxDepth = MAX_DEPTH): StringCandidate[] => {
  const out: StringCandidate[] = [];
  const walk = (start: number, end: number, path: number[], depth: number): void => {
    if (depth > maxDepth) return;
    const fields = parseFields(buf, start, end);
    if (!fields) return;
    for (const f of fields) {
      if (f.wire !== 2 || f.from === undefined || f.to === undefined) continue;
      const here = [...path, f.field];
      const text = asText(buf.subarray(f.from, f.to));
      if (text) out.push({ path: here.join("."), text, length: text.length });
      walk(f.from, f.to, here, depth + 1);
    }
  };
  walk(0, buf.length, [], 0);
  return out;
};

/**
 * Where the body lives: `document(2) -> note(3) -> note_text(2)`.
 *
 * Measured, not assumed. Running the structural walk over 53 real notes and
 * checking each result against the same note's Apple Events plaintext, every
 * note read from this path matched exactly (53/53), and picking the longest
 * string instead matched only 27/53 — on the other 26 an attribute-run field
 * outran the body by ~60 characters. That failure is silent: it returns
 * plausible, wrong text rather than an error.
 */
export const NOTE_TEXT_PATH = "2.3.2";

export type DecodedNote = {
  text: string | null;
  path: string | null;
  /** `pinned` or `longest`. A shift to `longest` is the schema-drift signal. */
  via: "pinned" | "longest" | null;
  candidateCount: number;
};

/**
 * The note body.
 *
 * Reads the pinned path first and falls back to the longest string only if that
 * path is absent, reporting which route it took so drift is detectable rather
 * than silently wrong.
 */
export const extractNoteText = (
  buf: Uint8Array,
  preferPath: string | null = NOTE_TEXT_PATH,
): DecodedNote => {
  const candidates = collectStrings(buf);
  const pinned = preferPath ? (candidates.find((c) => c.path === preferPath) ?? null) : null;
  const longest = candidates.toSorted((a, b) => b.length - a.length)[0] ?? null;
  const best = pinned ?? longest;
  return {
    text: best?.text ?? null,
    path: best?.path ?? null,
    via: best === null ? null : pinned ? "pinned" : "longest",
    candidateCount: candidates.length,
  };
};
