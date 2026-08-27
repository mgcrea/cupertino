import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  describeStore,
  inspectFile,
  type FileFacts,
  type StoreFacts,
} from "@mgcrea/mcp-apple-core";

/**
 * Find Maps' store.
 *
 * ## The path, and the three ways it was missed
 *
 * `~/Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1` — 3.3 MB of
 * Core Data on the probed machine. `docs/maps.md` records that this surface was
 * declared "no file lane" three separate times before the file was found, and
 * each failure is a rule this locator is shaped by:
 *
 *   1. **The file has no extension.** A sweep for `*.db` / `*.sqlite*` finds
 *      nothing here. Nothing in this file matches on a suffix.
 *   2. **`Data/Maps/` is gated.** It was the ONE unreadable directory in the
 *      container, so a listing taken without Full Disk Access omits it, and the
 *      omission reads as absence. `inspectFile` splits exists from readable
 *      precisely so those two never collapse into one answer.
 *   3. **`group.com.apple.Maps` is a decoy.** It exists, it is EPERM without the
 *      grant, and it holds three files that are not the store. A probe that
 *      could not descend into it reported it as empty.
 *
 * The rule underneath all three is the one `docs/surfaces.md` states: "'Absent'
 * and 'EPERM' are different findings." Keeping them apart, and saying which one
 * happened, is most of this module's job.
 *
 * ## The device-local cache is located and never read
 *
 * `MapsSync_0.0.1_deviceLocalCache.db` sits beside the store with the same 33
 * entities and, on the probed machine, **zero rows in every one of them**. It is
 * reported by diagnostics so anyone comparing the directory against this
 * server's output can see it was considered, and it is never opened.
 */

/** The container path. `Data/Maps` is the gated directory, not `Data/Library`. */
export const MAPS_DIR = ["Library", "Containers", "com.apple.Maps", "Data", "Maps"];

/**
 * No extension, and a version in the name.
 *
 * The `0.0.1` was stable on every machine this project has measured, but it is a
 * version string and it will move. `locateStore` falls back to scanning for a
 * `MapsSync_*` sibling rather than reporting a rename as "Maps has never run".
 */
export const STORE_FILENAME = "MapsSync_0.0.1";
export const STORE_PREFIX = "MapsSync_";
export const LOCAL_CACHE_SUFFIX = "_deviceLocalCache.db";

export const FDA_HINT =
  "Grant Full Disk Access to the app running this server (System Settings > Privacy & " +
  "Security > Full Disk Access) and restart it. Granting it to Maps.app does nothing — the " +
  "reader needs the permission, not the app.";

export type LocatedFile = FileFacts & { path: string };

export type LocateResult = StoreFacts & {
  directory: string;
  storePath: string | null;
  /** Reported so a reader can see it was considered. Never opened. */
  localCache: LocatedFile;
  /** True when the name came from a directory scan rather than the constant. */
  resolvedByScan: boolean;
  reason: string | null;
};

export const defaultDirectory = (home: string = homedir()): string => join(home, ...MAPS_DIR);

export const defaultStorePath = (home: string = homedir()): string =>
  join(defaultDirectory(home), STORE_FILENAME);

const locateFile = (path: string): LocatedFile => ({ ...inspectFile(path), path });

/**
 * Look for a `MapsSync_*` that is neither the local cache nor a SQLite sidecar.
 *
 * Only reached when the constant path is absent, and it needs the directory to
 * be listable — the same grant the store itself needs, so this asks for no new
 * permission and simply survives a version bump.
 */
const scanForStore = (directory: string, readdir: (p: string) => string[]): string | null => {
  let names: string[];
  try {
    names = readdir(directory);
  } catch {
    return null;
  }
  const candidate = names
    .filter(
      (n) =>
        n.startsWith(STORE_PREFIX) &&
        !n.endsWith(LOCAL_CACHE_SUFFIX) &&
        !n.endsWith("-wal") &&
        !n.endsWith("-shm"),
    )
    .toSorted()
    .at(-1);
  return candidate ? join(directory, candidate) : null;
};

export const locateStore = (
  opts: {
    storePath?: string | undefined;
    home?: string;
    /** Injected by tests so a scan never reaches a real directory. */
    readdir?: (path: string) => string[];
  } = {},
): LocateResult => {
  const directory = defaultDirectory(opts.home);
  const readdir = opts.readdir ?? ((p: string): string[] => readdirSync(p));

  const explicit = opts.storePath;
  const constant = defaultStorePath(opts.home);

  let storePath = explicit ?? constant;
  let resolvedByScan = false;

  if (!explicit && !describeStore(constant).exists) {
    const scanned = scanForStore(directory, readdir);
    if (scanned) {
      storePath = scanned;
      resolvedByScan = true;
    }
  }

  const facts = describeStore(storePath);

  const reason = facts.readable
    ? null
    : facts.exists
      ? `Found Maps' store at ${storePath} but cannot read it. ${FDA_HINT}`
      : explicit
        ? `No file at ${explicit}. APPLE_MAPS_STORE points at nothing.`
        : `No Maps store at ${storePath}, and no MapsSync_* file in ${directory}. Either Maps ` +
          `has never been used on this account, or the directory itself is not readable — those ` +
          `look identical from outside and only the grant tells them apart. ${FDA_HINT}`;

  return {
    ...facts,
    directory,
    storePath: facts.exists || !explicit ? storePath : null,
    localCache: locateFile(`${constant}${LOCAL_CACHE_SUFFIX}`),
    resolvedByScan,
    reason,
  };
};
