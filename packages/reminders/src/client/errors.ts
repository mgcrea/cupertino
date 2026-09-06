/**
 * Reminders' error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`;
 * what belongs here is the identity those messages are written against, and the
 * errors that are genuinely about reminders.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

/** Named in every user-facing error and in the env vars they mention. */
export const REMINDERS_SURFACE: SurfaceContext = {
  appName: "Reminders",
  envPrefix: "APPLE_REMINDERS",
};

export {
  AppleAutomationError as AppleRemindersError,
  AppBusyError as RemindersBusyError,
  AppNotRunningError as RemindersNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/** A ReminderRef no longer resolves — completed-and-cleared, deleted, or stale. */
export class ReminderNotFoundError extends AppleAutomationError {
  override readonly name = "ReminderNotFoundError";

  constructor(ref: string) {
    super(
      `No reminder for ref "${ref}". It was probably deleted since the search ran — and note ` +
        `that completing a reminder can also remove it from the default view. Re-run the search ` +
        `to get a current ref.`,
    );
  }
}

/** A list was named that Reminders does not have. */
export class ListNotFoundError extends AppleAutomationError {
  override readonly name = "ListNotFoundError";

  constructor(name: string, available: readonly string[] = []) {
    super(
      `No Reminders list named "${name}".` +
        (available.length
          ? ` Available: ${available.slice(0, 20).join(", ")}${available.length > 20 ? ", …" : ""}.`
          : ` Use apple_reminders_list_lists to see what exists.`),
      { requested: name },
    );
  }
}

/**
 * A date argument could not be read.
 *
 * Re-exported from core, which now owns the grammar every surface parses dates
 * with. Kept as a name in this module so `catch (e) { e instanceof
 * InvalidDateError }` here keeps working, and so the surface's error list reads
 * as one list.
 */
export { InvalidDateError } from "@mgcrea/mcp-apple-core";
