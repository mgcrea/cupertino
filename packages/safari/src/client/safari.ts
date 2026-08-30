import {
  createOsascriptRunner,
  type Logger,
  type OsascriptRunner,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { renderInstant, type Epoch } from "./dates.js";
import {
  BookmarksUnavailableError,
  SAFARI_SURFACE,
  SafariHistoryUnavailableError,
} from "./errors.js";
import { BOOKMARKS_WALK } from "./jxa/bookmarks.js";
import { LIVE_TABS } from "./jxa/tabs.js";
import { locateStore, type LocateResult } from "./locate.js";
import { urlVariants, type MatchKind } from "./match.js";
import { encodeBookmarkRef, encodeHistoryRef } from "./ref.js";
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
  windows: number;
  appFrontmost: boolean | null;
  windowOrderUnknown: boolean;
  tabs: {
    window: number;
    windowIndex: number | null;
    index: number | null;
    url: string | null;
    title: string | null;
    active: boolean;
    frontmost: boolean;
  }[];
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
        resolve = (url) => {
          for (const variant of ladders.get(url) ?? []) {
            const hit = rows.get(variant.url);
            // First hit wins, and the ladder is ordered most-faithful-first, so
            // an exact match is never lost to a looser one that also resolved.
            if (hit) return { page: this.#render(hit, store.caps.epoch), kind: variant.kind };
          }
          return null;
        };
      } catch {
        // No store. Tabs still work; they simply arrive unenriched.
        resolve = null;
      }
    }

    return {
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
