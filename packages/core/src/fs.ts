import { accessSync, constants, statSync } from "node:fs";

/**
 * Facts about a TCC-protected file.
 *
 * The subtlety this exists to encode: `statSync` **succeeds** on a
 * TCC-protected file — you get the real size and mtime — and only `open(2)` and
 * `access(2)` are denied. Existence and readability are therefore different
 * questions, and only readability tells you whether Full Disk Access is
 * granted. "The file is there" is not evidence.
 */
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

export type StoreFacts = FileFacts & {
  /** Whether a `-wal` sits beside it, i.e. whether `immutable=1` COULD miss recent writes. */
  walPresent: boolean;
  walSizeBytes: number | null;
};

/**
 * Describe a SQLite store and its write-ahead log in one call.
 *
 * The WAL matters because `immutable=1` skips it, so a read can silently miss
 * whatever has not been checkpointed — which is precisely the recent data an
 * agent is usually asked about.
 */
export const describeStore = (path: string): StoreFacts => {
  const facts = inspectFile(path);
  const wal = inspectFile(`${path}-wal`);
  return { ...facts, walPresent: wal.exists, walSizeBytes: wal.size };
};
