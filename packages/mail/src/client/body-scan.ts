import { readEmlxBodyText } from "./emlx.js";

/**
 * Body search, without an index.
 *
 * There is no index to use. The Envelope Index carries no FTS table, and the
 * Spotlight volume index does not reach `~/Library` at all — the whole tree is
 * excluded, so `mdfind` returns nothing there however the query is phrased.
 * Mail's own body search runs on CoreSpotlight donations, which are queried
 * through `CSSearchQuery` by the app that donated them and are not reachable
 * from here. docs/mail-body.md has the measurements.
 *
 * What is left is the shape this file implements: let the Envelope Index narrow
 * the query — mailbox, account, sender, date range, flags, all of which it
 * answers in milliseconds — then read the bodies of the survivors and match
 * them in memory.
 *
 * THE COST IS LINEAR IN SURVIVORS, AND THAT IS THE WHOLE DESIGN. Measured at
 * 0.48 ms per message warm on a 181,734-message store:
 *
 *     100 candidates      48 ms      a tight filter
 *     500 candidates     242 ms
 *   1,932 candidates     933 ms      90 days of the busiest mailbox
 *   6,566 candidates     3.2 s       90 days, every mailbox
 * 182,329 candidates      88 s       no filter at all — unusable
 *
 * So a bound is not optional. The one thing this must never do is scan a
 * truncated prefix and return what it found: answering "not found" from a
 * partial scan is indistinguishable from a real absence, and the model has no
 * way to tell. Over the bound this refuses and says so, with the numbers, so
 * the caller can narrow the filter or raise the ceiling deliberately.
 */

export type BodyScanOutcome =
  | {
      status: "ok";
      /** Rowids whose body matched, in the order the index returned them. */
      matched: number[];
      candidates: number;
      scanned: number;
      /** Candidates whose file could not be read — no grant, or no message file. */
      unreadable: number;
      elapsedMs: number;
    }
  | {
      status: "over-bound";
      candidates: number;
      bound: number;
    };

export type BodyScanOptions = {
  /** Candidate rowids, already narrowed by the index. */
  candidates: number[];
  term: string;
  bound: number;
  maxBytes: number;
  /** Resolve a rowid to a message file. Returns null when there is no file. */
  locate: (rowid: number) => string | null;
};

/**
 * Case-insensitive substring, matching what `search_messages` already does for
 * subject and sender via SQL `LIKE`. Not tokenised, not stemmed: a body search
 * that quietly stemmed while the subject search did not would make one tool
 * behave two ways depending on which field matched.
 */
const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle);

export const scanBodies = (opts: BodyScanOptions): BodyScanOutcome => {
  if (opts.candidates.length > opts.bound) {
    return { status: "over-bound", candidates: opts.candidates.length, bound: opts.bound };
  }

  const started = performance.now();
  const needle = opts.term.toLowerCase();
  const matched: number[] = [];
  let unreadable = 0;
  let scanned = 0;

  for (const rowid of opts.candidates) {
    const path = opts.locate(rowid);
    if (!path) {
      unreadable += 1;
      continue;
    }
    const text = readEmlxBodyText(path, { maxBytes: opts.maxBytes });
    if (text === null) {
      unreadable += 1;
      continue;
    }
    scanned += 1;
    if (matches(text, needle)) matched.push(rowid);
  }

  return {
    status: "ok",
    matched,
    candidates: opts.candidates.length,
    scanned,
    unreadable,
    elapsedMs: Math.round(performance.now() - started),
  };
};
