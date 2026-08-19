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
 * Configuration is environment-only. The sibling servers that also read a
 * `~/.config/<service>/config.json` do so because they hold a private key or an
 * OAuth token; this server holds no secret at all — its access comes from macOS
 * permissions granted to the host process — so a second config source would be
 * machinery without a job.
 */
/**
 * `allowWrites`, `debug`, `osascriptPath`, `osascriptTimeoutMs` and `maxResults`
 * come from `BaseConfigSchema` — every Apple-app server has them, with the same
 * bounds and the same defaults.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /**
   * Account allowlist (names or UUIDs). Empty means every account.
   *
   * `allowWrites` gates mutation, but the larger blast radius here is *reading*
   * a person's entire mail archive. This is the read-side control, and it is
   * enforced in exactly one place (mailbox-map) so no query path can escape it.
   */
  accounts: z.array(z.string().min(1)).default([]),
  /** Override the Mail data root. Normally discovered from Mail itself. */
  mailRoot: z.string().optional(),
  /** Explicit Envelope Index path. Bypasses discovery — used by tests and forensic copies. */
  envelopeIndexPath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /** Cap for the AppleScript listing lane: ~130ms + 42ms per message per property. */
  degradedMaxMessages: z.number().int().min(1).max(200).default(50),
  bodyMaxBytes: z.number().int().min(1_024).max(10_000_000).default(262_144),
  /** The only directory save_attachment may write into, enforced after realpath. */
  attachmentDir: z.string().default(join(homedir(), "Downloads")),
  mailboxCacheTtlMs: z.number().int().min(0).max(3_600_000).default(60_000),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * `env` is a parameter with a default so tests are hermetic — they pass their
 * own object rather than mutating (and having to restore) process.env.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const raw = {
    allowWrites: parseBool(env.APPLE_MAIL_ALLOW_WRITES),
    debug: parseBool(env.APPLE_MAIL_DEBUG),
    accounts: parseList(env.APPLE_MAIL_ACCOUNTS),
    mailRoot: trimmed(env.APPLE_MAIL_ROOT),
    envelopeIndexPath: trimmed(env.APPLE_MAIL_ENVELOPE_INDEX),
    indexMode: trimmed(env.APPLE_MAIL_INDEX_MODE),
    osascriptPath: trimmed(env.APPLE_MAIL_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_MAIL_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_MAIL_MAX_RESULTS),
    degradedMaxMessages: parseIntOpt(env.APPLE_MAIL_DEGRADED_MAX_MESSAGES),
    bodyMaxBytes: parseIntOpt(env.APPLE_MAIL_BODY_MAX_BYTES),
    attachmentDir: trimmed(env.APPLE_MAIL_ATTACHMENT_DIR),
    mailboxCacheTtlMs: parseIntOpt(env.APPLE_MAIL_MAILBOX_CACHE_TTL_MS),
  };

  return parseConfig(ConfigSchema, raw);
};
