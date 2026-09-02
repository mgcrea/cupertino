import { z } from "zod";

/**
 * Projection and aggregation for the read-only `*_query` tools.
 *
 * These exist to keep answers out of the context window that a model would
 * otherwise have to derive by reading rows. "Who emailed me most in June" is
 * one grouped table here; through a plain search it is two hundred message
 * summaries the model has to tally itself, and it pays for every subject,
 * recipient list and flag on the way.
 *
 * Nothing here builds SQL. Callers pass a field name that their surface has
 * already matched against its own allowlist, and the surface maps it to a
 * column expression. A caller's string never reaches a query.
 */

export const selectArg = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    "Keep only these fields on each row. Omit for the full row. Naming the two or three " +
      "fields you actually need is the cheapest way to shrink a large result.",
  );

/**
 * Build the `groupBy` arg from the fields a surface can actually group on.
 *
 * Taken as a parameter rather than fixed here because the sensible groupings
 * differ per surface — mail groups by sender, a calendar by day.
 */
export const groupByArg = <const F extends readonly [string, ...string[]]>(fields: F, note = "") =>
  z
    .enum(fields)
    .optional()
    .describe(
      `Aggregate instead of returning rows: count matches per ${fields.join(", ")}. ` +
        "Grouping runs over every match, not just the first `limit` of them — `limit` then " +
        `caps how many groups come back, ordered by descending count.${note ? ` ${note}` : ""}`,
    );

export type Bucket = {
  /** The grouped value. Null when the underlying field is null (no sender, etc.). */
  key: string | null;
  /** A display form of `key` where one exists — a sender's name, a mailbox's title. */
  label?: string | null;
  count: number;
} & Record<string, unknown>;

export type Aggregation = {
  groupedBy: string;
  groups: Bucket[];
  /** How many distinct groups matched, before `limit` cut the list. */
  totalGroups: number;
  /** How many underlying rows were aggregated. NOT capped by `limit`. */
  totalRows: number;
  /** True when `totalGroups` exceeded `limit`, so `groups` is a top-N. */
  truncated: boolean;
};

/**
 * Assemble the aggregation envelope.
 *
 * Thin on purpose, but it is the one place `truncated` is computed and the one
 * guarantee that `totalRows` is always reported. A grouped result that omits
 * `totalRows` reads as complete whether or not it is, which is the failure this
 * whole shape exists to prevent: a top-N over a truncated page is a confidently
 * wrong answer, and it looks exactly like a right one.
 */
export const describeAggregation = (
  groupedBy: string,
  groups: Bucket[],
  totals: { totalGroups: number; totalRows: number },
): Aggregation => ({
  groupedBy,
  groups,
  totalGroups: totals.totalGroups,
  totalRows: totals.totalRows,
  truncated: totals.totalGroups > groups.length,
});

export type Projected<T> = {
  rows: Partial<T>[];
  /**
   * Field names the caller asked for that this surface does not have. Reported
   * rather than dropped: a silent drop looks identical to "that field was null
   * on every row", and a model has no way to tell the two apart.
   */
  unknownFields?: string[];
};

/**
 * Keep only the named fields on each row.
 *
 * `known` is passed explicitly rather than read off the rows because an empty
 * result still has to be able to say a field name was wrong — deriving the key
 * set from the rows would report nothing at all on the case where a typo is
 * most likely to be the reason the result is empty.
 */
export const project = <T extends Record<string, unknown>>(
  rows: T[],
  select: string[] | undefined,
  known: readonly string[],
): Projected<T> => {
  if (!select?.length) return { rows };

  const knownSet = new Set(known);
  const wanted = select.filter((f) => knownSet.has(f));
  const unknownFields = select.filter((f) => !knownSet.has(f));

  // Every name was wrong. Projecting to {} would hand back a wall of empty
  // objects; the full row plus the complaint is the more useful answer.
  if (!wanted.length) return { rows, unknownFields };

  return {
    rows: rows.map((row) => {
      const out: Partial<T> = {};
      for (const field of wanted) {
        if (field in row) out[field as keyof T] = row[field as keyof T];
      }
      return out;
    }),
    ...(unknownFields.length ? { unknownFields } : {}),
  };
};
