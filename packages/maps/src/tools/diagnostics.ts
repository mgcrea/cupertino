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
      writes:
        "none — this server registers no mutating tool. The store is mirrored to iCloud by " +
        "NSPersistentCloudKitContainer, so a write is an edit to one replica of a " +
        "synchronising graph underneath a running app. That was never probed.",
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
      "How a collection item belongs to a collection is UNKNOWN — no ZCOLLECTION column was " +
        "found on ZCOLLECTIONITEM, and Core Data names a foreign key after the relationship " +
        "rather than the entity. `collectionFk` above shows what was resolved; when it is " +
        "null, collections list without their items and every result says so.",
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
