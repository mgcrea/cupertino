/**
 * Calendar's error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`;
 * what belongs here is the identity those messages are written against, and the
 * errors that are genuinely about calendars.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

/**
 * Named in every user-facing error and in the env vars they mention.
 *
 * `appName` is the display name, which is NOT the bundle id: Calendar.app is
 * still `com.apple.iCal` underneath. Every other surface has the two agreeing,
 * so the mismatch is written down in both places it matters.
 */
export const CALENDAR_SURFACE: SurfaceContext = {
  appName: "Calendar",
  envPrefix: "APPLE_CALENDAR",
};

/** Calendar's Apple Events target. Not `com.apple.Calendar`, which does not exist. */
export const CALENDAR_BUNDLE_ID = "com.apple.iCal";

export {
  AppleAutomationError as AppleCalendarError,
  AppBusyError as CalendarBusyError,
  AppNotRunningError as CalendarNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/** A CalendarRef no longer resolves — deleted, or moved to another calendar. */
export class EventNotFoundError extends AppleAutomationError {
  override readonly name = "EventNotFoundError";

  constructor(ref: string) {
    super(
      `No event for ref "${ref}". It was probably deleted or moved since the search ran. ` +
        `Re-run the search to get a current ref.`,
      { ref },
    );
  }
}

/** A calendar was named that Calendar does not have. */
export class CalendarNotFoundError extends AppleAutomationError {
  override readonly name = "CalendarNotFoundError";

  constructor(name: string, available: readonly string[] = []) {
    super(
      `No calendar named "${name}".` +
        (available.length
          ? ` Available: ${available.slice(0, 20).join(", ")}${available.length > 20 ? ", …" : ""}.`
          : ` Use apple_calendar_list_calendars to see what exists.`),
      { requested: name },
    );
  }
}

/**
 * A write was aimed at a calendar that cannot accept one.
 *
 * Its own error rather than a generic failure because the cause is almost
 * always structural rather than a mistake: holiday, birthday and subscribed
 * calendars are read-only by nature, and a caller that hits one needs to pick a
 * different target, not retry.
 */
export class CalendarNotWritableError extends AppleAutomationError {
  override readonly name = "CalendarNotWritableError";

  constructor(name: string) {
    super(
      `The calendar "${name}" is read-only, so nothing can be written to it. Subscribed ` +
        `calendars — holidays, birthdays, and anything added by URL — are read-only by nature. ` +
        `Use apple_calendar_list_calendars to find one where "writable" is true.`,
      { calendar: name },
    );
  }
}
