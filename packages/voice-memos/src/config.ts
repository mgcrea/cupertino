import { homedir } from "node:os";
import { join } from "node:path";

import {
  BaseConfigSchema,
  parseBool,
  parseConfig,
  parseIntOpt,
  trimmed,
} from "@mgcrea/mcp-apple-core";
import { z } from "zod";

/**
 * Configuration is environment-only: this server holds no secret. Its access is the macOS
 * permission the user granted.
 *
 * `allowWrites` gates one tool, `save_recording`, which copies a recording's audio into
 * `exportDir`. Nothing on this surface writes to Voice Memos' own store.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Explicit store path. Bypasses discovery: for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /** Where `save_recording` writes. `~/Downloads` by default, one of Cadence's import folders. */
  exportDir: z.string().min(1).default(join(homedir(), "Downloads")),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_VOICE_MEMOS_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_VOICE_MEMOS_EXPOSE_PROMPTS),
    lazyTools: parseBool(env.APPLE_VOICE_MEMOS_LAZY_TOOLS),
    storePath: trimmed(env.APPLE_VOICE_MEMOS_STORE),
    indexMode: trimmed(env.APPLE_VOICE_MEMOS_INDEX_MODE),
    exportDir: trimmed(env.APPLE_VOICE_MEMOS_EXPORT_DIR),
    osascriptPath: trimmed(env.APPLE_VOICE_MEMOS_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_VOICE_MEMOS_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_VOICE_MEMOS_MAX_RESULTS),
  });
