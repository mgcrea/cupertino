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
 * Configuration is environment-only — this server holds no secret at all. Its
 * access is the macOS permission the user granted, which is the whole point.
 *
 * `allowWrites` is inherited from `BaseConfigSchema` and, since the navigation
 * lane landed, actually gates something: `open_url` and
 * `add_reading_list_item`. It was ignored for v1 on the grounds that "opening a
 * URL or adding to the Reading List is an Apple Event that navigates a real,
 * visible browser" — true of the first and false of the second, which is what
 * made the Reading List the right verb to build first.
 *
 * `liveTabs` outranks it. That flag promises a server that sends no Apple Event
 * at all, and a write would break the promise on the one machine whose owner
 * asked for it, so the writes refuse when it is off — see
 * `AppleSafariClient.openUrl`.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /** Explicit history path. Bypasses discovery — for tests and forensic copies. */
  storePath: z.string().optional(),
  /**
   * Explicit `Bookmarks.plist` path.
   *
   * Separate from `storePath` because the two files fail independently, and a
   * test that points history at a fixture should not silently disable the
   * Reading List by implication.
   */
  bookmarksPath: z.string().optional(),
  /**
   * Explicit path to the Safari extension's capture store.
   *
   * Discovery resolves the extension's sandbox container, which is keyed by its
   * bundle identifier — and that identifier differs between a Debug and a
   * Release app. Overriding it is how a test points at a fixture, and how
   * someone running a locally built app reaches the right container.
   */
  pagesPath: z.string().optional(),
  /**
   * Explicit directory for the record of tabs `open_url` opened, which is what
   * `close_tabs` may close. Shared by every server by default, so a tab one
   * session opened can be closed from another; see `client/opened.ts`.
   */
  openedTabsPath: z.string().optional(),
  /**
   * How long to wait before re-reading `Bookmarks.plist` to confirm a Reading
   * List add, and how long to wait again before giving up.
   *
   * MEASURED: Safari committed an add to the file after **2 s** on macOS 26.6.
   * The first version of this checked immediately, which is a walk of an 880 KB
   * plist that could not yet contain the answer — it would have reported
   * `verified: null` on essentially every successful add, at full cost. Two
   * attempts a beat apart straddle the measured lag without turning a 148 ms
   * write into a long one.
   *
   * Zero disables the wait, which is how the tests avoid sleeping.
   */
  readingListConfirmMs: z.number().int().min(0).max(10_000).default(1_500),
  /**
   * How long an action tool waits for a page to answer.
   *
   * Generous on purpose, and the number comes from the other side: the content
   * script polls every second while its tab is visible and every ten while it
   * is hidden, so anything under ten seconds would report a background tab as
   * unreachable when it was merely asleep.
   */
  actionTimeoutMs: z.number().int().min(500).max(60_000).default(12_000),
  /**
   * How long `read_page` waits for the open tab to answer a LIVE read before
   * falling back to the stored capture.
   *
   * Short where `actionTimeoutMs` is long, because a miss here costs nothing
   * but freshness: the capture is still there to return. A visible tab polls
   * every second, so this covers it with room to spare; a hidden one polls
   * every ten and deliberately falls through to the capture rather than making
   * every read of a background tab take ten seconds.
   *
   * Zero disables the live read, which is how the capture-store tests avoid
   * waiting on a page that will never answer.
   */
  liveReadTimeoutMs: z.number().int().min(0).max(15_000).default(2_500),
  indexMode: z.enum(["auto", "ro", "immutable", "off"]).default("auto"),
  /**
   * Read live tabs through Apple Events.
   *
   * On by default, and this is the only surface where the Apple Events lane is
   * a READ rather than a write path. Turning it off leaves a working
   * history-and-bookmarks server that never sends an Apple Event and so never
   * triggers the Automation prompt — which is the right shape for a machine
   * where that prompt is unwelcome, and for any headless use.
   */
  liveTabs: z.boolean().default(true),
  /**
   * Return a one-time code that a page is showing.
   *
   * Deliberately NOT folded into `allowWrites`. That flag means "may change
   * something", and reaching a read through it would mean granting the right
   * to click a button in order to see a number.
   *
   * What it governs is narrower than the name suggests, and the boundary is
   * worth stating because it is not the obvious one. `page_elements` redacts a
   * CREDENTIAL field — a password, a card number — whatever this flag says, and
   * no setting turns that back on, because no tool here has a use for one. This
   * flag governs the other class: a one-time-code field, withheld by default and
   * returned when it is on. It also registers `apple_safari_find_codes` for the
   * code a page renders as TEXT, which no element enumeration can see.
   *
   * And it is WEAKER than the Messages gate of the same name, which should not
   * be papered over. There, off means the tool does not exist and the
   * alternative is sifting whole threads. Here `read_page` stays ungated, so off
   * removes the targeted field read and the live DOM scan — not every byte of a
   * page. A caller who wants the bytes can still have them.
   */
  allowCodes: z.boolean().default(false),
  /** Window for a range query that names neither edge. */
  defaultRangeDays: z.number().int().min(1).max(3_660).default(30),
  /**
   * Hard ceiling on a single range.
   *
   * Ten years rather than Calendar's one: a calendar query past its horizon is
   * usually a mistake, whereas "when did I first read about this" is a
   * legitimate question about a decade of history, and the file lane answers it
   * in milliseconds — 11 ms for a URL `LIKE` across 7,797 items, 2 ms on title.
   */
  maxRangeDays: z.number().int().min(1).max(36_600).default(3_660),
  /**
   * Whether the network-capture tools exist at all.
   *
   * Off by default, and off means NOT REGISTERED rather than refused: a page's
   * request and response bodies carry whatever the site's session carries, so
   * the opt-in is the user's, made once in Settings, and never something a
   * caller can talk its way into. Headers are redacted on top of that, but
   * redaction is a second line, not the first.
   */
  allowNetwork: z.boolean().default(false),
  /**
   * Whether `apple_safari_cookies` exists at all.
   *
   * Its own gate, for the reason `allowNetwork` is: it is a read, so it is not
   * `allowWrites`, and what it reads is a signed-in session rather than one
   * short-lived string, so it is not `allowCodes` either. A login cookie is the
   * session itself — whoever holds it is signed in — which is why it is also
   * the one gate here that is not enough on its own; see `cookieHosts`.
   *
   * Off means NOT REGISTERED, like the other read gates. The values never come
   * back inline even when it is on: `saveAs` writes them to a file, and that
   * additionally needs `allowWrites`.
   */
  allowCookies: z.boolean().default(false),
  /**
   * The sites whose cookies `apple_safari_cookies` may read, as registrable
   * domains ("yahoo.com"), matched on a label boundary so the entry covers the
   * domain and its subdomains and never `notyahoo.com`.
   *
   * The second gate, and the one that does the work. `allowCookies` alone
   * would let any agent take any session in the browser — the bank's as
   * readily as the one the user meant — so the flag registers the tool and
   * this list decides which pages it may read. Empty, which is the default,
   * means none. Entries are kept as given; `cookieHostRules` normalises them
   * and sets aside one with no dot, since "com" would open a whole TLD.
   */
  cookieHosts: z.array(z.string()).default([]),
  /**
   * Where `saveAs` may write. Only ever reached through core's
   * `writeConfinedFile`, which keeps a name to its basename, resolves symlinks
   * and refuses to overwrite; this setting is the root of that confinement.
   * Defaults to ~/Downloads because that is where a person looks for a file
   * they asked for.
   */
  downloadDir: z.string().default(join(homedir(), "Downloads")),
  /**
   * Characters of a body the server asks the page for per command.
   *
   * THE DEFAULT IS MEASURED TO WORK; THE CEILING IS NOT. A command's answer
   * travels through Safari's native-message channel, which has a size limit.
   * On Safari 26 a 1.3 MB emoji-heavy body came back byte-identical in five
   * chunks of this size, about 1.1 s each. How far above it the channel goes
   * is unmeasured: the server the extension talks to is the one the app
   * spawns, whose environment a shell cannot change, and a shell-launched
   * server cannot reach the extension's container (EPERM). So the default
   * stays. Too large and a chunk is dropped silently, too small and a big PDF
   * costs a hundred round trips at a poll interval each. See docs/safari.md,
   * "Measurements".
   */
  networkChunkChars: z.number().int().min(16_384).max(8_388_608).default(262_144),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  parseConfig(ConfigSchema, {
    allowWrites: parseBool(env.APPLE_SAFARI_ALLOW_WRITES),
    allowCodes: parseBool(env.APPLE_SAFARI_ALLOW_CODES),
    allowNetwork: parseBool(env.APPLE_SAFARI_ALLOW_NETWORK),
    allowCookies: parseBool(env.APPLE_SAFARI_ALLOW_COOKIES),
    cookieHosts: env.APPLE_SAFARI_COOKIE_HOSTS?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    downloadDir: trimmed(env.APPLE_SAFARI_DOWNLOAD_DIR),
    networkChunkChars: parseIntOpt(env.APPLE_SAFARI_NETWORK_CHUNK_CHARS),
    exposePrompts: parseBool(env.APPLE_SAFARI_EXPOSE_PROMPTS),
    lazyTools: parseBool(env.APPLE_SAFARI_LAZY_TOOLS),
    storePath: trimmed(env.APPLE_SAFARI_STORE),
    bookmarksPath: trimmed(env.APPLE_SAFARI_BOOKMARKS),
    pagesPath: trimmed(env.APPLE_SAFARI_PAGES),
    openedTabsPath: trimmed(env.APPLE_SAFARI_OPENED_TABS),
    readingListConfirmMs: parseIntOpt(env.APPLE_SAFARI_READING_LIST_CONFIRM_MS),
    actionTimeoutMs: parseIntOpt(env.APPLE_SAFARI_ACTION_TIMEOUT_MS),
    liveReadTimeoutMs: parseIntOpt(env.APPLE_SAFARI_LIVE_READ_TIMEOUT_MS),
    indexMode: trimmed(env.APPLE_SAFARI_INDEX_MODE),
    liveTabs: parseBool(env.APPLE_SAFARI_LIVE_TABS),
    defaultRangeDays: parseIntOpt(env.APPLE_SAFARI_DEFAULT_RANGE_DAYS),
    maxRangeDays: parseIntOpt(env.APPLE_SAFARI_MAX_RANGE_DAYS),
    osascriptPath: trimmed(env.APPLE_SAFARI_OSASCRIPT_PATH),
    osascriptTimeoutMs: parseIntOpt(env.APPLE_SAFARI_OSASCRIPT_TIMEOUT_MS),
    maxResults: parseIntOpt(env.APPLE_SAFARI_MAX_RESULTS),
  });
