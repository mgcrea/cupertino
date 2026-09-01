import { z } from "zod";

/**
 * Mail's tool helpers.
 *
 * The generic half — result shaping, error rendering and the two args every
 * server has — lives in `@mgcrea/mcp-apple-core`. Re-exported here so tools
 * keep importing from one place.
 */
export {
  compact,
  confirmArg,
  fail,
  limitArg,
  ok,
  okText,
  resolveLimit,
  toFailure,
  wrap,
  wrapResult,
  type ToolResult,
} from "@mgcrea/mcp-apple-core";

// ─── Mail's own args ─────────────────────────────────────────────────────────

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
