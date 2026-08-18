import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/**
 * `loadConfig` takes `env` as a parameter precisely so these tests never touch
 * (and never have to restore) process.env.
 */
describe("loadConfig", () => {
  it("defaults to a read-only server with no allowlist", () => {
    const config = loadConfig({});
    expect(config.allowWrites).toBe(false);
    expect(config.accounts).toEqual([]);
    expect(config.indexMode).toBe("auto");
    expect(config.osascriptPath).toBe("/usr/bin/osascript");
    expect(config.attachmentDir).toBe(join(homedir(), "Downloads"));
  });

  it.each([
    ["1", true],
    ["true", true],
    ["YES", true],
    ["on", true],
    ["0", false],
    ["false", false],
    ["", false],
  ])("parses APPLE_MAIL_ALLOW_WRITES=%s as %s", (value, expected) => {
    expect(loadConfig({ APPLE_MAIL_ALLOW_WRITES: value }).allowWrites).toBe(expected);
  });

  it("splits the account allowlist and drops blanks", () => {
    const config = loadConfig({ APPLE_MAIL_ACCOUNTS: " iCloud , ,Work " });
    expect(config.accounts).toEqual(["iCloud", "Work"]);
  });

  it("accepts the index modes and rejects anything else", () => {
    expect(loadConfig({ APPLE_MAIL_INDEX_MODE: "off" }).indexMode).toBe("off");
    expect(() => loadConfig({ APPLE_MAIL_INDEX_MODE: "readwrite" })).toThrow(/indexMode/);
  });

  it("rejects a nonsensical timeout instead of silently clamping it", () => {
    expect(() => loadConfig({ APPLE_MAIL_OSASCRIPT_TIMEOUT_MS: "10" })).toThrow(
      /osascriptTimeoutMs/,
    );
  });

  it("ignores a non-numeric override rather than producing NaN", () => {
    expect(loadConfig({ APPLE_MAIL_MAX_RESULTS: "lots" }).maxResults).toBe(200);
  });

  it("reads the remaining overrides", () => {
    const config = loadConfig({
      APPLE_MAIL_ROOT: "/tmp/Mail/V10",
      APPLE_MAIL_ENVELOPE_INDEX: "/tmp/idx",
      APPLE_MAIL_DEGRADED_MAX_MESSAGES: "10",
      APPLE_MAIL_BODY_MAX_BYTES: "2048",
      APPLE_MAIL_ATTACHMENT_DIR: "/tmp/att",
      APPLE_MAIL_MAILBOX_CACHE_TTL_MS: "0",
      APPLE_MAIL_OSASCRIPT_PATH: "/opt/osascript",
    });
    expect(config).toMatchObject({
      mailRoot: "/tmp/Mail/V10",
      envelopeIndexPath: "/tmp/idx",
      degradedMaxMessages: 10,
      bodyMaxBytes: 2048,
      attachmentDir: "/tmp/att",
      mailboxCacheTtlMs: 0,
      osascriptPath: "/opt/osascript",
    });
  });
});
