import { z } from "zod";

import { AppleMailError } from "../client/errors.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a mail body into one
 * escaped "Hi,\n\n…" line that no one can read.
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
  if (err instanceof AppleMailError) {
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

/** Like `wrap`, but the body chooses its own result shape (e.g. a raw mail body). */
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

/**
 * A capability-missing result.
 *
 * This is NOT an error: the tool is registered, the arguments were valid, and
 * the answer is "this lane needs a permission you have not granted". Returning
 * a structured explanation lets the model either use the degraded data or tell
 * the user precisely what to enable, which a bare `isError` cannot.
 */
export const degraded = (capability: string, reason: string | null, data?: unknown): ToolResult =>
  ok({
    degraded: true,
    capability,
    reason: reason ?? "unavailable",
    hint: "Call apple_mail_diagnostics for the full permission picture.",
    ...(data ? { data } : {}),
  });

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
  .describe("Must be true. This action changes or sends mail and is not undoable from here.");

export const accountArg = z
  .string()
  .optional()
  .describe(
    'Account display name (e.g. "iCloud") or its UUID, from apple_mail_list_accounts. ' +
      "Omit to span every visible account.",
  );

export const mailboxArg = z
  .string()
  .optional()
  .describe(
    'Mailbox name, e.g. "INBOX", "Sent Messages", or "[Gmail]/All Mail". ' +
      "Gmail-style prefixes are resolved automatically.",
  );

export const messageRefArg = z
  .string()
  .min(1)
  .describe(
    "An opaque message ref from a search or list result (looks like " +
      '"m1:<accountUuid>/<mailbox>#<id>"). Do not construct one by hand.',
  );

export const messageRefsArg = z
  .array(z.string().min(1))
  .min(1)
  .max(200)
  .describe(
    "Message refs from a search or list result. Batched by mailbox into one round-trip each.",
  );
