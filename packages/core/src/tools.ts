import { z } from "zod";

import { AppleAutomationError } from "./errors.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
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
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2),
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
  .describe("Maximum number of results. Defaults to 25.");

export const confirmArg = z
  .literal(true)
  .describe("Must be true. This action changes data and is not undoable from here.");
