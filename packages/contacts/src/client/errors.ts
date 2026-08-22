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
 * Contacts' Apple Events target — and, like Calendar's `com.apple.iCal`, not the
 * display name. Contacts.app kept the id it shipped with as Address Book;
 * `com.apple.Contacts` does not exist.
 *
 * Used by the write lane only. Reads never send an Apple Event.
 */
export const CONTACTS_BUNDLE_ID = "com.apple.AddressBook";

export {
  AppleAutomationError as AppleContactsError,
  AppBusyError as ContactsBusyError,
  AppNotRunningError as ContactsNotRunningError,
  IndexUnavailableError,
  OsascriptTimeoutError,
  PlatformError,
  PreconditionError,
  ProtocolError,
  SchemaDriftError,
  TccDeniedError,
  WritesDisabledError,
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

/**
 * A write did not survive the save.
 *
 * Its own error because Contacts fails this way and the other surfaces do not:
 * changes sit in an unsaved buffer until `save()` runs, so a mutation can
 * succeed, read back correctly inside the same script, and still never reach the
 * store. Every write script saves and then re-reads; this is what it raises when
 * the re-read comes back empty.
 */
export class ContactWriteNotPersistedError extends AppleAutomationError {
  override readonly name = "ContactWriteNotPersistedError";

  constructor(message: string) {
    super(
      `${message} Contacts keeps edits in an unsaved buffer, so this usually means the save was ` +
        `refused — check whether Contacts has a modal sheet open, or an account that is read-only.`,
      {},
    );
  }
}

/**
 * Deleting a contact is not offered, and this says why rather than 404ing.
 *
 * MEASURED, macOS 26.6: the string "delete" does not appear anywhere in
 * `sdef /System/Applications/Contacts.app`. The whole command list is make, add,
 * remove and save — `remove` takes a person out of a GROUP, it does not delete
 * them. Writes go through Apple Events on every surface in this repo because the
 * store is `PRAGMA query_only`, so no dictionary verb means no capability.
 */
export class ContactDeleteUnsupportedError extends AppleAutomationError {
  override readonly name = "ContactDeleteUnsupportedError";

  constructor() {
    super(
      `Contacts cannot delete a contact through Apple Events — its scripting dictionary has no ` +
        `delete command at all (make, add, remove and save are the whole list, and "remove" only ` +
        `takes someone out of a group). Deleting has to be done in Contacts.app. This server will ` +
        `not write to the address book database directly: it is owned by Contacts and reconciled ` +
        `against iCloud, so writing to it corrupts sync state.`,
      {},
    );
  }
}
