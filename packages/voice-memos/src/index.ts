export { BUILD_INFO, type BuildInfo } from "./build-info.js";
export {
  AppleVoiceMemosError,
  RecordingNotFoundError,
  VOICE_MEMOS_BUNDLE_ID,
  VOICE_MEMOS_SURFACE,
  VoiceMemosStoreUnavailableError,
} from "./client/errors.js";
export {
  GROUP_RECORDINGS_DIR,
  LEGACY_RECORDINGS_DIR,
  locateStore,
  STORE_FILENAME,
  type LocateResult,
} from "./client/locate.js";
export {
  AudioParseError,
  MAX_TRANSCRIPT_BYTES,
  scanAudio,
  scanAudioFile,
  type AudioScan,
  type ReadAt,
} from "./client/mp4.js";
export {
  VERIFIED_FINGERPRINT,
  VoiceMemosStore,
  type FolderRow,
  type RecordingRow,
} from "./client/store.js";
export {
  decodeTranscript,
  SEGMENTING,
  transcriptText,
  type Segment,
  type Transcript,
} from "./client/transcript.js";
export { TranscriptCache } from "./client/transcript-cache.js";
export {
  exportName,
  fold,
  VoiceMemosClient,
  type AudioFormat,
  type CreateClientOptions,
  type GetOptions,
  type ListQuery,
  type NotSearched,
  type RecordingView,
  type SearchHit,
  type SearchQuery,
  type TranscriptPage,
  type VoiceMemosStatus,
} from "./client/voice-memos.js";
export { loadConfig, type Config } from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
export { registerTools, type ToolContext } from "./tools/index.js";
