import { homedir } from "node:os";
import { join } from "node:path";

import { describeStore, type StoreFacts } from "@mgcrea/mcp-apple-core";

/**
 * Find Messages' store.
 *
 * The easiest locator in the repo: `~/Library/Messages/chat.db` is a constant,
 * with no generated directory name to list (Reminders) and no per-account fan-out
 * (Contacts). `statSync` succeeds on a TCC-protected file while `open` is denied,
 * so this distinguishes "not there" from "not allowed" with no permission at all
 * — which is most of what diagnostics is for on a surface where the grant is
 * mandatory.
 */

export const STORE_RELATIVE = join("Library", "Messages", "chat.db");

/** Attachment bytes live here, referenced by `attachment.filename`. */
export const ATTACHMENTS_RELATIVE = join("Library", "Messages", "Attachments");

/**
 * The directory an attachment path is required to sit inside.
 *
 * Deliberately the Messages root rather than `Attachments` itself. Measured
 * shapes of `attachment.filename` include stickers, which Messages keeps in a
 * sibling directory, so confining to `Attachments` would refuse real files —
 * and confining to nothing at all would let a row in a database this server
 * does not write choose which file gets copied out.
 */
export const MESSAGES_ROOT_RELATIVE = join("Library", "Messages");

export type LocateResult = StoreFacts & {
  storePath: string;
  attachmentsPath: string;
  /** Nothing outside this is copied out, whatever the store says. */
  messagesRoot: string;
  reason: string | null;
};

export const defaultStorePath = (home: string = homedir()): string => join(home, STORE_RELATIVE);

const FDA_HINT =
  "Grant Full Disk Access to the app running this server (System Settings > Privacy & Security > " +
  "Full Disk Access) and restart it. Granting it to Messages.app does nothing — the reader needs " +
  "the permission. Unlike every other surface here, there is no Apple Events fallback: Messages " +
  "has no read path in its scripting dictionary at all, so without this grant there is no server.";

export const locateStore = (
  opts: { storePath?: string | undefined; home?: string } = {},
): LocateResult => {
  const home = opts.home ?? homedir();
  const storePath = opts.storePath ?? defaultStorePath(home);
  const facts = describeStore(storePath);

  return {
    ...facts,
    storePath,
    attachmentsPath: join(home, ATTACHMENTS_RELATIVE),
    messagesRoot: join(home, MESSAGES_ROOT_RELATIVE),
    reason: facts.readable
      ? null
      : facts.exists
        ? `Found the Messages store at ${storePath} but cannot read it. ${FDA_HINT}`
        : opts.storePath
          ? `No file at ${storePath}. APPLE_MESSAGES_STORE points at nothing.`
          : `No Messages store at ${storePath}. Has Messages ever been set up on this account?`,
  };
};
