export { BUILD_INFO, type BuildInfo } from "./build-info.js";
export {
  AppleNotesError,
  NoteLockedError,
  NoteNotFoundError,
  NOTES_SURFACE,
  NotesBusyError,
  NotesNotRunningError,
} from "./client/errors.js";
export { defaultStorePath, locateStore, type LocateResult } from "./client/locate.js";
export {
  AppleNotesClient,
  type LaneStatus,
  type NoteAccount,
  type NoteFolder,
  type NoteSummary,
} from "./client/notes.js";
export {
  collectStrings,
  extractNoteText,
  NOTE_TEXT_PATH,
  parseFields,
  readVarint,
  type DecodedNote,
} from "./client/protobuf.js";
export {
  decodeRef,
  encodeRef,
  refFromPrimaryKey,
  REF_VERSION,
  type NoteRef,
} from "./client/ref.js";
export {
  introspect,
  NoteStore,
  openStore,
  type NoteRow,
  type StoreCapabilities,
} from "./client/store.js";
export { loadConfig, type Config } from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
export { registerTools, type ToolContext } from "./tools/index.js";
