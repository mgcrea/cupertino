import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** The freshest capture is older than the extension keeps one: the lane has gone quiet. */
export const isQuiet = ({ newestAgeSeconds }: Pick<PagesStatus, "newestAgeSeconds">): boolean =>
  newestAgeSeconds !== null && newestAgeSeconds > QUIET_AFTER_SECONDS;

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

/**
 * The capture of one URL, or null when there is none.
 *
 * Opens the one file the extension would have written it to, rather than
 * parsing the whole store to find it: the handler names each entry by the
 * SHA-256 of its URL (`filename(for:)` in SafariWebExtensionHandler.swift), so
 * the URL is the address. A full store is twenty entries of up to 1.25 MB
 * each, about 55 ms to parse, and a read that fell back to the capture paid
 * that up to four times.
 *
 * The entry's own `url` is checked too, so a file that is not what its name
 * says is a miss rather than another page's content.
 */
export const readPage = (directory: string, url: string): CapturedPage | null => {
  const name = `${createHash("sha256").update(url, "utf8").digest("hex")}.json`;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
    return isPage(parsed) && parsed.url === url ? parsed : null;
  } catch {
    // Absent, torn or not ours: no capture of this URL.
    return null;
  }
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

/**
 * One open page's proof of life, as the native handler records it.
 *
 * Every allowed page polls the handler for commands, about once a second while
 * visible and once every ten while hidden, and the handler stamps a file per
 * ORIGIN when it does (rewritten at most every five seconds). That is the one
 * signal that says the extension is running NOW: a capture only happens when a
 * page loads, so a healthy extension and a dead one look the same from captures
 * alone whenever nothing has loaded for half an hour.
 */
export type Heartbeat = { origin: string; ageSeconds: number; extensionVersion: string | null };

export type HeartbeatStatus = {
  /**
   * The directory exists, so this extension writes heartbeats and their
   * absence means something. An extension from before them writes none, and
   * then nothing here can say whether a page is answering.
   */
  supported: boolean;
  /** Origins whose page polled within `ANSWERING_WINDOW_SECONDS`, freshest first. */
  answering: Heartbeat[];
};

/**
 * How recent a heartbeat must be to count as a page answering now.
 *
 * A hidden tab polls every ten seconds and the handler rewrites a heartbeat at
 * most every five, so a live hidden page is never more than about fifteen
 * seconds old. Twice that leaves room for a busy page without keeping a closed
 * one alive for long.
 */
export const ANSWERING_WINDOW_SECONDS = 30;

/** Beside `pages/`, as the handler creates it (`channelDirectory` in the Swift). */
export const heartbeatDirectory = (pagesDirectory: string): string =>
  join(dirname(pagesDirectory), "heartbeat");

export const heartbeatStatus = (
  pagesDirectory: string,
  now: number = Date.now(),
): HeartbeatStatus => {
  const directory = heartbeatDirectory(pagesDirectory);
  let names: string[];
  try {
    names = readdirSync(directory).filter((n) => n.endsWith(".json"));
  } catch {
    return { supported: false, answering: [] };
  }
  const answering: Heartbeat[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        origin?: unknown;
        at?: unknown;
        extensionVersion?: unknown;
      };
      if (typeof parsed.origin !== "string" || typeof parsed.at !== "string") continue;
      const at = Date.parse(parsed.at);
      if (Number.isNaN(at)) continue;
      const age = Math.max(0, Math.round((now - at) / 1000));
      if (age > ANSWERING_WINDOW_SECONDS) continue;
      answering.push({
        origin: parsed.origin,
        ageSeconds: age,
        extensionVersion:
          typeof parsed.extensionVersion === "string" ? parsed.extensionVersion : null,
      });
    } catch {
      // Torn or not ours. Skip it, as readPages does.
    }
  }
  return { supported: true, answering: answering.toSorted((a, b) => a.ageSeconds - b.ageSeconds) };
};

/**
 * The lane in one word, from the two things this process can measure.
 *
 * - `never-ran`: no store at all. The extension has never written anything.
 * - `never-captured`: the store exists and holds nothing.
 * - `stale`: there are captures, all older than the extension keeps one.
 * - `capturing`: a capture inside that window.
 * - `answering`: a page polled within the last half minute, so a command sent
 *   now has somewhere to go. Only an extension that writes heartbeats can say so.
 */
export type ExtensionState = "never-ran" | "never-captured" | "stale" | "capturing" | "answering";

export const extensionState = (
  pages: PagesStatus,
  beats: HeartbeatStatus,
): { state: ExtensionState; working: boolean; answering: boolean | null } => {
  const answering = beats.supported ? beats.answering.length > 0 : null;
  const state: ExtensionState =
    answering === true
      ? "answering"
      : !pages.exists
        ? beats.supported
          ? "never-captured"
          : "never-ran"
        : pages.newestAgeSeconds === null
          ? "never-captured"
          : isQuiet(pages)
            ? "stale"
            : "capturing";
  // Working means a page could answer now. Without heartbeats the best evidence
  // is a capture inside the TTL; with them, only a heartbeat counts, because a
  // capture from five minutes ago is a page that may have closed since.
  const working = answering ?? state === "capturing";
  return { state, working, answering };
};

/** An origin, or null for something that is not an absolute URL. */
const originOf = (url: string | undefined): string | null => {
  if (url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** At most three, then a count: an agent needs a sample, not every tab. */
const listOrigins = (beats: Heartbeat[]): string => {
  const shown = beats.slice(0, 3).map((b) => b.origin);
  const more = beats.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
};

/**
 * What the heartbeats say about a page that did not answer, or null when this
 * extension writes none and they can say nothing.
 *
 * Three answers, and each sends someone somewhere different: nothing running
 * anywhere is Safari's Extensions pane (or a relaunch), running elsewhere but
 * not here is this site's permission, and running here is the tab itself.
 */
export const answeringDiagnosis = (
  beats: HeartbeatStatus,
  url: string | undefined,
): string | null => {
  if (!beats.supported) return null;
  if (beats.answering.length === 0) {
    return (
      `No open page has polled the extension in the last ${ANSWERING_WINDOW_SECONDS} seconds, ` +
      `on any site, so it is not running in Safari: switched off, allowed on no open page, or ` +
      `loaded but broken. If Safari > Settings > Extensions shows it ticked, look there for a ` +
      `second Cupertino row — two copies of Cupertino.app on this Mac can leave Safari with an ` +
      `extension it never runs — then quit and reopen Safari and reload the tab.`
    );
  }
  const origin = originOf(url);
  const here = origin === null ? undefined : beats.answering.find((b) => b.origin === origin);
  if (here) {
    return (
      `The extension is running on ${origin} right now, so it is allowed there, but no page on ` +
      `this exact URL took the command: the tab may be on a slightly different address ` +
      `(apple_safari_list_tabs gives the one Safari holds), still loading, or closed.`
    );
  }
  return (
    `The extension is running — pages on ${listOrigins(beats.answering)} are answering — ` +
    (origin === null
      ? `but no page took the command.`
      : `but not on ${origin}: it is not allowed on this site, or this tab has not loaded since ` +
        `it was allowed (reload it), or the tab is not open.`)
  );
};
