import { describe, expect, it } from "vitest";

import {
  decodeTranscript,
  SEGMENTING,
  type Segment,
  transcriptText,
} from "../src/client/transcript.js";
import { utf8 } from "./helpers/audio.js";

const LOCALE = { identifier: "en_US", current: 0 };

/** `runs` + `attributeTable`, the common variant: one table entry per word. */
const runsOf = (words: [string, number, number][]): unknown => ({
  locale: LOCALE,
  attributedString: {
    runs: words.flatMap(([text], i) => [text, i]),
    attributeTable: words.map(([, start, end]) => ({ timeRange: [start, end] })),
  },
});

const decode = (json: unknown) => decodeTranscript(utf8(JSON.stringify(json)));

const segmentsOf = (json: unknown): Segment[] => {
  const t = decode(json);
  if (t.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(t)}`);
  return t.segments;
};

describe("decodeTranscript", () => {
  it("decodes runs + attributeTable", () => {
    const t = decode(
      runsOf([
        ["Hello", 0, 0.4],
        [" world.", 0.4, 0.9],
        [" Next", 0.9, 1.2],
      ]),
    );
    expect(t).toEqual({
      status: "ok",
      locale: "en_US",
      segments: [
        { start: 0, end: 0.9, text: "Hello world." },
        { start: 0.9, end: 1.2, text: "Next" },
      ],
    });
  });

  it("decodes the flat alternating array", () => {
    const t = decode({
      locale: LOCALE,
      attributedString: ["Hi", { timeRange: [0, 0.3] }, " there", { timeRange: [0.3, 0.6] }],
    });
    expect(t).toEqual({
      status: "ok",
      locale: "en_US",
      segments: [{ start: 0, end: 0.6, text: "Hi there" }],
    });
  });

  it('reports empty for attributedString ""', () => {
    expect(decode({ locale: LOCALE, attributedString: "" })).toEqual({
      status: "empty",
      locale: "en_US",
    });
  });

  it("breaks after a word wider than maxWordSeconds", () => {
    expect(SEGMENTING.maxWordSeconds).toBe(1.0);
    // " so" spans 1.5 s: Apple folds the pause after it into the word.
    const segments = segmentsOf(
      runsOf([
        ["Well", 0, 0.5],
        [" so", 1, 2.5],
        [" anyway", 2.5, 3],
      ]),
    );
    expect(segments.map((s) => s.text)).toEqual(["Well so", "anyway"]);
    expect(segments[0]).toMatchObject({ start: 0, end: 2.5 });
  });

  it("breaks at a gap over maxGapSeconds", () => {
    const segments = segmentsOf(
      runsOf([
        ["One", 0, 0.5],
        [" two", 0.5, 1],
        [" three", 2.2, 2.6],
      ]),
    );
    expect(segments.map((s) => s.text)).toEqual(["One two", "three"]);
  });

  it("caps a segment at maxChars without splitting a word", () => {
    const word = " abcdefghi"; // 10 characters, abutting, no punctuation
    const words: [string, number, number][] = Array.from({ length: 100 }, (_, i) => [
      i === 0 ? word.trim() : word,
      i * 0.1,
      (i + 1) * 0.1,
    ]);
    const segments = segmentsOf(runsOf(words));
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.text.length).toBeLessThanOrEqual(SEGMENTING.maxChars);
      expect(s.text.split(" ").every((w) => w === "abcdefghi")).toBe(true);
    }
    expect(segments.map((s) => s.text).join(" ")).toBe(words.map(([w]) => w.trim()).join(" "));
  });

  it("drops the space before a punctuation-only run", () => {
    const segments = segmentsOf(
      runsOf([
        ["Yes", 0, 0.3],
        [" ,", 0.3, 0.3],
        [" sir", 0.3, 0.6],
      ]),
    );
    expect(segments.map((s) => s.text)).toEqual(["Yes, sir"]);
  });

  it("is unreadable, not empty, on bad JSON or an unknown shape", () => {
    const bad = decodeTranscript(utf8("{not json"));
    expect(bad.status).toBe("unreadable");
    expect(bad.status === "unreadable" && bad.reason).toMatch(/JSON/);

    const shape = decode({ locale: LOCALE, attributedString: 42 });
    expect(shape.status).toBe("unreadable");
    expect(shape.status === "unreadable" && shape.reason).toMatch(/shape/);
  });

  it("reads a missing locale as null", () => {
    expect(decode({ attributedString: "" })).toEqual({ status: "empty", locale: null });
  });
});

describe("transcriptText", () => {
  it("joins segments with \\n", () => {
    expect(
      transcriptText([
        { start: 0, end: 1, text: "A." },
        { start: 1, end: 2, text: "B." },
      ]),
    ).toBe("A.\nB.");
  });
});
