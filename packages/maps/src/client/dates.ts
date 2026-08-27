/**
 * Date handling for the Maps tools.
 *
 * Deliberately much smaller than `packages/safari/src/client/dates.ts`. That
 * surface needed a whole input grammar because history is a range query; Maps'
 * entities are lists a person curates, and v1 ships no tool taking a date
 * argument. So this module solves only the OUTPUT half — turning a stored
 * number into an instant. Inventing a parser nothing calls would be a fourth
 * copy of a grammar `packages/safari` has already noted should be hoisted into
 * core rather than duplicated again.
 *
 * ## The epoch is DETECTED, never assumed
 *
 * `docs/maps.md` records the measurement: `ZCREATETIME` resolves to
 * **apple-seconds** (Core Data, 2001 anchor). The same value read as unix
 * seconds lands in **1995** — well-formed, plausible at a glance, and wrong by
 * 31 years. `pnpm probe:maps` prints both readings side by side precisely
 * because the wrong one does not announce itself.
 *
 * So the offset is resolved from the store's own newest timestamp at open time,
 * and when it cannot be resolved every date renders `null` rather than being
 * guessed. An absent timestamp is a visible gap somebody can report; a
 * confidently wrong one is not. This is the discipline `packages/safari`
 * arrived at after a probe misread its own column — adopted here rather than
 * re-derived.
 */

import { CORE_DATA_EPOCH_OFFSET, detectEpoch } from "@mgcrea/mcp-apple-core";

export { CORE_DATA_EPOCH_OFFSET };

/**
 * How this store's timestamps map onto real time.
 *
 * `confident` is the field that matters. `detectEpoch` always returns an offset
 * — it falls back to unix when nothing fits — so the offset alone cannot
 * distinguish "measured as unix" from "gave up and assumed unix". Rendering the
 * second as though it were the first is the failure this module exists to
 * prevent, so the two are kept apart.
 */
export type Epoch = {
  offset: number;
  reason: string;
  confident: boolean;
};

/** What `detectEpoch` says when it has matched nothing. Same shape as Safari's. */
const GAVE_UP = /^(no dated rows|neither epoch)/;

export const resolveEpoch = (maxTimestamp: number | null, now: number = Date.now()): Epoch => {
  const { offset, reason } = detectEpoch(maxTimestamp, now);
  return { offset, reason, confident: !GAVE_UP.test(reason) };
};

/** The expectation docs/maps.md carries, used only where no store is open. */
export const APPLE_SECONDS: Epoch = {
  offset: CORE_DATA_EPOCH_OFFSET,
  reason: "assumed apple-seconds; no store was opened to measure against",
  confident: false,
};

/** A stored timestamp to a JS Date, or null when it cannot be placed. */
export const fromStoreTime = (value: number | null, epoch: Epoch): Date | null => {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  if (!epoch.confident) return null;
  const date = new Date((value + epoch.offset) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** ISO-8601, or null. What every date field on a result carries. */
export const renderInstant = (value: number | null, epoch: Epoch): string | null =>
  fromStoreTime(value, epoch)?.toISOString() ?? null;
