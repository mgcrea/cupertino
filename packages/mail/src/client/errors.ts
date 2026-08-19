/**
 * Error taxonomy. Every message is written for the person who has to fix it —
 * a TCC denial says which System Settings pane to open, not "operation failed".
 */

/** Base class so `toFailure` can carry structured detail through in one branch. */
export class AppleMailError extends Error {
  override readonly name: string = "AppleMailError";
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

/** The host process is not allowed to send Apple Events to Mail (osascript -1743). */
export class TccDeniedError extends AppleMailError {
  override readonly name = "TccDeniedError";

  constructor(hint = "Mail") {
    super(
      `Not authorized to control ${hint}. Grant it in System Settings > Privacy & Security > ` +
        `Automation > (the app running this server) > Mail, then restart the server. ` +
        `If no entry appears, the first attempt was denied before the prompt could be answered — ` +
        `run \`tccutil reset AppleEvents\` and try again.`,
    );
  }
}

/** Mail.app is not running and the operation refuses to launch it. */
export class MailNotRunningError extends AppleMailError {
  override readonly name = "MailNotRunningError";

  constructor() {
    super(
      "Mail is not running. Read tools do not launch it, because launching Mail triggers a " +
        "sync and steals focus. Open Mail and retry.",
    );
  }
}

/** The Envelope Index could not be opened, so the search lane is unavailable. */
export class IndexUnavailableError extends AppleMailError {
  override readonly name = "IndexUnavailableError";
}

/** A MessageRef no longer resolves — the message was moved, deleted, or the index is stale. */
export class MessageNotFoundError extends AppleMailError {
  override readonly name = "MessageNotFoundError";

  constructor(ref: string) {
    super(
      `No message for ref "${ref}". It was probably moved or deleted since the search ran. ` +
        `Re-run the search to get a current ref.`,
    );
  }
}

/** The Envelope Index schema is not the one we know how to read. */
export class SchemaDriftError extends AppleMailError {
  override readonly name = "SchemaDriftError";
}

/** osascript exceeded its budget and was killed. */
export class OsascriptTimeoutError extends AppleMailError {
  override readonly name = "OsascriptTimeoutError";

  constructor(timeoutMs: number) {
    super(
      `Mail did not answer within ${timeoutMs}ms. It may be mid-sync, or a permission prompt may ` +
        `be waiting on screen. Raise APPLE_MAIL_OSASCRIPT_TIMEOUT_MS if this is routine for your mailbox size.`,
    );
  }
}

/** Mail was busy and refused the Apple Event (-1712). Retried once before surfacing. */
export class MailBusyError extends AppleMailError {
  override readonly name = "MailBusyError";

  constructor() {
    super("Mail is busy (probably syncing) and did not answer in time. Retry in a few seconds.");
  }
}

/** The server is not running on macOS, or osascript is missing. */
export class PlatformError extends AppleMailError {
  override readonly name = "PlatformError";
}

/** osascript exited 0 but did not produce the JSON envelope we require. */
export class ProtocolError extends AppleMailError {
  override readonly name = "ProtocolError";
}

/** A local precondition failed before anything was sent to Mail. */
export class PreconditionError extends AppleMailError {
  override readonly name = "PreconditionError";
}

/**
 * A write was attempted while writes are disabled. Under the house pattern write
 * tools are not registered at all when `allowWrites` is off, so this is a
 * belt-and-braces guard for the library surface, not a path tools can reach.
 */
export class WritesDisabledError extends AppleMailError {
  override readonly name = "WritesDisabledError";

  constructor() {
    super("Writes are disabled. Set APPLE_MAIL_ALLOW_WRITES=1 to enable the mutating tools.");
  }
}
