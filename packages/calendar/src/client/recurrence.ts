/**
 * Merging the two legs of a range query, and saying honestly what the result
 * does not cover.
 *
 * ## Why this is its own module
 *
 * It is the piece most likely to be rewritten. `store.ts` knows how to ask the
 * database questions; this file encodes what the answers MEAN, and that meaning
 * rests on measurements (`docs/calendar.md`) rather than on documentation Apple
 * publishes. Keeping it separate means a future correction swaps this file
 * rather than picking through SQL.
 *
 * ## Why a merge is needed at all
 *
 * Measured: `OccurrenceCache` holds 489 distinct parents, of which **456 carry
 * no recurrence rule**. So the cache is not "the repeating events" — it holds
 * plain one-shot events too, and a naive union of "items" and "occurrences"
 * double-counts most of an ordinary calendar. Dedupe here is load-bearing, not
 * defensive.
 *
 * ## Why the coverage edge is published rather than hidden
 *
 * The cache reaches about two years either side of today on the probed store,
 * which is a real expansion rather than a month-view cache. It is still an edge.
 * A query running past it gets fewer repeating events than it should, and a
 * short list of events is indistinguishable from a free afternoon — the quietest
 * possible failure on this surface. So the edge travels with the result.
 */

import type { Coverage, EventRow } from "./store.js";

export type Truncation = {
  reason: string;
  /** Apple-seconds. The part of the requested window the expansion cannot cover. */
  uncoveredFromApple?: number;
  uncoveredToApple?: number;
  affects: string;
};

export type ExpansionState = "expanded" | "unavailable";

export type MergedRange = {
  rows: EventRow[];
  expansion: ExpansionState;
  /** Present when the expansion could not run at all. */
  expansionReason?: string;
  coverage: Coverage;
  truncated?: Truncation;
  /** Rows dropped for having no usable start. Counted rather than silently lost. */
  dropped: number;
};

/**
 * Identity for deduping.
 *
 * `(uuid, start instant)` rather than uuid alone: two occurrences of the same
 * series are the same event at different times, and collapsing them by uuid
 * would return a weekly meeting once — the exact bug the two-leg design exists
 * to avoid.
 */
const keyOf = (r: EventRow): string => `${String(r.uuid).toUpperCase()}|${r.startApple}`;

/**
 * The identity of the occurrence a detached row REPLACES.
 *
 * When someone drags one instance of a series to a new time, Calendar writes a
 * detached `CalendarItem` carrying `orig_item_id` (the series) and `orig_date`
 * (the slot it came from). The stale cache row for that slot may still exist, so
 * keying on `(uuid, start)` alone will not catch it: the instants differ, which
 * is the entire point of the move.
 */
const replacedKeyOf = (r: EventRow): string | null =>
  r.origItemPk !== null && r.origDateApple !== null ? `${r.origItemPk}|${r.origDateApple}` : null;

const occurrenceSlotOf = (r: EventRow): string => `${r.itemPk}|${r.startApple}`;

export const mergeRange = (opts: {
  items: EventRow[];
  occurrences: EventRow[];
  coverage: Coverage;
  hasOccurrenceCache: boolean;
  /** Why the expansion is missing, when it is. */
  unavailableReason?: string;
  fromApple: number;
  toApple: number;
  limit: number;
}): MergedRange => {
  const seen = new Set<string>();
  const out: EventRow[] = [];
  let dropped = 0;

  // Every slot a detached row has taken over. Built before anything is emitted,
  // because a cache row can be visited before the item that supersedes it.
  const replaced = new Set<string>();
  for (const r of opts.items) {
    const k = replacedKeyOf(r);
    if (k) replaced.add(k);
  }

  // Items first: leg 1 WINS on collision. A detached row is the user's edited
  // version, and the cache row for the same slot may predate the edit.
  for (const r of [...opts.items, ...opts.occurrences]) {
    if (r.startApple === null) {
      dropped += 1;
      continue;
    }
    if (r.source === "occurrence" && replaced.has(occurrenceSlotOf(r))) continue;
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }

  out.sort((a, b) => (a.startApple ?? 0) - (b.startApple ?? 0));

  const merged: MergedRange = {
    rows: out.slice(0, opts.limit),
    expansion: opts.hasOccurrenceCache ? "expanded" : "unavailable",
    coverage: opts.coverage,
    dropped,
  };

  if (!opts.hasOccurrenceCache) {
    merged.expansionReason =
      opts.unavailableReason ??
      "this store has no OccurrenceCache table, so occurrences of repeating events are not " +
        "expanded; each repeating event appears once, at its series start";
    return merged;
  }

  const cov = opts.coverage;
  if (cov) {
    const past = opts.fromApple < cov.fromApple;
    const future = opts.toApple > cov.toApple;
    if (past || future) {
      merged.truncated = {
        reason:
          "the requested window extends past the range the store has expanded, so repeating " +
          "events outside it are missing from this result",
        ...(past ? { uncoveredFromApple: opts.fromApple } : {}),
        ...(future ? { uncoveredToApple: opts.toApple } : {}),
        affects: "repeating events only — single events are correct at any distance",
      };
    }
  }

  return merged;
};
