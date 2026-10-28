import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The record of tabs an agent opened, which is what makes closing one safe.
 *
 * ## Why a record at all
 *
 * Safari gives a tab no identity over Apple Events: a tab is a position in a
 * window and a URL, and positions move the moment somebody drags one. So "the
 * tab the agent opened" has to be written down when it is opened, by
 * `open_url`, and found again later by what it still shows. A tab that is not
 * in this record cannot be closed by anything on this surface.
 *
 * ## The URL is the identity, and a tab that left it is let go
 *
 * A recorded tab is found again only while it still shows the URL it was
 * opened on. One that moved on — a redirect, a link the agent clicked, a page
 * the user navigated to — is reported `notFound` and left open. Following a
 * tab through a navigation needs more than a URL can carry; see
 * docs/safari.md, "Closing a tab, built", for what that would take.
 *
 * ## One file per tab, on disk, shared by every server
 *
 * Every client gets its own server process, and "a tab an agent opened" means
 * any agent's, including one whose session has ended. So the record is on
 * disk, outside any one process, and each entry is its own file: recording is
 * a create, forgetting is an unlink, and two servers doing either at once
 * cannot lose each other's entries the way a shared JSON array would.
 *
 * The directory sits under the RELEASE app's identifier for both builds. A tab
 * a Debug build opened is still a tab an agent opened.
 */

export type OpenedTab = {
  /** Also the file's name and the tail of the `st1:` ref. */
  id: string;
  /** The URL the agent asked for, as it asked for it. */
  url: string;
  /** Safari's window id when the tab was placed precisely, else null. */
  windowId: number | null;
  openedAt: string;
};

/** A live tab, as far as finding one again needs it. */
export type LiveTab = {
  windowId: number | null;
  index: number | null;
  url: string | null;
};

export type Located =
  | { kind: "found"; tab: LiveTab }
  | { kind: "notFound" }
  | { kind: "ambiguous"; tabs: number };

/**
 * A week. Long enough to clean up after yesterday's research; short enough
 * that an entry whose tab has long since gone does not linger as a claim on
 * whatever page next shows its URL.
 */
export const OPENED_TAB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const openedTabsDirectory = (home: string = homedir()): string =>
  join(home, "Library", "Application Support", "io.mgcrea.cupertino", "safari", "opened-tabs");

/** Ids are minted here as UUIDs; anything else never names a file. */
const ID = /^[0-9a-f-]{36}$/;

/**
 * Whether two URLs name the same page, as Safari reports them.
 *
 * WHATWG parsing and nothing more: it folds the host's case and adds the
 * trailing slash a bare host gets, which is the difference between the URL an
 * agent passes and the one Safari shows for it. Query and fragment stay
 * significant — either can be the whole page.
 */
const normalised = (u: string): string => {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
};

export const sameUrl = (a: string, b: string): boolean => normalised(a) === normalised(b);

export const recordOpenedTab = (
  dir: string,
  input: { url: string; windowId: number | null },
  now: number = Date.now(),
): OpenedTab => {
  const entry: OpenedTab = {
    id: randomUUID(),
    url: input.url,
    windowId: input.windowId,
    openedAt: new Date(now).toISOString(),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written aside and renamed in, so a reader never sees half an entry.
  const file = join(dir, `${entry.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return entry;
};

const isEntry = (v: unknown): v is OpenedTab => {
  const e = v as OpenedTab;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof e.id === "string" &&
    ID.test(e.id) &&
    typeof e.url === "string" &&
    (e.windowId === null || typeof e.windowId === "number") &&
    typeof e.openedAt === "string" &&
    Number.isFinite(Date.parse(e.openedAt))
  );
};

/** Every live entry, oldest first. Expired ones are removed on the way. */
export const readOpenedTabs = (dir: string, now: number = Date.now()): OpenedTab[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: OpenedTab[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      // Unreadable is not ours to judge, and not a reason to fail the read.
      continue;
    }
    // A file under another name could never be forgotten by its id, and would
    // count as a claim on its URL for a week.
    if (!isEntry(parsed) || name !== `${parsed.id}.json`) continue;
    if (now - Date.parse(parsed.openedAt) > OPENED_TAB_TTL_MS) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    out.push(parsed);
  }
  return out.toSorted((a, b) => a.openedAt.localeCompare(b.openedAt));
};

export const forgetOpenedTabs = (dir: string, ids: readonly string[]): void => {
  for (const id of ids) {
    // The id came from a caller's ref, so it is checked before it names a file.
    if (ID.test(id)) rmSync(join(dir, `${id}.json`), { force: true });
  }
};

/**
 * Find each asked-for entry among the live tabs.
 *
 * `all` is every entry in the record, not just the ones asked about, because
 * the question for a URL is "how many agents opened it": two agent tabs on one
 * page are both closeable, while a third tab on it is somebody's own and makes
 * every one of them ambiguous. When more tabs show the URL than agents opened,
 * nothing is chosen — and a tab whose URL could not be read (`url: null`:
 * loading, a native error page, a window whose tab list failed) counts as one
 * that might show it, so its presence in scope is ambiguous too.
 *
 * Two passes. Entries whose window is still open are matched inside that
 * window, so the user's own copy of the page in another window is never
 * counted against one, nor taken for it. Entries whose window has gone — ids
 * do not survive a relaunch, and session restore brings the tabs back under
 * new ones — are matched across every window, among the tabs the first pass
 * did not take.
 */
export const locateOpenedTabs = (
  asked: readonly OpenedTab[],
  all: readonly OpenedTab[],
  live: readonly LiveTab[],
): { entry: OpenedTab; outcome: Located }[] => {
  const openWindows = new Set(live.map((t) => t.windowId).filter((id) => id !== null));
  const scopeOf = (e: OpenedTab): number | null =>
    e.windowId !== null && openWindows.has(e.windowId) ? e.windowId : null;

  const outcomes = new Map<string, Located>();
  const taken = new Set<LiveTab>();

  const settle = (claimants: OpenedTab[], pool: LiveTab[]): void => {
    const url = claimants[0]?.url ?? "";
    const unreadable = pool.some((t) => t.url === null);
    const candidates = pool
      .filter((t) => t.url !== null && sameUrl(t.url, url))
      .toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (unreadable || candidates.length > claimants.length) {
      const tabs = candidates.length + pool.filter((t) => t.url === null).length;
      for (const e of claimants) outcomes.set(e.id, { kind: "ambiguous", tabs });
      return;
    }
    // Same page, so which agent entry takes which tab changes nothing on
    // screen; the order only has to be stable between two calls.
    claimants.forEach((e, i) => {
      const tab = candidates[i];
      if (tab) taken.add(tab);
      outcomes.set(e.id, tab ? { kind: "found", tab } : { kind: "notFound" });
    });
  };

  const groups = (entries: readonly OpenedTab[]): OpenedTab[][] => {
    const out: OpenedTab[][] = [];
    for (const e of entries.toSorted(
      (a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id),
    )) {
      const group = out.find((g) => scopeOf(g[0]!) === scopeOf(e) && sameUrl(g[0]!.url, e.url));
      if (group) group.push(e);
      else out.push([e]);
    }
    return out;
  };

  for (const group of groups(all.filter((e) => scopeOf(e) !== null))) {
    const scope = scopeOf(group[0]!);
    settle(
      group,
      live.filter((t) => t.windowId === scope),
    );
  }
  for (const group of groups(all.filter((e) => scopeOf(e) === null))) {
    settle(
      group,
      live.filter((t) => !taken.has(t)),
    );
  }

  return asked.map((entry) => ({ entry, outcome: outcomes.get(entry.id) ?? { kind: "notFound" } }));
};
