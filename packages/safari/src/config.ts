import {
  BaseConfigSchema,
  parseBool,
  parseConfig,
  parseIntOpt,
  trimmed,
} from "@mgcrea/mcp-apple-core";
import { z } from "zod";

/**
 * Configuration is environment-only — this server holds no secret at all. Its
 * access is the macOS permission the user granted, which is the whole point.
 *
 * What is deliberately ABSENT: anything gating writes. `allowWrites` is
 * inherited from `BaseConfigSchema` and ignored, because v1 registers no
 * mutating tool. docs/safari.md records that no write was ever probed, and the
 * reason is worth restating: opening a URL or adding to the Reading List is an
 * Apple Event that navigates a real, visible browser. That is not a measurement
 * to take without asking, and not a capability to ship untested.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Explicit history path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  /**
   * Explicit `Bookmarks.plist` path.
   *
   * Separate from `storePath` because the two files fail independently, and a
   * test that points history at a fixture should not silently disable the
   * Reading List by implication.
   */
  bookmarksPath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /**
   * Read live tabs through Apple Events.
   *
   * On by default, and this is the only surface where the Apple Events lane is
   * a READ rather than a write path. Turning it off leaves a working
   * history-and-bookmarks server that never sends an Apple Event and so never
   * triggers the Automation prompt — which is the right shape for a machine
   * where that prompt is unwelcome, and for any headless use.
   */
  liveTabs: z.boolean().default(true),
  /** Window for a range query that names neither edge. */
  defaultRangeDays: z.number().int().min(1).max(3_660).default(30),
  /**
   * Hard ceiling on a single range.
   *
   * Ten years rather than Calendar's one: a calendar query past its horizon is
   * usually a mistake, whereas "when did I first read about this" is a
   * legitimate question about a decade of history, and the file lane answers it
   * in milliseconds — 11 ms for a URL `LIKE` across 7,797 items, 2 ms on title.
   */
  maxRangeDays: z.number().int().min(1).max(36_600).default(3_660),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_SAFARI_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_SAFARI_EXPOSE_PROMPTS),
    debug: parseBool(env.APPLE_SAFARI_DEBUG),
    storePath: trimmed(env.APPLE_SAFARI_STORE),
    bookmarksPath: trimmed(env.APPLE_SAFARI_BOOKMARKS),
    indexMode: trimmed(env.APPLE_SAFARI_INDEX_MODE),
    liveTabs: parseBool(env.APPLE_SAFARI_LIVE_TABS),
    defaultRangeDays: parseIntOpt(env.APPLE_SAFARI_DEFAULT_RANGE_DAYS),
    maxRangeDays: parseIntOpt(env.APPLE_SAFARI_MAX_RANGE_DAYS),
    osascriptPath: trimmed(env.APPLE_SAFARI_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_SAFARI_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_SAFARI_MAX_RESULTS),
  });
