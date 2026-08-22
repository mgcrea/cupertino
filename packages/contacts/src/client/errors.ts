/**
 * Contacts' error surface. The taxonomy lives in `@mgcrea/mcp-apple-core`; what
 * belongs here is the identity those messages are written against.
 */

import { AppleAutomationError, type SurfaceContext } from "@mgcrea/mcp-apple-core";

export const CONTACTS_SURFACE: SurfaceContext = {
  appName: "Contacts",
  envPrefix: "APPLE_CONTACTS",
};

/**
 * Recorded for completeness, and deliberately unused.
 *
 * This server never sends an Apple Event. Contacts is read-only and file-lane
 * only, so it asks for no Automation grant at all — see `tools/index.ts`. The
 * bundle id is here so that a future write lane does not have to rediscover it,
 * and because `apps/apple/Cupertino/Surfaces.swift` needs it if this surface is
 * ever registered there.
 */
export const CONTACTS_BUNDLE_ID = "com.apple.AddressBook";

export {
  AppleAutomationError as AppleContactsError,
  IndexUnavailableError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
} from "@mgcrea/mcp-apple-core";

/** A contact ref no longer resolves — deleted, or its account was removed. */
export class ContactNotFoundError extends AppleAutomationError {
  override readonly name = "ContactNotFoundError";

  constructor(ref: string) {
    super(
      `No contact for ref "${ref}". It was probably deleted, or the account holding it was ` +
        `removed, since the search ran. Re-run the search to get a current ref.`,
      { ref },
    );
  }
}

/**
 * The store could not be read, with the reason spelled out.
 *
 * Its own error because Contacts fails differently from every other surface in
 * this repo: it sits behind its own TCC service rather than behind Full Disk
 * Access, and unlike Full Disk Access that permission PROMPTS. So the fix is
 * usually "answer the dialog", not "go to System Settings" — and telling
 * somebody to grant whole-disk access for an address book would be asking for
 * far more than this server needs.
 */
export class ContactsUnavailableError extends AppleAutomationError {
  override readonly name = "ContactsUnavailableError";

  constructor(reason: string) {
    super(reason, {});
  }
}
