import { statSync } from "node:fs";

import { AudioParseError, scanAudioFile } from "./mp4.js";
import { decodeTranscript, type Transcript } from "./transcript.js";

/**
 * Decoded transcripts, keyed by `(path, mtime, size)` so an edited or re-synced file is read
 * again. In memory and bounded: search reads every transcript, and walking the boxes of all 86
 * files on the probed library took about 200 ms, so no persistent index.
 */
export const TRANSCRIPT_CACHE_ENTRIES = 256;

export class TranscriptCache {
  readonly #entries = new Map<string, Transcript>();

  constructor(private readonly capacity: number = TRANSCRIPT_CACHE_ENTRIES) {}

  get size(): number {
    return this.#entries.size;
  }

  /** The transcript in the file at `path`, which must exist. Never throws on a bad file. */
  read(path: string): Transcript {
    let key: string;
    try {
      const st = statSync(path);
      key = `${path}\0${st.mtimeMs}\0${st.size}`;
    } catch {
      return { status: "no-audio" };
    }
    const hit = this.#entries.get(key);
    if (hit) {
      // Re-insert so the least recently used entry is the one evicted.
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const transcript = this.#decode(path);
    this.#entries.set(key, transcript);
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return transcript;
  }

  #decode(path: string): Transcript {
    try {
      const scan = scanAudioFile(path);
      if (!scan.transcript) return { status: "none" };
      return decodeTranscript(scan.transcript.bytes);
    } catch (error) {
      const reason =
        error instanceof AudioParseError
          ? `the audio file would not parse: ${error.message}`
          : `the audio file could not be read: ${(error as Error).message}`;
      return { status: "unreadable", reason };
    }
  }
}
