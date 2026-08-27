/**
 * Maps' tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
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

export const placeRefArg = z
  .string()
  .min(1)
  .describe(
    'An opaque place ref from a listing (looks like "p1:f:12"). Do not construct one by hand. ' +
      "Refs address a row in the local store, so they are only valid for this session — an " +
      "iCloud re-sync can renumber them.",
  );

export const collectionRefArg = z
  .string()
  .min(1)
  .describe('An opaque collection ref from apple_maps_list_collections (looks like "pc1:3").');

export const queryArg = z
  .string()
  .min(1)
  .describe(
    "Text to look for in a place's name, the label you gave it, or its address. Wildcards are " +
      'escaped, so searching for "100%" finds that literal string.',
  );
