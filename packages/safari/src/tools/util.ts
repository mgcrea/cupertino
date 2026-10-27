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
  resolveLimit,
  toFailure,
  wrap,
  wrapResult,
  type ToolResult,
} from "@mgcrea/mcp-apple-core";

import { z } from "zod";

import type { AppleSafariClient } from "../client/safari.js";

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

/**
 * The page a READ tool looks at: the one named, or the tab in front.
 *
 * "What is on my screen" is the commonest question this surface gets, and
 * when every page tool wanted an exact URL it always cost a list_tabs call
 * first. The tools that act keep their URL, because there the element id is
 * what picks the page and the URL is the check that it has not moved.
 */
export const pageUrlArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The exact URL of the page, as apple_safari_list_tabs reports it. Omit it for the tab the " +
      "user is looking at (the frontmost one): that costs one Apple Event and the Automation " +
      "grant, and the result's `url` says which page it was.",
  );

/** The URL to use, and `tab: "frontmost"` when it was not given but looked up. */
export const resolvePageUrl = async (
  client: AppleSafariClient,
  url: string | undefined,
): Promise<{ url: string; tab?: "frontmost" }> =>
  url !== undefined ? { url } : { url: await client.frontmostTabUrl(), tab: "frontmost" };
