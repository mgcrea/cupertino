export { BUILD_INFO, type BuildInfo } from "./build-info.js";
export {
  AppleMessagesClient,
  type Correspondent,
  type CreateClientOptions,
  type RenderedChat,
  type RenderedMessage,
  type SendResult,
} from "./client/messages.js";
export {
  appleSecondsSql,
  CORE_DATA_EPOCH_OFFSET,
  fromAppleSeconds,
  renderInstant,
  toAppleSeconds,
} from "./client/dates.js";
export {
  AppleMessagesError,
  ChatNotFoundError,
  IndexUnavailableError,
  MESSAGES_BUNDLE_ID,
  MESSAGES_SURFACE,
  MessageNotFoundError,
  MessagesUnavailableError,
  SchemaDriftError,
  SendFailedError,
  SendTargetNotFoundError,
} from "./client/errors.js";
export {
  ATTACHMENTS_RELATIVE,
  defaultStorePath,
  locateStore,
  STORE_RELATIVE,
  type LocateResult,
} from "./client/locate.js";
export {
  CHAT_REF_VERSION,
  decodeChatRef,
  decodeMessageRef,
  encodeChatRef,
  encodeMessageRef,
  InvalidMessageRefError,
  MESSAGE_REF_VERSION,
} from "./client/ref.js";
export {
  introspect,
  MessagesStore,
  openStore,
  reactionLabel,
  type ChatRow,
  type MessageRow,
  type RangeQuery,
  type StoreCapabilities,
} from "./client/store.js";
/**
 * The decoder, exported because it is the piece this surface rests on and the
 * one most likely to be wanted elsewhere. Validated at 100.000% agreement with
 * the `text` column across 94,043 real rows, and zero failures across all 97,094 — see docs/messages.md.
 */
export { decodeAttributedBody, outline, type DecodedBody } from "./client/typedstream.js";
export { PRELUDE } from "./client/jxa/core.js";
export { SEND_MESSAGE } from "./client/jxa/write.js";
export { loadConfig, type Config } from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
export { registerTools, type ToolContext } from "./tools/index.js";
