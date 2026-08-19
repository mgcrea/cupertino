export { readPackageIdentity, type BuildInfo, type PackageIdentity } from "./build-info.js";
export { runStdioServer, type StdioServerOptions } from "./cli.js";
export {
  BaseConfigSchema,
  parseBool,
  parseConfig,
  parseIntOpt,
  parseList,
  trimmed,
} from "./config.js";
export {
  AppBusyError,
  AppleAutomationError,
  AppNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
  type SurfaceContext,
} from "./errors.js";
export { describeStore, inspectFile, type FileFacts, type StoreFacts } from "./fs.js";
export {
  assertStaticScript,
  createOsascriptRunner,
  mapOsaError,
  withBusyRetry,
  type ExecImpl,
  type JxaEnvelope,
  type Logger,
  type OsascriptOptions,
  type OsascriptRunner,
} from "./osascript.js";
export {
  columnsOf,
  CORE_DATA_EPOCH_OFFSET,
  detectEpoch,
  fingerprintSchema,
  tableMap,
} from "./schema.js";
export {
  escapeLike,
  openReadOnly,
  toFileUri,
  type OpenedStore,
  type OpenOptions,
  type ReadOnlyMode,
} from "./sqlite.js";
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
} from "./tools.js";
