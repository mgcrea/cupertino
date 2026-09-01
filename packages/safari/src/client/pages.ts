import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The extension lane: pages the Safari extension captured.
 *
 * ## Why this store exists where it does
 *
 * This is the only lane whose data is written by something other than Safari.
 * `apps/apple/CupertinoSafariExtension` runs a content script on the sites the
 * user has allowed it on, and its native handler writes each capture into the
 * EXTENSION's own sandbox container. An app extension may write nowhere else.
 *
 * That container is readable from here for a measured reason, not a hopeful
 * one: it is `drwx------` owned by the user and is not TCC-protected, so this
 * process reads it with no grant of any kind. See docs/safari.md, which records
 * the negative control — a shell denied on `History.db`, `~/Library/Mail` and
 * `chat.db` reads three appex containers, including two belonging to other
 * vendors' App Store apps.
 *
 * The alternative was an app group, which would have meant a new entitlement on
 * Cupertino.app, and docs/distribution.md calls its identity "the most
 * expensive string in the project: changing it is a new TCC identity, so every
 * existing user re-grants Full Disk Access".
 *
 * ## What this lane is NOT
 *
 * It is not live. The extension pushes; nothing here can pull. A capture is
 * whatever the page looked like when it was last visited on a permitted site,
 * so every read carries `capturedAt` and the tool says plainly that it may be
 * stale. Reporting a cached page as the current one is the specific wrong
 * answer this design can produce, and the timestamp is what prevents it.
 */

/** Where the extension writes. Keyed by the appex's bundle identifier. */
const EXTENSION_BUNDLE_ID = "io.mgcrea.cupertino.SafariExtension";

export const defaultPagesDirectory = (home: string = homedir()): string =>
  join(
    home,
    "Library",
    "Containers",
    EXTENSION_BUNDLE_ID,
    "Data",
    "Library",
    "Application Support",
    "pages",
  );

export type CapturedPage = {
  url: string;
  title: string;
  /** ISO-8601, written by the extension at capture time. */
  capturedAt: string;
  text: string;
  html: string;
  /** The capture hit the extension's per-entry byte cap and was cut. */
  textTruncated: boolean;
  htmlTruncated: boolean;
  /**
   * Which build of the extension captured this, as the content script reported
   * it. Optional because entries written before this existed carry none, and
   * because an orphaned content script cannot read its own manifest — both of
   * which mean "older than us", which is what the reader does with it.
   */
  extensionVersion?: string | null;
};

export type PagesStatus = {
  directory: string;
  /** The directory exists — i.e. the extension has run at least once. */
  exists: boolean;
  /** Entries currently on disk, before any TTL judgement. */
  count: number;
  /**
   * Age of the freshest capture, or null when there are none.
   *
   * This is how the lane detects its own silence. Whether the extension is
   * ENABLED is a switch in Safari's UI that only the containing app can read,
   * and a value passed to this process at spawn would be a snapshot of a
   * setting the user can flip a second later — reported confidently and wrong.
   *
   * What can be measured here is quietness. The extension prunes on write with
   * a 30 minute TTL, so if it were running and being used, something would be
   * recent. A newest capture older than that means the lane has gone quiet:
   * switched off, or allowed on no site the user has visited since. Either way
   * the honest thing is to say the captures are old, not to assert why.
   */
  newestAgeSeconds: number | null;
};

/**
 * Past this, the lane is reported as quiet.
 *
 * Matches the extension's own TTL in `SafariWebExtensionHandler.swift`. If the
 * two drift, this reports quiet while entries are still being kept, or stays
 * silent about a store that has stopped being written — so they are the same
 * number on purpose.
 */
export const QUIET_AFTER_SECONDS = 30 * 60;

const isPage = (v: unknown): v is CapturedPage =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as CapturedPage).url === "string" &&
  typeof (v as CapturedPage).capturedAt === "string";

/**
 * Every capture currently on disk, newest first.
 *
 * Tolerant by construction: a file being written while this reads, or left by
 * an older extension with a different shape, is skipped rather than failing the
 * call. The extension writes atomically, so a torn read is unlikely — but this
 * lane must never take down a tool over one bad entry, because the store is
 * written by a component that updates on its own schedule.
 */
export const readPages = (directory: string): CapturedPage[] => {
  let names: string[];
  try {
    names = readdirSync(directory).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }

  const pages: CapturedPage[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (isPage(parsed)) pages.push(parsed);
    } catch {
      // Unreadable or not ours. Skip it.
    }
  }

  // Newest first, so "the freshest capture of this URL" is just the first hit.
  // Sorted on the extension's own timestamp rather than mtime: mtime moves for
  // reasons that have nothing to do with when the page was read.
  return pages.toSorted((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
};

export const pagesStatus = (directory: string, now: number = Date.now()): PagesStatus => {
  try {
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      return { directory, exists: false, count: 0, newestAgeSeconds: null };
    }
    const pages = readPages(directory);
    return {
      directory,
      exists: true,
      count: pages.length,
      // readPages sorts newest first.
      newestAgeSeconds: pages[0] ? ageSeconds(pages[0], now) : null,
    };
  } catch {
    return { directory, exists: false, count: 0, newestAgeSeconds: null };
  }
};

/** How old a capture is, in whole seconds. Negative clock skew clamps to zero. */
export const ageSeconds = (page: CapturedPage, now: number = Date.now()): number => {
  const at = Date.parse(page.capturedAt);
  if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now - at) / 1000));
};
