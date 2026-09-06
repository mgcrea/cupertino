import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import type { AppleMapsClient } from "../client/maps.js";
import { wrap } from "./util.js";

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
  return {
    server: { name: BUILD_INFO.name, version: BUILD_INFO.version },
    settings: { exposePrompts: client.config.exposePrompts },
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
        enabled: client.config.allowWrites,
        lane:
          "SQL, directly into the Core Data store. Maps ships no scripting dictionary and " +
          "registers no App Intents on macOS, so there is no lane where the app performs the " +
          "write on our behalf — this is the only surface here that writes its own store.",
        seeding:
          "A place is only real to Maps if it carries a ZMAPITEMSTORAGE blob, which this repo " +
          "cannot generate. Opening maps://?q=<name>&ll=<lat>,<lon> through LaunchServices makes " +
          "Maps mint one, and that record is copied. The place is therefore left in Recents " +
          "whether or not the favourite is kept, and resolving it can take tens of seconds.",
        blastRadius:
          "The store is mirrored by NSPersistentCloudKitContainer, and mirroring does not wait " +
          "to be told. A malformed row is not a local mistake: it reaches every device on the " +
          "account as soon as Maps next runs. Hence the rule in client/write.ts — never " +
          "fabricate a place record, only ever copy one Maps wrote.",
        tools: client.config.allowWrites
          ? ["apple_maps_add_favorite", "apple_maps_remove_favorite"]
          : [],
      },
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
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => buildDiagnostics(client)),
  );
};
