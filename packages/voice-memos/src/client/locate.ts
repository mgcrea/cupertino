import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { describeStore, type StoreFacts } from "@mgcrea/mcp-apple-core";

/**
 * Find Voice Memos' store.
 *
 * `CloudRecordings.db` sits in the same directory as the audio, so the directory found here
 * is also the one every `ZPATH` is resolved against. The group container is where macOS 27
 * keeps it (measured); the legacy Application Support directory is where older releases are
 * believed to, and is tried second rather than assumed gone.
 *
 * Without Full Disk Access the group container is EPERM, not empty: `describeStore` keeps
 * "exists" and "readable" apart so those two never collapse into one answer.
 */

export const GROUP_RECORDINGS_DIR = [
  "Library",
  "Group Containers",
  "group.com.apple.VoiceMemos.shared",
  "Recordings",
];
export const LEGACY_RECORDINGS_DIR = [
  "Library",
  "Application Support",
  "com.apple.voicememos",
  "Recordings",
];
export const STORE_FILENAME = "CloudRecordings.db";

export const FDA_HINT =
  "Grant Full Disk Access to the app running this server (System Settings > Privacy & " +
  "Security > Full Disk Access) and restart it. Granting it to Voice Memos.app does nothing: " +
  "the reader needs the permission, not the app.";

export type LocateResult = StoreFacts & {
  /** The Recordings directory: the store's own, and the root every audio path is confined to. */
  directory: string;
  storePath: string;
  /** True when the store came from the legacy Application Support directory. */
  legacy: boolean;
  reason: string | null;
};

export const locateStore = (
  opts: { storePath?: string | undefined; home?: string | undefined } = {},
): LocateResult => {
  const home = opts.home ?? homedir();
  const group = join(home, ...GROUP_RECORDINGS_DIR, STORE_FILENAME);
  const legacyPath = join(home, ...LEGACY_RECORDINGS_DIR, STORE_FILENAME);

  let storePath = group;
  let legacy = false;
  if (opts.storePath) storePath = opts.storePath;
  else if (!describeStore(group).exists && describeStore(legacyPath).exists) {
    storePath = legacyPath;
    legacy = true;
  }

  const facts = describeStore(storePath);
  const reason = facts.readable
    ? null
    : facts.exists
      ? `Found Voice Memos' store at ${storePath} but cannot read it. ${FDA_HINT}`
      : opts.storePath
        ? `No file at ${opts.storePath}. APPLE_VOICE_MEMOS_STORE points at nothing.`
        : `No Voice Memos store at ${storePath}. Either Voice Memos has never been used on this ` +
          `account, or its directory is not readable: those look identical from outside and ` +
          `only the grant tells them apart. ${FDA_HINT}`;

  return { ...facts, directory: dirname(storePath), storePath, legacy, reason };
};
