// Decodes the transcript Apple embeds in a Voice Memos recording.
//
// The payload is UTF-8 JSON, `{ locale, attributedString }`, in three measured variants
// (docs/voice-memos.md):
//   - `attributedString: { runs: [text, index, …], attributeTable: [{ timeRange }] }`
//   - `attributedString: [text, { timeRange }, …]`, a flat alternating array
//   - `attributedString: ""`, a transcript that ran and heard nothing
//
// Measured, not assumed: `timeRange` is `[start, end]` in seconds; each run carries its own
// leading space, so the text is the runs concatenated; and a pause is folded into the word
// before it rather than left as a gap, which is why a wide word ends a segment.

export type Segment = { start: number; end: number; text: string };
export type Transcript =
  | { status: "ok"; locale: string | null; segments: Segment[] }
  /** The transcript ran and heard nothing. */
  | { status: "empty"; locale: string | null }
  /** The file carries no transcript: Apple has not transcribed it. */
  | { status: "none" }
  /** The recording has no audio file. */
  | { status: "no-audio" }
  /** There is a transcript, or should be, and it could not be read. Never reported as none. */
  | { status: "unreadable"; reason: string };

export const SEGMENTING = { maxGapSeconds: 1.0, maxWordSeconds: 1.0, maxChars: 400 } as const;

type Word = { text: string; start: number; end: number };

const PUNCTUATION_ONLY = /^\s*[.,!?;:…]+\s*$/u;
const SENTENCE_END = /[.!?…]["'”’)]*\s*$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `[start, end]`, or null when the entry carries no usable timing. */
const rangeOf = (attrs: unknown): [number, number] | null => {
  if (!isRecord(attrs)) return null;
  const r = attrs["timeRange"];
  if (!Array.isArray(r) || typeof r[0] !== "number" || typeof r[1] !== "number") return null;
  return [r[0], Math.max(r[0], r[1])];
};

/** Turns text/attribute pairs into words. A run with no timing takes the previous word's end. */
const wordsOf = (pairs: [unknown, unknown][]): Word[] | string => {
  const words: Word[] = [];
  let cursor = 0;
  for (const [i, [text, attrs]] of pairs.entries()) {
    if (typeof text !== "string") return `run ${i + 1} is not text`;
    const range = rangeOf(attrs) ?? [cursor, cursor];
    cursor = range[1];
    words.push({ text, start: range[0], end: range[1] });
  }
  return words;
};

const pairsOf = (attributed: unknown): [unknown, unknown][] | string => {
  if (Array.isArray(attributed)) {
    const pairs: [unknown, unknown][] = [];
    for (let i = 0; i < attributed.length; i += 2) pairs.push([attributed[i], attributed[i + 1]]);
    return pairs;
  }
  if (isRecord(attributed)) {
    const runs = attributed["runs"];
    const table = attributed["attributeTable"];
    if (!Array.isArray(runs) || !Array.isArray(table)) {
      return "unknown transcript shape: attributedString has no runs and attributeTable";
    }
    const pairs: [unknown, unknown][] = [];
    for (let i = 0; i < runs.length; i += 2) {
      const index = runs[i + 1];
      pairs.push([runs[i], typeof index === "number" ? table[index] : undefined]);
    }
    return pairs;
  }
  return `unknown transcript shape: attributedString is ${attributed === null ? "null" : typeof attributed}`;
};

const segment = (words: Word[]): Segment[] => {
  const segments: Segment[] = [];
  let current: { start: number; end: number; text: string } | null = null;
  const flush = (): void => {
    if (current) {
      const text = current.text.trim();
      if (text) segments.push({ start: current.start, end: current.end, text });
    }
    current = null;
  };
  for (const word of words) {
    const text = PUNCTUATION_ONLY.test(word.text) ? word.text.trim() : word.text;
    if (!text.trim()) continue;
    if (current !== null) {
      const c: { start: number; end: number; text: string } = current;
      const gap = word.start - c.end;
      const tooLong = (c.text + text).trim().length > SEGMENTING.maxChars;
      if (gap > SEGMENTING.maxGapSeconds || tooLong) flush();
    }
    if (current === null) current = { start: word.start, end: word.end, text: text.trimStart() };
    else {
      current.text += text;
      current.end = Math.max(current.end, word.end);
    }
    if (SENTENCE_END.test(text) || word.end - word.start > SEGMENTING.maxWordSeconds) flush();
  }
  flush();
  return segments;
};

/** Decodes a transcript payload. Never returns `none` or `no-audio`: those are the caller's to say. */
export const decodeTranscript = (bytes: Uint8Array): Transcript => {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return {
      status: "unreadable",
      reason: `the transcript is not JSON: ${(error as Error).message}`,
    };
  }
  if (!isRecord(doc) || !("attributedString" in doc)) {
    return { status: "unreadable", reason: "unknown transcript shape: no attributedString" };
  }
  const loc = doc["locale"];
  const locale = isRecord(loc) && typeof loc["identifier"] === "string" ? loc["identifier"] : null;
  const attributed = doc["attributedString"];
  if (attributed === "") return { status: "empty", locale };
  const pairs = pairsOf(attributed);
  if (typeof pairs === "string") return { status: "unreadable", reason: pairs };
  const words = wordsOf(pairs);
  if (typeof words === "string") return { status: "unreadable", reason: words };
  const segments = segment(words);
  if (segments.length === 0) return { status: "empty", locale };
  return { status: "ok", locale, segments };
};

export const transcriptText = (segments: Segment[]): string =>
  segments.map((s) => s.text).join("\n");
