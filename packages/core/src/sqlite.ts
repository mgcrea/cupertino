import { DatabaseSync } from "node:sqlite";

import { IndexUnavailableError } from "./errors.js";

/**
 * Read-only access to a store some Apple app owns.
 *
 * Two rules, both load-bearing:
 *
 * 1. **Never write.** The app owns the database, holds it open, and reconciles
 *    it against a server. `PRAGMA query_only` makes that structural rather than
 *    a matter of everyone remembering.
 * 2. **Prefer `mode=ro` over `immutable=1`.** `immutable=1` tells SQLite the
 *    file cannot change and to skip the `-wal` entirely — so a read silently
 *    misses anything not yet checkpointed. Measured on a live Mail index: the
 *    two modes reported 181427 and 181426 messages minutes after reporting the
 *    same number, the difference being one newly-arrived mail. It is a race you
 *    lose intermittently and without any error, which is the worst kind.
 */
export type ReadOnlyMode = "auto" | "ro" | "immutable" | "off";

export type OpenedStore<T = undefined> = {
  db: DatabaseSync;
  /** Which mode actually opened. `immutable` results are WAL-blind — say so. */
  mode: "ro" | "immutable";
  /** Whatever `validate` returned, so a capability probe is not run twice. */
  validated: T;
};

/**
 * SQLite URI filenames need percent-encoding, and Mail's path contains a space
 * ("Envelope Index"). `?` and `#` would otherwise be read as URI syntax.
 */
export const toFileUri = (path: string, query: string): string =>
  `file:${encodeURI(path).replaceAll("?", "%3f").replaceAll("#", "%23")}?${query}`;

/** Escape LIKE wildcards so a value containing % or _ searches literally. */
export const escapeLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export type OpenOptions<T> = {
  /** Named in the error when `mode` is "off", so the message says how to re-enable. */
  envVar?: string | undefined;
  /** What the store is, for the failure message, e.g. "Mail's search index". */
  label?: string | undefined;
  /** Appended to the failure message — typically how to grant the missing permission. */
  hint?: string | undefined;
  /**
   * Runs on every attempt; throwing rejects that attempt and tries the next
   * mode. Validating *inside* the ladder rather than after it matters: a store
   * that opens but is unusable should fall through, not be returned.
   */
  validate?: ((db: DatabaseSync) => T) | undefined;
  /**
   * Errors that no other open mode could fix, so the ladder aborts instead of
   * masking them behind a generic "could not open".
   */
  fatal?: ((err: unknown) => boolean) | undefined;
  /** Called when the WAL-blind fallback is what actually opened. */
  onFallback?: (() => void) | undefined;
};

export const openReadOnly = <T = undefined>(
  path: string,
  mode: ReadOnlyMode,
  opts: OpenOptions<T> = {},
): OpenedStore<T> => {
  if (mode === "off") {
    throw new IndexUnavailableError(
      `The index lane is disabled${opts.envVar ? ` (${opts.envVar}=off)` : ""}.`,
    );
  }

  const attempts: ("ro" | "immutable")[] =
    mode === "auto" ? ["ro", "immutable"] : [mode === "ro" ? "ro" : "immutable"];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const uri = toFileUri(path, attempt === "ro" ? "mode=ro" : "immutable=1");
      const db = new DatabaseSync(uri, { readOnly: true, allowExtension: false });
      // Belt and braces: no caller can issue DML even by accident.
      db.exec("PRAGMA query_only = 1");
      const validated = opts.validate?.(db) as T;
      if (attempt === "immutable") opts.onFallback?.();
      return { db, mode: attempt, validated };
    } catch (err) {
      if (opts.fatal?.(err)) throw err;
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new IndexUnavailableError(
    `Could not open ${opts.label ?? path} at ${path}: ${message}.${opts.hint ? ` ${opts.hint}` : ""}`,
  );
};
