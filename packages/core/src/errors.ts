/**
 * Error taxonomy shared by every Apple-app server.
 *
 * Every message is written for the person who has to fix it — a TCC denial says
 * which System Settings pane to open, not "operation failed".
 *
 * ## Why the surface is a required argument
 *
 * These messages name an app ("Not authorized to control Mail") and an
 * environment variable (`APPLE_MAIL_ALLOW_WRITES`). An earlier version made the
 * app name an *optional* parameter defaulting to "Mail" — and then never passed
 * it at any call site, while a second mention of Mail stayed hardcoded further
 * down the same string. That is worse than no parameter at all: it looks
 * configurable and is not.
 *
 * So `SurfaceContext` is required wherever it appears in a message. Servers
 * subclass with their own surface bound, which keeps `new MailBusyError()`
 * ergonomic at the call site without letting the context go missing.
 */

/** Identity of the app a server drives, for anything user-facing. */
export type SurfaceContext = {
  /** How the app is named to a human, e.g. "Mail", "Notes". */
  appName: string;
  /** Environment variable prefix for this server, e.g. "APPLE_MAIL". */
  envPrefix: string;
};

/** Base class so `toFailure` can carry structured detail through in one branch. */
export class AppleAutomationError extends Error {
  override readonly name: string = "AppleAutomationError";
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

/** The host process may not send Apple Events to the app (osascript -1743). */
export class TccDeniedError extends AppleAutomationError {
  override readonly name: string = "TccDeniedError";

  constructor(surface: SurfaceContext) {
    super(
      `Not authorized to control ${surface.appName}. Grant it in System Settings > ` +
        `Privacy & Security > Automation > (the app running this server) > ${surface.appName}, ` +
        `then restart the server. If no entry appears, the first attempt was denied before the ` +
        `prompt could be answered — run \`tccutil reset AppleEvents\` and try again.`,
    );
  }
}

/** The app is not running and the operation refuses to launch it. */
export class AppNotRunningError extends AppleAutomationError {
  override readonly name: string = "AppNotRunningError";

  constructor(surface: SurfaceContext) {
    super(
      `${surface.appName} is not running. Read tools do not launch it, because launching it ` +
        `steals focus and can start a sync. Open ${surface.appName} and retry.`,
    );
  }
}

/** The app was busy and refused the Apple Event (-1712). Retried once before surfacing. */
export class AppBusyError extends AppleAutomationError {
  override readonly name: string = "AppBusyError";

  constructor(surface: SurfaceContext) {
    super(
      `${surface.appName} is busy (probably syncing) and did not answer in time. ` +
        `Retry in a few seconds.`,
    );
  }
}

/** osascript exceeded its budget and was killed. */
export class OsascriptTimeoutError extends AppleAutomationError {
  override readonly name: string = "OsascriptTimeoutError";

  constructor(timeoutMs: number, surface: SurfaceContext) {
    super(
      `${surface.appName} did not answer within ${timeoutMs}ms. It may be mid-sync, or a ` +
        `permission prompt may be waiting on screen. Raise ` +
        `${surface.envPrefix}_OSASCRIPT_TIMEOUT_MS if this is routine at your data size.`,
    );
  }
}

/**
 * A write was attempted while writes are disabled. Under the house pattern write
 * tools are not registered at all when `allowWrites` is off, so this is a
 * belt-and-braces guard for the library surface, not a path tools can reach.
 */
export class WritesDisabledError extends AppleAutomationError {
  override readonly name: string = "WritesDisabledError";

  constructor(surface: SurfaceContext) {
    super(
      `Writes are disabled. Set ${surface.envPrefix}_ALLOW_WRITES=1 to enable the mutating tools.`,
    );
  }
}

/** A read-only index could not be opened, so the file lane is unavailable. */
export class IndexUnavailableError extends AppleAutomationError {
  override readonly name: string = "IndexUnavailableError";
}

/** The store's schema is not the one we know how to read. */
export class SchemaDriftError extends AppleAutomationError {
  override readonly name: string = "SchemaDriftError";
}

/** The server is not running on macOS, or osascript is missing. */
export class PlatformError extends AppleAutomationError {
  override readonly name: string = "PlatformError";
}

/** osascript exited 0 but did not produce the JSON envelope we require. */
export class ProtocolError extends AppleAutomationError {
  override readonly name: string = "ProtocolError";
}

/** A local precondition failed before anything was sent to the app. */
export class PreconditionError extends AppleAutomationError {
  override readonly name: string = "PreconditionError";
}
