import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMapsClient } from "../client/maps.js";
import { decodeCollectionRef, decodePlaceRef } from "../client/ref.js";
import {
  collectionRefArg,
  compact,
  fail,
  limitArg,
  ok,
  placeRefArg,
  queryArg,
  resolveLimit,
  wrapResult,
} from "./util.js";

/**
 * The place tools.
 *
 * Every description states the permission fact plainly. On this surface it is
 * not the usual "slower without the grant" — there is no second lane, so
 * without Full Disk Access these tools have nothing to read. Saying so in the
 * description is what stops a model concluding, from an error it half-read,
 * that the person simply has not saved any places.
 */
export const registerPlaceTools = (server: McpServer, client: AppleMapsClient): void => {
  server.registerTool(
    "apple_maps_list_favorites",
    {
      description:
        "List the places saved as favourites in Maps, with coordinates, address and the label " +
        "the user gave them. Needs Full Disk Access — Maps is not scriptable, so without the " +
        "grant this returns an error rather than an empty list. Some entries have no linked " +
        "place (`linked: false`); those are the unconfigured Home/Work/School slots, not " +
        "broken rows. This is everything SAVED: Maps' own Pinned panel applies display rules " +
        "that are not in the store and can show fewer.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) =>
      wrapResult(async () => {
        const capped = resolveLimit(limit, client.config.maxResults);
        const result = client.places("favorite", { limit: capped });
        const unlinked = result.places.filter((p) => !p.linked).length;
        return ok(
          compact({
            favorites: result.places,
            count: result.places.length,
            unlinked: unlinked
              ? `${unlinked} entr${unlinked === 1 ? "y has" : "ies have"} no linked place — ` +
                `these are Maps' unconfigured Home/Work/School slots. They are returned rather ` +
                `than dropped, because silently omitting rows reads as a deletion.`
              : undefined,
            /**
             * MEASURED, and the reason the note above no longer claims this count
             * matches the app: on a real store Maps' Pinned panel showed 17 while
             * this tool returned 24. Three extras were the unlinked slots; four
             * were ordinary favourites with names, addresses and coordinates, one
             * an exact duplicate of a shown entry.
             *
             * No column in ZFAVORITEITEM separates them — ZHIDDEN, ZSOURCE, ZTYPE
             * and ZVERSION were all cross-tabulated and none yields a group of
             * four. `ZVERSION = 2` has exactly 17 rows and is a COINCIDENCE OF
             * TOTALS: 16 of them are linked while all 17 shown entries are. So
             * Maps applies display rules this server cannot see — de-duplication
             * is the visible one — and no filter written here could reproduce
             * them. Saying so beats guessing, and beats the old note, which
             * asserted the opposite of what was measured. See docs/maps.md.
             */
            mayExceedApp:
              "Maps' own Pinned panel can show FEWER places than this. It applies display " +
              "rules — de-duplication at least — that are not recorded in the store, so this " +
              "is everything saved, not everything shown.",
            truncated: result.truncated
              ? `More favourites exist beyond limit=${capped}.`
              : undefined,
            datesUnavailable: result.datesAvailable
              ? undefined
              : "Timestamps could not be placed on a known epoch, so every date reads null. " +
                "They are withheld rather than guessed — see apple_maps_diagnostics.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_list_collections",
    {
      description:
        "List the collections (Guides) in Maps. Each carries Maps' own count of the places in " +
        "it. Use apple_maps_list_collection_places to enumerate one. Needs Full Disk Access.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) =>
      wrapResult(async () => {
        const capped = resolveLimit(limit, client.config.maxResults);
        const result = client.collections({ limit: capped });
        return ok(
          compact({
            collections: result.collections,
            count: result.collections.length,
            // The guides do not account for every saved place, and silence
            // about that reads as "there are no others".
            unfiled:
              result.unfiled && result.unfiled > 0
                ? `${result.unfiled} saved place(s) are in no collection. ` +
                  `List them with apple_maps_list_unfiled_places.`
                : undefined,
            // The honest version of a capability this server may not have.
            itemsUnavailable: result.itemsEnumerable
              ? undefined
              : "This store does not expose how an item belongs to a collection, so the places " +
                "inside a collection cannot be listed. `placesCount` is Maps' own number and is " +
                "still accurate; apple_maps_list_collection_places will return nothing.",
            truncated: result.truncated
              ? `More collections exist beyond limit=${capped}.`
              : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_list_collection_places",
    {
      description:
        "List the places filed in one collection, by its ref. Needs Full Disk Access. Returns " +
        "nothing when this store does not expose collection membership — check " +
        "apple_maps_diagnostics, which reports whether the key was resolved.",
      inputSchema: { ref: collectionRefArg, limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref, limit }) =>
      wrapResult(async () => {
        const collectionId = client.collectionRowId(decodeCollectionRef(ref));
        const capped = resolveLimit(limit, client.config.maxResults);
        const result = client.places("collection-item", {
          limit: capped,
          collectionId: collectionId ?? undefined,
        });
        const collections = client.collections({ limit: 1_000 });
        if (!collections.itemsEnumerable) {
          return fail(
            "This store does not expose which collection an item belongs to, so its places " +
              "cannot be listed. The collection itself and its place count are still readable " +
              "through apple_maps_list_collections.",
          );
        }
        return ok(
          compact({
            places: result.places,
            count: result.places.length,
            truncated: result.truncated
              ? `More places exist beyond limit=${capped}.`
              : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_list_unfiled_places",
    {
      description:
        "List saved places that are in no collection. Maps files a saved place into a Guide " +
        "through a join table, and a place can exist with no row there — 12 of 30 on the probed " +
        "machine, 7 of which appear nowhere else in the store: not as a favourite, not in " +
        "another Guide, not in recents. Those are reachable through no other tool. Needs Full " +
        "Disk Access. Returns nothing when collection membership could not be resolved, which " +
        "apple_maps_diagnostics reports.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) =>
      wrapResult(async () => {
        const collections = client.collections({ limit: 1 });
        if (!collections.itemsEnumerable) {
          return fail(
            "This store does not expose which collection an item belongs to, so places in no " +
              "collection cannot be told apart from places in one. " +
              "apple_maps_list_collections still works.",
          );
        }
        const capped = resolveLimit(limit, client.config.maxResults);
        const result = client.places("collection-item", {
          limit: capped,
          unfiled: true,
        });
        return ok(
          compact({
            places: result.places,
            count: result.places.length,
            truncated: result.truncated
              ? `More places exist beyond limit=${capped}.`
              : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_list_recents",
    {
      description:
        "List the places recently looked at in Maps, newest first. This is Maps' Recents list, " +
        "not a search history: it holds places, directions and searches the user actually " +
        "opened. Needs Full Disk Access.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) =>
      wrapResult(async () => {
        const capped = resolveLimit(limit, client.config.maxResults);
        const result = client.places("history", { limit: capped });
        const named = result.places.filter((p) => p.name).length;
        return ok(
          compact({
            recents: result.places,
            count: result.places.length,
            // MEASURED: 1 of 33 rows carried a name. A recent's place name
            // lives in the linked map item's undecoded blob, not in a column,
            // so most rows have coordinates and no label. Saying so stops a
            // caller reporting "33 unnamed places" as if the data were damaged.
            namesUnavailable:
              result.places.length > 0 && named * 4 < result.places.length
                ? `Only ${named} of ${result.places.length} entries carry a name. Maps keeps a ` +
                  `recent's place name in an encoded record this server does not decode, so most ` +
                  `rows have coordinates and dates but no label. This is the store's shape, not ` +
                  `missing data.`
                : undefined,
            truncated: result.truncated
              ? `More entries exist beyond limit=${capped}.`
              : undefined,
            datesUnavailable: result.datesAvailable
              ? undefined
              : "Timestamps could not be placed on a known epoch, so every date reads null.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_search_places",
    {
      description:
        "Search every saved place — favourites, collection entries and recents — by name, by " +
        "the label the user gave it, or by address. Returns each match with the kind of entry " +
        "it came from. Needs Full Disk Access. This searches what is SAVED on this Mac; it " +
        "does not search Apple's map of the world.",
      inputSchema: { query: queryArg, limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit }) =>
      wrapResult(async () => {
        const capped = resolveLimit(limit, client.config.maxResults);
        const result = client.search({ query, limit: capped });
        return ok(
          compact({
            places: result.places,
            count: result.places.length,
            truncated: result.truncated
              ? `More matches exist beyond limit=${capped}.`
              : undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_get_place",
    {
      description:
        "Get one saved place by its ref, with coordinates, address and dates. Needs Full Disk " +
        "Access.",
      inputSchema: { ref: placeRefArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const { kind, key } = decodePlaceRef(ref);
        const place = client.place(kind, key);
        if (!place) {
          return fail(
            "uuid" in key
              ? `No place for that ref. It was removed in Maps, or it belongs to a different ` +
                  `store than the one being read.`
              : `No place for that ref. It may have been removed in Maps, or iCloud may have ` +
                  `re-synced the store and renumbered the rows since the listing ran — this ref ` +
                  `carries a row id, which only this store's current numbering can resolve. ` +
                  `Re-run the listing for a current ref.`,
          );
        }
        return ok({ place });
      }),
  );
};
