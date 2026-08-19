/**
 * Minimal protobuf wire-format reader, enough to pull the body text out of an
 * Apple Notes `ZICNOTEDATA.ZDATA` blob.
 *
 * ## Why it does not hardcode Apple's schema
 *
 * The usual approach is to compile Apple's (unpublished) .proto and read
 * `document.note.note_text` by field number. That breaks the first time Apple
 * renumbers a field, and this repo already budgets for the schema drifting on
 * every macOS release.
 *
 * So this walks the wire format structurally instead: every length-delimited
 * field is tried both as a nested message and as a UTF-8 string, and the
 * longest plausible string wins. Field numbers are *reported* rather than
 * assumed, which turns "which path holds the text" into a measurement the probe
 * records - the same way the Envelope Index schema was learned, not guessed.
 *
 * Wire format, for reference:
 *   tag = varint;  field = tag >> 3;  wire type = tag & 7
 *   0 varint - 1 fixed64 - 2 length-delimited - 5 fixed32 - 3/4 groups (legacy)
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
const isControl = (code) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;

/** Read a base-128 varint. Returns null rather than throwing on a truncated one. */
export const readVarint = (buf, pos) => {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const byte = buf[p];
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

/**
 * Split a buffer into wire-format fields. Returns null if the bytes are not a
 * well-formed message ending exactly on the boundary - that "exactly" is what
 * makes this usable as a test for whether a blob is a nested message.
 */
export const parseFields = (buf, start = 0, end = buf.length) => {
  const fields = [];
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
const asText = (bytes) => {
  let text;
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

/**
 * Every string in the blob, with the field path that reached it.
 *
 * A length-delimited field can be both a valid message and valid text, so both
 * readings are followed. That ambiguity is the normal case, not an error - the
 * caller resolves it by picking the longest candidate.
 */
export const collectStrings = (buf, { maxDepth = MAX_DEPTH } = {}) => {
  const out = [];
  const walk = (start, end, path, depth) => {
    if (depth > maxDepth) return;
    const fields = parseFields(buf, start, end);
    if (!fields) return;
    for (const f of fields) {
      if (f.wire !== 2) continue;
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
 * note whose text was read from this path matched exactly, and every note read
 * from anywhere else did not. Discovering this is what the walk was for.
 */
export const NOTE_TEXT_PATH = "2.3.2";

/**
 * The note body.
 *
 * Reads the pinned path first and falls back to the longest string only if that
 * path is absent. "Longest" alone is NOT good enough: on about half of a real
 * library an attribute-run field outruns the body by ~60 characters and wins,
 * which is a silently wrong answer rather than a failure.
 *
 * `via` reports which route produced the text, so a caller can detect Apple
 * renumbering the field - a sudden shift to "longest" is the drift signal.
 */
export const extractNoteText = (buf, { preferPath = NOTE_TEXT_PATH, ...opts } = {}) => {
  const candidates = collectStrings(buf, opts);
  const byLength = candidates.toSorted((a, b) => b.length - a.length);
  const pinned = candidates.find((c) => c.path === preferPath) ?? null;
  const best = pinned ?? byLength[0] ?? null;
  return {
    text: best?.text ?? null,
    path: best?.path ?? null,
    via: best === null ? null : pinned ? "pinned" : "longest",
    candidateCount: candidates.length,
    // Field paths and lengths only - never the text itself.
    topPaths: byLength.slice(0, 3).map((c) => ({ path: c.path, length: c.length })),
  };
};
