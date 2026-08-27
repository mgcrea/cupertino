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
        "broken rows.",
      inputSchema: { limit: limitArg },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ limit }) =>
      wrapResult(async () => {
        const result = client.places("favorite", { limit: limit ?? client.config.maxResults });
        const unlinked = result.places.filter((p) => !p.linked).length;
        return ok(
          compact({
            favorites: result.places,
            count: result.places.length,
            unlinked: unlinked
              ? `${unlinked} entr${unlinked === 1 ? "y has" : "ies have"} no linked place — ` +
                `these are Maps' unconfigured Home/Work/School slots, returned rather than ` +
                `hidden so the count matches what the app shows.`
              : undefined,
            truncated: result.truncated
              ? `More favourites exist beyond limit=${limit ?? client.config.maxResults}.`
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
        const result = client.collections({ limit: limit ?? client.config.maxResults });
        return ok(
          compact({
            collections: result.collections,
            count: result.collections.length,
            // The honest version of a capability this server may not have.
            itemsUnavailable: result.itemsEnumerable
              ? undefined
              : "This store does not expose how an item belongs to a collection, so the places " +
                "inside a collection cannot be listed. `placesCount` is Maps' own number and is " +
                "still accurate; apple_maps_list_collection_places will return nothing.",
            truncated: result.truncated
              ? `More collections exist beyond limit=${limit ?? client.config.maxResults}.`
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
        const id = decodeCollectionRef(ref);
        const result = client.places("collection-item", {
          limit: limit ?? client.config.maxResults,
          collectionId: id,
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
              ? `More places exist beyond limit=${limit ?? client.config.maxResults}.`
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
        const result = client.places("history", { limit: limit ?? client.config.maxResults });
        return ok(
          compact({
            recents: result.places,
            count: result.places.length,
            truncated: result.truncated
              ? `More entries exist beyond limit=${limit ?? client.config.maxResults}.`
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
        const result = client.search({ query, limit: limit ?? client.config.maxResults });
        return ok(
          compact({
            places: result.places,
            count: result.places.length,
            truncated: result.truncated
              ? `More matches exist beyond limit=${limit ?? client.config.maxResults}.`
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
        const { kind, id } = decodePlaceRef(ref);
        const place = client.place(kind, id);
        if (!place) {
          return fail(
            `No place for that ref. It may have been removed in Maps, or iCloud may have ` +
              `re-synced the store and renumbered the rows since the listing ran. Re-run the ` +
              `listing for a current ref.`,
          );
        }
        return ok({ place });
      }),
  );
};
