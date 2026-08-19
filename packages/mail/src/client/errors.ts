/**
 * Mail's error surface.
 *
 * The taxonomy itself lives in `@mgcrea/mcp-apple-core` — TCC denial, app not
 * running, app busy and the rest are facts about driving any Apple app, not
 * about mail. What belongs here is the identity those messages are written
 * against, and the one error that is genuinely about messages.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

/** Named in every user-facing error and in the env vars they mention. */
export const MAIL_SURFACE: SurfaceContext = { appName: "Mail", envPrefix: "APPLE_MAIL" };

export {
  AppleAutomationError as AppleMailError,
  AppBusyError as MailBusyError,
  AppNotRunningError as MailNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/** A MessageRef no longer resolves — the message was moved, deleted, or the index is stale. */
export class MessageNotFoundError extends AppleAutomationError {
  override readonly name = "MessageNotFoundError";

  constructor(ref: string) {
    super(
      `No message for ref "${ref}". It was probably moved or deleted since the search ran. ` +
        `Re-run the search to get a current ref.`,
    );
  }
}
