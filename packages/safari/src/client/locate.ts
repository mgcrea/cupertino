import { homedir } from "node:os";
import { join } from "node:path";

import {
  describeStore,
  inspectFile,
  type FileFacts,
  type StoreFacts,
} from "@mgcrea/mcp-apple-core";

/**
 * Find Safari's files.
 *
 * ## The easy case, four times over
 *
 * Reminders keeps its database under a generated directory name, so resolving it
 * means *listing* a protected directory — the privileged operation itself, which
 * leaves no path to even stat without the grant. Safari is the opposite
 * extreme: everything sits at a constant path under `~/Library/Safari/`, so
 * there is no discovery to do at all.
 *
 *     History.db       6,606,848   9 tables, fingerprint 1d20bcd2b9a5
 *     Bookmarks.plist    880,559   binary plist — bookmarks AND the Reading List
 *     Downloads.plist      3,871   unexamined; reported, never parsed
 *     CloudTabs.db        absent   tabs open on other devices
 *
 * (Sizes measured on macOS 26.6 — see docs/safari.md.) `statSync` succeeds on a
 * TCC-protected file where `access(2)` is denied (packages/core/src/fs.ts), so
 * this locator distinguishes "exists but unreadable" from "not there at all"
 * with no permission whatsoever. Those are different failures with different
 * fixes, and saying which one happened is most of what diagnostics is for.
 *
 * ## Why all four are located, not just the one
 *
 * They fail INDEPENDENTLY, and this surface is the one where that matters.
 * Every other server in this repo has a single store: it opens or it does not.
 * Safari's capabilities are spread across separate files under one grant, so a
 * corrupt `Bookmarks.plist` takes the Reading List away while history keeps
 * working perfectly. Reporting one boolean for "the store" would turn that into
 * an unexplained empty list.
 *
 * `CloudTabs.db` was ABSENT on the probed machine, so nothing here treats its
 * absence as a fault — it is reported and never required.
 */

/** Everything lives directly in here. No group container, no generated name. */
export const SAFARI_DIR = ["Library", "Safari"];

export const HISTORY_FILENAME = "History.db";
export const BOOKMARKS_FILENAME = "Bookmarks.plist";
export const DOWNLOADS_FILENAME = "Downloads.plist";
export const CLOUD_TABS_FILENAME = "CloudTabs.db";

/**
 * The hint, worded for the failure people actually hit.
 *
 * The second sentence is the one that matters: granting Full Disk Access to
 * *Safari* is the intuitive move and does nothing at all. The reader needs the
 * permission, and the reader is whatever app launched this server.
 */
export const FDA_HINT =
  "Grant Full Disk Access to the app running this server (System Settings > Privacy & " +
  "Security > Full Disk Access) and restart it. Granting it to Safari.app does nothing — " +
  "the reader needs the permission, not the browser.";

export type LocatedFile = FileFacts & { path: string };

export type LocateResult = StoreFacts & {
  directory: string;
  /** Null only when `APPLE_SAFARI_STORE` points at nothing. */
  historyPath: string | null;
  bookmarks: LocatedFile;
  downloads: LocatedFile;
  cloudTabs: LocatedFile;
  reason: string | null;
};

export const defaultDirectory = (home: string = homedir()): string => join(home, ...SAFARI_DIR);

export const defaultHistoryPath = (home: string = homedir()): string =>
  join(defaultDirectory(home), HISTORY_FILENAME);

export const defaultBookmarksPath = (home: string = homedir()): string =>
  join(defaultDirectory(home), BOOKMARKS_FILENAME);

const locateFile = (path: string): LocatedFile => ({ ...inspectFile(path), path });

export const locateStore = (
  opts: { storePath?: string | undefined; bookmarksPath?: string | undefined; home?: string } = {},
): LocateResult => {
  const directory = defaultDirectory(opts.home);

  // An explicit path is a bypass for tests and forensic copies. The companion
  // files are still located from the real directory unless separately
  // overridden, because pointing history at a fixture should not silently
  // disable the Reading List.
  const historyPath = opts.storePath ?? defaultHistoryPath(opts.home);
  const bookmarksPath = opts.bookmarksPath ?? defaultBookmarksPath(opts.home);

  const facts = describeStore(historyPath);

  const reason = facts.readable
    ? null
    : facts.exists
      ? `Found Safari's history at ${historyPath} but cannot read it. ${FDA_HINT}`
      : opts.storePath
        ? `No file at ${opts.storePath}. APPLE_SAFARI_STORE points at nothing.`
        : `No history database at ${historyPath}. Has Safari ever been used on this account?`;

  return {
    ...facts,
    directory,
    historyPath: facts.exists || !opts.storePath ? historyPath : null,
    bookmarks: locateFile(bookmarksPath),
    downloads: locateFile(join(directory, DOWNLOADS_FILENAME)),
    cloudTabs: locateFile(join(directory, CLOUD_TABS_FILENAME)),
    reason,
  };
};
