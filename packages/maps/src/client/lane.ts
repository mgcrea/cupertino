import { openStoreLane, type StoreLane, StoreLaneError } from "@mgcrea/mcp-apple-core";

import { MAPS_SURFACE } from "./errors.js";
import type { SourceKind } from "./place-source.js";

/** What the app answers after one save. `changed` is empty when there was nothing to do. */
export type LaneWrite = {
  /** The item written, or the one that already stood there: a dashed uuid. */
  id: string;
  changed: string[];
  /** False when the item already existed and was returned unchanged. */
  created: boolean;
  /** `fileInGuide` only: whether the read-back found the place in the Guide. */
  filed?: boolean;
  modelVersion: string | null;
  /** True only on a Maps model whose iCloud upload was measured. */
  syncMeasured: boolean;
};

/** Whether the app can write this Mac's Maps store, and why not when it cannot. */
export type LaneStatus = {
  compatible: boolean;
  modelVersion: string | null;
  syncMeasured: boolean;
  refusal: string | null;
};

/** Where the place record to copy comes from: an item Maps wrote, by its identifier. */
export type PlaceFrom = {
  source: SourceKind;
  sourceId: string;
  /**
   * What the caller searched Maps for. The app shows it as the place's name
   * only when the source has none of its own (a recent), until a device
   * refreshes the place; it never becomes a label.
   */
  query: string;
  /** The caller's own label, only when they gave one: the app saves it as `customName`. */
  name?: string | undefined;
  /** The caller's coordinate, when given: the app refuses a record far from it. */
  near?: { latitude: number; longitude: number } | undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the keys given: an absent `name` or `near` is left off the wire, not sent as null. */
const placeParams = (p: PlaceFrom): Record<string, unknown> => ({
  source: p.source,
  sourceId: p.sourceId,
  query: p.query,
  ...(p.name !== undefined ? { name: p.name } : {}),
  ...(p.near ? { near: { latitude: p.near.latitude, longitude: p.near.longitude } } : {}),
});

/**
 * Maps' writes, saved by Cupertino.app through Core Data with Maps' own model,
 * so they are recorded in persistent history like a change made in the app.
 *
 * The app does the work and validates every argument; this side only names the
 * method and checks the answer has the shape the tools report. A reply of
 * another shape is a `StoreLaneError` with reason `protocol`, the reason core
 * uses for a reply it cannot read. The same lane as Voice Memos'
 * (`packages/voice-memos/src/client/lane.ts`), on surface `maps`.
 */
export class MapsLane {
  readonly #lane: StoreLane;

  private constructor(lane: StoreLane) {
    this.#lane = lane;
  }

  /**
   * Null when this server is not hosted by Cupertino: see `core/src/store-lane.ts`.
   *
   * Opening connects nothing. Cupertino spawns the server with the lane env just
   * to list its tools, and that listing must never wait on the app.
   */
  static open(env: NodeJS.ProcessEnv = process.env): MapsLane | null {
    const lane = openStoreLane(MAPS_SURFACE, env);
    return lane ? new MapsLane(lane) : null;
  }

  close(): void {
    this.#lane.close();
  }

  /** A favourite with its own copy of the source's place record. */
  addFavorite(p: PlaceFrom): Promise<LaneWrite> {
    return this.#write("maps.addFavorite", placeParams(p));
  }

  removeFavorite(id: string): Promise<LaneWrite> {
    return this.#write("maps.removeFavorite", { id });
  }

  /** A saved place in no Guide, with its own copy of the source's place record. */
  savePlace(p: PlaceFrom): Promise<LaneWrite> {
    return this.#write("maps.savePlace", placeParams(p));
  }

  removeSavedPlace(id: string): Promise<LaneWrite> {
    return this.#write("maps.removeSavedPlace", { id });
  }

  /**
   * File a saved place in a Guide: one already saved, by `placeId`, or one to
   * save first from a source, which the app saves and files in one save.
   */
  fileInGuide(p: { guide: string; placeId: string } | ({ guide: string } & PlaceFrom)) {
    const params =
      "placeId" in p
        ? { guide: p.guide, placeId: p.placeId }
        : { guide: p.guide, ...placeParams(p) };
    return this.#write("maps.fileInGuide", params, { filed: true });
  }

  async status(): Promise<LaneStatus> {
    const r = await this.#lane.call("maps.status", {});
    if (
      !isRecord(r) ||
      typeof r.compatible !== "boolean" ||
      !isStringOrNull(r.modelVersion) ||
      typeof r.syncMeasured !== "boolean" ||
      !isStringOrNull(r.refusal)
    ) {
      throw this.#unreadable("maps.status");
    }
    return {
      compatible: r.compatible,
      modelVersion: r.modelVersion,
      syncMeasured: r.syncMeasured,
      refusal: r.refusal,
    };
  }

  /**
   * One write, its answer checked. `filed` is required where the method files:
   * the tool reports it, and a missing one must not read as "not filed".
   */
  async #write(
    method: string,
    params: Record<string, unknown>,
    want: { filed?: true } = {},
  ): Promise<LaneWrite> {
    const r = await this.#lane.call(method, params);
    if (
      !isRecord(r) ||
      typeof r.id !== "string" ||
      !UUID.test(r.id) ||
      !Array.isArray(r.changed) ||
      !r.changed.every((c) => typeof c === "string") ||
      typeof r.created !== "boolean" ||
      (want.filed
        ? typeof r.filed !== "boolean"
        : r.filed !== undefined && typeof r.filed !== "boolean") ||
      !isStringOrNull(r.modelVersion) ||
      typeof r.syncMeasured !== "boolean"
    ) {
      throw this.#unreadable(method);
    }
    return {
      // Lowercase, as every id read from the store is here: Swift spells uuids in capitals.
      id: r.id.toLowerCase(),
      changed: r.changed as string[],
      created: r.created,
      ...(typeof r.filed === "boolean" ? { filed: r.filed } : {}),
      modelVersion: r.modelVersion,
      syncMeasured: r.syncMeasured,
    };
  }

  #unreadable(method: string): StoreLaneError {
    return new StoreLaneError(
      MAPS_SURFACE,
      "protocol",
      `the reply to ${method} is not the shape this server reads`,
    );
  }
}
