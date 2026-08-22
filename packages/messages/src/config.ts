import {
  BaseConfigSchema,
  parseBool,
  parseConfig,
  parseIntOpt,
  trimmed,
} from "@mgcrea/mcp-apple-core";
import { z } from "zod";

/**
 * Configuration is environment-only — this server holds no secret at all, its
 * access is the macOS permission the user granted.
 *
 * What is deliberately ABSENT: anything gating writes. `allowWrites` is
 * inherited from `BaseConfigSchema` and ignored, because v1 registers no
 * mutating tool. `docs/messages.md` records why sending was not even probed —
 * "probing it would mean sending a real message to a real person" — and the id
 * bridge finding compounds it: Apple Events returns no chat identifier at all,
 * so a send could never be reconciled against a read.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Explicit store path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /**
   * Look names up in Contacts.
   *
   * On by default: without it this server answers "+15551234567 said …", which
   * is why `packages/contacts` was built. Off is for a machine where the
   * Contacts permission has not been granted and the prompt is unwelcome — the
   * resolver degrades to raw handles either way, so this only decides whether it
   * is attempted.
   */
  resolveContacts: z.boolean().default(true),
  /** Window for a range query that names only a start. */
  defaultRangeDays: z.number().int().min(1).max(3_660).default(30),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_MESSAGES_ALLOW_WRITES),
    debug: parseBool(env.APPLE_MESSAGES_DEBUG),
    storePath: trimmed(env.APPLE_MESSAGES_STORE),
    indexMode: trimmed(env.APPLE_MESSAGES_INDEX_MODE),
    resolveContacts: parseBool(env.APPLE_MESSAGES_RESOLVE_CONTACTS),
    defaultRangeDays: parseIntOpt(env.APPLE_MESSAGES_DEFAULT_RANGE_DAYS),
    osascriptPath: trimmed(env.APPLE_MESSAGES_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_MESSAGES_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_MESSAGES_MAX_RESULTS),
  });
