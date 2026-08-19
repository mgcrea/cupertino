import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/** `loadConfig` takes an env object so these are hermetic — no process.env mutation. */
describe("loadConfig", () => {
  it("defaults writes off", () => {
    expect(loadConfig({}).allowWrites).toBe(false);
  });

  it.each([["1"], ["true"], ["yes"], ["on"]])("treats %s as enabling writes", (v) => {
    expect(loadConfig({ APPLE_NOTES_ALLOW_WRITES: v }).allowWrites).toBe(true);
  });

  it.each([["0"], ["false"], ["off"], [""]])("treats %s as leaving writes off", (v) => {
    expect(loadConfig({ APPLE_NOTES_ALLOW_WRITES: v }).allowWrites).toBe(false);
  });

  it("splits the account allowlist on commas and trims", () => {
    expect(loadConfig({ APPLE_NOTES_ACCOUNTS: " iCloud , Work " }).accounts).toEqual([
      "iCloud",
      "Work",
    ]);
  });

  it("inherits the shared defaults from BaseConfigSchema", () => {
    const c = loadConfig({});
    expect(c.osascriptPath).toBe("/usr/bin/osascript");
    expect(c.osascriptTimeoutMs).toBe(30_000);
  });

  it("rejects an out-of-range value rather than silently clamping", () => {
    expect(() => loadConfig({ APPLE_NOTES_OSASCRIPT_TIMEOUT_MS: "5" })).toThrow(
      /Invalid configuration/,
    );
  });

  it("ignores an unparseable number so the default applies", () => {
    expect(loadConfig({ APPLE_NOTES_MAX_RESULTS: "abc" }).maxResults).toBe(200);
  });

  it("rejects an unknown index mode", () => {
    expect(() => loadConfig({ APPLE_NOTES_INDEX_MODE: "sideways" })).toThrow(
      /Invalid configuration/,
    );
  });
});
