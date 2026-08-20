import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { describe, expect, it, vi } from "vitest";

import { AppleRemindersClient } from "../src/client/reminders.js";
import { loadConfig } from "../src/config.js";

const BULK = { count: 0, reminders: [], lists: [], unmapped: 0, membershipVia: "nested" };

const runner = () => {
  const run = vi.fn(async (script: string) => {
    if (script.includes("membershipVia")) return BULK;
    return [];
  });
  return { run } as unknown as OsascriptRunner & { run: ReturnType<typeof vi.fn> };
};

const bulkCalls = (r: { run: ReturnType<typeof vi.fn> }) =>
  r.run.mock.calls.filter((c) => String(c[0]).includes("membershipVia")).length;

/** Index off: the cache being tested is the Apple Events one. */
const client = (env: NodeJS.ProcessEnv, clock: () => Date, osascript: OsascriptRunner) =>
  new AppleRemindersClient({
    config: loadConfig({ APPLE_REMINDERS_INDEX_MODE: "off", ...env }),
    osascript,
    now: clock,
  });

/**
 * The cache is a TTL, not an invalidation scheme, and that is a measured
 * decision rather than laziness: asking Reminders "has anything changed" means
 * bulk-fetching ids and modification dates, which costs about what re-reading
 * everything costs. Notes measured the same trade at 128ms to check against
 * 97ms to rescan.
 */
describe("bulk cache", () => {
  it("reads once within the TTL", async () => {
    const r = runner();
    let t = 1_000_000;
    const c = client({ APPLE_REMINDERS_SEARCH_CACHE_TTL_MS: "30000" }, () => new Date(t), r);

    await c.listReminders({ limit: 10 });
    t += 10_000;
    await c.listReminders({ limit: 10 });

    expect(bulkCalls(r)).toBe(1);
  });

  it("reads again once the TTL expires", async () => {
    const r = runner();
    let t = 1_000_000;
    const c = client({ APPLE_REMINDERS_SEARCH_CACHE_TTL_MS: "30000" }, () => new Date(t), r);

    await c.listReminders({ limit: 10 });
    t += 30_001;
    await c.listReminders({ limit: 10 });

    expect(bulkCalls(r)).toBe(2);
  });

  it("never caches when the TTL is zero", async () => {
    const r = runner();
    const c = client({ APPLE_REMINDERS_SEARCH_CACHE_TTL_MS: "0" }, () => new Date(1), r);

    await c.listReminders({ limit: 10 });
    await c.listReminders({ limit: 10 });

    expect(bulkCalls(r)).toBe(2);
  });

  /** A write must be visible to the next read, whatever the TTL says. */
  it("drops the cache after a write", async () => {
    const r = runner();
    const c = client({ APPLE_REMINDERS_SEARCH_CACHE_TTL_MS: "3600000" }, () => new Date(1), r);

    await c.listReminders({ limit: 10 });
    c.invalidate();
    await c.listReminders({ limit: 10 });

    expect(bulkCalls(r)).toBe(2);
  });

  it("shares one read between list and search", async () => {
    const r = runner();
    const c = client({ APPLE_REMINDERS_SEARCH_CACHE_TTL_MS: "30000" }, () => new Date(1), r);

    await c.listReminders({ limit: 10 });
    await c.searchReminders("x", { limit: 10 });

    expect(bulkCalls(r)).toBe(1);
  });
});
