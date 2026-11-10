import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TranscriptCache } from "../src/client/transcript-cache.js";
import { m4aWithTranscript } from "./helpers/audio.js";

const said = (text: string) => ({
  attributedString: { runs: [text, 0], attributeTable: [{ timeRange: [0, 1] }] },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vm-cache-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TranscriptCache", () => {
  it("reads a file again when its mtime or size changes", () => {
    const path = join(dir, "a.m4a");
    writeFileSync(path, m4aWithTranscript(said("first")));
    const cache = new TranscriptCache();
    expect(cache.read(path)).toMatchObject({ segments: [{ text: "first" }] });
    writeFileSync(path, m4aWithTranscript(said("second, longer")));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect(cache.read(path)).toMatchObject({ segments: [{ text: "second, longer" }] });
  });

  it("holds at most its capacity, evicting the least recently used", () => {
    const cache = new TranscriptCache(2);
    const paths = ["a", "b", "c"].map((n) => {
      const p = join(dir, `${n}.m4a`);
      writeFileSync(p, m4aWithTranscript(said(n)));
      return p;
    });
    cache.read(paths[0]!);
    cache.read(paths[1]!);
    cache.read(paths[0]!);
    cache.read(paths[2]!);
    expect(cache.size).toBe(2);
  });

  it("answers no-audio for a file that is not there", () => {
    expect(new TranscriptCache().read(join(dir, "gone.m4a"))).toEqual({ status: "no-audio" });
  });
});
