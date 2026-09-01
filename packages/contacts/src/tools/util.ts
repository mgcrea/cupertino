/**
 * Contacts' tool helpers. The generic half lives in `@mgcrea/mcp-apple-core`;
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
