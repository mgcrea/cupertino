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
 * Configuration is environment-only — this server holds no secret at all, its
 * access is the macOS permission the user granted.
 *
 * `allowWrites` is inherited from `BaseConfigSchema` and, since 1.2.0, means
 * something here: it gates the one mutating tool, `send_message`. With it off
 * this server registers no write tool and therefore sends no Apple Event at all,
 * which is what keeps its "no Automation grant" claim true by default.
 *
 * `docs/messages.md` recorded why sending went unprobed for so long — "probing
 * it would mean sending a real message to a real person" — and left the id
 * bridge open, because Apple Events returns no chat identifier to reconcile
 * against. `sendReconcileMs` is that decision made: the file lane finds the row
 * instead.
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
  /**
   * The only directory `save_attachment` may write into.
   *
   * A boundary rather than a default: the tool's `directory` argument selects a
   * subdirectory of this and cannot escape it. Saving is write-gated for the
   * same reason it is in Mail and Notes — it puts a file on the user's disk,
   * even though it changes nothing in Messages.
   */
  attachmentDir: z.string().default(join(homedir(), "Downloads")),
  /** Window for a range query that names only a start. */
  defaultRangeDays: z.number().int().min(1).max(3_660).default(30),
  /**
   * How long to wait for a sent message to appear in the store.
   *
   * Messages writes the outgoing row asynchronously, so a send that returns
   * instantly has usually not been written yet. Five seconds is generous for a
   * local write and short enough that a tool call does not hang on a bad
   * network; a miss is reported as `pending`, never as a failure. Zero means one
   * immediate check and no polling, which is what the test suite uses.
   */
  sendReconcileMs: z.number().int().min(0).max(60_000).default(5_000),
  /**
   * Gates `find_codes`, and deliberately NOT folded into `allowWrites`.
   *
   * Two reasons, and the second is the real one. It is a read, so putting it
   * behind a write gate would mean granting the right to send a message in
   * order to get a read tool — the two are unrelated and bundling them makes
   * both switches mean less.
   *
   * And it is a read of a different tier. This server already holds the
   * conversation history; a sibling holds Mail. Between them that is the
   * password-RESET channel, and adding live authentication codes to the same
   * process completes an account-takeover primitive out of parts that were each
   * individually reasonable. That is a real change in what a leaked transcript
   * costs, so it gets a switch of its own and defaults off.
   */
  allowCodes: z.boolean().default(false),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_MESSAGES_ALLOW_WRITES),
    exposePrompts: parseBool(env.APPLE_MESSAGES_EXPOSE_PROMPTS),
    debug: parseBool(env.APPLE_MESSAGES_DEBUG),
    storePath: trimmed(env.APPLE_MESSAGES_STORE),
    indexMode: trimmed(env.APPLE_MESSAGES_INDEX_MODE),
    resolveContacts: parseBool(env.APPLE_MESSAGES_RESOLVE_CONTACTS),
    attachmentDir: trimmed(env.APPLE_MESSAGES_ATTACHMENT_DIR),
    defaultRangeDays: parseIntOpt(env.APPLE_MESSAGES_DEFAULT_RANGE_DAYS),
    sendReconcileMs: parseIntOpt(env.APPLE_MESSAGES_SEND_RECONCILE_MS),
    allowCodes: parseBool(env.APPLE_MESSAGES_ALLOW_CODES),
    osascriptPath: trimmed(env.APPLE_MESSAGES_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_MESSAGES_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_MESSAGES_MAX_RESULTS),
  });
