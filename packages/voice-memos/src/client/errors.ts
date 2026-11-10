/**
 * Voice Memos' error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`; what belongs
 * here is the identity those messages are written against, plus the failures no other surface
 * has.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

export const VOICE_MEMOS_SURFACE: SurfaceContext = {
  appName: "Voice Memos",
  envPrefix: "APPLE_VOICE_MEMOS",
};

/** Recorded, and used by nothing: Voice Memos ships no scripting dictionary. */
export const VOICE_MEMOS_BUNDLE_ID = "com.apple.VoiceMemos";

export {
  AppleAutomationError as AppleVoiceMemosError,
  IndexUnavailableError,
  PreconditionError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/**
 * The store could not be read.
 *
 * One lane and no fallback: without Full Disk Access there is no degraded Voice Memos
 * server. So every read throws this rather than returning an empty list, because an empty
 * list reads exactly like a person who has never recorded a memo.
 */
export class VoiceMemosStoreUnavailableError extends AppleAutomationError {
  override readonly name = "VoiceMemosStoreUnavailableError";

  constructor(reason: string) {
    super(
      `${reason} Voice Memos has no second lane: it ships no scripting dictionary, and its App ` +
        `Intents are reachable only from Shortcuts, so nothing at all can be read without the grant.`,
      {},
    );
  }
}

/** An id that no longer resolves: the memo was deleted for good, or the id is wrong. */
export class RecordingNotFoundError extends AppleAutomationError {
  override readonly name = "RecordingNotFoundError";

  constructor(id: string) {
    super(
      `No recording with id "${id}". It may have been removed from Recently Deleted, or the id ` +
        `came from somewhere else. List the recordings again to get a current id.`,
      { id },
    );
  }
}
