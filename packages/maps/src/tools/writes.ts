import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppleMapsClient } from "../client/maps.js";
import { decodePlaceRef } from "../client/ref.js";
import { compact, fail, ok, placeRefArg, wrapResult } from "./util.js";

/**
 * The mutating tools.
 *
 * Registered only when `APPLE_MAPS_ALLOW_WRITES` is true, so a host that has not
 * opted in is never told they exist — the same gate every other surface uses.
 *
 * ## Two things these descriptions must say, because they are surprising
 *
 * **Adding a favourite leaves an entry in Recents.** A place is only real to
 * Maps once it has a GEO record, and the only thing that can produce one is Maps
 * itself: the place is opened through the `maps://` URL scheme, Maps resolves it
 * and files it in Recents, and that record is copied into the favourite. There
 * is no way to have the first without the second, so the caller is told rather
 * than surprised. When the place is already known to the store, no seeding
 * happens and no Recents entry appears.
 *
 * **It reaches the user's other devices.** The store is mirrored by
 * `NSPersistentCloudKitContainer`, which reconciles on the app's next save
 * whether or not it was told anything. A favourite added here arrived on an
 * iPhone. That makes this the one write in the bundle whose blast radius is
 * larger than the machine it runs on, and the descriptions say so.
 */
export const registerWriteTools = (server: McpServer, client: AppleMapsClient): void => {
  server.registerTool(
    "apple_maps_add_favorite",
    {
      description:
        "Save a place to Maps' favourites (the Pinned list). Give the place NAME as `query` — a " +
        "bare coordinate does not identify a place to Maps — and latitude/longitude when known, " +
        "which makes the match exact and skips the lookup. SIDE EFFECT: unless the place is " +
        "already in the store, Maps is asked to resolve it and the place also appears in the " +
        "user's Recents; there is no way to add a favourite without that. The favourite syncs " +
        "to the user's other Apple devices through iCloud. Idempotent: asking twice for the same " +
        "place returns the existing favourite rather than creating a second. Needs Full Disk " +
        "Access.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("The place's name, as you would type it into Maps' search field."),
        latitude: z.number().min(-90).max(90).optional().describe("Latitude, when known."),
        longitude: z.number().min(-180).max(180).optional().describe("Longitude, when known."),
        name: z.string().min(1).optional().describe("Label to save it under. Defaults to `query`."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ query, latitude, longitude, name }) =>
      wrapResult(async () => {
        const result = client.writer().addFavorite({ query, latitude, longitude, name });
        return ok(
          compact({
            favorite: {
              ref: `p1:f:${result.uuid.replaceAll("-", "")}`,
              name: result.name,
              latitude: result.latitude,
              longitude: result.longitude,
            },
            created: result.created,
            alreadyExisted: result.created
              ? undefined
              : "A favourite for this place already existed and was returned unchanged.",
            recentsNote: result.seeded
              ? "Maps was asked to resolve this place, so it now also appears in the user's " +
                "Recents. That is how the place record is obtained and cannot be avoided."
              : undefined,
            syncNote:
              "This favourite will reach the user's other Apple devices through iCloud once " +
              "Maps next runs.",
          }),
        );
      }),
  );

  server.registerTool(
    "apple_maps_remove_favorite",
    {
      description:
        "Remove a place from Maps' favourites, by a ref from apple_maps_list_favorites. This " +
        "deletes the favourite on the user's other Apple devices too, through iCloud. It does " +
        "not affect Guides, Recents, or anything else that references the same place. Needs " +
        "Full Disk Access.",
      inputSchema: { ref: placeRefArg },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    },
    async ({ ref }) =>
      wrapResult(async () => {
        const { kind, key } = decodePlaceRef(ref);
        if (kind !== "favorite") {
          return fail(
            `That ref points at a ${kind === "history" ? "recent" : "collection entry"}, not a ` +
              `favourite. Only favourites can be removed; pass a ref from ` +
              `apple_maps_list_favorites.`,
          );
        }
        const removed = client.writer().removeFavorite(key);
        if (!removed) {
          return fail(
            "No favourite matched that ref. It may already have been removed, or the listing " +
              "it came from may predate a change. Re-run apple_maps_list_favorites.",
          );
        }
        return ok({
          removed: true,
          syncNote:
            "The removal will reach the user's other Apple devices through iCloud once Maps " +
            "next runs.",
        });
      }),
  );
};
