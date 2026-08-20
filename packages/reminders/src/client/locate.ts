import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describeStore, type StoreFacts } from "@mgcrea/mcp-apple-core";

/**
 * Find Reminders' store.
 *
 * ## Why this is harder than Notes'
 *
 * Notes has one constant path, so its locator can `statSync` a known file and
 * learn "exists but unreadable" — the signature of a TCC denial — without any
 * permission at all. Reminders keeps its database under a **generated
 * directory name**:
 *
 *     ~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-<UUID>.sqlite
 *
 * Resolving that means *listing* a protected directory, which is itself the
 * privileged operation. So without Full Disk Access there is not even a path to
 * stat, and this returns `storePath: null` with a reason rather than reporting a
 * file that does not exist. Those are different failures and lead to different
 * fixes.
 *
 * ## Why it globs rather than hardcoding `Container_v1/Stores`
 *
 * That subpath is the observed layout, not a documented one, and Apple has
 * moved this data before — `~/Library/Reminders/Container_v1/Stores` on older
 * releases, and `~/Library/Calendars` in the EventKit era. A bounded walk for
 * `*.sqlite` survives a reshuffle; a hardcoded path turns one into a total
 * outage. The known layout is still *preferred* when present, so the common
 * case costs one readdir.
 */

/** `group.com.apple.reminders`, under `~/Library/Group Containers`. */
export const GROUP_CONTAINER = "group.com.apple.reminders";

/** The observed layout. Preferred when it exists; not required. */
const PREFERRED = ["Container_v1", "Stores"];

/** Depth cap for the fallback walk. The real store sits at depth 2. */
const MAX_DEPTH = 4;

export type StoreCandidate = StoreFacts & { path: string };

export type LocateResult = StoreFacts & {
  containerPath: string;
  /** Null when discovery could not run — see `reason`. */
  storePath: string | null;
  /** Every `.sqlite` found, largest first. More than one is normal. */
  candidates: StoreCandidate[];
  /** Whether the container could be listed at all. The FDA signal for this surface. */
  containerListable: boolean;
  reason: string | null;
};

export const defaultContainerPath = (home: string = homedir()): string =>
  join(home, "Library", "Group Containers", GROUP_CONTAINER);

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
    else if (e.name.endsWith(".sqlite")) out.push(p);
  }
  return out;
};

const FDA_HINT =
  "Grant Full Disk Access to the app running this server (System Settings > Privacy & " +
  "Security > Full Disk Access) and restart it. Granting it to Reminders.app does nothing — " +
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
      reason: facts.readable
        ? null
        : facts.exists
          ? `The store at ${opts.storePath} exists but cannot be read. ${FDA_HINT}`
          : `No file at ${opts.storePath}. APPLE_REMINDERS_STORE points at nothing.`,
    };
  }

  // The preferred subpath first, so the common case is one readdir rather than
  // a walk of the whole container.
  const preferredDir = join(containerPath, ...PREFERRED);
  const found = listDir(preferredDir)
    .filter((n) => n.endsWith(".sqlite"))
    .map((n) => join(preferredDir, n));
  const paths = found.length ? found : walk(containerPath, 0, []);

  const candidates: StoreCandidate[] = paths
    .map((p) => ({ ...describeStore(p), path: p }))
    .toSorted((a, b) => (b.size ?? 0) - (a.size ?? 0));

  // Largest readable file wins. Reminders keeps per-store containers, and a
  // stale or empty one can sit beside the real database — picking the first
  // entry readdir happens to return would be a coin flip between them.
  const chosen = candidates.find((c) => c.readable) ?? candidates[0] ?? null;

  // Distinguishing "cannot list" from "listed, found nothing" is the whole
  // point: the first is a permission problem, the second is a Reminders that
  // was never set up.
  const containerListable = paths.length > 0 || listDir(containerPath).length > 0;

  const reason = chosen
    ? chosen.readable
      ? null
      : `Found the Reminders store but cannot read it. ${FDA_HINT}`
    : containerListable
      ? `No .sqlite file under ${containerPath}. Has Reminders ever been set up on this account?`
      : `Cannot list ${containerPath}, so the store cannot even be located — its filename ` +
        `carries a generated UUID. ${FDA_HINT}`;

  const facts: StoreFacts = chosen
    ? {
        exists: chosen.exists,
        readable: chosen.readable,
        size: chosen.size,
        mtime: chosen.mtime,
        walPresent: chosen.walPresent,
        walSizeBytes: chosen.walSizeBytes,
      }
    : {
        exists: false,
        readable: false,
        size: null,
        mtime: null,
        walPresent: false,
        walSizeBytes: null,
      };

  return {
    ...facts,
    containerPath,
    storePath: chosen?.path ?? null,
    candidates,
    containerListable,
    reason,
  };
};
