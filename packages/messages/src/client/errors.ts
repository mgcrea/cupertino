/**
 * Messages' error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`; what
 * belongs here is the identity those messages are written against.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

export const MESSAGES_SURFACE: SurfaceContext = {
  appName: "Messages",
  envPrefix: "APPLE_MESSAGES",
};

/**
 * Used by exactly one code path, and unused by every read.
 *
 * Messages is the one surface with NO Apple Events read lane at all — measured,
 * not assumed. `docs/messages.md` records every attempt failing, and the reason
 * is peculiar enough to write down: Messages answers "Application isn't running"
 * while `NSRunningApplication` reports it running, because it lives as a
 * windowless background process that declines to wake for a script. The liveness
 * check and the app's own answer disagree and neither is lying.
 *
 * The id is the liveness check for `send`, which is the only thing Apple Events
 * can do on this surface — see `client/jxa/core.ts`.
 */
export const MESSAGES_BUNDLE_ID = "com.apple.MobileSMS";

export {
  AppleAutomationError as AppleMessagesError,
  IndexUnavailableError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
} from "@mgcrea/mcp-apple-core";

/** A message ref no longer resolves — deleted, or the chat was cleared. */
export class MessageNotFoundError extends AppleAutomationError {
  override readonly name = "MessageNotFoundError";

  constructor(ref: string) {
    super(
      `No message for ref "${ref}". It was probably deleted since the search ran. Re-run the ` +
        `search to get a current ref.`,
      { ref },
    );
  }
}

/** A chat ref no longer resolves. */
export class ChatNotFoundError extends AppleAutomationError {
  override readonly name = "ChatNotFoundError";

  constructor(ref: string) {
    super(`No chat for ref "${ref}". Use apple_messages_list_chats to get a current ref.`, { ref });
  }
}

/**
 * The store could not be read.
 *
 * Its own error because this surface fails harder than any other: there is no
 * Apple Events fallback, so without Full Disk Access there is no server at all.
 * `docs/distribution.md`'s "try before you grant" was retired partly because of
 * this surface, and the message says so rather than implying a degraded mode
 * that does not exist.
 */
export class MessagesUnavailableError extends AppleAutomationError {
  override readonly name = "MessagesUnavailableError";

  constructor(reason: string) {
    super(reason, {});
  }
}

/**
 * Messages would not accept any form of recipient for a send.
 *
 * Its own error because the cause is almost never the recipient. Every rung of
 * the ladder in `client/jxa/core.ts` except the first one enumerates something,
 * and enumeration is exactly what this app refuses — so the usual cause of this
 * error is that the chat is new (no guid in the store to address it by) rather
 * than that the person does not exist. The message says so, because "not found"
 * would send a caller looking for a typo that is not there.
 */
export class SendTargetNotFoundError extends AppleAutomationError {
  override readonly name = "SendTargetNotFoundError";

  constructor(recipient: string, attempts: readonly string[]) {
    super(
      `Messages would not resolve "${recipient}" to a chat or participant, so nothing was sent. ` +
        `This usually means there is no existing conversation with them on this Mac: Messages ` +
        `refuses to enumerate participants for a script, so an existing chat is the only handle ` +
        `this server can address reliably. Open the conversation once in Messages.app and retry.`,
      { recipient, attempts: [...attempts] },
    );
  }
}

/** Messages accepted the target and then refused the send itself. */
export class SendFailedError extends AppleAutomationError {
  override readonly name = "SendFailedError";

  constructor(message: string, attempts: readonly string[]) {
    super(`Messages refused the send: ${message}`, { attempts: [...attempts] });
  }
}
