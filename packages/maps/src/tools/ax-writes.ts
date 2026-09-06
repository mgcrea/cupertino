import { interferenceNote } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { MapsAxLane } from "../client/ax.js";
import { fail, ok, wrapResult } from "./util.js";

/**
 * The tools that go through Maps' own interface rather than its store.
 *
 * ## Why these are not in `writes.ts`
 *
 * Different lane, different objects, different failure modes. `writes.ts` writes
 * SQL into the Core Data store and reaches **favourites**; these press controls
 * on a place card and reach the **Places library** and **guide membership** —
 * two sets the SQL lane does not offer at all. `docs/maps.md` lists guide
 * membership as unbuilt for exactly that reason.
 *
 * ## Registered only when the app is hosting this server
 *
 * The Accessibility grant belongs to Cupertino.app, not to node, so a package
 * installed from npm and run by hand has no lane here and these tools are not
 * registered at all — the same rule the write gate follows, so a host is never
 * told about a tool that cannot work for it.
 *
 * ## What every description has to say
 *
 * **It opens Maps and leaves the place in Recents.** Reaching a card means
 * opening `maps://`, which is how the SQL lane seeds a record too. There is no
 * way to have the card without the Recents entry.
 *
 * **It moves the user's screen.** Unlike a SQL write, this brings a window
 * forward and presses things in it. That is worth stating plainly.
 */
const noCard = (query: string, disturbed: string) =>
  fail(
    `Maps did not show a place card for "${query}" within 10s. Nothing was changed. The ` +
      `coordinates may not resolve to a place Maps recognises, or Maps may not have finished ` +
      `loading it.` +
      disturbed,
  );

export const registerAxWriteTools = (server: McpServer, lane: MapsAxLane): void => {
  const place = {
    query: z
      .string()
      .min(1)
      .describe("The place's name, as you would type it into Maps' search field."),
    latitude: z.number().min(-90).max(90).describe("Latitude of the place."),
    longitude: z.number().min(-180).max(180).describe("Longitude of the place."),
  };

  const openCard = async (args: { query: string; latitude: number; longitude: number }) =>
    lane.openCard({ name: args.query, latitude: args.latitude, longitude: args.longitude });

  server.registerTool(
    "apple_maps_save_place",
    {
      description:
        "Save a place into Maps' Places library, by pressing Add on its card. This is NOT a " +
        "favourite: the Pinned list is a different set, written by apple_maps_add_favorite. " +
        "Maps performs the write itself, so it cannot produce a malformed record. SIDE EFFECTS: " +
        "opens Maps, brings its window forward, and leaves the place in the user's Recents. " +
        "Syncs to the user's other Apple devices. Needs Accessibility for Cupertino.",
      inputSchema: place,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      wrapResult(async () => {
        // Watched from before Maps is even asked to open, so a disturbed run
        // says so rather than blaming the app. This is the lane where that
        // actually happened: three separate failures were attributed to Maps
        // and two of them were somebody typing.
        const watch = lane.watch();
        const disturbed = async () => interferenceNote(await watch.check());
        if (!(await openCard(args))) return noCard(args.query, await disturbed());
        if ((await lane.isSaved()) === true) {
          return ok({ saved: true, alreadySaved: true, query: args.query });
        }
        if (!(await lane.savePlace())) {
          return fail(
            `The card for "${args.query}" opened but the naming sheet did not, so nothing was ` +
              `saved. The card may still be on screen.` +
              (await disturbed()),
          );
        }
        // Read the state bit back rather than trusting the press, which is the
        // rule the whole write half of this repo is built on — and re-open the
        // card to do it, because saving DISMISSES the card that carries the bit.
        const saved = await lane.verifySaved({
          name: args.query,
          latitude: args.latitude,
          longitude: args.longitude,
        });
        return saved === true
          ? ok({ saved: true, alreadySaved: false, query: args.query })
          : fail(
              `"${args.query}" was pressed through the save sheet but its card does not report it ` +
                `as saved, so this MUST NOT be reported as done. Check Maps.` +
                (await disturbed()),
            );
      }),
  );

  server.registerTool(
    "apple_maps_remove_saved_place",
    {
      description:
        "Remove a place from Maps' Places library, through the card's overflow menu. This does " +
        "NOT touch favourites — use apple_maps_remove_favorite for those. SIDE EFFECTS: opens " +
        "Maps, brings its window forward, and leaves the place in the user's Recents. Syncs to " +
        "the user's other Apple devices. Needs Accessibility for Cupertino.",
      inputSchema: place,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      wrapResult(async () => {
        // Watched from before Maps is even asked to open, so a disturbed run
        // says so rather than blaming the app. This is the lane where that
        // actually happened: three separate failures were attributed to Maps
        // and two of them were somebody typing.
        const watch = lane.watch();
        const disturbed = async () => interferenceNote(await watch.check());
        if (!(await openCard(args))) return noCard(args.query, await disturbed());
        const outcome = await lane.removePlace();
        if (outcome === "not-saved") {
          return ok({ removed: false, wasSaved: false, query: args.query });
        }
        if (outcome === "no-menu") {
          return fail(
            `The card for "${args.query}" opened but its overflow menu did not, so nothing was ` +
              `removed.` +
              (await disturbed()),
          );
        }
        const saved = await lane.verifySaved({
          name: args.query,
          latitude: args.latitude,
          longitude: args.longitude,
        });
        return saved === false
          ? ok({ removed: true, wasSaved: true, query: args.query })
          : fail(
              `"${args.query}" was pressed through Delete from Places but its card still reports ` +
                `it as saved, so this MUST NOT be reported as done. Check Maps.` +
                (await disturbed()),
            );
      }),
  );

  server.registerTool(
    "apple_maps_add_place_to_guide",
    {
      description:
        "File a place into one of Maps' Guides, through the card's Add to Guides picker. This " +
        "is the write apple_maps_list_collections has no counterpart for. IT CANNOT CONFIRM " +
        "ITSELF: Maps does not expose whether the place ended up in the guide, so the " +
        'result says filed: "unverified" and it must not be reported as done. The guide must ' +
        "already exist; when the name does not match, the refusal lists every guide Maps " +
        "offers, which is the authoritative list and can differ from what " +
        "apple_maps_list_collections returns. SIDE EFFECTS: opens Maps, brings its window " +
        "forward, and leaves the place in the user's Recents. Syncs to the user's other Apple " +
        "devices. Needs Accessibility for Cupertino.",
      inputSchema: {
        ...place,
        guide: z.string().min(1).describe("Name of the guide to file it into, as Maps shows it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      wrapResult(async () => {
        // Watched from before Maps is even asked to open, so a disturbed run
        // says so rather than blaming the app. This is the lane where that
        // actually happened: three separate failures were attributed to Maps
        // and two of them were somebody typing.
        const watch = lane.watch();
        const disturbed = async () => interferenceNote(await watch.check());
        if (!(await openCard(args))) return noCard(args.query, await disturbed());
        const guides = await lane.openGuidePicker();
        if (guides === null) {
          return fail(
            `The card for "${args.query}" opened but its Add to Guides picker did not, so nothing ` +
              `was filed.` +
              (await disturbed()),
          );
        }
        if (!(await lane.chooseGuide(args.guide))) {
          await lane.cancelGuidePicker();
          return fail(
            `Maps offers no guide called "${args.guide}", so nothing was filed. It offers: ` +
              `${guides.map((g) => g.name).join(", ")}.`,
            { guides: compactGuides(guides) },
          );
        }
        // NOT `filed: true`. The press lands — watching the screen, the row
        // takes its checkmark — and this tool CANNOT SEE that. The row's label
        // carries a stale count ("My Places, 2 places" reads identically before
        // and after), and no attribute found on the row exposes the selection.
        //
        // Everything else in this bundle verifies its write before reporting
        // one. This is the exception and it says so in a field the caller has
        // to look at, because `filed: true` here would be exactly the failure
        // the compose path was built to prevent: a result correct in every
        // visible respect except whether it happened.
        return ok({
          filed: "unverified",
          query: args.query,
          guide: args.guide,
          guides: compactGuides(guides),
          note:
            "The guide row and then Done were pressed. Maps does not expose whether the place " +
            "ended up in the guide — the picker's counts do not refresh in the accessibility " +
            "tree — so this MUST NOT be reported to the user as filed. Check Maps.",
        });
      }),
  );
};

const compactGuides = (guides: { name: string; places: number | null }[]) =>
  guides.map((g) => (g.places === null ? { name: g.name } : { name: g.name, places: g.places }));
