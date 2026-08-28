import { AppleAutomationError } from "@mgcrea/mcp-apple-core";

import type { EntityKey } from "./store.js";

/**
 * Refs for places and collections.
 *
 * ## Why the ref is not `ZMUID`
 *
 * `ZMUID` is Apple's own place identifier and looks like the better key — it is
 * the same number for the same restaurant across every device. It is not used,
 * for two measured reasons recorded in `docs/maps.md`:
 *
 *   * It is populated **20 of 23** favourites. The three without it are the
 *     rows that have no linked place at all, but a ref scheme that cannot
 *     address three rows in twenty-three is not a ref scheme.
 *   * It identifies a PLACE, not an entry. The same café saved as a favourite
 *     AND filed in a collection carries one `ZMUID` across both, so a ref built
 *     on it could not say which of the two a caller meant.
 *
 * The keys below address the ENTRY, which is what every tool here returns. The
 * kind is carried in the prefix so a favourite ref and a collection-item ref
 * can never be confused for one another.
 *
 * ## What the ref carries: a uuid when the store has one, a row id when it does not
 *
 * `ZIDENTIFIER` — a 16-byte Core Data UUID — is set on every favourite,
 * collection, collection item and recent on a real store, and is distinct on
 * every one. It addresses the ENTRY, survives a delete elsewhere in the table,
 * and survives an iCloud re-sync renumbering rows. It is the ref whenever
 * `store.ts` can confirm total coverage.
 *
 * It was found by watching Maps write, not by reading the schema — see
 * `docs/maps.md`. The read probe never reported it, because a probe can only
 * report columns it thought to look for.
 *
 * When a store has no usable identifier the ref falls back to the Core Data row
 * id, and then the old caveat applies in full: `Z_PK` is reused after a delete
 * and renumbered by a re-sync, so such a ref is only good for the session.
 * `packages/messages` rejected row ids outright for that reason; here they are
 * the degraded mode rather than the design.
 *
 * The two are told apart BY SHAPE — a uuid is 32 hex characters, a row id is
 * decimal — and the resolver refuses to try a uuid against a store with no
 * identifier column rather than reinterpreting it as a number. Silently
 * resolving one key space in the other would find a real but wrong place, which
 * is worse than finding nothing.
 *
 * ## Why `p1:` and `pc1:`
 *
 * `c1:` is Calendar's, `r1:` Reminders', `k1:` Contacts', `n1:` Notes',
 * `m1:`/`mc1:` Messages', `s1:`/`sb1:` Safari's. A ref that decodes under two
 * surfaces is worse than one that decodes under none, so each prefix is claimed
 * once and the version digit keeps a future change additive rather than a
 * silent reinterpretation of refs already sitting in a conversation.
 */

export const PLACE_REF_VERSION = "p1";
export const COLLECTION_REF_VERSION = "pc1";

/** The entity a place ref points into. Carried in the ref, never guessed. */
export type PlaceKind = "favorite" | "collection-item" | "history";

const KIND_CODE: Record<PlaceKind, string> = {
  favorite: "f",
  "collection-item": "c",
  history: "h",
};
const CODE_KIND: Record<string, PlaceKind> = {
  f: "favorite",
  c: "collection-item",
  h: "history",
};

const PLACE_PATTERN = /^p1:([fch]):([0-9a-f]{32}|\d+)$/;
const COLLECTION_PATTERN = /^pc1:([0-9a-f]{32}|\d+)$/;

/** 32 hex characters is a uuid; anything else that matched the pattern is a row id. */
const toKey = (raw: string): EntityKey =>
  /^[0-9a-f]{32}$/.test(raw)
    ? {
        uuid: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`,
      }
    : { rowId: Number(raw) };

/** A uuid goes into the ref undashed, so the ref stays one opaque token. */
const fromKey = (key: EntityKey): string =>
  "uuid" in key ? key.uuid.replaceAll("-", "").toLowerCase() : String(key.rowId);

const otherSurface = (raw: string): string => {
  if (raw.startsWith("c1:")) return " That one is a Calendar event ref.";
  if (raw.startsWith("r1:")) return " That one is a Reminders ref.";
  if (raw.startsWith("k1:")) return " That one is a Contacts ref.";
  if (raw.startsWith("n1:")) return " That one is a Notes ref.";
  if (raw.startsWith("mc1:")) return " That one is a Messages chat ref.";
  if (raw.startsWith("m1:")) return " That one is a Messages message ref.";
  if (raw.startsWith("sb1:")) return " That one is a Safari bookmark ref.";
  if (raw.startsWith("s1:")) return " That one is a Safari history ref.";
  if (raw.startsWith("pc1:")) return " That one is a COLLECTION ref — this wants a place ref.";
  if (raw.startsWith("p1:")) return " That one is a PLACE ref — this wants a collection ref.";
  return "";
};

export class InvalidMapsRefError extends AppleAutomationError {
  override readonly name = "InvalidMapsRefError";

  constructor(raw: string, want: "place" | "collection") {
    const shape = want === "place" ? '"p1:<kind>:<id>"' : '"pc1:<id>"';
    super(
      `"${raw}" is not a ${want} ref. Refs come from apple_maps_* results and look like ` +
        `${shape} — they are opaque and must not be constructed by hand.${otherSurface(raw)}`,
      { ref: raw },
    );
  }
}

export const encodePlaceRef = (kind: PlaceKind, key: EntityKey): string =>
  `${PLACE_REF_VERSION}:${KIND_CODE[kind]}:${fromKey(key)}`;

export const encodeCollectionRef = (key: EntityKey): string =>
  `${COLLECTION_REF_VERSION}:${fromKey(key)}`;

export const decodePlaceRef = (raw: string): { kind: PlaceKind; key: EntityKey } => {
  const m = PLACE_PATTERN.exec(raw.trim());
  const kind = m?.[1] ? CODE_KIND[m[1]] : undefined;
  if (!m?.[2] || !kind) throw new InvalidMapsRefError(raw, "place");
  return { kind, key: toKey(m[2]) };
};

export const decodeCollectionRef = (raw: string): EntityKey => {
  const m = COLLECTION_PATTERN.exec(raw.trim());
  if (!m?.[1]) throw new InvalidMapsRefError(raw, "collection");
  return toKey(m[1]);
};
