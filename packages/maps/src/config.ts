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
 * `allowWrites` gates two mutating tools, and gates them harder than elsewhere.
 * Maps has no scripting dictionary and no registered App Intents, so a write is
 * SQL straight into a Core Data store that `NSPersistentCloudKitContainer`
 * mirrors — which means it reaches every device on the account, not just this
 * Mac. That was measured, along with the rule that keeps it safe: never
 * fabricate a place record, only ever copy one Maps wrote itself. See
 * `docs/maps.md` and `client/write.ts`.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Explicit store path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /**
   * How long `add_favorite` waits for Maps to resolve a place it does not know.
   * Tens of seconds is normal — Maps goes to the network — and a slow link
   * needs more; this is the one timeout in the bundle that was not a setting.
   */
  seedTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_MAPS_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_MAPS_EXPOSE_PROMPTS),
    lazyTools: parseBool(env.APPLE_MAPS_LAZY_TOOLS),
    storePath: trimmed(env.APPLE_MAPS_STORE),
    indexMode: trimmed(env.APPLE_MAPS_INDEX_MODE),
    osascriptPath: trimmed(env.APPLE_MAPS_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_MAPS_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_MAPS_MAX_RESULTS),
    seedTimeoutMs: parseIntOpt(env.APPLE_MAPS_SEED_TIMEOUT_MS),
  });
