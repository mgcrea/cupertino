import { z } from "zod";

import { AppleAutomationError } from "./errors.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed.
 *
 * A model does not need the indentation, and it is not free: measured against
 * rows matching these servers' own types, `null, 2` adds 25-41% depending on how
 * many short keys a row carries - worst on the widest lists, which are exactly
 * the responses already big enough to matter. Every tool in every surface
 * returns through here, so this is the one place it is paid.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a message body into
 * one escaped "Hi,\n\n…" line that no one can read.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving whatever detail it carried. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof AppleAutomationError) {
    return fail(err.message, { kind: err.name, ...err.details });
  }
  if (err instanceof Error) {
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (e.g. a raw body). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

/** Drop undefined values so we never send `{mailbox: undefined}` down a lane. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

// ─── shared args ─────────────────────────────────────────────────────────────

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Maximum number of results. Each tool states its own default; " +
      "`maxResults` is the ceiling either way.",
  );

/**
 * Settle a caller's `limit` against the tool's default and the config ceiling.
 *
 * Written out by hand at twenty-odd call sites before this existed, in five
 * different spellings - and three surfaces spelled it `limit ?? maxResults`,
 * with no `Math.min` at all. That made their real default 200 while `limitArg`
 * told every model it was 25, so a model that trusted the description and
 * omitted the argument got eight times the rows it asked for.
 *
 * `fallback` is the tool's own documented default, not a global one: a mailbox
 * listing and a day of events do not want the same number.
 */
export const resolveLimit = (
  limit: number | undefined,
  maxResults: number,
  fallback = 25,
): number => Math.min(limit ?? fallback, maxResults);

export const confirmArg = z
  .literal(true)
  .describe("Must be true. This action changes data and is not undoable from here.");
