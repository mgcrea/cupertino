/**
 * Maps' error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`; what
 * belongs here is the identity those messages are written against, plus the
 * failures no other surface has.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

export const MAPS_SURFACE: SurfaceContext = {
  appName: "Maps",
  envPrefix: "APPLE_MAPS",
};

/**
 * Maps is one of the few Apple apps whose bundle id matches its display name —
 * unlike `com.apple.iCal`, `com.apple.AddressBook` and `com.apple.MobileSMS`.
 * Stated rather than assumed, because this repo has been caught by the opposite
 * three times.
 *
 * It is recorded here and used by almost nothing. Maps ships **no scripting
 * dictionary** — `/System/Applications/Maps.app` contains no `.sdef`, checked
 * directly rather than inferred from `NSAppleScriptEnabled` — so there is no
 * Apple Events lane to address, and this server never sends one.
 */
export const MAPS_BUNDLE_ID = "com.apple.Maps";

export {
  AppleAutomationError as AppleMapsError,
  IndexUnavailableError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
} from "@mgcrea/mcp-apple-core";

/**
 * The store could not be read.
 *
 * This surface has **one lane and no fallback**, which puts it with Messages
 * rather than with Safari: without Full Disk Access there is no degraded Maps
 * server, there is no Maps server. So every read throws this rather than
 * returning an empty list — an empty `favorites` reads exactly like a person
 * who has saved no places, and that is the failure this error exists to
 * prevent.
 *
 * The hint names the trap that actually catches people: the store lives at a
 * path with **no file extension**, inside the one directory in Maps' container
 * that Full Disk Access gates. A sweep for `*.db` finds nothing and concludes
 * the data is not on disk. It is.
 */
export class MapsStoreUnavailableError extends AppleAutomationError {
  override readonly name = "MapsStoreUnavailableError";

  constructor(reason: string) {
    super(
      `${reason} Maps has no second lane — it ships no scripting dictionary, so there is no ` +
        `Apple Events fallback and nothing at all can be read without the grant.`,
      {},
    );
  }
}

/** A ref no longer resolves — the place was removed, or the store was re-synced. */
export class PlaceNotFoundError extends AppleAutomationError {
  override readonly name = "PlaceNotFoundError";

  constructor(ref: string) {
    super(
      `No place for ref "${ref}". It may have been removed in Maps, or iCloud may have ` +
        `re-synced the store and renumbered it. Re-run the listing to get a current ref.`,
      { ref },
    );
  }
}

/**
 * The epoch could not be identified from the data.
 *
 * The same discipline `packages/safari` applies, for the same measured reason:
 * a wrong epoch produces dates that are well-formed and wrong by 31 years.
 * `docs/maps.md` records that this store's `ZCREATETIME` read as apple-seconds
 * and that a unix-seconds reading of the same value lands in 1995 while still
 * looking entirely plausible. So the offset is detected from the store at open
 * time and dates are WITHHELD when it cannot be.
 */
export class UndatableStoreError extends AppleAutomationError {
  override readonly name = "UndatableStoreError";

  constructor(reason: string) {
    super(
      `Maps' timestamps could not be placed on a known epoch (${reason}). Dates are withheld ` +
        `rather than guessed — a timestamp wrong by decades reads exactly like a correct one. ` +
        `Everything that does not depend on a date still works.`,
      {},
    );
  }
}
