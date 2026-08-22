/**
 * Safari's tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
 * re-exported here so tools import from one place.
 */
export {
  compact,
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

export const historyRefArg = z
  .string()
  .min(1)
  .describe(
    'An opaque history ref from a search result (looks like "s1:<url>"). Do not construct one ' +
      "by hand.",
  );

export const fromArg = z
  .string()
  .optional()
  .describe(
    'Start of the window. ISO-8601 ("2026-08-01", "2026-08-01T09:00") or relative ' +
      '("-7d", "-3h", "yesterday", "last monday"). Defaults to defaultRangeDays before `to`.',
  );

export const toArg = z
  .string()
  .optional()
  .describe("End of the window, same grammar as `from`. Defaults to now.");

export const scopeArg = z
  .enum(["url", "full"])
  .optional()
  .describe(
    'Which text the query matches. "url" searches addresses only; "full" also searches page ' +
      'titles. Defaults to "full" — a person searching for a topic means the title, and a URL ' +
      "often does not contain the words the page is about.",
  );
