import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GROUP_RECORDINGS_DIR,
  LEGACY_RECORDINGS_DIR,
  locateStore,
  STORE_FILENAME,
} from "../src/client/locate.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vm-locate-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const plant = (parts: string[]): string => {
  const dir = join(home, ...parts);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, STORE_FILENAME);
  writeFileSync(path, "");
  return path;
};

describe("locateStore", () => {
  it("chooses the group container over the legacy directory", () => {
    const group = plant(GROUP_RECORDINGS_DIR);
    plant(LEGACY_RECORDINGS_DIR);
    const found = locateStore({ home });
    expect(found).toMatchObject({
      storePath: group,
      directory: join(home, ...GROUP_RECORDINGS_DIR),
      legacy: false,
      exists: true,
      readable: true,
      reason: null,
    });
  });

  it("falls back to the legacy directory when the group container has no store", () => {
    const legacy = plant(LEGACY_RECORDINGS_DIR);
    expect(locateStore({ home })).toMatchObject({
      storePath: legacy,
      directory: join(home, ...LEGACY_RECORDINGS_DIR),
      legacy: true,
    });
  });

  it("reports the group container when neither exists", () => {
    const found = locateStore({ home });
    expect(found).toMatchObject({
      storePath: join(home, ...GROUP_RECORDINGS_DIR, STORE_FILENAME),
      exists: false,
      legacy: false,
    });
    expect(found.reason).toMatch(/Full Disk Access/);
  });

  it("an explicit storePath wins, and its directory holds the audio", () => {
    plant(GROUP_RECORDINGS_DIR);
    const elsewhere = plant(["elsewhere"]);
    expect(locateStore({ home, storePath: elsewhere })).toMatchObject({
      storePath: elsewhere,
      directory: join(home, "elsewhere"),
      legacy: false,
    });
  });

  it("names Full Disk Access when the store exists but cannot be read", () => {
    const group = plant(GROUP_RECORDINGS_DIR);
    chmodSync(group, 0o000);
    try {
      const found = locateStore({ home });
      expect(found).toMatchObject({ exists: true, readable: false });
      expect(found.reason).toMatch(/Full Disk Access/);
      expect(found.reason).toMatch(/Voice Memos\.app/);
    } finally {
      chmodSync(group, 0o600);
    }
  });
});
