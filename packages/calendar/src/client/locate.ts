import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describeStore, type StoreFacts } from "@mgcrea/mcp-apple-core";

/**
 * Find Calendar's store.
 *
 * ## Why this is the easy case
 *
 * Reminders keeps its database under a generated directory name, so resolving
 * it means *listing* a protected directory — which is itself the privileged
 * operation, leaving no path to even stat without the grant. Calendar does not:
 *
 *     ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb
 *
 * is a constant. `statSync` succeeds on a TCC-protected file (only `access(2)`
 * is denied — see packages/core/src/fs.ts), so this locator can tell "exists but
 * unreadable" from "not there at all" with no permission whatsoever. Those are
 * different failures with different fixes, and saying so is most of what
 * diagnostics is for.
 *
 * ## Why it still walks the container
 *
 * `docs/calendar.md` recorded per-account stores sitting beside the main one,
 * and the probe picked between them by size. The known filename is *preferred*,
 * so the common case costs one `describeStore` and no listing at all; the walk
 * is a fallback for a machine whose layout differs, and for the day Apple moves
 * the file the way it moved Reminders' out of `~/Library/Reminders`.
 */

/** `group.com.apple.calendar`, under `~/Library/Group Containers`. */
export const GROUP_CONTAINER = "group.com.apple.calendar";

/** The observed filename. Preferred when present; not required. */
export const STORE_FILENAME = "Calendar.sqlitedb";

/** Sits beside the store. 32 KB, and its contents are not used by this server. */
export const EXTRAS_FILENAME = "Extras.db";

/** Depth cap for the fallback walk. The real store sits at depth 0. */
const MAX_DEPTH = 3;

const STORE_SUFFIX = /\.(sqlitedb|sqlite)$/i;

export type StoreCandidate = StoreFacts & { path: string };

export type LocateResult = StoreFacts & {
  containerPath: string;
  /** Null when discovery found nothing at all — see `reason`. */
  storePath: string | null;
  /** Every store-shaped file found, largest first. */
  candidates: StoreCandidate[];
  /**
   * Whether the container could be listed.
   *
   * Unlike Reminders this is NOT the permission signal — the store's path is
   * known, so `readable` answers that directly. It is reported because a
   * listable container with no store in it means Calendar was never set up,
   * which is a different conversation from a denied grant.
   */
  containerListable: boolean;
  /** `Extras.db` beside the store. Recorded so it stops being an unknown. */
  extrasPresent: boolean;
  reason: string | null;
};

export const defaultContainerPath = (home: string = homedir()): string =>
  join(home, "Library", "Group Containers", GROUP_CONTAINER);

export const defaultStorePath = (home: string = homedir()): string =>
  join(defaultContainerPath(home), STORE_FILENAME);

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? [] : [e.name],
    );
  } catch {
    return [];
  }
};

const walk = (dir: string, depth: number, out: string[]): string[] => {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (STORE_SUFFIX.test(e.name)) out.push(p);
  }
  return out;
};

const FDA_HINT =
  "Grant Full Disk Access to the app running this server (System Settings > Privacy & " +
  "Security > Full Disk Access) and restart it. Granting it to Calendar.app does nothing — " +
  "the reader needs the permission.";

export const locateStore = (
  opts: { storePath?: string | undefined; home?: string } = {},
): LocateResult => {
  const containerPath = defaultContainerPath(opts.home);

  // An explicit path is a bypass, for tests and forensic copies. No discovery.
  if (opts.storePath) {
    const facts = describeStore(opts.storePath);
    return {
      ...facts,
      containerPath,
      storePath: opts.storePath,
      candidates: [{ ...facts, path: opts.storePath }],
      containerListable: true,
      extrasPresent: false,
      reason: facts.readable
        ? null
        : facts.exists
          ? `The store at ${opts.storePath} exists but cannot be read. ${FDA_HINT}`
          : `No file at ${opts.storePath}. APPLE_CALENDAR_STORE points at nothing.`,
    };
  }

  // The known path first. This is the whole advantage over Reminders: it needs
  // no directory listing, so it works — and reports the truth — with no grant.
  const known = defaultStorePath(opts.home);
  const knownFacts = describeStore(known);

  const listing = listDir(containerPath);
  const containerListable = listing.length > 0;
  const extrasPresent = listing.includes(EXTRAS_FILENAME);

  const paths = knownFacts.readable ? [known] : walk(containerPath, 0, []);
  const candidates: StoreCandidate[] = (paths.includes(known) ? paths : [known, ...paths])
    .map((p) => ({ ...describeStore(p), path: p }))
    .filter((c) => c.exists)
    .toSorted((a, b) => (b.size ?? 0) - (a.size ?? 0));

  // The known path wins when it is readable, even if some other file is larger:
  // size is a tie-breaker between unknowns, not evidence against a documented
  // filename. Otherwise fall back to the largest readable candidate.
  const chosen = knownFacts.readable
    ? ({ ...knownFacts, path: known } satisfies StoreCandidate)
    : (candidates.find((c) => c.readable) ?? candidates[0] ?? null);

  const reason = chosen?.readable
    ? null
    : knownFacts.exists
      ? `Found the Calendar store at ${known} but cannot read it. ${FDA_HINT}`
      : containerListable
        ? `No store file under ${containerPath}. Has Calendar ever been set up on this account?`
        : `Neither ${known} nor its container could be reached. If Calendar is set up on this ` +
          `account this is a permission problem. ${FDA_HINT}`;

  const facts: StoreFacts = chosen
    ? {
        exists: chosen.exists,
        readable: chosen.readable,
        size: chosen.size,
        mtime: chosen.mtime,
        walPresent: chosen.walPresent,
        walSizeBytes: chosen.walSizeBytes,
      }
    : knownFacts;

  return {
    ...facts,
    containerPath,
    storePath: chosen?.path ?? null,
    candidates,
    containerListable,
    extrasPresent,
    reason,
  };
};
