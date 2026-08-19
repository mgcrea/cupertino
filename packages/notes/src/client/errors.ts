/**
 * Notes' error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`; what
 * belongs here is the identity those messages are written against, and the
 * errors that are genuinely about notes.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

/** Named in every user-facing error and in the env vars they mention. */
export const NOTES_SURFACE: SurfaceContext = { appName: "Notes", envPrefix: "APPLE_NOTES" };

export {
  AppleAutomationError as AppleNotesError,
  AppBusyError as NotesBusyError,
  AppNotRunningError as NotesNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/** A NoteRef no longer resolves — the note was deleted, or the index is stale. */
export class NoteNotFoundError extends AppleAutomationError {
  override readonly name = "NoteNotFoundError";

  constructor(ref: string) {
    super(
      `No note for ref "${ref}". It was probably deleted since the search ran. ` +
        `Re-run the search to get a current ref.`,
    );
  }
}

/**
 * The note is password-protected and Notes will not hand over its text.
 *
 * The file lane cannot help either: locked notes are AES ciphertext at rest,
 * which is why `ZICNOTEDATA` carries `ZCRYPTOINITIALIZATIONVECTOR` and
 * `ZCRYPTOTAG` columns. Saying so is more useful than an empty body.
 */
export class NoteLockedError extends AppleAutomationError {
  override readonly name = "NoteLockedError";

  constructor(ref: string) {
    super(
      `Note "${ref}" is password-protected. Unlock it in Notes and retry — its text is ` +
        `encrypted at rest, so no amount of permission makes it readable from here.`,
    );
  }
}
