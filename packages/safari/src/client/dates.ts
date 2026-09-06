/**
 * Date handling for the Safari tools.
 *
 * ## Two halves, and the second one is the interesting one
 *
 * INPUT reuses the grammar `packages/reminders/src/client/dates.ts` established
 * and `packages/calendar` repeated, deliberately unchanged where it overlaps: an
 * ISO date names a day, an ISO date-time names an instant, day and week offsets
 * are calendar arithmetic while hour and minute offsets are elapsed time. That
 * last split is not cosmetic — reversing it drifts every bound by an hour twice
 * a year.
 *
 * It differs in one respect, because this surface points the other way. Every
 * other surface here is about the future: a reminder is due, an event is
 * scheduled. **History is only ever the past**, so the grammar accepts a
 * NEGATIVE offset (`-7d`) and the words `yesterday` and `last monday`, and
 * `parseRange` defaults to a window that ends now and reaches backwards. A
 * caller asking for "the last week" should not have to write it as a
 * subtraction from a date it has to compute first.
 *
 * (This is now the third copy of the grammar. Reminders' comment declined to
 * hoist it into `packages/core` on the grounds that two consumers with
 * different output types were not enough evidence for a shared abstraction.
 * Three is arguably the trigger, and the three have since diverged in exactly
 * the way that makes hoisting harder. Recorded here rather than done here:
 * refactoring two shipped surfaces is not part of adding a third.)
 *
 * ## OUTPUT: the epoch is DETECTED, never assumed
 *
 * This is the part that is specific to Safari, and it exists because of a
 * measured near-miss. docs/safari.md records that the first granted probe run
 * reported `visit_time` as apple-NANOseconds. That was wrong — a probe bug, in
 * which a plausibility window accepted a degenerate reading anchored at 2001 —
 * and the corrected expectation is apple-seconds. See docs/calendar.md for the
 * full account.
 *
 * The lesson is not "hardcode the corrected value". A wrong epoch produces
 * dates that are perfectly well-formed and wrong by 31 years, which no test on
 * synthetic data can catch and no reader notices until something important
 * turns out to have been visited in 1995. So the offset is resolved from the
 * store's own data at open time, and when it cannot be resolved the dates are
 * WITHHELD rather than guessed. An absent timestamp is a visible gap somebody
 * can report; a confident wrong one is not.
 */

import { CORE_DATA_EPOCH_OFFSET, detectEpoch } from "@mgcrea/mcp-apple-core";

export { CORE_DATA_EPOCH_OFFSET };

/**
 * How this store's timestamps map onto real time.
 *
 * `confident` is the field that matters. `detectEpoch` always returns an
 * offset — it falls back to unix when nothing fits — so the offset alone cannot
 * distinguish "measured as unix" from "gave up and assumed unix". Rendering the
 * second as though it were the first is the exact failure this module is built
 * around, so the two are kept apart.
 */
export type Epoch = {
  offset: number;
  reason: string;
  confident: boolean;
};

/** What `detectEpoch` says when it has matched nothing. */
const GAVE_UP = /^(no dated rows|neither epoch)/;

/**
 * Decide the epoch from the largest timestamp in the store.
 *
 * @param maxTimestamp The maximum `visit_time`, or null when there are no rows.
 */
export const resolveEpoch = (maxTimestamp: number | null, now: number = Date.now()): Epoch => {
  const { offset, reason } = detectEpoch(maxTimestamp, now);
  return { offset, reason, confident: !GAVE_UP.test(reason) };
};

/** The expectation docs/safari.md carries, used only where no store is open. */
export const APPLE_SECONDS: Epoch = {
  offset: CORE_DATA_EPOCH_OFFSET,
  reason: "assumed apple-seconds; no store was opened to measure against",
  confident: false,
};

/** A stored timestamp to a JS Date, or null when it cannot be placed. */
export const fromStoreTime = (value: number | null, epoch: Epoch): Date | null => {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  if (!epoch.confident) return null;
  const ms = (value + epoch.offset) * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** A JS Date to the store's own units, for range bounds. */
export const toStoreTime = (date: Date, epoch: Epoch): number =>
  date.getTime() / 1000 - epoch.offset;

/** ISO-8601, or null. What every date field on a result carries. */
export const renderInstant = (value: number | null, epoch: Epoch): string | null =>
  fromStoreTime(value, epoch)?.toISOString() ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// Input grammar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The input grammar comes from core now.
 *
 * This file's own header used to say the hoist was overdue and declined to do
 * it — "refactoring two shipped surfaces is not part of adding a third". It has
 * since been done, and this surface's superset (signed offsets, `yesterday`,
 * `last monday`) is what core adopted, because history only ever points
 * backwards and a grammar that differs per surface is the drift being removed.
 *
 * One change came back with it: a bare day used as an upper bound is the NEXT
 * day's midnight, so `store.ts` compares `visit_time < ?` rather than `<=`.
 */
export {
  addLocalDays,
  parseBound,
  parseDate,
  startOfLocalDay,
  toLocalIso,
  type DateKind,
  type ParsedDate,
} from "@mgcrea/mcp-apple-core";

import {
  addLocalDays,
  InvalidDateError,
  parseBound,
  startOfLocalDay,
  toLocalIso,
} from "@mgcrea/mcp-apple-core";

export type Range = { from: Date; to: Date; clamped: boolean };

/**
 * Resolve a query window over history.
 *
 * Backwards by default, which is the difference from Calendar's version. A
 * browser history has a natural "now" edge and stretches indefinitely into the
 * past, so an omitted `to` means this moment and an omitted `from` means
 * `defaultRangeDays` before it. Calendar defaults forward for the mirror-image
 * reason.
 *
 * `clamped` is reported rather than silently applied: a caller that asked for a
 * decade and received a year needs to know the answer is partial, or it will
 * read an empty tail as an absence of browsing.
 */
export const parseRange = (
  opts: {
    from?: string | undefined;
    to?: string | undefined;
    defaultRangeDays: number;
    maxRangeDays: number;
  },
  now: Date = new Date(),
): Range => {
  const to = opts.to ? parseBound("to", opts.to, "end", now) : now;
  const from = opts.from
    ? parseBound("from", opts.from, "start", now)
    : startOfLocalDay(addLocalDays(to, -(opts.defaultRangeDays - 1)));

  if (to.getTime() < from.getTime()) {
    throw new InvalidDateError(
      "to",
      String(opts.to ?? ""),
      `it resolves to ${toLocalIso(to)}, which is before from (${toLocalIso(from)})`,
    );
  }

  const maxMs = opts.maxRangeDays * 86_400_000;
  if (to.getTime() - from.getTime() > maxMs) {
    // Keep the RECENT edge and move the far one. A history query that is too
    // wide almost always wants the newest rows, and truncating the other way
    // would answer "what did I read this week" with results from last year.
    return { from: new Date(to.getTime() - maxMs), to, clamped: true };
  }
  return { from, to, clamped: false };
};
