/**
 * Messages' tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
 * re-exported here so tools import from one place.
 */
export {
  compact,
  confirmArg,
  fail,
  limitArg,
  ok,
  okText,
  toFailure,
  wrap,
  wrapResult,
  type ToolResult,
} from "@mgcrea/mcp-apple-core";

import { z } from "zod";

export const chatRefArg = z
  .string()
  .optional()
  .describe(
    'An opaque chat ref from apple_messages_list_chats (looks like "mc1:<guid>"). Do not ' +
      "construct one by hand.",
  );

export const messageRefArg = z
  .string()
  .min(1)
  .describe(
    'An opaque message ref from a list or search result (looks like "m1:<guid>"). Do not ' +
      "construct one by hand.",
  );

export const fromArg = z
  .string()
  .optional()
  .describe('Start of the window, ISO-8601 — "2026-08-01" or "2026-08-01T09:00".');

export const toArg = z
  .string()
  .optional()
  .describe("End of the window, ISO-8601. Defaults to now.");

export const includeReactionsArg = z
  .boolean()
  .optional()
  .describe(
    "Include tapbacks as if they were messages. Off by default, and you almost never want it " +
      'on: a tapback renders as `Liked "see you at 8"`, which nobody typed. Use ' +
      "apple_messages_get_message to see the reactions on a specific message instead.",
  );
