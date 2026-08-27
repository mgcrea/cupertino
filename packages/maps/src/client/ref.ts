import { AppleAutomationError } from "@mgcrea/mcp-apple-core";

/**
 * Refs for places and collections.
 *
 * ## Why the ref carries the row id and not `ZMUID`
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
 * The row id addresses the entry, which is what every tool here returns. The
 * kind is carried in the prefix so a favourite ref and a collection-item ref
 * can never be confused for one another.
 *
 * ## The cost, stated rather than hidden
 *
 * Core Data reuses `Z_PK` values after a delete, and this store is mirrored
 * from CloudKit, so a re-sync can renumber rows underneath a conversation.
 * `packages/messages` rejected rowids for exactly this reason. The difference
 * here is that there is no alternative that addresses an entry, so instead of
 * pretending the problem away every resolver re-reads the row and the tools say
 * plainly that a ref is only good for the current session.
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

const PLACE_PATTERN = /^p1:([fch]):(\d+)$/;
const COLLECTION_PATTERN = /^pc1:(\d+)$/;

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

export const encodePlaceRef = (kind: PlaceKind, id: number): string =>
  `${PLACE_REF_VERSION}:${KIND_CODE[kind]}:${id}`;

export const encodeCollectionRef = (id: number): string => `${COLLECTION_REF_VERSION}:${id}`;

export const decodePlaceRef = (raw: string): { kind: PlaceKind; id: number } => {
  const m = PLACE_PATTERN.exec(raw.trim());
  const kind = m?.[1] ? CODE_KIND[m[1]] : undefined;
  if (!m?.[2] || !kind) throw new InvalidMapsRefError(raw, "place");
  return { kind, id: Number(m[2]) };
};

export const decodeCollectionRef = (raw: string): number => {
  const m = COLLECTION_PATTERN.exec(raw.trim());
  if (!m?.[1]) throw new InvalidMapsRefError(raw, "collection");
  return Number(m[1]);
};
