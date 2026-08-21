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
  /**
   * The declared bound on a body search, in candidate messages.
   *
   * Body search has no index behind it — the Spotlight volume index does not
   * reach `~/Library` at all, so there is nothing to query. What there is
   * instead is the Envelope Index narrowing a query to its survivors and the
   * scan reading only those. Cost is therefore linear in survivors, measured at
   * 0.48 ms per message warm: 100 candidates is 48 ms, 2,000 is under a second,
   * and the whole 182k store is 88 seconds — the Apple Events wall again.
   *
   * 2,000 is where an interactive answer stops being interactive. Over it the
   * search returns `degraded` naming the count and the bound rather than
   * scanning a truncated prefix, which is the failure this default exists to
   * avoid: a silent cap answers "not found" for older mail indistinguishably
   * from a real absence. See docs/mail-body.md.
   */
  bodyScanMax: z.number().int().min(1).max(50_000).default(2_000),
  /**
   * How much of each candidate file the scan reads. 79% of a mail store's bytes
   * are base64 that no text search matches, and MIME puts the text parts first.
   */
  bodyScanBytes: z.number().int().min(1_024).max(1_000_000).default(65_536),
  /**
   * The only directory save_attachment may write into. Enforced lexically with
   * `resolve()` + `basename()`, not `realpath()`: the destination may not exist
   * yet, and the filename — not the directory — is the attacker-controlled part.
   */
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
    bodyScanMax: parseIntOpt(env.APPLE_MAIL_BODY_SCAN_MAX),
    bodyScanBytes: parseIntOpt(env.APPLE_MAIL_BODY_SCAN_BYTES),
    attachmentDir: trimmed(env.APPLE_MAIL_ATTACHMENT_DIR),
    mailboxCacheTtlMs: parseIntOpt(env.APPLE_MAIL_MAILBOX_CACHE_TTL_MS),
  };

  return parseConfig(ConfigSchema, raw);
};
