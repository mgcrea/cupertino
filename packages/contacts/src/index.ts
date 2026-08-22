export { BUILD_INFO, type BuildInfo } from "./build-info.js";
export {
  AppleContactsClient,
  type ContactDetail,
  type CreateClientOptions,
  type LaneStatus,
} from "./client/contacts.js";
export {
  AppleContactsError,
  CONTACTS_BUNDLE_ID,
  CONTACTS_SURFACE,
  ContactNotFoundError,
  ContactsUnavailableError,
  IndexUnavailableError,
  SchemaDriftError,
} from "./client/errors.js";
export {
  ADDRESSBOOK_DIR,
  defaultDirPath,
  locateStores,
  SOURCES_DIRNAME,
  STORE_FILENAME,
  type LocateResult,
  type StoreCandidate,
} from "./client/locate.js";
export {
  digitsOf,
  emailKey,
  handleKind,
  isShortcode,
  SUFFIX_DIGITS,
  suffixKey,
  type HandleKind,
} from "./client/phone.js";
export {
  decodeRef,
  encodeRef,
  InvalidContactRefError,
  REF_VERSION,
  type ContactRef,
} from "./client/ref.js";
/**
 * The resolver, exported as a first-class API rather than only as a tool.
 *
 * `packages/messages` is the intended consumer: it holds handles and needs
 * names, and going through MCP to reach a function in the same workspace would
 * be absurd. See docs/contacts.md for what the rates actually are.
 */
export {
  resolveHandle,
  resolveHandles,
  summarise,
  type ResolutionStatus,
  type ResolvedHandle,
} from "./client/resolve.js";
export {
  ContactsIndex,
  countContacts,
  displayNameOf,
  introspect,
  openShard,
  type HandleLookup,
  type IndexContact,
  type Shard,
  type StoreCapabilities,
} from "./client/store.js";
export { loadConfig, type Config } from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
export { registerTools, type ToolContext } from "./tools/index.js";
