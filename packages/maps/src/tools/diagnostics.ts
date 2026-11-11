import { buildBaseDiagnostics } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BUILD_INFO } from "../build-info.js";
import type { LaneStatus } from "../client/lane.js";
import type { AppleMapsClient } from "../client/maps.js";
import { STORE_WRITE_TOOLS } from "./store-writes.js";
import { wrap } from "./util.js";

const SQL_TOOLS = ["apple_maps_add_favorite", "apple_maps_remove_favorite"];
const AX_TOOLS = [
  "apple_maps_save_place",
  "apple_maps_remove_saved_place",
  "apple_maps_add_place_to_guide",
];

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
  const route = !allowWrites ? "off" : hosted ? "store lane" : "sql";
  const tools = !allowWrites
    ? []
    : hosted
      ? [...STORE_WRITE_TOOLS]
      : [...SQL_TOOLS, ...(client.axLane ? AX_TOOLS : [])];
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
        lane: hosted
          ? "Cupertino's store lane: the app saves each write through Core Data with Maps' own " +
            "model, so it is recorded in persistent history like a change made in Maps. This " +
            "server only reads the store, to de-duplicate, find a place record to copy, and " +
            "turn a ref into the identifier the lane fetches by."
          : "SQL, directly into the Core Data store. Maps ships no scripting dictionary and " +
            "registers no App Intents on macOS, so run from npm there is no lane where the app " +
            "performs the write on our behalf. Hosted by Cupertino, the writes go through its " +
            "store lane instead.",
        seeding: hosted
          ? "A place is only real to Maps if it carries a ZMAPITEMSTORAGE record, which nothing " +
            "here can generate. When no record is already in the store near the coordinate, " +
            "this server opens maps://?q=<query> (the name alone, no coordinate) through " +
            "LaunchServices and waits, read-only, for the recent Maps files with a record; the " +
            "lane then copies that record. The place is therefore left in Recents, and " +
            "resolving it can take tens of seconds."
          : "A place is only real to Maps if it carries a ZMAPITEMSTORAGE blob, which this repo " +
            "cannot generate. Opening maps://?q=<name>&ll=<lat>,<lon> through LaunchServices " +
            "makes Maps mint one, and that record is copied. The place is therefore left in " +
            "Recents whether or not the favourite is kept, and resolving it can take tens of " +
            "seconds.",
        blastRadius: hosted
          ? "The store is mirrored by NSPersistentCloudKitContainer, so a write reaches every " +
            "device on the account. Each one is saved by Cupertino through Maps' own model, " +
            "never as SQL, and only ever copies a place record Maps minted; a model that does " +
            "not match the store is refused as incompatible rather than opened."
          : "The store is mirrored by NSPersistentCloudKitContainer, and mirroring does not " +
            "wait to be told. A malformed row is not a local mistake: it reaches every device " +
            "on the account as soon as Maps next runs. Hence the rule in client/write.ts — " +
            "never fabricate a place record, only ever copy one Maps wrote.",
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
