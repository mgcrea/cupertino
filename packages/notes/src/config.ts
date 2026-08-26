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
  /**
   * Account allowlist (names or ids). Empty means every account.
   *
   * `allowWrites` gates mutation, but the larger blast radius is *reading* a
   * person's whole notebook, so this is the read-side control.
   */
  accounts: z.array(z.string().min(1)).default([]),
  /** Explicit NoteStore.sqlite path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /**
   * Cap for the Apple Events listing lane. Generous compared to Mail's because
   * a bulk property fetch here is one round trip at ~0.1ms per note, not 42ms.
   */
  degradedMaxNotes: z.number().int().min(1).max(1_000).default(200),
  bodyMaxBytes: z.number().int().min(1_024).max(10_000_000).default(262_144),
  /**
   * The confinement boundary for save_attachment, not merely its default: the
   * tool's `directory` argument may select a subdirectory of this, never escape
   * it. Enforced lexically with `resolve()` + `basename()`, not `realpath()` —
   * the destination may not exist yet.
   */
  attachmentDir: z.string().default(join(homedir(), "Downloads")),
  /**
   * How long the Apple Events plaintext cache stays warm.
   *
   * Measured: fetching ids + modification dates to check freshness costs *more*
   * (128ms) than simply re-scanning every body (97ms), so there is no cheap
   * invalidation to be had. A TTL with bounded staleness is the only sensible
   * trade when the index lane is unavailable.
   */
  searchCacheTtlMs: z.number().int().min(0).max(3_600_000).default(60_000),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * `env` is a parameter with a default so tests are hermetic — they pass their
 * own object rather than mutating (and having to restore) process.env.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_NOTES_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_NOTES_EXPOSE_PROMPTS),
    debug: parseBool(env.APPLE_NOTES_DEBUG),
    accounts: parseList(env.APPLE_NOTES_ACCOUNTS),
    storePath: trimmed(env.APPLE_NOTES_STORE),
    indexMode: trimmed(env.APPLE_NOTES_INDEX_MODE),
    osascriptPath: trimmed(env.APPLE_NOTES_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_NOTES_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_NOTES_MAX_RESULTS),
    degradedMaxNotes: parseIntOpt(env.APPLE_NOTES_DEGRADED_MAX_NOTES),
    bodyMaxBytes: parseIntOpt(env.APPLE_NOTES_BODY_MAX_BYTES),
    attachmentDir: trimmed(env.APPLE_NOTES_ATTACHMENT_DIR),
    searchCacheTtlMs: parseIntOpt(env.APPLE_NOTES_SEARCH_CACHE_TTL_MS),
  });
