import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describeStore, type StoreFacts } from "@mgcrea/mcp-apple-core";

/**
 * Find Contacts' stores — plural, which is the whole point of this file.
 *
 * Every other surface in this repo has one store. Contacts has one per account
 * plus a root database, and `docs/contacts.md` measured what that means:
 *
 *     AddressBook-v22.abcddb                       1 contact
 *     Sources/<uuid>/AddressBook-v22.abcddb      420 contacts
 *
 * The obvious path — the one at the top of the directory — is present, readable,
 * correctly shaped, and empty. A server that opens it gets a working database
 * with nobody in it, which fails no check and returns no answer. That is not a
 * hypothetical: `scripts/probe-contacts.mjs` did exactly this and reported a
 * confident 0% resolution rate before anyone noticed.
 *
 * So there is no "the" store here. Everything readable is opened and the rows
 * are unioned, and the number of sources is discovered rather than assumed —
 * one on the probed machine, more with Google or Exchange accounts.
 */

/** `~/Library/Application Support/AddressBook`. */
export const ADDRESSBOOK_DIR = join("Library", "Application Support", "AddressBook");

/** The per-account subdirectory. Each child holds one database. */
export const SOURCES_DIRNAME = "Sources";

/** Constant on every store, root and source alike. */
export const STORE_FILENAME = "AddressBook-v22.abcddb";

export type StoreCandidate = StoreFacts & {
  path: string;
  /** `root` for the top-level database, else the source directory name. */
  label: string;
};

export type LocateResult = {
  dirPath: string;
  dirListable: boolean;
  /** Every store-shaped file found, root first. */
  candidates: StoreCandidate[];
  /** The subset that can actually be opened. May be empty. */
  readable: StoreCandidate[];
  /** How many `Sources/*` directories were seen, readable or not. */
  sourceCount: number;
  reason: string | null;
};

export const defaultDirPath = (home: string = homedir()): string => join(home, ADDRESSBOOK_DIR);

/**
 * The grant hint.
 *
 * Deliberately NOT the Full Disk Access sentence the other surfaces use.
 * Contacts is protected by its own TCC service, and unlike Full Disk Access that
 * one prompts — so the likely fix is a dialog that was dismissed, and the
 * remedy names the Contacts pane rather than asking for the whole disk.
 */
const GRANT_HINT =
  "Contacts is protected by its own privacy permission, not by Full Disk Access. macOS asks for " +
  "it the first time something reads the address book; if that dialog was dismissed, re-enable " +
  "the app under System Settings > Privacy & Security > Contacts and restart it.";

const listDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

export const locateStores = (
  opts: { storePath?: string | undefined; home?: string } = {},
): LocateResult => {
  const dirPath = defaultDirPath(opts.home);

  // An explicit path is a bypass, for tests and forensic copies. No discovery,
  // and no union — the caller said which file it meant.
  if (opts.storePath) {
    const candidate: StoreCandidate = {
      ...describeStore(opts.storePath),
      path: opts.storePath,
      label: "explicit",
    };
    return {
      dirPath,
      dirListable: true,
      candidates: [candidate],
      readable: candidate.readable ? [candidate] : [],
      sourceCount: 0,
      reason: candidate.readable
        ? null
        : candidate.exists
          ? `The store at ${opts.storePath} exists but cannot be read. ${GRANT_HINT}`
          : `No file at ${opts.storePath}. APPLE_CONTACTS_STORE points at nothing.`,
    };
  }

  const rootPath = join(dirPath, STORE_FILENAME);
  const sourceNames = listDirs(join(dirPath, SOURCES_DIRNAME));

  const candidates: StoreCandidate[] = [
    { ...describeStore(rootPath), path: rootPath, label: "root" },
    ...sourceNames.map((name) => {
      const path = join(dirPath, SOURCES_DIRNAME, name, STORE_FILENAME);
      return { ...describeStore(path), path, label: name };
    }),
  ].filter((c) => c.exists);

  const readable = candidates.filter((c) => c.readable);

  // `dirListable` is the signal here, not a store's readability: the root file
  // can be statted without the grant, so "the file is there" proves nothing. If
  // the directory cannot be listed then the sources cannot even be enumerated,
  // and the sources are where the contacts are.
  const dirListable = listDirs(dirPath).length > 0 || sourceNames.length > 0;

  const reason = readable.length
    ? null
    : candidates.length
      ? `Found ${candidates.length} Contacts store(s) under ${dirPath} but none could be opened. ${GRANT_HINT}`
      : dirListable
        ? `No ${STORE_FILENAME} under ${dirPath}. Has Contacts ever been set up on this account?`
        : `${dirPath} could not be listed, so the per-account stores could not be found. ${GRANT_HINT}`;

  return { dirPath, dirListable, candidates, readable, sourceCount: sourceNames.length, reason };
};
