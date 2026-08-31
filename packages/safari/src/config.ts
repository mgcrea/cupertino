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
 * `allowWrites` is inherited from `BaseConfigSchema` and, since the navigation
 * lane landed, actually gates something: `open_url` and
 * `add_reading_list_item`. It was ignored for v1 on the grounds that "opening a
 * URL or adding to the Reading List is an Apple Event that navigates a real,
 * visible browser" — true of the first and false of the second, which is what
 * made the Reading List the right verb to build first.
 *
 * `liveTabs` outranks it. That flag promises a server that sends no Apple Event
 * at all, and a write would break the promise on the one machine whose owner
 * asked for it, so the writes refuse when it is off — see
 * `AppleSafariClient.openUrl`.
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
  /**
   * Explicit path to the Safari extension's capture store.
   *
   * Discovery resolves the extension's sandbox container, which is keyed by its
   * bundle identifier — and that identifier differs between a Debug and a
   * Release app. Overriding it is how a test points at a fixture, and how
   * someone running a locally built app reaches the right container.
   */
  pagesPath: z.string().optional(),
  /**
   * How long to wait before re-reading `Bookmarks.plist` to confirm a Reading
   * List add, and how long to wait again before giving up.
   *
   * MEASURED: Safari committed an add to the file after **2 s** on macOS 26.6.
   * The first version of this checked immediately, which is a walk of an 880 KB
   * plist that could not yet contain the answer — it would have reported
   * `verified: null` on essentially every successful add, at full cost. Two
   * attempts a beat apart straddle the measured lag without turning a 148 ms
   * write into a long one.
   *
   * Zero disables the wait, which is how the tests avoid sleeping.
   */
  readingListConfirmMs: z.number().int().min(0).max(10_000).default(1_500),
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
    pagesPath: trimmed(env.APPLE_SAFARI_PAGES),
    readingListConfirmMs: parseIntOpt(env.APPLE_SAFARI_READING_LIST_CONFIRM_MS),
    indexMode: trimmed(env.APPLE_SAFARI_INDEX_MODE),
    liveTabs: parseBool(env.APPLE_SAFARI_LIVE_TABS),
    defaultRangeDays: parseIntOpt(env.APPLE_SAFARI_DEFAULT_RANGE_DAYS),
    maxRangeDays: parseIntOpt(env.APPLE_SAFARI_MAX_RANGE_DAYS),
    osascriptPath: trimmed(env.APPLE_SAFARI_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_SAFARI_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_SAFARI_MAX_RESULTS),
  });
