export { BUILD_INFO, type BuildInfo } from "./build-info.js";
export {
  AppleMailError,
  IndexUnavailableError,
  MailBusyError,
  MailNotRunningError,
  MessageNotFoundError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "./client/errors.js";
export { inspectFile, locateEnvelopeIndex, type LocateResult } from "./client/locate.js";
export { AppleMailClient, type LaneStatus, type MessageSummary } from "./client/mail.js";
export { MailboxMap, type MailAccount } from "./client/mailbox-map.js";
export {
  assertStaticScript,
  createOsascriptRunner,
  mapOsaError,
  withBusyRetry,
  type JxaEnvelope,
  type Logger,
  type OsascriptRunner,
} from "./client/osascript.js";
export {
  decodeRef,
  encodeRef,
  groupRefsByMailbox,
  REF_VERSION,
  type MessageRef,
} from "./client/ref.js";
export { loadConfig, type Config } from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
export { registerTools, type ToolContext } from "./tools/index.js";
