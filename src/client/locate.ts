import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Find Mail's data root and its Envelope Index.
 *
 * The obvious approach — glob `~/Library/Mail/V*` — does not work: that
 * directory is TCC-protected, so without Full Disk Access the glob returns
 * nothing even though the path is right there. Mail itself will hand us the
 * answer though: `account.accountDirectory()` returns
 * `~/Library/Mail/V10/<accountUuid>` over Apple Events, which need only the
 * Automation permission. So Mail naming its own directory is the primary
 * strategy and the glob is the fallback, not the other way round.
 *
 * A second subtlety, learned the same way: `statSync` SUCCEEDS on a
 * TCC-protected file — you get the real size and mtime — and only open(2) and
 * access(2) are denied. Existence and readability are therefore different
 * questions here, and only readability tells you whether FDA is granted.
 */

export type LocateResult = {
  /** e.g. /Users/me/Library/Mail/V10 */
  mailRoot: string | null;
  /** e.g. V10 */
  dataVersion: string | null;
  envelopeIndexPath: string | null;
  /** How mailRoot was decided — reported by diagnostics so a bug report is self-describing. */
  strategy: "config" | "accountDirectory" | "glob" | "none";
  exists: boolean;
  readable: boolean;
  sizeBytes: number | null;
  mtime: string | null;
  /** Whether a -wal file is present, i.e. whether `immutable=1` would hide recent mail. */
  walPresent: boolean;
  walSizeBytes: number | null;
  reason: string | null;
};

export type FileFacts = {
  exists: boolean;
  readable: boolean;
  size: number | null;
  mtime: string | null;
};

export const inspectFile = (path: string): FileFacts => {
  let size: number | null = null;
  let mtime: string | null = null;
  try {
    const st = statSync(path);
    size = st.size;
    mtime = st.mtime.toISOString();
  } catch {
    return { exists: false, readable: false, size: null, mtime: null };
  }
  let readable = false;
  try {
    accessSync(path, constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  return { exists: true, readable, size, mtime };
};

export type LocateOptions = {
  /** Explicit index path from config — wins outright. */
  envelopeIndexPath?: string | undefined;
  /** Explicit Mail root from config. */
  mailRoot?: string | undefined;
  /** Any account directory reported by Mail, e.g. ~/Library/Mail/V10/<uuid>. */
  accountDirectory?: string | undefined;
  /** Injectable for tests. */
  home?: string | undefined;
};

const INDEX_SUFFIX = join("MailData", "Envelope Index");

const highestVersionDir = (mailHome: string): string | null => {
  try {
    const versions = readdirSync(mailHome)
      .filter((d) => /^V\d+$/.test(d))
      .toSorted((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    return versions[0] ?? null;
  } catch {
    // Almost always EPERM without Full Disk Access — not "Mail isn't installed".
    return null;
  }
};

export const locateEnvelopeIndex = (opts: LocateOptions = {}): LocateResult => {
  const home = opts.home ?? homedir();

  let mailRoot: string | null = null;
  let indexPath: string | null = null;
  let strategy: LocateResult["strategy"] = "none";

  if (opts.envelopeIndexPath) {
    indexPath = opts.envelopeIndexPath;
    mailRoot = dirname(dirname(indexPath));
    strategy = "config";
  } else if (opts.mailRoot) {
    mailRoot = opts.mailRoot;
    indexPath = join(mailRoot, INDEX_SUFFIX);
    strategy = "config";
  } else if (opts.accountDirectory) {
    mailRoot = dirname(opts.accountDirectory);
    indexPath = join(mailRoot, INDEX_SUFFIX);
    strategy = "accountDirectory";
  } else {
    const mailHome = join(home, "Library", "Mail");
    const v = highestVersionDir(mailHome);
    if (v) {
      mailRoot = join(mailHome, v);
      indexPath = join(mailRoot, INDEX_SUFFIX);
      strategy = "glob";
    }
  }

  if (!indexPath || !mailRoot) {
    return {
      mailRoot: null,
      dataVersion: null,
      envelopeIndexPath: null,
      strategy: "none",
      exists: false,
      readable: false,
      sizeBytes: null,
      mtime: null,
      walPresent: false,
      walSizeBytes: null,
      reason:
        "Could not locate Mail's data directory. Mail did not report an account directory and " +
        "~/Library/Mail could not be listed (expected without Full Disk Access).",
    };
  }

  const facts = inspectFile(indexPath);
  const wal = inspectFile(`${indexPath}-wal`);

  const reason = facts.exists
    ? facts.readable
      ? null
      : "The Envelope Index exists but cannot be read. Grant Full Disk Access to the app running " +
        "this server (System Settings > Privacy & Security > Full Disk Access) and restart it. " +
        "Granting it to Mail.app does nothing — the reader needs the permission."
    : `No Envelope Index at ${indexPath}. Has Mail ever been set up on this account?`;

  return {
    mailRoot,
    dataVersion: /\/(V\d+)$/.exec(mailRoot)?.[1] ?? null,
    envelopeIndexPath: indexPath,
    strategy,
    exists: facts.exists,
    readable: facts.readable,
    sizeBytes: facts.size,
    mtime: facts.mtime,
    walPresent: wal.exists,
    walSizeBytes: wal.size,
    reason,
  };
};
