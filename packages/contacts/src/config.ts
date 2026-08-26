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
 * Note what is ABSENT, and why:
 *
 * - **No `allowWrites` behaviour.** It is inherited from `BaseConfigSchema` and
 *   deliberately ignored: this surface registers no mutating tool, so there is
 *   nothing for the flag to gate. Editing someone's address book from a tool
 *   call was never part of what Contacts was probed for.
 * - **No `osascript` settings in use.** Also inherited, also unused — there is
 *   no Apple Events lane here at all, which is what lets this server run without
 *   an Automation grant.
 * - **No account allowlist.** Contacts are unioned across accounts precisely so
 *   that a handle resolves wherever its owner lives; scoping that by account
 *   would reintroduce the bug this surface exists to avoid.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /**
   * Explicit store path. Bypasses discovery — for tests and forensic copies.
   *
   * Naming one file also DISABLES the union, which is the point of having it:
   * a test needs a single known database, not whatever the machine happens to
   * hold.
   */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /**
   * Trailing digits that make a phone key.
   *
   * Exposed because the right value is a fact about the user's country, and nine
   * was measured on one machine with mostly French and E.164 numbers. Lower is
   * more forgiving and collides more; the ambiguity count in `diagnostics` is
   * how to tell whether a change helped.
   */
  phoneSuffixDigits: z.number().int().min(6).max(15).default(9),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_CONTACTS_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_CONTACTS_EXPOSE_PROMPTS),
    debug: parseBool(env.APPLE_CONTACTS_DEBUG),
    storePath: trimmed(env.APPLE_CONTACTS_STORE),
    indexMode: trimmed(env.APPLE_CONTACTS_INDEX_MODE),
    phoneSuffixDigits: parseIntOpt(env.APPLE_CONTACTS_PHONE_SUFFIX_DIGITS),
    osascriptPath: trimmed(env.APPLE_CONTACTS_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_CONTACTS_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_CONTACTS_MAX_RESULTS),
  });
