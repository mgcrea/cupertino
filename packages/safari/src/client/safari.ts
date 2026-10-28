import {
  createOsascriptRunner,
  type Logger,
  type OsascriptRunner,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "../build-info.js";
import type { Config } from "../config.js";
import { pageOfElement, runCommand, type Command, type CommandResult } from "./actions.js";
import { renderInstant, type Epoch } from "./dates.js";
import {
  BookmarksUnavailableError,
  PageCommandTimeoutError,
  PreconditionError,
  SAFARI_SURFACE,
  SafariHistoryUnavailableError,
} from "./errors.js";
import { BOOKMARKS_WALK } from "./jxa/bookmarks.js";
import { LIVE_TABS } from "./jxa/tabs.js";
import { ADD_READING_LIST_ITEM, CLOSE_TABS, OPEN_URL } from "./jxa/writes.js";
import { locateStore, type LocateResult } from "./locate.js";
import { extensionRanges, urlVariants, type MatchKind } from "./match.js";
import {
  networkGet,
  networkList,
  networkRecord,
  type GetInput,
  type GetResult,
  type ListResult,
  type RecordInput,
  type RecordState,
} from "./network.js";
import {
  forgetOpenedTabs,
  locateOpenedTabs,
  openedTabsDirectory,
  readOpenedTabs,
  recordOpenedTab,
  type OpenedTab,
} from "./opened.js";
import {
  ageSeconds,
  answeringDiagnosis,
  defaultPagesDirectory,
  heartbeatStatus,
  isQuiet,
  pagesStatus,
  readPage,
  readPages,
  type CapturedPage,
  type HeartbeatStatus,
  type PagesStatus,
} from "./pages.js";
import {
  decodeOpenedTabRef,
  encodeBookmarkRef,
  encodeHistoryRef,
  encodeOpenedTabRef,
} from "./ref.js";
import { openStore, type HistoryRow, type RangeQuery, type SafariStore } from "./store.js";

/**
 * The lane orchestrator.
 *
 * ## The one thing this class exists to prevent
 *
 * Every other surface in this repo has two lanes that answer the same
 * questions, so an orchestrator's job is picking the faster one. Here the lanes
 * answer DIFFERENT questions, and the job is making sure neither is ever
 * presented as a substitute for the other.
 *
 * That failure would be quiet and severe. Without Full Disk Access this server
 * can still list live tabs perfectly, so it looks alive — and every history
 * query would come back empty, which reads exactly like a person who has not
 * browsed rather than a permission that was not granted. So a history call with
 * no store THROWS a named error; it never returns `[]`.
 */

export type RenderedPage = {
  ref: string;
  url: string;
  title: string | null;
  visitCount: number | null;
  lastVisited: string | null;
  firstVisited: string | null;
  loadSuccessful: boolean | null;
  viaRedirect: boolean | null;
};

export type RenderedTab = {
  url: string | null;
  title: string | null;
  /** Which window, 1-based, in the order `windows()` returned them. */
  window: number;
  /**
   * The tab's POSITION, not an identifier. It changes the moment a tab is
   * dragged, so it is useful for describing the current screen and useless for
   * addressing a tab later.
   */
  index: number | null;
  /**
   * Selected in ITS OWN window — so a person with three windows open has three
   * active tabs, and this alone cannot answer "the tab I am looking at".
   *
   * That question is `frontmost`, and the difference is not pedantic: a caller
   * that reads the first `active` tab as the current one describes a page in
   * some other window with complete confidence.
   */
  active: boolean;
  /**
   * Selected, in the front window, and therefore the ONE tab a person means by
   * "my current tab". At most one tab in a response carries it.
   *
   * False on every tab is a real state, not a bug: it means the front window's
   * position could not be read (`windowOrderUnknown`), or Safari has no windows
   * at all. Note it does not require Safari to be the frontmost APPLICATION —
   * `appFrontmost` on the result answers that separately, because "the front
   * tab of a background browser" is still a meaningful thing to ask for.
   */
  frontmost: boolean;
  /**
   * The matching history entry, when the URL resolves to one.
   *
   * MEASURED, macOS 26.6, 76 open tabs, BEFORE the variant ladder: 19 matched
   * exactly, 23 more only after the query string came off, and **34 did not
   * match at all**. A miss is NORMAL, not an error: session parameters and
   * pages never committed to history both produce a tab whose URL is simply not
   * there. Null means "not found", never "no history".
   *
   * `historyMatch` says which rung of the ladder answered, and a caller should
   * treat the rungs differently — see `MatchKind`.
   */
  history: RenderedPage | null;
  /** How faithfully `history` was matched. Null exactly when `history` is. */
  historyMatch: MatchKind | null;
};

export type RenderedBookmark = {
  ref: string;
  url: string;
  title: string | null;
  folder: string | null;
  readingList: boolean;
  dateAdded: string | null;
  /** Present means opened. Its ABSENCE is the entire unread flag. */
  dateLastViewed: string | null;
  unread: boolean | null;
  previewText: string | null;
};

type BookmarkEntry = {
  uuid: string | null;
  url: string | null;
  title: string | null;
  folder: string | null;
  readingList: boolean;
  dateAdded: string | null;
  dateLastViewed: string | null;
  previewText: string | null;
};

type TabsPayload = {
  /** False when Safari was quit and the script declined to launch it. */
  running?: boolean;
  windows: number;
  appFrontmost: boolean | null;
  windowOrderUnknown: boolean;
  /** Tabs the read could not see, per window; `tabs: null` when the whole list failed. */
  unreadable?: { windowId: number | null; tabs: number | null }[];
  tabs: {
    window: number;
    /** Safari's window id. Absent from a payload that predates it. */
    windowId?: number | null;
    windowIndex: number | null;
    index: number | null;
    url: string | null;
    title: string | null;
    active: boolean;
    frontmost: boolean;
  }[];
};

export type OpenUrlResult = {
  /**
   * Which idiom actually placed the page. `tab-push` and `current-tab` are the
   * precise routes; either `open-location` spelling means Safari chose where
   * the page went, so the tab reported below may not be where a caller expects.
   */
  route: "current-tab" | "tab-push" | "open-location" | "open-location-fallback" | null;
  /** Null when it could not be read — never guessed. */
  launchedSafari: boolean | null;
  windows: number | null;
  /** The window a `tab-push` went into; null on every other route. */
  windowId?: number | null;
  /** Read back immediately, so a still-loading page reports nulls. */
  tab: { url: string | null; title: string | null; index: number | null };
  /**
   * The `st1:` ref `close_tabs` takes, when the new tab was recorded. Null for
   * `current-tab`, which navigated a tab that was the user's, and when the
   * record could not be written — `refNote` then says why.
   */
  ref?: string | null;
  refNote?: string | null;
};

export type CloseTabsResult = {
  safariRunning: boolean;
  closed: { ref: string; url: string; windowClosed: boolean }[];
  notFound: { ref: string; url: string; openedAt: string }[];
  ambiguous: { ref: string; url: string; tabs: number }[];
  stale: { ref: string; url: string; reason: string | null }[];
  unknown: string[];
};

type ClosePayload = {
  running: boolean;
  results: {
    id: string;
    outcome: "closed" | "stale" | "failed";
    windowClosed?: boolean;
    message?: string;
  }[];
};

export type AddReadingListItemResult = {
  launchedSafari: boolean | null;
  /** `true` when re-read and found. Never `false` — see `addReadingListItem`. */
  verified: true | null;
  verifyNote: string | null;
};

/**
 * A pause, used only to straddle Safari's write lag. Named rather than inlined
 * so a zero — which the tests pass — reads as "do not wait" instead of as a
 * timer that fires immediately.
 */
/**
 * The pause between two `wait_for` checks. Half the page's own one-second
 * poll on a visible tab, so a check is usually waiting when the page asks.
 */
const WAIT_INTERVAL_MS = 500;

/** A tab whose content script predates the command it was sent. */
class UnknownActionError extends Error {}

/** The frontmost tab has no URL at this moment, as while it loads. */
class NoFrontPageError extends PreconditionError {}

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * The scheme gate, and the security boundary of this whole lane.
 *
 * `javascript:` navigates a tab into script execution, which is exactly the
 * capability `jxa/writes.ts` refuses to ship; `file:` turns a navigation verb
 * into a local-file reader. An allowlist rather than a blocklist, because the
 * set of schemes a browser will act on is open-ended and the set this surface
 * means is two.
 */
export const assertNavigableUrl = (url: string): void => {
  if (!/^https?:\/\//i.test(url)) {
    throw new PreconditionError(
      `Refusing to open "${url.slice(0, 80)}". Only http:// and https:// URLs are allowed. ` +
        `A javascript: URL would execute script in the page, which this server does not offer, ` +
        `and a file: URL would read local files through the browser.`,
    );
  }
};

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches real Safari. */
  osascript?: OsascriptRunner;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
};

export class AppleSafariClient {
  readonly #config: Config;
  readonly #logger: Logger | undefined;
  readonly #osascript: OsascriptRunner;
  readonly #home: string | undefined;

  #located: LocateResult | null = null;
  #store: SafariStore | null = null;
  #storeError: string | null = null;

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
    this.#osascript =
      opts.osascript ??
      createOsascriptRunner({
        surface: SAFARI_SURFACE,
        osascriptPath: this.#config.osascriptPath,
        timeoutMs: this.#config.osascriptTimeoutMs,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
  }

  get config(): Config {
    return this.#config;
  }

  located(): LocateResult {
    this.#located ??= locateStore({
      storePath: this.#config.storePath,
      bookmarksPath: this.#config.bookmarksPath,
      ...(this.#home ? { home: this.#home } : {}),
    });
    return this.#located;
  }

  /**
   * Open the history store, once, lazily.
   *
   * Lazily because this server is genuinely useful without it — live tabs need
   * no grant at all — so a missing store must not stop the process from
   * starting. Once because opening is the expensive part and the handle is
   * read-only.
   */
  store(): SafariStore {
    if (this.#store) return this.#store;
    if (this.#storeError !== null) throw new SafariHistoryUnavailableError(this.#storeError);

    const located = this.located();
    if (!located.readable || !located.historyPath) {
      this.#storeError = located.reason ?? "Safari's history database could not be opened.";
      throw new SafariHistoryUnavailableError(this.#storeError);
    }
    try {
      this.#store = openStore({
        path: located.historyPath,
        mode: this.#config.indexMode as ReadOnlyMode,
        ...(this.#logger ? { logger: this.#logger } : {}),
      });
      return this.#store;
    } catch (err) {
      this.#storeError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  get epoch(): Epoch {
    return this.store().caps.epoch;
  }

  #render(row: HistoryRow, epoch: Epoch): RenderedPage {
    return {
      ref: encodeHistoryRef(row.url),
      url: row.url,
      title: row.title,
      visitCount: row.visitCount,
      lastVisited: renderInstant(row.lastVisitedRaw, epoch),
      firstVisited: renderInstant(row.firstVisitedRaw, epoch),
      loadSuccessful: row.loadSuccessful,
      viaRedirect: row.viaRedirect,
    };
  }

  search(q: RangeQuery): {
    pages: RenderedPage[];
    rangeApplied: boolean;
    truncated: boolean;
    datesAvailable: boolean;
  } {
    const store = this.store();
    const { rows, rangeApplied, truncated } = store.search(q);
    return {
      pages: rows.map((r) => this.#render(r, store.caps.epoch)),
      rangeApplied,
      truncated,
      datesAvailable: store.caps.epoch.confident,
    };
  }

  get(url: string): RenderedPage | null {
    const store = this.store();
    const row = store.get(url);
    return row ? this.#render(row, store.caps.epoch) : null;
  }

  /**
   * Live tabs, optionally enriched from history.
   *
   * The enrichment is best-effort in both directions: a tab whose URL is not in
   * history gets `history: null`, and a machine with no Full Disk Access gets
   * `history: null` on every tab rather than an error. Losing the store must
   * not take the lane that does not depend on it.
   *
   * The join is ONE query for the whole tab set. Every tab expands into its
   * variant ladder (see `match.ts`), every candidate goes into a single `IN`,
   * and each tab then walks its own ladder against that result to find the most
   * faithful rung that answered. The alternative — a lookup per tab per rung —
   * is a few hundred prepared statements to answer a question SQLite can answer
   * once.
   */
  async tabs(opts: { enrich: boolean }): Promise<{
    running: boolean;
    windows: number;
    appFrontmost: boolean | null;
    windowOrderUnknown: boolean;
    tabs: RenderedTab[];
    enriched: boolean;
  }> {
    const payload = await this.#osascript.run<TabsPayload>(LIVE_TABS, {});

    // Built once for the whole set, so a tab's ladder is walked twice — once to
    // collect candidates, once to resolve — rather than hitting the store.
    const ladders = new Map<string, ReturnType<typeof urlVariants>>();
    for (const t of payload.tabs) {
      if (t.url && !ladders.has(t.url)) ladders.set(t.url, urlVariants(t.url));
    }

    let resolve: ((url: string) => { page: RenderedPage; kind: MatchKind } | null) | null = null;
    if (opts.enrich && ladders.size > 0) {
      try {
        const store = this.store();
        const candidates = [...ladders.values()].flatMap((ladder) => ladder.map((v) => v.url));
        const rows = store.getMany(candidates);
        const render = (row: HistoryRow, kind: MatchKind) => ({
          page: this.#render(row, store.caps.epoch),
          kind,
        });
        resolve = (url) => {
          const ladder = ladders.get(url) ?? [];
          for (const variant of ladder) {
            if (variant.kind === "query-stripped") break;
            const hit = rows.get(variant.url);
            // First hit wins, and the ladder is ordered most-faithful-first, so
            // an exact match is never lost to a looser one that also resolved.
            if (hit) return render(hit, variant.kind);
          }
          // Below every rung that keeps the tab's query, above the one that
          // throws it away: `/search?q=w&utm_source=x` is closer to a tab on
          // `/search?q=w` than the bare `/search` is. Asked only for a tab the
          // faithful rungs missed, one indexed query each.
          // Guarded, because this query runs per tab outside the try above, and
          // a busy store must leave a tab unenriched rather than fail the list.
          let extended: HistoryRow | null = null;
          try {
            extended = store.extending(extensionRanges(url));
          } catch {
            extended = null;
          }
          if (extended) return render(extended, "query-added");
          for (const variant of ladder) {
            if (variant.kind !== "query-stripped") continue;
            const hit = rows.get(variant.url);
            if (hit) return render(hit, variant.kind);
          }
          return null;
        };
      } catch {
        // No store. Tabs still work; they simply arrive unenriched.
        resolve = null;
      }
    }

    return {
      // Absent from a payload that predates the check, which only ever came
      // back from a Safari that was running.
      running: payload.running !== false,
      windows: payload.windows,
      appFrontmost: payload.appFrontmost,
      windowOrderUnknown: payload.windowOrderUnknown,
      // An empty Safari has no tabs to enrich, and calling that "unenriched"
      // would report a permission problem that does not exist.
      enriched: opts.enrich && (resolve !== null || ladders.size === 0),
      tabs: payload.tabs.map((t) => {
        const match = resolve && t.url ? resolve(t.url) : null;
        return {
          url: t.url,
          title: t.title,
          window: t.window,
          index: t.index,
          active: t.active,
          frontmost: t.frontmost,
          history: match?.page ?? null,
          historyMatch: match?.kind ?? null,
        };
      }),
    };
  }

  /**
   * Bookmarks and the Reading List.
   *
   * Reached through osascript but sending no Apple Event — see
   * `jxa/bookmarks.ts`. It needs Full Disk Access and works with Safari closed.
   */
  async bookmarks(opts: { readingListOnly: boolean }): Promise<{
    bookmarks: RenderedBookmark[];
    folders: number;
    depthTruncated: boolean;
  }> {
    const located = this.located();
    if (!located.bookmarks.readable) {
      throw new BookmarksUnavailableError(
        located.bookmarks.exists
          ? `${located.bookmarks.path} exists but cannot be read.`
          : `No bookmarks file at ${located.bookmarks.path}.`,
      );
    }

    const payload = await this.#osascript.run<{
      entries: BookmarkEntry[];
      folders: number;
      depthTruncated: boolean;
    }>(BOOKMARKS_WALK, { path: located.bookmarks.path });

    const entries = opts.readingListOnly
      ? payload.entries.filter((e) => e.readingList)
      : payload.entries;

    return {
      folders: payload.folders,
      depthTruncated: payload.depthTruncated,
      bookmarks: entries
        .filter((e): e is BookmarkEntry & { url: string } => typeof e.url === "string")
        .map((e) => ({
          // A bookmark with no UUID falls back to its URL, so it still gets a
          // ref rather than being dropped from the list entirely.
          ref: encodeBookmarkRef(e.uuid ?? e.url),
          url: e.url,
          title: e.title,
          folder: e.folder,
          readingList: e.readingList,
          dateAdded: e.dateAdded,
          dateLastViewed: e.dateLastViewed,
          // Only meaningful for Reading List entries; a plain bookmark has no
          // read state at all, and reporting `false` would invent one.
          unread: e.readingList ? e.dateLastViewed === null : null,
          previewText: e.previewText,
        })),
    };
  }

  /**
   * Open a URL in Safari.
   *
   * ## Refused when the Apple Events lane is switched off
   *
   * `liveTabs: false` is documented as leaving a server that "never sends an
   * Apple Event and so never triggers the Automation prompt". A write that
   * ignored the flag would break that promise silently, on the one machine
   * whose owner asked for it — so it is refused instead. The flag is about the
   * lane, not about reads.
   */
  async openUrl(input: {
    url: string;
    target: "new-tab" | "current-tab";
    activate: boolean;
  }): Promise<OpenUrlResult> {
    this.#assertAppleEventsAllowed("Opening a URL");
    assertNavigableUrl(input.url);
    const result = await this.#osascript.run<OpenUrlResult>(OPEN_URL, {
      url: input.url,
      target: input.target,
      activate: input.activate,
    });
    if (input.target === "current-tab" || result.route === "current-tab") {
      return { ...result, ref: null, refNote: null };
    }
    // The page is open whatever happens here, so a record that cannot be
    // written costs the ref and nothing else.
    try {
      const entry = recordOpenedTab(this.openedTabsDirectory, {
        url: input.url,
        windowId: result.route === "tab-push" ? (result.windowId ?? null) : null,
      });
      return { ...result, ref: encodeOpenedTabRef(entry.id), refNote: null };
    } catch (cause) {
      return {
        ...result,
        ref: null,
        refNote:
          `The tab is open but could not be recorded, so apple_safari_close_tabs cannot close ` +
          `it. (${String(cause)})`,
      };
    }
  }

  /** Where the record of tabs `openUrl` opened lives; see `opened.ts`. */
  get openedTabsDirectory(): string {
    return this.#config.openedTabsPath ?? openedTabsDirectory(this.#home);
  }

  /**
   * Close tabs an agent opened: the ones named, or every one in the record.
   *
   * A tab is closed only when it still shows the URL it was opened on and no
   * other open tab could be it; `locateOpenedTabs` decides that, and the close
   * script checks it again right before closing. Everything else is reported
   * and left open. An entry is forgotten once its tab is closed or can no
   * longer be found, and kept when it was ambiguous or stale, since a later
   * call may yet close it.
   */
  async closeTabs(input: { refs: string[] } | { all: true }): Promise<CloseTabsResult> {
    this.#assertAppleEventsAllowed("Closing a tab");
    // Decoded before anything is read, so a malformed ref fails the call
    // without an Apple Event sent.
    // And deduplicated: one ref twice would send one position twice, and the
    // tab that slides into it after the first close would pass the second.
    const ids = "refs" in input ? [...new Set(input.refs.map((r) => decodeOpenedTabRef(r)))] : null;

    const dir = this.openedTabsDirectory;
    const all = readOpenedTabs(dir);
    const byId = new Map(all.map((e) => [e.id, e]));
    const asked: OpenedTab[] = ids ? ids.flatMap((id) => byId.get(id) ?? []) : all;
    const unknown = ids ? ids.filter((id) => !byId.has(id)).map(encodeOpenedTabRef) : [];

    const result: CloseTabsResult = {
      safariRunning: true,
      closed: [],
      notFound: [],
      ambiguous: [],
      stale: [],
      unknown,
    };
    if (asked.length === 0) return result;

    const payload = await this.#osascript.run<TabsPayload>(LIVE_TABS, {});
    if (payload.running === false) return { ...result, safariRunning: false };

    const live = [
      ...payload.tabs.map((t) => ({ windowId: t.windowId ?? null, index: t.index, url: t.url })),
      // A tab the read could not see stands in as one whose URL is unknown,
      // which is what keeps its window from being called unambiguous.
      ...(payload.unreadable ?? []).map((u) => ({ windowId: u.windowId, index: null, url: null })),
    ];
    const targets: { id: string; windowId: number; index: number; url: string }[] = [];
    const forget: string[] = [];
    for (const { entry, outcome } of locateOpenedTabs(asked, all, live)) {
      const ref = encodeOpenedTabRef(entry.id);
      if (outcome.kind === "notFound") {
        result.notFound.push({ ref, url: entry.url, openedAt: entry.openedAt });
        forget.push(entry.id);
      } else if (outcome.kind === "ambiguous") {
        result.ambiguous.push({ ref, url: entry.url, tabs: outcome.tabs });
      } else {
        const { windowId, index, url } = outcome.tab;
        if (windowId === null || index === null || url === null) {
          result.stale.push({ ref, url: entry.url, reason: "Safari did not report its window." });
        } else {
          targets.push({ id: entry.id, windowId, index, url });
        }
      }
    }

    // Before the close, which can time out: a notFound entry is let go either way.
    forgetOpenedTabs(dir, forget.splice(0));

    // One position, one target. Matching never assigns a tab twice, so this
    // is the backstop that keeps it impossible rather than merely untested.
    const seen = new Set<string>();
    const unique = targets.filter((t) => {
      const key = `${t.windowId}:${t.index}`;
      if (seen.has(key)) {
        result.ambiguous.push({ ref: encodeOpenedTabRef(t.id), url: t.url, tabs: 2 });
        return false;
      }
      seen.add(key);
      return true;
    });

    if (unique.length > 0) {
      // Rightmost first within a window, so one close never moves the next.
      unique.sort((a, b) => a.windowId - b.windowId || b.index - a.index);
      const closed = await this.#osascript.run<ClosePayload>(CLOSE_TABS, { targets: unique });
      const outcomes = new Map(closed.results.map((r) => [r.id, r]));
      for (const t of unique) {
        const ref = encodeOpenedTabRef(t.id);
        const url = byId.get(t.id)?.url ?? t.url;
        const r = outcomes.get(t.id);
        if (r?.outcome === "closed") {
          result.closed.push({ ref, url, windowClosed: r.windowClosed === true });
          forget.push(t.id);
        } else {
          result.stale.push({ ref, url, reason: r?.message ?? null });
        }
      }
    }

    forgetOpenedTabs(dir, forget);
    return result;
  }

  /**
   * Add an item to the Reading List.
   *
   * ## Verification is best-effort, and never turns a success into a failure
   *
   * Safari owns `Bookmarks.plist` and writes it on its own schedule, so an item
   * that was genuinely added can be absent from the file a moment later. The
   * walk is attempted when the file is readable, and its three outcomes are
   * kept distinct: `true` (found), `null` with a reason (not visible yet, or
   * not readable at all), and never `false`. Reporting an unconfirmed write as
   * a failed one would be the worse error — the caller would retry, and Safari
   * would end up with two entries.
   *
   * Safari's own `sync all plist to disk` verb looks like the fix for the lag.
   * It is hidden, undocumented and unmeasured, so it is not used here.
   */
  async addReadingListItem(input: {
    url: string;
    title?: string | undefined;
    previewText?: string | undefined;
  }): Promise<AddReadingListItemResult> {
    this.#assertAppleEventsAllowed("Adding to the Reading List");
    assertNavigableUrl(input.url);

    const payload = await this.#osascript.run<{ launchedSafari: boolean | null }>(
      ADD_READING_LIST_ITEM,
      { url: input.url, title: input.title, previewText: input.previewText },
    );

    let verified: true | null = null;
    let verifyNote: string | null =
      "Full Disk Access is missing, so the Reading List could not be re-read to confirm the add.";

    if (this.located().bookmarks.readable) {
      try {
        // TWO attempts, a beat apart, and the beat is the whole point. Safari
        // was measured committing an add to Bookmarks.plist after 2 s; a walk
        // taken immediately — which is what this did first — reads a file that
        // cannot yet contain the answer, so it paid for an 880 KB traversal to
        // report `null` on every successful add. The first attempt straddles
        // the measured lag and the second covers a slower one.
        let found = false;
        for (const attempt of [0, 1]) {
          await delay(this.#config.readingListConfirmMs);
          const { bookmarks } = await this.bookmarks({ readingListOnly: true });
          found = bookmarks.some((b) => b.url === input.url);
          if (found || attempt === 1) break;
        }
        verified = found ? true : null;
        verifyNote = found
          ? null
          : "The item is not in Bookmarks.plist yet. Safari writes that file on its own " +
            "schedule — measured at 2 s, and this waited longer than that — so a miss here is " +
            "unusual but still does not mean the add failed. Do not retry: that is how a " +
            "Reading List ends up with two of everything, and nothing here can remove one.";
      } catch {
        // The walk is a courtesy. Its failure says nothing about the write.
        verifyNote =
          "The Reading List could not be re-read to confirm the add. The add itself reported " +
          "success.";
      }
    }

    return { launchedSafari: payload.launchedSafari, verified, verifyNote };
  }

  /**
   * The guard both writes share.
   *
   * Throws rather than returning a flag: there is no partially-performed write
   * to describe, and a caller that ignored a boolean would report a page as
   * opened that never was.
   */
  /**
   * The URL of the tab the user is looking at, for a page tool called without
   * one.
   *
   * The live-tabs script again, unenriched: the frontmost tab needs the
   * window's front-to-back position as well as its selected tab, which that
   * script already reads, and a second script would be a second idea of
   * "frontmost". Each refusal names the url argument, because passing one is
   * always the way round it.
   */
  async frontmostTabUrl(): Promise<string> {
    this.#assertAppleEventsAllowed("No url was given, and finding the frontmost tab");
    const result = await this.tabs({ enrich: false });
    if (!result.running) {
      throw new PreconditionError(
        "No url was given, and Safari is not running, so no tab is in front. It was not " +
          "launched to check.",
      );
    }
    // Checked before `frontmost` is read, because the live-tabs script still
    // marks a tab frontmost when it could not read window order: it falls
    // back to list order, which is a guess, and a guess is not a page to act
    // on.
    if (result.windowOrderUnknown) {
      throw new PreconditionError(
        "No url was given, and Safari did not report its window order, so no tab can be " +
          "called frontmost. Pass the page's url; apple_safari_list_tabs lists them.",
      );
    }
    const front = result.tabs.find((t) => t.frontmost);
    if (!front?.url) {
      throw new NoFrontPageError(
        "No url was given, and the frontmost tab is showing no page right now (it may be " +
          "loading). Pass the page's url; apple_safari_list_tabs lists them.",
      );
    }
    return front.url;
  }

  #assertAppleEventsAllowed(what: string): void {
    if (!this.#config.liveTabs) {
      throw new PreconditionError(
        `${what} needs the Apple Events lane, which is disabled by configuration ` +
          `(APPLE_SAFARI_LIVE_TABS=false). This server is running history-only and sends no ` +
          `Apple Event.`,
      );
    }
  }

  /**
   * Ask a page to do something, through the extension.
   *
   * ## The one lane that needs no permission at all
   *
   * No Apple Event, so no Automation grant — and `liveTabs` deliberately does
   * NOT gate it, because that flag promises a server that sends no Apple Event
   * and this sends none. No Full Disk Access either: the appex container is
   * readable and writable by any same-user process. What it needs instead is
   * the user having allowed the extension on that specific website, which is a
   * consent Safari collects per site and they can revoke per site.
   *
   * That makes it the narrowest-consent capability in the bundle, and the one
   * that fails most legibly: with no grant nothing polls, and the caller gets a
   * timeout that says exactly which of the three conditions is missing.
   */
  async pageAction(
    input: {
      action: "elements" | "click" | "fill" | "scroll" | "submit" | "find" | "codes" | "read";
      url?: string | undefined;
      elementId?: string | undefined;
      text?: string | undefined;
      direction?: "up" | "down" | undefined;
      limit?: number | undefined;
      format?: "text" | "html" | undefined;
      maxChars?: number | undefined;
      maxValueChars?: number | undefined;
      query?: string | undefined;
      kind?: string | undefined;
      inViewOnly?: boolean | undefined;
    },
    // A caller with a fallback waits less than one without: `read_page` has
    // the capture to return, a click has nothing.
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    // An element id names the page load that handed it out, and the command
    // carries that token so only that load can claim it — see `pageOfElement`.
    // Derived HERE, from the id, rather than taken as a separate argument: a
    // caller cannot pair an id with the wrong page if it never says the page.
    // Checked before anything is written, outside the silence diagnosis below,
    // because a malformed id is the caller's mistake and no tab's.
    let page: string | undefined;
    if (input.elementId !== undefined) {
      page = pageOfElement(input.elementId) ?? undefined;
      if (!page) {
        throw new PreconditionError(
          `"${input.elementId}" is not an element id from apple_safari_page_elements. IDs look ` +
            `like "3f9a2c1d-e12" — the part before the dash names the page load that handed it ` +
            `out. Enumerate the page and pass an id exactly as given; never construct one.`,
        );
      }
    }
    const sentAt = Date.now();
    try {
      return await runCommand(
        {
          pagesDirectory: this.pagesDirectory,
          timeoutMs: opts.timeoutMs ?? this.#config.actionTimeoutMs,
        },
        // `includeCodes` is attached HERE rather than by the caller, so there is
        // one place the setting can enter the channel and no tool can pass it.
        { ...input, page, includeCodes: this.#config.allowCodes },
      );
    } catch (error) {
      throw this.#explainSilence(error, input.url, sentAt);
    }
  }

  /**
   * Check a page until some text appears on it (or, with `gone`, leaves it).
   *
   * The loop is HERE, not in the page. The page runs one command per poll and
   * synchronously, so a wait inside it would hold up every other command for
   * that tab; instead the page answers a cheap `find` (does the text occur,
   * and a short passage around it) and this asks again until the deadline.
   * Each check may wait out the whole remaining deadline for the page to pick
   * it up, so a background tab that polls every ten seconds still gets a turn.
   *
   * With no `url` the frontmost tab is looked up again for EVERY check, which
   * is what makes "click, then wait for the confirmation" work: the
   * confirmation is usually on the page the click navigated to, whose URL the
   * caller does not know yet.
   *
   * A tab whose content script predates `find` answers "Unknown action"; it is
   * then asked for a live `read` instead and searched here, which moves the
   * whole text per check but works on any build that can read live.
   *
   * Not meeting the condition is an answer, not an error: `met: false`.
   */
  async waitFor(input: {
    url?: string | undefined;
    text: string;
    gone: boolean;
    timeoutMs: number;
  }): Promise<{
    met: boolean;
    url: string | null;
    tab?: "frontmost";
    excerpt?: string;
    checks: number;
    waitedMs: number;
    lastMiss?: string;
  }> {
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;
    const tab = input.url === undefined ? { tab: "frontmost" as const } : {};
    let checks = 0;
    let url: string | null = null;
    let lastMiss: string | undefined;
    let viaRead = false;

    while (Date.now() < deadline) {
      let seen: { present: boolean; excerpt?: string | undefined };
      try {
        url = input.url ?? (await this.frontmostTabUrl());
        seen = viaRead
          ? await this.#findByRead(url, input.text, deadline)
          : await this.#find(url, input.text, deadline);
      } catch (error) {
        if (error instanceof UnknownActionError) {
          viaRead = true;
          continue;
        }
        if (error instanceof NoFrontPageError) {
          // The tab in front has no URL for a moment, as a tab does while it
          // loads the page a click sent it to: a miss, not the end.
          lastMiss = error.message;
          await delay(Math.min(WAIT_INTERVAL_MS, Math.max(0, deadline - Date.now())));
          continue;
        }
        if (!(error instanceof PageCommandTimeoutError)) throw error;
        // Nobody answered within what was left. Mid-navigation that is the
        // page being replaced, so it is noted and the deadline decides.
        lastMiss = error.message;
        continue;
      }
      checks += 1;
      if (seen.present !== input.gone) {
        return {
          met: true,
          url,
          ...tab,
          ...(seen.excerpt !== undefined ? { excerpt: seen.excerpt } : {}),
          checks,
          waitedMs: Date.now() - startedAt,
        };
      }
      await delay(Math.min(WAIT_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    return {
      met: false,
      url,
      ...tab,
      checks,
      waitedMs: Date.now() - startedAt,
      ...(lastMiss !== undefined ? { lastMiss } : {}),
    };
  }

  /** One `find` check. A page that refuses it says so in an error. */
  async #find(
    url: string,
    text: string,
    deadline: number,
  ): Promise<{ present: boolean; excerpt?: string | undefined }> {
    const result = await this.pageAction(
      { action: "find", url, text },
      { timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    if (!result.ok) {
      if (/Unknown action/.test(result.error ?? "")) throw new UnknownActionError();
      // The page refused the check itself, which asking again will not change.
      throw new PreconditionError(result.error ?? "The page could not be checked.");
    }
    const data = result.data as { found?: unknown; excerpt?: unknown };
    return {
      present: data.found === true,
      excerpt: typeof data.excerpt === "string" ? data.excerpt : undefined,
    };
  }

  /** The same check for a tab from before `find`: a live read, searched here. */
  async #findByRead(
    url: string,
    text: string,
    deadline: number,
  ): Promise<{ present: boolean; excerpt?: string | undefined }> {
    const result = await this.pageAction(
      { action: "read", url, format: "text", maxChars: 1_048_576 },
      { timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    const content = (result.data as { content?: unknown } | undefined)?.content;
    if (!result.ok || typeof content !== "string") {
      throw new PreconditionError(result.error ?? "The page could not be read to check it.");
    }
    // A case-insensitive pattern on the text as it is, as the page's `find`
    // does: an index into a lower-cased copy can point elsewhere in the
    // original once lower-casing has changed its length.
    const match = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").exec(content);
    if (!match) return { present: false };
    return {
      present: true,
      excerpt: content
        .slice(Math.max(0, match.index - 80), match.index + match[0].length + 80)
        .replace(/\s+/g, " ")
        .trim(),
    };
  }

  /**
   * Send one network command through the same channel and the same silence
   * diagnosis as `pageAction`. The logic that uses it lives in `network.ts`;
   * this is only the wiring, to keep this file from carrying it.
   */
  #runNet = async (command: Omit<Command, "id" | "expiresAt">): Promise<CommandResult> => {
    const sentAt = Date.now();
    try {
      return await runCommand(
        { pagesDirectory: this.pagesDirectory, timeoutMs: this.#config.actionTimeoutMs },
        command,
      );
    } catch (error) {
      throw this.#explainSilence(error, command.url, sentAt);
    }
  };

  /** Start, stop, clear or report network recording on a page. */
  networkRecord(input: RecordInput): Promise<RecordState> {
    return networkRecord(this.#runNet, { allowWrites: this.#config.allowWrites }, input);
  }

  /** The records a page has buffered, filtered and paged. */
  networkList(input: Parameters<typeof networkList>[1]): Promise<ListResult> {
    return networkList(this.#runNet, input);
  }

  /** One record's headers and body, pulled in chunks; see `networkGet`. */
  networkGet(input: GetInput): Promise<GetResult> {
    return networkGet(
      this.#runNet,
      {
        allowWrites: this.#config.allowWrites,
        downloadDir: this.#config.downloadDir,
        chunkChars: this.#config.networkChunkChars,
      },
      input,
    );
  }

  /**
   * Turn "nothing answered" into the one diagnosis the caller cannot reach.
   *
   * A timeout has three ordinary causes and the message already names them: the
   * extension is not enabled, it is not allowed on that site, or the page is
   * not open. There is a fourth that looks identical and is nobody's fault —
   * **an update leaves already-open tabs running the previous content script**,
   * orphaned from their own runtime and unable to answer or even to capture.
   *
   * The evidence is a capture this URL left behind stamped with a version that
   * is not ours. Both halves ship inside one app bundle, so they are the same
   * version whenever they are the same build; a difference means the tab
   * predates an update. Absent evidence, nothing is added — a guess here would
   * send someone reloading tabs to fix a permission they never granted.
   *
   * A fifth is the lane going quiet everywhere: no capture from ANY site for
   * longer than the extension keeps one. Seen 2026-10-09 with the extension
   * still enabled: restarting Cupertino did nothing, quitting and reopening
   * Safari brought it back. But the extension captures only on a page load, so
   * a healthy one also goes quiet when no ALLOWED page has loaded in that time
   * — and then the missing permission is the right answer. Only this URL's own
   * capture argues against the permission, and only as of when it was taken: a
   * stale capture survives precisely because nothing has written since, so the
   * grant may have lapsed or the tab closed after it. The tab's own version
   * evidence is more specific, so it is checked first.
   */
  #explainSilence(error: unknown, url: string | undefined, sentAt: number): unknown {
    // Only a timeout is silence. Anything else — the command directory
    // unwritable, say — failed before any tab was asked, and blaming Safari
    // would send someone there for a problem on this side.
    if (!(error instanceof PageCommandTimeoutError)) return error;

    // No capture of this URL says nothing about its version: a page that was
    // never allowed and a page whose capture aged out look the same from here.
    const hit = url ? this.page(url) : null;
    if (hit) {
      const seen = hit.page.extensionVersion ?? null;
      if (seen !== BUILD_INFO.version) {
        return new PageCommandTimeoutError(
          `${error.message} This page was last captured by ` +
            `${seen === null ? "an extension too old to say which version" : `extension ${seen}`}, ` +
            `and this server is ${BUILD_INFO.version} — both ship inside the same app, so they only ` +
            `differ when a tab has been open across an update. That tab is still running the ` +
            `previous content script and cannot answer. RELOAD it and try again.`,
        );
      }
    }

    // Heartbeats, where the extension writes them, answer the question the
    // captures below can only guess at: is anything running, and where.
    const now = Date.now();
    const diagnosis = answeringDiagnosis(this.heartbeatStatus(now), url, { sentAt, now });
    if (diagnosis !== null) return new PageCommandTimeoutError(`${error.message} ${diagnosis}`);

    const status = this.pagesStatus();
    if (!isQuiet(status)) return error;
    const quietMinutes = Math.round((status.newestAgeSeconds ?? 0) / 60);
    const quietFor = `captured on ANY site for ${quietMinutes} minutes`;
    const quiet = `Nothing has been ${quietFor}`;
    const reopen =
      `quit and reopen Safari — restarting Cupertino does not reach it, the extension runs ` +
      `inside Safari — then reload the tab.`;
    if (hit) {
      return new PageCommandTimeoutError(
        `${error.message} This page was captured ${Math.round(hit.ageSeconds / 60)} minutes ` +
          `ago, so the extension was allowed on it then, and nothing has been ${quietFor}: ` +
          `unless the tab has closed or the site's permission lapsed since, the extension looks ` +
          `not to be running in Safari at all. If the tab is open and the extension still ` +
          `enabled in Safari > Settings > Extensions, ${reopen}`,
      );
    }
    return new PageCommandTimeoutError(
      `${error.message} ${quiet} either: the extension is not running in Safari, or it is ` +
        `allowed on no site loaded since. If it is allowed on this site and still enabled in ` +
        `Safari > Settings > Extensions, ${reopen}`,
    );
  }

  /** Where the Safari extension writes its captures. */
  get pagesDirectory(): string {
    return this.#config.pagesPath ?? defaultPagesDirectory(this.#home);
  }

  /**
   * The freshest capture of one URL, or null.
   *
   * Matching is exact. The extension records `location.href`, which is the URL
   * the page itself reports — so it already agrees with what
   * `apple_safari_list_tabs` returns for that tab, and the variant ladder that
   * history needs does not apply here. Two tabs on the same URL collapse to one
   * entry by construction, because the extension keys its files by URL digest.
   */
  page(url: string): { page: CapturedPage; ageSeconds: number } | null {
    const hit = readPage(this.pagesDirectory, url);
    return hit ? { page: hit, ageSeconds: ageSeconds(hit) } : null;
  }

  /** Every capture currently on disk, newest first. */
  pages(): { page: CapturedPage; ageSeconds: number }[] {
    return readPages(this.pagesDirectory).map((page) => ({ page, ageSeconds: ageSeconds(page) }));
  }

  pagesStatus(): PagesStatus {
    return pagesStatus(this.pagesDirectory);
  }

  /** Which open pages have polled lately; see `heartbeatStatus`. */
  heartbeatStatus(now?: number): HeartbeatStatus {
    return heartbeatStatus(this.pagesDirectory, now);
  }

  /** Everything diagnostics needs, with no lane allowed to fail the whole call. */
  status(): {
    located: LocateResult;
    store: { opened: boolean; mode: string | null; reason: string | null };
    capabilities: Record<string, unknown> | null;
  } {
    const located = this.located();
    let store: SafariStore | null = null;
    let reason: string | null = located.reason;
    try {
      store = this.store();
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    return {
      located,
      store: { opened: store !== null, mode: store?.mode ?? null, reason },
      capabilities: store
        ? {
            fingerprint: store.caps.fingerprint,
            tables: store.caps.tables,
            counts: store.caps.counts,
            itemFk: store.caps.itemFk,
            itemPk: store.caps.itemPk,
            hasVisits: store.caps.hasVisits,
            hasTombstones: store.caps.hasTombstones,
            epoch: store.caps.epoch,
          }
        : null,
    };
  }

  close(): void {
    this.#store?.close();
    this.#store = null;
  }
}
