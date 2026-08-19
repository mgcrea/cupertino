/**
 * NoteRef — the one identifier any tool accepts or returns.
 *
 * Notes' own id is already globally unique and resolvable without a container,
 * unlike Mail's message ids: `x-coredata://<store>/ICNote/p<N>` addresses a note
 * outright, so this carries no folder and needs no lookup ladder.
 *
 * Wire format:  n1:<coredata-id>
 *
 * The `n1:` prefix is deliberate. If the id scheme ever changes, a versioned
 * prefix makes that an additive change instead of a silent reinterpretation of
 * every ref already in a conversation.
 *
 * Deliberately NOT shared with Mail's `ref.ts`: that codec's `#(\d+)$` and
 * `Number.isSafeInteger` both assume an integer id, which this is not.
 */

import { PreconditionError } from "./errors.js";

export const REF_VERSION = "n1";

/** `x-coredata://<uuid>/ICNote/p123` — the primary key is the trailing p-number. */
const CORE_DATA_ID = /^x-coredata:\/\/[^/]+\/ICNote\/p(\d+)$/;

export type NoteRef = {
  /** The full Core Data URI, which is what Apple Events resolves. */
  id: string;
  /** `Z_PK` in `ZICCLOUDSYNCINGOBJECT` — measured, see docs/notes.md. */
  primaryKey: number;
};

export const encodeRef = (id: string): string => `${REF_VERSION}:${id}`;

export const decodeRef = (raw: string): NoteRef => {
  const m = /^([a-z0-9]+):(.+)$/.exec(raw);
  if (!m) {
    throw new PreconditionError(
      `Malformed note ref "${raw}". Refs come from the search and list tools — ` +
        `construct them from those results rather than by hand.`,
      { expected: `${REF_VERSION}:x-coredata://<store>/ICNote/p<N>` },
    );
  }
  const [, version, id] = m;
  if (version !== REF_VERSION) {
    throw new PreconditionError(
      `Unknown note ref version "${version}". This server issues "${REF_VERSION}:" refs.`,
    );
  }
  const pk = CORE_DATA_ID.exec(id ?? "")?.[1];
  if (!pk) {
    throw new PreconditionError(`Note ref "${raw}" does not carry a Core Data note id.`);
  }
  return { id: id as string, primaryKey: Number(pk) };
};

/** Build a ref from an index row, which only ever knows the primary key. */
export const refFromPrimaryKey = (storeUuid: string, primaryKey: number): string =>
  encodeRef(`x-coredata://${storeUuid}/ICNote/p${primaryKey}`);
