/**
 * ReminderRef — the one identifier any tool accepts or returns.
 *
 * Wire format:  r1:<reminders-id>
 *
 * The `r1:` prefix follows the same reasoning as Notes' `n1:`: if the id scheme
 * ever changes, a versioned prefix makes that an additive change instead of a
 * silent reinterpretation of every ref already sitting in a conversation.
 *
 * Deliberately NOT shared with Notes' or Mail's codec. Mail's assumes an integer
 * id; Notes' hardcodes `ICNote/p<N>` and returns a numeric `primaryKey`.
 * Reminders' `id` is declared `type="text"` in the scripting dictionary and is
 * opaque — so this codec validates the envelope and refuses to invent structure
 * inside it.
 *
 * ## Why this is tolerant about the id's shape
 *
 * Apple Events ids are observed as `x-apple-reminder://<uuid>`, but that is a
 * shape this server *observes*, not one Apple documents. Rejecting anything
 * else would turn a harmless format change into total failure, and a reminder
 * synced from a CalDAV account is exactly the case most likely to differ. So an
 * id is carried through verbatim, and the UUID is extracted opportunistically —
 * it is what joins a row in the store to a reminder in the app, and when it is
 * absent the index lane simply cannot enrich that one result.
 */

import { PreconditionError } from "./errors.js";

export const REF_VERSION = "r1";

/** The observed Apple Events form. Used to *find* the uuid, never to require it. */
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export type ReminderRef = {
  /** The full id, exactly as Apple Events issued it. This is what resolves. */
  id: string;
  /**
   * The bridge to the store, when the id carries one.
   *
   * Null is a legitimate value, not an error: it means this reminder can still
   * be read and written over Apple Events, and only the index-only fields
   * (tags, url, recurrence, alarms) are unavailable for it.
   */
  uuid: string | null;
};

export const encodeRef = (id: string): string => `${REF_VERSION}:${id}`;

export const decodeRef = (raw: string): ReminderRef => {
  const m = /^([a-z0-9]+):(.+)$/.exec(String(raw ?? ""));
  if (!m) {
    throw new PreconditionError(
      `Malformed reminder ref ${JSON.stringify(raw)}. Refs come from the search and list tools — ` +
        `construct them from those results rather than by hand.`,
      { expected: `${REF_VERSION}:<reminders-id>` },
    );
  }
  const [, version, id] = m;
  if (version !== REF_VERSION) {
    throw new PreconditionError(
      `Unknown reminder ref version "${version}". This server issues "${REF_VERSION}:" refs.`,
    );
  }
  return { id: id as string, uuid: UUID.exec(id ?? "")?.[1]?.toUpperCase() ?? null };
};

/**
 * Build a ref from an index row, which only ever knows the bare UUID.
 *
 * The scheme is measured, not assumed: the probe read a real id from Apple
 * Events and found `x-apple-reminder://<uuid>`, then located the same UUID in
 * `ZREMCDREMINDER.ZCKIDENTIFIER`. That round trip is what makes reconstructing
 * an id from the store defensible.
 */
export const refFromUuid = (uuid: string): string =>
  encodeRef(`x-apple-reminder://${uuid.toUpperCase()}`);

/** The store keeps bare identifiers; normalise for comparison against a ref. */
export const uuidOf = (id: string): string | null =>
  UUID.exec(String(id ?? ""))?.[1]?.toUpperCase() ?? null;
