import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { describeStore, type StoreFacts } from "@mgcrea/mcp-apple-core";

/**
 * Find Notes' store.
 *
 * Simpler than Mail's, and measurably so: Mail's root is version-numbered
 * (`~/Library/Mail/V10`) *and* TCC-hidden, so it needs a four-branch strategy
 * ladder that asks Mail to name its own directory. Notes has one constant path,
 * confirmed on macOS 26.6.
 *
 * The path is TCC-protected, so `statSync` succeeds on it while `open` and
 * `access` are denied — existence and readability are different questions, and
 * only readability answers whether Full Disk Access is granted.
 */

/** `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`. */
export const GROUP_CONTAINER = "group.com.apple.notes";

export type LocateResult = StoreFacts & {
  storePath: string;
  /** Where attachment bytes live, one directory per account. */
  mediaRoot: string;
  reason: string | null;
};

export const defaultStorePath = (home: string = homedir()): string =>
  join(home, "Library", "Group Containers", GROUP_CONTAINER, "NoteStore.sqlite");

export const locateStore = (
  opts: { storePath?: string | undefined; home?: string } = {},
): LocateResult => {
  const storePath = opts.storePath ?? defaultStorePath(opts.home);
  const facts = describeStore(storePath);

  const reason = facts.exists
    ? facts.readable
      ? null
      : "NoteStore.sqlite exists but cannot be read. Grant Full Disk Access to the app running " +
        "this server (System Settings > Privacy & Security > Full Disk Access) and restart it. " +
        "Granting it to Notes.app does nothing — the reader needs the permission."
    : `No NoteStore.sqlite at ${storePath}. Has Notes ever been set up on this account?`;

  return { ...facts, storePath, mediaRoot: join(dirname(storePath), "Accounts"), reason };
};
