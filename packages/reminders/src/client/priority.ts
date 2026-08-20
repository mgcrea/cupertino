/**
 * Reminder priority, which is a range on the wire and a set of buttons in the UI.
 *
 * The scripting dictionary documents the encoding exactly:
 *
 *     priority — 0: no priority, 1–4: high, 5: medium, 6–9: low
 *
 * Two things follow, and naive implementations get both wrong.
 *
 * **Reading is a bucket, not a lookup.** The range exists because Reminders
 * shares this field with CalDAV, where any 1–9 is legal. A reminder synced from
 * another client can arrive as priority 3, and a `switch` over {0,1,5,9} would
 * report it as unknown — or, worse, fall through to "none" and show an urgent
 * item as unflagged.
 *
 * **Writing is a choice of representative.** The UI offers four buttons, so
 * each bucket needs one canonical value. These match what Reminders itself
 * writes, which keeps a round trip through this server from silently rewriting
 * a value the app would have left alone.
 *
 * Note the inversion: a *lower* number is a *higher* priority. Sorting by the
 * raw field ascending puts "none" (0) first, ahead of high (1) — so ordering by
 * urgency needs `rank`, not the raw value.
 */

/** What the tools accept and return. */
export type PriorityName = "none" | "low" | "medium" | "high";

export const PRIORITY_NAMES: readonly PriorityName[] = ["none", "low", "medium", "high"];

/** The value Reminders.app itself writes for each bucket. */
const CANONICAL: Record<PriorityName, number> = { none: 0, high: 1, medium: 5, low: 9 };

/** Name → wire value, for writes. */
export const toPriorityValue = (name: PriorityName): number => CANONICAL[name];

/**
 * Wire value → name, for reads. Buckets the whole legal range, so a value
 * written by another CalDAV client is still classified rather than dropped.
 */
export const toPriorityName = (value: number | null | undefined): PriorityName => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "none";
  const n = Math.trunc(value);
  if (n <= 0) return "none";
  if (n <= 4) return "high";
  if (n === 5) return "medium";
  if (n <= 9) return "low";
  // Out of the documented range. Something is set, and "none" would be a lie.
  return "low";
};

/**
 * Sort key, ascending = most urgent first, with "none" last.
 *
 * The raw field cannot be used for this: 0 means "no priority" but sorts ahead
 * of 1, which means "high".
 */
export const rank = (value: number | null | undefined): number => {
  const name = toPriorityName(value);
  return name === "none" ? Number.MAX_SAFE_INTEGER : CANONICAL[name];
};
