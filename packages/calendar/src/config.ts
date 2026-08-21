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
 *
 * Note what is deliberately ABSENT relative to `packages/reminders`: there is no
 * `searchCacheTtlMs` and no degraded-listing cap, because both exist there to
 * manage an Apple Events READ lane. Calendar has none by design
 * (`docs/distribution.md`), and config for a lane that does not exist would
 * advertise a fallback this server cannot provide.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Account allowlist (names or ids). Empty means every account. */
  accounts: z.array(z.string().min(1)).default([]),
  /**
   * Calendar allowlist (names or uids). Empty means every calendar.
   *
   * The important one for this surface: a work calendar and a personal one
   * routinely live in the same account, so the account is the wrong unit to
   * scope by whenever scoping is the point.
   */
  calendars: z.array(z.string().min(1)).default([]),
  /** Explicit store path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /** Calendar a new event goes to when the caller names none. Empty = Calendar's default. */
  defaultCalendar: z.string().optional(),
  /**
   * Window for a range query that names only a start.
   *
   * A calendar has no natural "everything" answer the way a note list does, and
   * an unbounded default would scan a decade to report next Tuesday.
   */
  defaultRangeDays: z.number().int().min(1).max(366).default(7),
  /** Hard clamp, so one query cannot ask for a decade. */
  maxRangeDays: z.number().int().min(1).max(3_660).default(366),
  /** Length of a created event when the caller gives neither an end nor a duration. */
  defaultEventDurationMinutes: z.number().int().min(1).max(1_440).default(60),
  /** Whether events the user declined are included when the caller does not say. */
  includeDeclined: z.boolean().default(false),
  /** Whether events an organiser cancelled are included when the caller does not say. */
  includeCancelled: z.boolean().default(false),
  /**
   * Render override for timed events. Empty means the system zone.
   *
   * Validated as a real IANA name here rather than at render time: a bad zone
   * should fail at startup with the variable named, not once per event.
   */
  timeZone: z
    .string()
    .refine(
      (v) => {
        try {
          Intl.DateTimeFormat("en-US", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'not an IANA time zone name, e.g. "Europe/Paris"' },
    )
    .optional(),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * `env` is a parameter with a default so tests are hermetic — they pass their
 * own object rather than mutating (and having to restore) process.env.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_CALENDAR_ALLOW_WRITES),
    debug: parseBool(env.APPLE_CALENDAR_DEBUG),
    accounts: parseList(env.APPLE_CALENDAR_ACCOUNTS),
    calendars: parseList(env.APPLE_CALENDAR_CALENDARS),
    storePath: trimmed(env.APPLE_CALENDAR_STORE),
    indexMode: trimmed(env.APPLE_CALENDAR_INDEX_MODE),
    defaultCalendar: trimmed(env.APPLE_CALENDAR_DEFAULT_CALENDAR),
    defaultRangeDays: parseIntOpt(env.APPLE_CALENDAR_DEFAULT_RANGE_DAYS),
    maxRangeDays: parseIntOpt(env.APPLE_CALENDAR_MAX_RANGE_DAYS),
    defaultEventDurationMinutes: parseIntOpt(env.APPLE_CALENDAR_DEFAULT_EVENT_DURATION_MINUTES),
    includeDeclined: parseBool(env.APPLE_CALENDAR_INCLUDE_DECLINED),
    includeCancelled: parseBool(env.APPLE_CALENDAR_INCLUDE_CANCELLED),
    osascriptPath: trimmed(env.APPLE_CALENDAR_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_CALENDAR_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_CALENDAR_MAX_RESULTS),
    timeZone: trimmed(env.APPLE_CALENDAR_TIMEZONE),
  });
