import {
  AppNotRunningError,
  OsascriptTimeoutError,
  PlatformError,
  TccDeniedError,
} from "./errors.js";

/**
 * Batch writes that run one script per group (a mailbox, a calendar).
 *
 * Each group's script APPLIES before the next one starts, so a group that
 * throws cannot undo the ones before it. The loops used to let that throw
 * escape and drop every row already collected: the tool answered with a bare
 * error while earlier groups had been deleted, moved or flagged, and a caller
 * who believed it retried them. Settling per group keeps that record.
 *
 * What a throwing group's refs get depends on what the error says happened:
 *
 * - **A timeout** — the script may have run to completion after osascript gave
 *   up on it, so its refs are `ok: null`, counted in `unknown`: neither a
 *   success nor a failure anyone should retry blindly.
 * - **A surface-wide refusal** — no Automation grant, the app not running, not
 *   macOS — the same refusal awaits every later group, so the loop stops and
 *   the rest are `notAttempted`.
 * - **Anything else** is about that group (a mailbox that is gone, a calendar
 *   that is read-only): its refs are `ok: false` with the error's `code`, and
 *   the next group runs.
 *
 * When no group completed and none is unknown, nothing was applied and the
 * first error is rethrown, so a single-group failure stays the plain tool
 * error it always was.
 */

export type UnsettledRow =
  | { ref: string; ok: false; error: string; code: string }
  | { ref: string; ok: null; error: string }
  | { ref: string; ok: false; notAttempted: true; error: string };

export type SettledGroups<R> = {
  /** Every completed group's own rows, and one row per ref of any other. */
  rows: (R | UnsettledRow)[];
  /** Refs whose group timed out, so whether they were applied is not known. */
  unknown: number;
};

const surfaceWide = (err: unknown): boolean =>
  err instanceof TccDeniedError ||
  err instanceof AppNotRunningError ||
  err instanceof PlatformError;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The script's own error code when it reported one, else the error's class. */
const codeOf = (err: unknown): string => {
  const code = (err as { details?: { code?: unknown } } | null)?.details?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "UNKNOWN";
};

export const settleGroups = async <G, R>(
  groups: Iterable<G>,
  refsOf: (group: G) => readonly string[],
  run: (group: G) => Promise<R[]>,
): Promise<SettledGroups<R>> => {
  const pending = [...groups];
  const rows: (R | UnsettledRow)[] = [];
  let unknown = 0;
  let completed = 0;
  let firstError: { err: unknown } | null = null;

  for (const [i, group] of pending.entries()) {
    try {
      rows.push(...(await run(group)));
      completed += 1;
    } catch (err) {
      firstError ??= { err };
      const error = messageOf(err);
      const refs = refsOf(group);
      if (err instanceof OsascriptTimeoutError) {
        for (const ref of refs) rows.push({ ref, ok: null, error });
        unknown += refs.length;
        continue;
      }
      for (const ref of refs) rows.push({ ref, ok: false, error, code: codeOf(err) });
      if (surfaceWide(err)) {
        for (const rest of pending.slice(i + 1)) {
          for (const ref of refsOf(rest)) rows.push({ ref, ok: false, notAttempted: true, error });
        }
        break;
      }
    }
  }

  if (firstError && completed === 0 && unknown === 0) throw firstError.err;
  return { rows, unknown };
};
