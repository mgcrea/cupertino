/**
 * NSArchiver `typedstream` reader — enough of it to pull the text out of a
 * Messages `attributedBody` blob.
 *
 * ## Why this has to exist
 *
 * `docs/messages.md` measured it: 97,092 of 97,414 messages carry a blob and
 * only 94,049 carry `text`. **The blob is the norm and `text` is the redundant
 * copy**, not the other way round. 3,043 messages — one in thirty-two — have an
 * empty `text` and content only in here, so a server that reads the column
 * returns nothing for them, silently and with no error to notice.
 *
 * The archive header is `04 0B streamtyped 81 E8 03`. Not `bplist00`, not gzip,
 * and not the protobuf that Notes turned out to hold, so none of the existing
 * decoders apply.
 *
 * ## The format, as far as this reader needs it
 *
 * A stream of tagged values. Integers are a single signed byte unless prefixed:
 *
 *     0x81  int16 follows (little-endian)
 *     0x82  int32 follows
 *     0x83  float or double follows
 *     0x84  START — a new class or object definition
 *     0x85  nil / empty
 *     0x86  END of the current object
 *     >=0x92 a back-reference; index = byte - 0x92
 *
 * Strings arrive length-prefixed. Class names and object contents both use that
 * shape, which is why this walks structurally instead of pattern-matching: the
 * same bytes mean different things depending on where you are.
 *
 * ## Honest failure, never a guess
 *
 * The Notes decoder was documented backwards because a `LIMIT 1` sample landed
 * on an outlier, and this project has now been bitten three times by a heuristic
 * that produced a plausible wrong answer. So there is no "longest printable run"
 * fallback here. If the structure does not parse, `ok` is false and the caller
 * counts it — and `text` remains available as the answer for the 96.5% of rows
 * that have one.
 *
 * Pure and I/O-free.
 *
 * ## Two copies, deliberately
 *
 * `scripts/lib/typedstream.mjs` is the same reader, and the probe uses it to
 * measure this one against a real store. They are kept in step by hand, as
 * `packages/notes/src/client/protobuf.ts` and `scripts/lib/note-protobuf.mjs`
 * already are: a probe that imported from a package would stop being runnable
 * before that package exists, which is the wrong way round.
 */

const SIGNATURE = "streamtyped";

const TAG_I16 = 0x81;
const TAG_I32 = 0x82;
const TAG_DECIMAL = 0x83;
const TAG_START = 0x84;
const TAG_EMPTY = 0x85;
const TAG_END = 0x86;
/** Anything at or above this is an index into the table of things already seen. */
const TAG_REFERENCE = 0x92;

/** A blob larger than this is not a message; refuse rather than chew through it. */
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
/**
 * Structural guard for the walk BEFORE the text is reached — class chains and
 * type encodings, which are a few dozen tokens on every blob measured. Reaching
 * this means the stream is not shaped like an archived attributed string.
 */
const MAX_TOKENS = 20_000;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

class Cursor {
  readonly buf: Uint8Array;
  pos: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.pos = 0;
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  byte(): number {
    return this.buf[this.pos++] as number;
  }
  peek(): number {
    return this.buf[this.pos] as number;
  }
  take(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /**
   * A byte at an offset from the cursor. Every caller checks `remaining` first,
   * so the index is in range — this exists to say that once rather than to
   * scatter non-null assertions through the integer readers.
   */
  at(offset: number): number {
    return this.buf[this.pos + offset] as number;
  }
}

/**
 * A signed integer, which is also how every length in the stream is written.
 *
 * Returns null rather than throwing on a truncated read — a truncated blob is a
 * finding, not a crash.
 */
const readInt = (c: Cursor): number | null => {
  if (c.done) return null;
  const b = c.byte();
  if (b === TAG_I16) {
    if (c.remaining < 2) return null;
    const v = c.at(0) | (c.at(1) << 8);
    c.pos += 2;
    // Sign-extend: lengths are positive, but the same encoding carries indices.
    return v > 0x7fff ? v - 0x10000 : v;
  }
  if (b === TAG_I32) {
    if (c.remaining < 4) return null;
    const v = (c.at(0) | (c.at(1) << 8) | (c.at(2) << 16) | (c.at(3) << 24)) >>> 0;
    c.pos += 4;
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
  if (b === TAG_DECIMAL) {
    // Present in attribute values (font sizes). Skipped deliberately: nothing
    // this reader reports needs the number, and consuming it keeps the walk
    // aligned. Width is not knowable from the tag alone, so this is where an
    // unfamiliar blob is most likely to derail — and it will say so.
    return null;
  }
  return b > 0x7f ? b - 0x100 : b;
};

/** A length-prefixed string. `null` when the bytes are not valid UTF-8. */
const readString = (c: Cursor): string | null => {
  const len = readInt(c);
  if (len === null || len < 0 || len > c.remaining) return null;
  const bytes = c.take(len);
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * A length-prefixed UTF-8 payload — the `+` type encoding's value.
 *
 * The length is in BYTES, which is the trap: a 22-character string of accents
 * and kana declares 36. Slicing by character count would desynchronise the walk
 * and corrupt everything after it.
 */
const readByteArray = (c: Cursor): string | null => {
  const len = readInt(c);
  if (len === null || len < 0 || len > c.remaining) return null;
  const bytes = c.take(len);
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * Validate the archive header and position the cursor after it.
 *
 * The system-version integer that follows the signature is read and discarded —
 * it is 1000 on every blob measured, and pinning it would reject a future macOS
 * for no reason.
 */
const readHeader = (c: Cursor): string | null => {
  if (c.remaining < 16) return "too short to be a typedstream";
  const version = c.byte();
  const sigLen = c.byte();
  if (sigLen !== SIGNATURE.length) return `bad signature length ${sigLen}`;
  const sig = latin1.decode(c.take(sigLen));
  if (sig !== SIGNATURE) return `not a typedstream (signature ${JSON.stringify(sig)})`;
  readInt(c);
  return version === 4 ? null : `unexpected streamer version ${version}`;
};

/**
 * Walk the stream, dispatching on the type encoding.
 *
 * The layout, read off real bytes rather than inferred — `NSArchiver` still
 * ships on macOS 26, so `NSAttributedString(string: "Hello, world")` archived
 * through it produces exactly what Messages stores, with a plaintext nobody has
 * to guess at:
 *
 *     04 0b "streamtyped" 81 e8 03      header
 *     84 01 40                          START, type "@" — an object
 *     84 84 84 12 "NSAttributedString" 00
 *     84 84 08 "NSObject" 00  85  92
 *     84 84 84 08 "NSString" 01  94
 *     84 01 2b  0c "Hello, world"       START, type "+", then the bytes
 *     86                                END
 *
 * So the content is whatever follows the type encoding `+`, and the length is in
 * BYTES of UTF-8 — 0x24 for a 22-character string of accents and kana. Past 127
 * it takes the 0x81 int16 form, measured at 0x81 90 01 for a 400-byte payload.
 *
 * Walking structurally rather than scanning for `84 01 2b` matters: 0x84 is a
 * valid UTF-8 continuation byte, so that sequence can occur INSIDE a message.
 * Consuming each payload by its declared length is what keeps the walk in sync
 * and makes a false positive impossible.
 */
type WalkResult = {
  strings: string[];
  classes: string[];
  firstPayloadEnd: number | null;
  error: string | null;
};

const walk = (c: Cursor): WalkResult => {
  const strings: string[] = [];
  const classes: string[] = [];
  let firstPayloadEnd: number | null = null;
  let tokens = 0;

  while (!c.done) {
    if (++tokens > MAX_TOKENS) {
      return { strings, classes, firstPayloadEnd, error: "token limit exceeded" };
    }
    const b = c.peek();

    if (b !== TAG_START) {
      // nil, END, a back-reference, a version byte or a scalar. None of them
      // carries text, and all are one byte wide.
      c.pos += 1;
      continue;
    }

    c.pos += 1;
    // A class chain: START START START <name>. Nothing to read at this level.
    if (c.peek() === TAG_START) continue;

    const before = c.pos;
    const encoding = readString(c);
    if (encoding === null) {
      c.pos = before;
      continue;
    }

    if (encoding === "+") {
      const value = readByteArray(c);
      if (value === null) {
        return { strings, classes, firstPayloadEnd, error: "truncated byte array" };
      }
      strings.push(value);
      firstPayloadEnd = c.pos;
      // STOP HERE. The first `+` payload is the backing store, and nothing past
      // it is decoded by design — so walking on can only fail.
      //
      // It did. Measured over 97,094 real blobs, this reader failed exactly
      // twice, both "token limit exceeded", and both had ALREADY read their text
      // (936 and 2,095 bytes) before exhausting the walk on attribute runs. Two
      // messages were being thrown away for work whose result was discarded.
      // Whether anything follows is a position comparison, not a walk.
      return { strings, classes, firstPayloadEnd, error: null };
    }

    // A class name rather than a type encoding. Recorded because which classes
    // appear is how the open question in docs/messages.md gets answered.
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(encoding) && encoding.length > 2) classes.push(encoding);
  }
  return { strings, classes, firstPayloadEnd, error: null };
};

/**
 * The message text.
 *
 * ## Text only, and that is now a measured decision rather than a shortcut
 *
 * `docs/messages.md` left this open: *"whether `attributedBody` carries
 * formatting that matters, or is only ever a redundant copy of `text` plus
 * attachment placeholders. This decides whether the decoder must preserve
 * structure or merely extract a string."*
 *
 * It is the second. Two things settle it:
 *
 * 1. **Attribute values are back-REFERENCED, not inline.** Archiving an
 *    attachment-shaped string through the real `NSArchiver` produces
 *    `92 84 98 98 22 "__kIMFileTransferGUIDAttributeName" 86` — where `98` is an
 *    index into the object table rather than a type encoding. Resolving those
 *    means reconstructing the whole table, which is materially more code and
 *    more ways to be silently wrong.
 * 2. **Nothing needs it.** The one attribute worth having is the file-transfer
 *    GUID, and attachments are already reachable relationally — 17,529 rows in
 *    their own table, joined through `message_attachment_join`. The blob's copy
 *    is redundant, and the placeholder character itself (U+FFFC) survives in the
 *    text, so the position is not lost either.
 *
 * So this returns the backing string and says plainly that it stopped there.
 * `hasAttributes` reports whether anything followed it, which is what a future
 * decision to go further would be based on — a count, not a guess.
 */
export type DecodedBody =
  | {
      ok: true;
      text: string;
      classes: string[];
      /** Bytes remained after the backing store — attribute runs this does not decode. */
      hasAttributes: boolean;
      error: null;
    }
  | { ok: false; text?: undefined; classes?: string[]; hasAttributes?: undefined; error: string };

export const decodeAttributedBody = (buffer: Uint8Array | null | undefined): DecodedBody => {
  if (!buffer || buffer.length === 0) return { ok: false, error: "empty blob" };
  if (buffer.length > MAX_BLOB_BYTES) return { ok: false, error: "blob too large" };

  const c = new Cursor(buffer);
  const headerError = readHeader(c);
  if (headerError) return { ok: false, error: headerError };

  const { strings, classes, error, firstPayloadEnd } = walk(c);
  if (error) return { ok: false, error, classes };
  if (strings.length === 0) return { ok: false, error: "no content string found", classes };

  return {
    ok: true,
    text: strings[0] as string,
    classes,
    /** Bytes remained after the backing store — attribute runs this does not decode. */
    hasAttributes: firstPayloadEnd !== null && firstPayloadEnd < buffer.length - 2,
    error: null,
  };
};

/**
 * A redacted structural outline of one blob.
 *
 * For measuring the format on a machine that has the data, without the report
 * ever carrying a message. Every string is reduced to its length and its
 * character class; only Apple's own constants survive as themselves.
 */
export const outline = (buffer: Uint8Array, maxTokens = 60): string[] => {
  const c = new Cursor(buffer);
  const headerError = readHeader(c);
  if (headerError) return [`ERROR ${headerError}`];

  const out: string[] = [];
  let tokens = 0;
  while (!c.done && tokens < maxTokens) {
    tokens += 1;
    const b = c.peek();
    if (b === TAG_START) {
      c.pos += 1;
      out.push("START");
      continue;
    }
    if (b === TAG_EMPTY) {
      c.pos += 1;
      out.push("nil");
      continue;
    }
    if (b === TAG_END) {
      c.pos += 1;
      out.push("END");
      continue;
    }
    if (b >= TAG_REFERENCE) {
      c.pos += 1;
      out.push(`ref#${b - TAG_REFERENCE}`);
      continue;
    }
    const before = c.pos;
    const s = readString(c);
    if (s === null) {
      c.pos = before + 1;
      out.push(`byte 0x${b.toString(16).padStart(2, "0")}`);
      continue;
    }
    // Apple constants and type encodings are safe to print. Anything else is
    // somebody's message, and only its shape leaves the process.
    if (/^(NS|IM|__kIM|CF)[A-Za-z0-9_]*$/.test(s) || s.length <= 2) out.push(`"${s}"`);
    else out.push(`<str len=${s.length} ${/^[\x20-\x7e]*$/.test(s) ? "ascii" : "unicode"}>`);
  }
  if (!c.done) out.push("…");
  return out;
};

export const TYPEDSTREAM_SIGNATURE = SIGNATURE;
