import { buildBaseDiagnostics } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BUILD_INFO } from "../build-info.js";
import type { LaneStatus } from "../client/lane.js";
import type { AppleMapsClient } from "../client/maps.js";
import { STORE_WRITE_TOOLS } from "./store-writes.js";
import { wrap } from "./util.js";

/**
 * The store lane's own answer, asked only when Cupertino hosts this server. A
 * lane that cannot answer is reported as `{ error }`, never as a failed
 * diagnostics call: this report is where a person looks when the lane is the
 * thing that broke. As Voice Memos' diagnostics does.
 */
const writeLaneStatus = async (
  client: AppleMapsClient,
): Promise<LaneStatus | { error: string } | null> => {
  if (!client.lane) return null;
  try {
    return await client.lane.status();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Build the report.
 *
 * Split out of the tool registration so the `cupertino://maps/diagnostics`
 * resource can serve the same bytes. Two renderings of one probe: duplicated,
 * the resource and the tool would drift, and the disagreement would surface as
 * "the diagnostics lied" — the one thing this file must never do.
 */
export const buildDiagnostics = async (
  client: AppleMapsClient,
): Promise<Record<string, unknown>> => {
  const status = client.status();
  const located = status.located;
  const hosted = client.lane !== null;
  const writeLane = await writeLaneStatus(client);
  const allowWrites = client.config.allowWrites;
  /** The route `tools/index.ts` registered, so this report cannot disagree with it. */
  const route = !allowWrites ? "off" : hosted ? "store lane" : "not hosted";
  const tools = allowWrites && hosted ? [...STORE_WRITE_TOOLS] : [];
  const base = buildBaseDiagnostics({
    build: BUILD_INFO,
    config: client.config,
    allowWrites: client.config.allowWrites,
  });
  return {
    ...base,
    settings: { ...base.settings, seedTimeoutMs: client.config.seedTimeoutMs },
    lanes: {
      summary:
        "Maps has ONE lane. Maps.app ships no scripting dictionary — there is no .sdef in the " +
        "bundle, checked directly — so there is no Apple Events fallback. Without Full Disk " +
        "Access this server cannot read anything at all, and it says so rather than returning " +
        "empty lists.",
      fileLane: {
        needs: "Full Disk Access",
        answers: "favourites, collections (guides), recents",
        working: status.store.opened,
      },
      appleEvents: "none — Maps is not scriptable",
      writes: {
        enabled: allowWrites,
        route,
        ...(hosted
          ? {
              lane:
                "Cupertino's store lane, Maps' only write route: the app saves each write " +
                "through Core Data with Maps' own model, so it is recorded in persistent " +
                "history like a change made in Maps. This server only reads the store, to " +
                "de-duplicate, find a place record to copy, and turn a ref into the " +
                "identifier the lane fetches by.",
              seeding:
                "A place is only real to Maps if it carries a ZMAPITEMSTORAGE record, which " +
                "nothing here can generate. When no record is already in the store near the " +
                "coordinate, this server opens maps://?q=<query> (the name alone, no " +
                "coordinate) through LaunchServices and waits, read-only, for the recent Maps " +
                "files with a record; the lane then copies that record. The place is " +
                "therefore left in Recents, and resolving it can take tens of seconds.",
              blastRadius:
                "The store is mirrored by NSPersistentCloudKitContainer, and a lane write goes " +
                "with it: on the model whose syncMeasured is true, every one of the five was " +
                "seen on a Mac and an iPhone on 2026-11-11, one with Maps quit. Each one is " +
                "saved by Cupertino through Maps' own model and only ever copies a place " +
                "record Maps minted; a model that does not match the store is refused as " +
                "incompatible rather than opened.",
            }
          : {
              lane:
                "none: run from npm, this server writes nothing to Maps, whatever " +
                "APPLE_MAPS_ALLOW_WRITES says. Maps' writes exist only when Cupertino hosts " +
                "this server, through its store lane. The route this package wrote through " +
                "itself was retired on 2026-11-11: its inserts were watched never to reach " +
                "iCloud (docs/maps.md).",
            }),
        tools,
      },
      writeLane,
      ...(hosted
        ? {}
        : {
            writeLaneNote:
              "not hosted by Cupertino: the store lane, and the writes that go through it, " +
              "need the app",
          }),
    },
    store: {
      path: located.storePath,
      exists: located.exists,
      readable: located.readable,
      opened: status.store.opened,
      mode: status.store.mode,
      reason: status.store.reason,
      resolvedByScan: located.resolvedByScan,
      ...status.capabilities,
    },
    files: {
      directory: located.directory,
      localCache: {
        path: located.localCache.path,
        exists: located.localCache.exists,
        note:
          "The device-local cache. Same entities as the sync store and, on the probed " +
          "machine, zero rows in every one of them. Located so it is visibly considered, " +
          "never opened.",
      },
    },
    caveats: [
      "This store was missed three times before it was found, and the reasons are worth " +
        "knowing if it ever looks absent: the file has NO EXTENSION (MapsSync_0.0.1), it " +
        "lives in the one directory of Maps' container that Full Disk Access gates, and " +
        "`group.com.apple.Maps` is a decoy that is EPERM rather than empty.",
      "Columns are resolved BY COVERAGE, not by name. ZHISTORYITEM carries both ZLATITUDE " +
        "(1 row of 33) and ZLATITUDE1 (19 of 33); picking the first recognised name would " +
        "report that Maps holds almost no coordinates. `entities.*.resolved` above shows " +
        "which column actually won for each field.",
      "Some favourites have no linked place: 3 of 23 on the probed machine, with no name " +
        "and no coordinate. Almost certainly the unconfigured Home / Work / School slots. " +
        "They are returned with `linked: false` rather than dropped, because silently " +
        "omitting rows reads as a deletion.",
      "Collection membership is a many-to-many join table, Z_6PLACES(Z_6COLLECTIONS, " +
        "Z_7PLACES) on the probed machine, NOT a column on ZCOLLECTIONITEM — which is why " +
        "four guessed column names all missed it. It is re-proved at open time by " +
        "reproducing ZPLACESCOUNT exactly, never by matching a name, because " +
        "ZCOLLECTIONITEM.ZMAPITEM joins 3 of 10 collections by coincidence. When nothing " +
        "reproduces those counts, `collectionMembership` is null, collections list " +
        "without their places and every result says so.",
      "Refs address a local row id. Core Data reuses those after a delete and this store is " +
        "mirrored from CloudKit, so a re-sync can renumber rows. A ref is good for the " +
        "current session and should not be stored.",
      "Timestamps are placed on an epoch DETECTED from the store, never assumed. The same " +
        "value read as unix seconds instead of Core Data seconds lands in 1995 and looks " +
        "entirely plausible. When detection fails every date reads null rather than guessed.",
    ],
  };
};

export const registerDiagnosticsTools = (server: McpServer, client: AppleMapsClient): void => {
  server.registerTool(
    "apple_maps_diagnostics",
    {
      description:
        "Report whether Maps' store can be read, which columns were resolved for each entity, " +
        "and what this server deliberately cannot do. Start here when a read returns nothing — " +
        "this surface has no second lane, so a missing grant means no data at all rather than " +
        "slower data.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => buildDiagnostics(client)),
  );
};
