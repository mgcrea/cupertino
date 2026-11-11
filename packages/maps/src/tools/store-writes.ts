import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { LaneWrite, MapsLane } from "../client/lane.js";
import type { AppleMapsClient } from "../client/maps.js";
import type { PlaceSource, StoredPlace } from "../client/place-source.js";
import {
  decodePlaceRef,
  encodePlaceRef,
  InvalidMapsRefError,
  type PlaceKind,
} from "../client/ref.js";
import type { EntityKey } from "../client/store.js";
import { compact, confirmArg, fail, ok, placeRefArg, type ToolResult, wrapResult } from "./util.js";

/** The five tools this file registers, in registration order. */
export const STORE_WRITE_TOOLS: readonly string[] = [
  "apple_maps_add_favorite",
  "apple_maps_remove_favorite",
  "apple_maps_save_place",
  "apple_maps_remove_saved_place",
  "apple_maps_add_place_to_guide",
];

/**
 * What a write promises about iCloud, in one sentence, on Voice Memos' pattern
 * (`packages/voice-memos/src/tools/store-writes.ts`).
 *
 * Sync is promised only on a model version whose upload was measured: Maps'
 * DataModel_0_0_1 on macOS 27.2, every write seen on a Mac and an iPhone on
 * 2026-11-11, one with Maps quit and mapssyncd exporting alone (`docs/maps.md`,
 * "Measured 2026-11-11"). Elsewhere the save still happened, but nobody has
 * watched it reach another device, so the result says so.
 */
export const syncSentence = (w: Pick<LaneWrite, "changed" | "syncMeasured" | "modelVersion">) => {
  if (w.changed.length === 0) return "Nothing to change.";
  if (w.syncMeasured) {
    return (
      "Saved the way Maps saves it. It reaches your other devices through iCloud, even with " +
      "Maps closed."
    );
  }
  return (
    `Saved, but sync is not yet measured on this macOS (model ${w.modelVersion ?? "unknown"}): ` +
    "check the place on another device."
  );
};

/** The lane's own fields, plus the sentence. */
const laneFields = (w: LaneWrite) => ({
  changed: w.changed,
  modelVersion: w.modelVersion,
  syncMeasured: w.syncMeasured,
  sync: syncSentence(w),
});

/**
 * The answer when an item already stood there and the lane was never asked: no
 * model version to report, because nothing was saved.
 */
const unchanged = { changed: [] as string[], sync: "Nothing to change." };

const RECENTS_NOTE =
  "Maps was asked to resolve this place, so it now also appears in the user's Recents. That " +
  "is how the place record is obtained and cannot be avoided.";

/** Every lane tool says this after what it does. */
const SAVED_LIKE =
  "Saved through Maps' own data model inside Cupertino, as a change made in the app is; the " +
  "result's `sync` says whether that is measured to reach the user's other Apple devices on " +
  "this macOS. Only available when Cupertino hosts this server.";

/** The three tools that may need a place record Maps has not minted yet. */
const SEEDS =
  "SIDE EFFECT: unless the place is already in the store, Maps is asked to resolve it by name " +
  "and the place also appears in the user's Recents; there is no way to have the record " +
  "without that.";

/**
 * Where an unpinned place went. Maps does not delete a pin it unpins: it moves
 * the place into the library as a saved place (watched 2026-11-11,
 * `docs/maps.md`), and the lane does the same. `changed` lists `savedPlace`
 * when the lane made one. Only `favorite` has two causes the answer does not
 * tell apart: a saved place already stood at that spot, or the pin carried no
 * place record or coordinate to move. The sentence is true of both.
 */
const libraryNote = (changed: string[]): string | undefined => {
  if (!changed.includes("favorite")) return undefined;
  // An existing saved place may be filed in a Guide, so both listings are named.
  const from =
    "by its ref from apple_maps_list_unfiled_places or apple_maps_list_collection_places.";
  return changed.includes("savedPlace")
    ? "Unpinned, and kept in your library as a saved place, as Maps does. " +
        `apple_maps_remove_saved_place removes it entirely, ${from}`
    : "Unpinned. No new saved place was made: one already stood at this spot, or the pin " +
        "carried no place record to keep. apple_maps_remove_saved_place removes a saved " +
        `place entirely, ${from}`;
};

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const REMOVE = { ...WRITE, destructiveHint: true } as const;

const queryArg = z
  .string()
  .min(1)
  .describe(
    "The place's name, as you would type it into Maps' search field. A bare coordinate does " +
      "not identify a place to Maps.",
  );
const latitudeArg = z
  .number()
  .min(-90)
  .max(90)
  .optional()
  .describe("Latitude, when known: makes the match exact and can skip asking Maps.");
const longitudeArg = z.number().min(-180).max(180).optional().describe("Longitude, when known.");

/** A refusal decided here, before the lane is called, in the lane's own vocabulary. */
const refuse = (reason: "invalid" | "notFound", message: string) => fail(message, { reason });

/**
 * Both halves of a coordinate, or neither. Half of one is a caller's mistake,
 * refused rather than dropped: dropping it would seed by name alone and could
 * save a namesake on the other side of the world.
 */
const coordsOf = (
  latitude: number | undefined,
  longitude: number | undefined,
): { near: { latitude: number; longitude: number } | undefined } | { refusal: ToolResult } => {
  if (latitude !== undefined && longitude !== undefined) return { near: { latitude, longitude } };
  if (latitude === undefined && longitude === undefined) return { near: undefined };
  return { refusal: refuse("invalid", "Give both latitude and longitude, or neither.") };
};

/** Where `find` got the record, as the lane names it. */
const fromSource = (s: PlaceSource) => ({ source: s.kind, sourceId: s.id });

/**
 * A place in an answer: its ref, and the item's own name and coordinate as the
 * store holds them. Fields the read-back did not find are left out, never
 * filled with what the caller asked for.
 */
const described = (
  client: AppleMapsClient,
  kind: "favorite" | "collection-item",
  id: string,
  stored?: StoredPlace | null,
) => {
  const row = stored === undefined ? client.placeSource().describe(kind, id) : stored;
  return compact({
    ref: encodePlaceRef(kind, { uuid: id }),
    name: row?.name ?? undefined,
    latitude: row?.latitude ?? undefined,
    longitude: row?.longitude ?? undefined,
  });
};

/**
 * A ref from a listing to the identifier the lane fetches by, or a refusal.
 *
 * A ref that does not decode is refused `invalid`, like every other refusal
 * decided here. Null from `identifierOf` is a row with no `ZIDENTIFIER` (a
 * row-id ref), or no row at all: either way the lane, which fetches by uuid
 * only, cannot be given it, so the lane is not called.
 */
const identifierFor = (
  client: AppleMapsClient,
  ref: string,
  want: Exclude<PlaceKind, "history">,
  verb: "removed" | "filed",
): { id: string } | { refusal: ToolResult } => {
  let decoded: { kind: PlaceKind; key: EntityKey };
  try {
    decoded = decodePlaceRef(ref);
  } catch (err) {
    if (err instanceof InvalidMapsRefError) {
      return { refusal: refuse("invalid", err.message) };
    }
    throw err;
  }
  const { kind, key } = decoded;
  const what = want === "favorite" ? "favourite" : "saved place";
  if (kind !== want) {
    const is = kind === "history" ? "recent" : kind === "favorite" ? "favourite" : "saved place";
    const from =
      want === "favorite"
        ? "apple_maps_list_favorites"
        : "apple_maps_list_unfiled_places or apple_maps_list_collection_places";
    return {
      refusal: refuse(
        "invalid",
        `That ref points at a ${is}, not a ${what}. Pass a ref from ${from}.`,
      ),
    };
  }
  const id = client.placeSource().identifierOf(kind, key);
  if (id === null) {
    return {
      refusal: refuse(
        "notFound",
        "uuid" in key
          ? `No ${what} matched that ref. It may already have been removed; re-run the listing.`
          : `This ${what} has no stable id, so it cannot be ${verb} ` +
              "through Cupertino (or it is no longer in the store).",
      ),
    };
  }
  return { id };
};

/**
 * The store lane's Maps tools. Registered only when writes are on and
 * Cupertino hosts this server; see `tools/index.ts`, which then registers
 * neither the SQL tools (`writes.ts`) nor the interface ones (`ax-writes.ts`).
 *
 * This side keeps what only it can do: de-duplicate on the caller's coordinate
 * and name before anything else, find a place record Maps minted (seeding when
 * there is none), and turn a listing's ref into the identifier the lane fetches
 * by. The app validates every argument again and answers with a `reason` on
 * refusal (`invalid`, `notFound`, `incompatible`, `writesOff`, `failed`, or one
 * of the connection's own), which the tool error carries in `details.reason`.
 * Refusals decided here use the same vocabulary.
 *
 * A place in an answer is the item as the store holds it, read back after the
 * lane answers: the de-duplication can match a favourite saved under another
 * name, or ~250 m from the caller's coordinate, and the caller's guess must
 * not be reported as the place.
 *
 * The list does not depend on whether the lane is compatible: MCP clients cache
 * it, so an incompatible lane refuses per call instead.
 */
export const registerStoreWriteTools = (
  server: McpServer,
  client: AppleMapsClient,
  lane: MapsLane,
): void => {
  server.registerTool(
    "apple_maps_add_favorite",
    {
      description:
        "Save a place to Maps' favourites (the Pinned list). Give the place NAME as `query`, " +
        "and latitude/longitude when known. " +
        `${SEEDS} ${SAVED_LIKE} Idempotent: asking twice for the same place returns the ` +
        "existing favourite rather than creating a second. Needs Full Disk Access.",
      inputSchema: z.object({
        query: queryArg,
        latitude: latitudeArg,
        longitude: longitudeArg,
        name: z.string().min(1).optional().describe("Label to save it under. Defaults to `query`."),
      }),
      annotations: WRITE,
    },
    async ({ query, latitude, longitude, name }) =>
      wrapResult(async () => {
        const label = name ?? query;
        const coords = coordsOf(latitude, longitude);
        if ("refusal" in coords) return coords.refusal;
        const { near } = coords;
        const finder = client.placeSource();
        const existing = near ? finder.existingFavorite({ ...near, name: label }) : null;
        if (existing) {
          return ok({
            favorite: described(client, "favorite", existing.id, existing),
            created: false,
            alreadyExisted:
              "A favourite for this place already existed and was returned unchanged.",
            ...unchanged,
          });
        }
        const s = await finder.find(near ? { query, ...near } : { query });
        const w = await lane.addFavorite({ ...fromSource(s), name: label, near });
        return ok(
          compact({
            favorite: described(client, "favorite", w.id),
            created: w.created,
            alreadyExisted: w.created
              ? undefined
              : "A favourite for this place already existed and was returned unchanged.",
            ...laneFields(w),
            recentsNote: s.seeded ? RECENTS_NOTE : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_remove_favorite",
    {
      description:
        "Unpin a place from Maps' favourites (the Pinned list), by a ref from " +
        "apple_maps_list_favorites. As in Maps, unpinning keeps the place in the user's " +
        "library as a saved place, in no Guide; no new one is made when one already stands " +
        "at that spot, or the pin carries no place record. " +
        "apple_maps_remove_saved_place removes it entirely. Only pins: the Home, Work and " +
        "School slots are refused. It does not touch Guides or Recents. " +
        `${SAVED_LIKE} Needs Full Disk Access, and an explicit confirm: the unpin is not ` +
        "undoable from here.",
      inputSchema: z.object({ ref: placeRefArg, confirm: confirmArg }),
      annotations: REMOVE,
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const target = identifierFor(client, ref, "favorite", "removed");
        if ("refusal" in target) return target.refusal;
        const w = await lane.removeFavorite(target.id);
        return ok(
          compact({
            removed: w.changed.length > 0,
            id: w.id,
            library: libraryNote(w.changed),
            ...laneFields(w),
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_save_place",
    {
      description:
        "Save a place into Maps' Places library, in no Guide. This is NOT a favourite: the " +
        "Pinned list is a different set, written by apple_maps_add_favorite. Give the place " +
        `NAME as \`query\`, and latitude/longitude when known. ${SEEDS} ${SAVED_LIKE} ` +
        "Idempotent: a place already saved is returned unchanged. Needs Full Disk Access.",
      inputSchema: z.object({
        query: queryArg,
        latitude: latitudeArg,
        longitude: longitudeArg,
        name: z.string().min(1).optional().describe("Label to save it under. Defaults to `query`."),
      }),
      annotations: WRITE,
    },
    async ({ query, latitude, longitude, name }) =>
      wrapResult(async () => {
        const label = name ?? query;
        const coords = coordsOf(latitude, longitude);
        if ("refusal" in coords) return coords.refusal;
        const { near } = coords;
        const finder = client.placeSource();
        const existing = near ? finder.existingSavedPlace({ ...near, name: label }) : null;
        if (existing) {
          return ok({
            place: described(client, "collection-item", existing.id, existing),
            saved: true,
            alreadySaved: true,
            created: false,
            ...unchanged,
          });
        }
        const s = await finder.find(near ? { query, ...near } : { query });
        const w = await lane.savePlace({ ...fromSource(s), name: label, near });
        return ok(
          compact({
            place: described(client, "collection-item", w.id),
            saved: true,
            alreadySaved: !w.created,
            created: w.created,
            ...laneFields(w),
            recentsNote: s.seeded ? RECENTS_NOTE : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_remove_saved_place",
    {
      description:
        "Remove a place from Maps' Places library, by a ref from " +
        "apple_maps_list_unfiled_places or apple_maps_list_collection_places. That takes it " +
        "out of every Guide it is filed in. This does NOT touch favourites: use " +
        `apple_maps_remove_favorite for those. ${SAVED_LIKE} Needs Full Disk Access, and an ` +
        "explicit confirm: the removal is not undoable from here.",
      inputSchema: z.object({ ref: placeRefArg, confirm: confirmArg }),
      annotations: REMOVE,
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const target = identifierFor(client, ref, "collection-item", "removed");
        if ("refusal" in target) return target.refusal;
        const w = await lane.removeSavedPlace(target.id);
        return ok({ removed: w.changed.length > 0, id: w.id, ...laneFields(w) });
      }),
  );

  server.registerTool(
    "apple_maps_add_place_to_guide",
    {
      description:
        "File a place into one of Maps' Guides. Give either `ref`, a saved place from " +
        "apple_maps_list_unfiled_places or apple_maps_list_collection_places, or `query` " +
        "(with latitude/longitude when known) for a place to save and file in one save; not " +
        "both. The Guide must already exist, and a name that matches none, or several, is " +
        "refused naming the candidates. `filed` comes from reading the Guide back after the " +
        `save, never from having asked. ${SEEDS} ${SAVED_LIKE} Needs Full Disk Access.`,
      inputSchema: z.object({
        guide: z.string().min(1).describe("The Guide's name, as Maps shows it."),
        ref: placeRefArg
          .optional()
          .describe(
            "A saved place's ref, from apple_maps_list_unfiled_places or " +
              "apple_maps_list_collection_places. Give this or `query`, not both.",
          ),
        query: queryArg
          .optional()
          .describe(
            "The place's name, for a place to save first, as apple_maps_save_place takes it. " +
              "Give this or `ref`, not both.",
          ),
        latitude: latitudeArg.describe("Latitude, with `query`, when known."),
        longitude: longitudeArg.describe("Longitude, with `query`, when known."),
      }),
      annotations: WRITE,
    },
    async ({ guide, ref, query, latitude, longitude }) =>
      wrapResult(async () => {
        const hasCoords = latitude !== undefined || longitude !== undefined;
        if ((ref === undefined) === (query === undefined) || (ref !== undefined && hasCoords)) {
          return refuse(
            "invalid",
            "Give either `ref` (a saved place) or `query` with an optional latitude and " +
              "longitude (a place to save first): exactly one of the two.",
          );
        }
        const filedAnswer = (w: LaneWrite, seeded: boolean) =>
          ok(
            compact({
              filed: w.filed,
              guide,
              place: described(client, "collection-item", w.id),
              ...laneFields(w),
              recentsNote: seeded ? RECENTS_NOTE : undefined,
            }),
          );

        if (ref !== undefined) {
          const target = identifierFor(client, ref, "collection-item", "filed");
          if ("refusal" in target) return target.refusal;
          return filedAnswer(await lane.fileInGuide({ guide, placeId: target.id }), false);
        }

        const name = query as string;
        const coords = coordsOf(latitude, longitude);
        if ("refusal" in coords) return coords.refusal;
        const { near } = coords;
        const finder = client.placeSource();
        const existing = near ? finder.existingSavedPlace({ ...near, name }) : null;
        if (existing) {
          return filedAnswer(await lane.fileInGuide({ guide, placeId: existing.id }), false);
        }
        const s = await finder.find(near ? { query: name, ...near } : { query: name });
        const w = await lane.fileInGuide({ guide, ...fromSource(s), name, near });
        return filedAnswer(w, s.seeded);
      }),
  );
};
