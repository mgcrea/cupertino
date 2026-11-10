import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults exportDir to ~/Downloads, one of Cadence's import folders", () => {
    expect(loadConfig({}).exportDir).toBe(join(homedir(), "Downloads"));
  });

  it("takes APPLE_VOICE_MEMOS_EXPORT_DIR over the default", () => {
    expect(loadConfig({ APPLE_VOICE_MEMOS_EXPORT_DIR: " /tmp/memos " }).exportDir).toBe(
      "/tmp/memos",
    );
  });

  it("reads the store path, index mode and write gate", () => {
    const c = loadConfig({
      APPLE_VOICE_MEMOS_STORE: "/x/CloudRecordings.db",
      APPLE_VOICE_MEMOS_INDEX_MODE: "immutable",
      APPLE_VOICE_MEMOS_ALLOW_WRITES: "1",
    });
    expect(c).toMatchObject({
      storePath: "/x/CloudRecordings.db",
      indexMode: "immutable",
      allowWrites: true,
    });
    expect(loadConfig({}).indexMode).toBe("auto");
    expect(loadConfig({}).allowWrites).toBe(false);
  });

  it("rejects an unknown index mode", () => {
    expect(() => loadConfig({ APPLE_VOICE_MEMOS_INDEX_MODE: "wal" })).toThrow();
  });
});
