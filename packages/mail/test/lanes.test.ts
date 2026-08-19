import { describe, expect, it, vi } from "vitest";

import { MAIL_SURFACE, MailNotRunningError } from "../src/client/errors.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";

/**
 * Regression tests for the cold-start race.
 *
 * The first Apple Event of a fresh process triggers the macOS Automation
 * prompt, and osascript can report failure while the user is still deciding.
 * A single probe therefore mislabels a working lane as denied.
 */

const ACCOUNTS = [
  {
    id: "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99",
    name: "iCloud",
    enabled: true,
    accountType: "iCloud",
    emailAddresses: ["me@icloud.com"],
    fullName: "Me",
    directory: null,
    messageCaching: null,
    mailboxes: ["INBOX"],
  },
];

/** Fails the first N account probes, then succeeds — the prompt-race shape. */
const flakyRunner = (failures: number): { runner: OsascriptRunner; calls: () => number } => {
  let calls = 0;
  const runner: OsascriptRunner = {
    run: vi.fn(async (script: string) => {
      if (!script.includes("a.emailAddresses()")) return [];
      calls += 1;
      if (calls <= failures) throw new MailNotRunningError(MAIL_SURFACE);
      return ACCOUNTS;
    }) as OsascriptRunner["run"],
  };
  return { runner, calls: () => calls };
};

const clientWith = (runner: OsascriptRunner) =>
  new AppleMailClient({
    // Point the index somewhere that cannot exist, so the index lane is
    // deterministically unavailable and only the AppleScript lane is under test.
    config: loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: "/nonexistent/Envelope Index" }),
    osascript: runner,
  });

describe("lane probing", () => {
  it("reports live when the probe succeeds first time", async () => {
    const { runner } = flakyRunner(0);
    expect((await clientWith(runner).lanes()).applescript).toBe("live");
  });

  it("retries once, so a prompt-race failure does not mislabel a working lane", async () => {
    const { runner, calls } = flakyRunner(1);
    const lanes = await clientWith(runner).lanes();

    expect(lanes.applescript).toBe("live");
    expect(calls()).toBe(2);
  });

  it("still reports unavailable when the lane is genuinely dead", async () => {
    const { runner, calls } = flakyRunner(99);
    const lanes = await clientWith(runner).lanes();

    expect(lanes.applescript).toBe("unavailable");
    // Bounded: the lane probe retries once, and locate() makes one more attempt
    // when it asks Mail for its own data directory. Not an unbounded loop.
    expect(calls()).toBeLessThanOrEqual(4);
  });

  it("never calls the lane dead while also returning its data", async () => {
    // The exact contradiction observed in the wild: automation reported as
    // denied in a response that listed four accounts read over automation.
    const { runner } = flakyRunner(1);
    const client = clientWith(runner);

    // Mirrors the tool's own order: lanes() first, because it is the call that
    // retries past the prompt and leaves the accounts cached for the response.
    const lanes = await client.lanes();
    const accounts = await client.accounts();

    expect(lanes.applescript).toBe("live");
    expect(accounts).toHaveLength(1);
  });

  it("reports the index lane unavailable with a reason rather than throwing", async () => {
    const { runner } = flakyRunner(0);
    const lanes = await clientWith(runner).lanes();

    expect(lanes.index).toBe("unavailable");
    expect(lanes.indexReason).toBeTruthy();
  });

  it("honours APPLE_MAIL_INDEX_MODE=off without touching the disk", async () => {
    const { runner } = flakyRunner(0);
    const client = new AppleMailClient({
      config: loadConfig({ APPLE_MAIL_INDEX_MODE: "off" }),
      osascript: runner,
    });
    const lanes = await client.lanes();

    expect(lanes.index).toBe("disabled");
    expect(lanes.indexReason).toContain("off");
  });
});
