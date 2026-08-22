/**
 * Safari's error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`; what
 * belongs here is the identity those messages are written against, plus the two
 * failures no other surface has.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

export const SAFARI_SURFACE: SurfaceContext = {
  appName: "Safari",
  envPrefix: "APPLE_SAFARI",
};

/**
 * Safari is one of the few Apple apps whose bundle id matches its display name
 * — unlike `com.apple.iCal`, `com.apple.AddressBook` and `com.apple.MobileSMS`.
 * Stated rather than assumed, because this repo has been caught by the opposite
 * three times.
 */
export const SAFARI_BUNDLE_ID = "com.apple.Safari";

export {
  AppleAutomationError as AppleSafariError,
  AppBusyError as SafariBusyError,
  AppNotRunningError as SafariNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/** A ref no longer resolves — history was cleared, or the row aged out. */
export class HistoryItemNotFoundError extends AppleAutomationError {
  override readonly name = "HistoryItemNotFoundError";

  constructor(ref: string) {
    super(
      `No history item for ref "${ref}". Safari may have cleared it, or it may have aged out of ` +
        `the retention window. Re-run the search to get a current ref.`,
      { ref },
    );
  }
}

/**
 * The store could not be read.
 *
 * Worth its own error because Safari's degraded mode is unlike every other
 * surface's. Elsewhere, losing the file lane means a slower server answering
 * the same questions. Here it means a server that has lost *the past entirely*
 * and can still see the present — so the message says what remains rather than
 * implying the surface is down.
 */
export class SafariHistoryUnavailableError extends AppleAutomationError {
  override readonly name = "SafariHistoryUnavailableError";

  constructor(reason: string) {
    super(
      `${reason} Live tabs still work — they come from Apple Events, not from this file — but ` +
        `history, bookmarks and the Reading List all need Full Disk Access.`,
      {},
    );
  }
}

/**
 * `Bookmarks.plist` could not be read or walked.
 *
 * Separate from history because they are separate files that fail
 * independently: the grant is the same, but a corrupt or restructured plist
 * takes bookmarks and the Reading List away while history keeps working.
 */
export class BookmarksUnavailableError extends AppleAutomationError {
  override readonly name = "BookmarksUnavailableError";

  constructor(reason: string) {
    super(`${reason} History is unaffected — it lives in a different file.`, {});
  }
}

/**
 * The epoch could not be identified from the data.
 *
 * MEASURED, and the reason this is an error rather than a default: the first
 * granted probe run reported `visit_time` as apple-nanoseconds, which was a
 * probe bug — the plausibility window accepted a degenerate 2001 reading. See
 * docs/calendar.md for the full account.
 *
 * The lesson taken here is not "hardcode the corrected answer". It is that a
 * silently wrong epoch is indistinguishable from correct output until somebody
 * notices every date is off by 31 years, so this server DETECTS the epoch from
 * the store at open time and refuses to render dates it cannot place. A visibly
 * absent timestamp is recoverable; a confidently wrong one is not.
 */
export class UndatableStoreError extends AppleAutomationError {
  override readonly name = "UndatableStoreError";

  constructor(reason: string) {
    super(
      `Safari's history timestamps could not be placed on a known epoch (${reason}). Dates are ` +
        `withheld rather than guessed — a timestamp that is wrong by decades reads exactly like a ` +
        `correct one. Everything that does not depend on a date still works.`,
      {},
    );
  }
}

/**
 * A date argument did not parse.
 *
 * Carries the whole accepted grammar in the message rather than a terse
 * rejection: the caller is usually a model, and a model that is told which
 * forms exist retries correctly on the next turn instead of guessing again.
 */
export class InvalidDateError extends AppleAutomationError {
  override readonly name = "InvalidDateError";

  constructor(field: string, raw: string, why: string) {
    super(
      `${field}: "${raw}" could not be read as a date — ${why}. Accepted forms: an ISO date ` +
        `("2026-08-20"), an ISO date-time ("2026-08-20T09:00", optionally with an offset), a ` +
        `signed offset from now ("-7d", "-3h", "+1w"), "today", "yesterday", "tomorrow", or ` +
        `"last monday" / "next monday".`,
      { field, raw },
    );
  }
}
