import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportName, VoiceMemosClient } from "../src/client/voice-memos.js";
import { loadConfig } from "../src/config.js";
import { m4aWithTranscript, qtaWithTranscript } from "./helpers/audio.js";
import { insertRecording, type Library, makeLibrary } from "./helpers/store.js";

let lib: Library;
let out: string;
let client: VoiceMemosClient;
const QTA = qtaWithTranscript({ attributedString: "" });

beforeEach(() => {
  lib = makeLibrary();
  out = realpathSync(mkdtempSync(join(tmpdir(), "vm-export-")));
  insertRecording(lib.db, {
    pk: 1,
    id: "Q",
    title: "Weekly sync",
    date: 3,
    path: lib.addAudio("q.qta", QTA),
  });
  insertRecording(lib.db, {
    pk: 2,
    id: "M",
    label: "2025-11-05T09:00:00Z",
    date: 2,
    path: lib.addAudio("m.m4a", m4aWithTranscript(null)),
  });
  insertRecording(lib.db, { pk: 3, id: "GONE", title: "Lost", date: 1 });
  insertRecording(lib.db, {
    pk: 4,
    id: "EVIL",
    title: "../../etc/passwd/..",
    date: 0,
    path: lib.addAudio("e.qta", QTA),
  });
  client = new VoiceMemosClient({
    config: loadConfig({
      APPLE_VOICE_MEMOS_STORE: lib.storePath,
      APPLE_VOICE_MEMOS_EXPORT_DIR: out,
      APPLE_VOICE_MEMOS_ALLOW_WRITES: "1",
    }),
  });
});

afterEach(() => {
  lib.cleanup();
  rmSync(out, { recursive: true, force: true });
});

describe("saveRecording", () => {
  it("copies the audio byte for byte into exportDir with the title as name", () => {
    const saved = client.saveRecording("Q");
    expect(saved).toEqual({ path: join(out, "Weekly sync.qta"), bytes: QTA.length, format: "qta" });
    expect(new Uint8Array(readFileSync(saved.path))).toEqual(QTA);
  });

  it("names an untitled recording from its label, keeping the extension", () => {
    expect(client.saveRecording("M").path).toBe(join(out, "2025-11-05T09_00_00Z.m4a"));
  });

  it("refuses to overwrite unless asked", () => {
    client.saveRecording("Q");
    expect(() => client.saveRecording("Q")).toThrow(/already exists/);
    expect(client.saveRecording("Q", { overwrite: true }).bytes).toBe(QTA.length);
  });

  it("refuses a row without audio with the no-audio reason", () => {
    expect(() => client.saveRecording("GONE")).toThrow(/no audio file/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('a title with "/" and ".." cannot leave exportDir', () => {
    const saved = client.saveRecording("EVIL");
    expect(saved.path.startsWith(`${out}/`)).toBe(true);
    expect(readdirSync(out)).toHaveLength(1);
    expect(existsSync(join(out, "..", "etc"))).toBe(false);
  });

  it("refuses a directory outside exportDir", () => {
    expect(() => client.saveRecording("Q", { directory: "../elsewhere" })).toThrow(/outside/);
  });
});

describe("exportName", () => {
  it("keeps letters, digits, spaces, dots, dashes and underscores, and caps the length", () => {
    expect(exportName("Café: notes/ideas?", ".qta")).toBe("Café_ notes_ideas_.qta");
    expect(exportName("a".repeat(300), ".m4a")).toBe(`${"a".repeat(120)}.m4a`);
    expect(exportName("..", ".m4a")).toBe("recording.m4a");
  });
});
