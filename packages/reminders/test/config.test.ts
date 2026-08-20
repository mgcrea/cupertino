import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/** `loadConfig` takes an env object so these are hermetic — no process.env mutation. */
describe("loadConfig", () => {
  it("defaults writes off", () => {
    expect(loadConfig({}).allowWrites).toBe(false);
  });

  it.each([["1"], ["true"], ["yes"], ["on"]])("treats %s as enabling writes", (v) => {
    expect(loadConfig({ APPLE_REMINDERS_ALLOW_WRITES: v }).allowWrites).toBe(true);
  });

  /**
   * The default that matches what Reminders itself shows. A long-lived account
   * holds years of completed items, and surfacing them by default would bury
   * every live one.
   */
  it("excludes completed reminders by default", () => {
    expect(loadConfig({}).includeCompleted).toBe(false);
  });

  it("can be told to include them", () => {
    expect(loadConfig({ APPLE_REMINDERS_INCLUDE_COMPLETED: "1" }).includeCompleted).toBe(true);
  });

  it("splits the account allowlist on commas and trims", () => {
    expect(loadConfig({ APPLE_REMINDERS_ACCOUNTS: " iCloud , Work " }).accounts).toEqual([
      "iCloud",
      "Work",
    ]);
  });

  /**
   * Lists are a separate allowlist from accounts on purpose: a shared grocery
   * list and a private one live in the same account, so the account is often
   * the wrong unit to scope by.
   */
  it("splits the list allowlist independently of accounts", () => {
    const c = loadConfig({ APPLE_REMINDERS_LISTS: "Groceries,Work" });
    expect(c.lists).toEqual(["Groceries", "Work"]);
    expect(c.accounts).toEqual([]);
  });

  it("inherits the shared defaults from BaseConfigSchema", () => {
    const c = loadConfig({});
    expect(c.osascriptPath).toBe("/usr/bin/osascript");
    expect(c.osascriptTimeoutMs).toBe(30_000);
  });

  it("rejects an out-of-range value rather than silently clamping", () => {
    expect(() => loadConfig({ APPLE_REMINDERS_OSASCRIPT_TIMEOUT_MS: "5" })).toThrow(
      /Invalid configuration/,
    );
  });

  it("ignores an unparseable number so the default applies", () => {
    expect(loadConfig({ APPLE_REMINDERS_MAX_RESULTS: "abc" }).maxResults).toBe(200);
  });

  it("rejects an unknown index mode", () => {
    expect(() => loadConfig({ APPLE_REMINDERS_INDEX_MODE: "sideways" })).toThrow(
      /Invalid configuration/,
    );
  });

  it("leaves defaultList unset so Reminders' own default list wins", () => {
    expect(loadConfig({}).defaultList).toBeUndefined();
  });
});
