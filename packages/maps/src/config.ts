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
 * mutating tool.
 *
 * That is not the usual "not probed yet". The store is mirrored to iCloud by
 * `NSPersistentCloudKitContainer`, so a write is not a write to a file — it is
 * an edit to one replica of a synchronising graph, underneath an app that is
 * also editing it, with `NSCK*` bookkeeping tables that a third-party writer
 * would not maintain. `docs/maps.md` records this as unmeasured and unsafe to
 * assume, and a write path needs its own probe before it needs a flag.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Explicit store path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_MAPS_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_MAPS_EXPOSE_PROMPTS),
    debug: parseBool(env.APPLE_MAPS_DEBUG),
    storePath: trimmed(env.APPLE_MAPS_STORE),
    indexMode: trimmed(env.APPLE_MAPS_INDEX_MODE),
    osascriptPath: trimmed(env.APPLE_MAPS_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_MAPS_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_MAPS_MAX_RESULTS),
  });
