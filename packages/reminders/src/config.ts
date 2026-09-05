import { homedir } from "node:os";
import { join } from "node:path";

import {
  BaseConfigSchema,
  parseBool,
  parseConfig,
  parseIntOpt,
  parseList,
  trimmed,
} from "@mgcrea/mcp-apple-core";
import { z } from "zod";

/**
 * Configuration is environment-only — this server holds no secret at all, its
 * access is the macOS permission the user granted.
 *
 * `allowWrites`, `debug`, `osascriptPath`, `osascriptTimeoutMs` and `maxResults`
 * come from `BaseConfigSchema`.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Account allowlist (names or ids). Empty means every account. */
  accounts: z.array(z.string().min(1)).default([]),
  /**
   * List allowlist (names or ids). Empty means every list.
   *
   * Finer-grained than the account allowlist and worth having here in a way it
   * was not for Notes: a shared "Groceries" list and a private one live in the
   * same account, so the account is often the wrong unit to scope by.
   */
  lists: z.array(z.string().min(1)).default([]),
  /** Explicit store path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /** List a new reminder goes to when the caller names none. Empty = Reminders' default list. */
  defaultList: z.string().optional(),
  /**
   * Whether completed reminders are included when the caller does not say.
   *
   * Off, matching what Reminders itself shows. A long-lived account accumulates
   * years of completed items that would otherwise dominate every result.
   */
  includeCompleted: z.boolean().default(false),
  /** Cap for the Apple Events listing lane. */
  degradedMaxReminders: z.number().int().min(1).max(5_000).default(500),
  /** The only directory save_attachment may write into, enforced after realpath. */
  attachmentDir: z.string().default(join(homedir(), "Downloads")),
  /**
   * How long the Apple Events bulk-property cache stays warm.
   *
   * Same trade as Notes: a bulk fetch is one Apple Event per property whatever
   * the library size, so there is no cheap way to ask "has anything changed"
   * that costs less than simply asking again. A TTL with bounded staleness is
   * the honest option.
   */
  searchCacheTtlMs: z.number().int().min(0).max(3_600_000).default(30_000),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * `env` is a parameter with a default so tests are hermetic — they pass their
 * own object rather than mutating (and having to restore) process.env.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_REMINDERS_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_REMINDERS_EXPOSE_PROMPTS),
    lazyTools: parseBool(env.APPLE_REMINDERS_LAZY_TOOLS),
    debug: parseBool(env.APPLE_REMINDERS_DEBUG),
    accounts: parseList(env.APPLE_REMINDERS_ACCOUNTS),
    lists: parseList(env.APPLE_REMINDERS_LISTS),
    storePath: trimmed(env.APPLE_REMINDERS_STORE),
    indexMode: trimmed(env.APPLE_REMINDERS_INDEX_MODE),
    defaultList: trimmed(env.APPLE_REMINDERS_DEFAULT_LIST),
    includeCompleted: parseBool(env.APPLE_REMINDERS_INCLUDE_COMPLETED),
    osascriptPath: trimmed(env.APPLE_REMINDERS_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_REMINDERS_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_REMINDERS_MAX_RESULTS),
    degradedMaxReminders: parseIntOpt(env.APPLE_REMINDERS_DEGRADED_MAX_REMINDERS),
    attachmentDir: trimmed(env.APPLE_REMINDERS_ATTACHMENT_DIR),
    searchCacheTtlMs: parseIntOpt(env.APPLE_REMINDERS_SEARCH_CACHE_TTL_MS),
  });
