import { openStoreLane, type StoreLane, StoreLaneError } from "@mgcrea/mcp-apple-core";

import { VOICE_MEMOS_SURFACE } from "./errors.js";

/** What the app answers after one save. `changed` is empty when there was nothing to do. */
export type LaneWrite = {
  id: string;
  changed: string[];
  modelVersion: string | null;
  /** True only on a Voice Memos model whose iCloud upload was measured. */
  syncMeasured: boolean;
};

/** Whether the app can write this Mac's Voice Memos store, and why not when it cannot. */
export type LaneStatus = {
  compatible: boolean;
  modelVersion: string | null;
  syncMeasured: boolean;
  refusal: string | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/**
 * Voice Memos' writes, saved by Cupertino.app through Core Data with Voice Memos' own model,
 * so iCloud uploads them like a change made in the app.
 *
 * The app does the work and validates every argument; this side only names the method and
 * checks the answer has the shape the tools report. A reply of another shape is a
 * `StoreLaneError` with reason `protocol`, the reason core uses for a reply it cannot read.
 */
export class VoiceMemosLane {
  readonly #lane: StoreLane;

  private constructor(lane: StoreLane) {
    this.#lane = lane;
  }

  /**
   * Null when this server is not hosted by Cupertino: see `core/src/store-lane.ts`.
   *
   * Opening connects nothing. Cupertino spawns the server with the lane env just to list its
   * tools, and that listing must never wait on the app.
   */
  static open(env: NodeJS.ProcessEnv = process.env): VoiceMemosLane | null {
    const lane = openStoreLane(VOICE_MEMOS_SURFACE, env);
    return lane ? new VoiceMemosLane(lane) : null;
  }

  close(): void {
    this.#lane.close();
  }

  rename(id: string, title: string): Promise<LaneWrite> {
    return this.#write("voiceMemos.rename", { id, title });
  }

  setFavorite(id: string, favorite: boolean): Promise<LaneWrite> {
    return this.#write("voiceMemos.setFavorite", { id, favorite });
  }

  /** `null` takes the recording out of every folder; the key is always sent. */
  move(id: string, folderId: string | null): Promise<LaneWrite> {
    return this.#write("voiceMemos.move", { id, folderId });
  }

  /** To Recently Deleted, which Voice Memos empties on its own schedule. */
  delete(id: string): Promise<LaneWrite> {
    return this.#write("voiceMemos.delete", { id });
  }

  restore(id: string): Promise<LaneWrite> {
    return this.#write("voiceMemos.restore", { id });
  }

  async status(): Promise<LaneStatus> {
    const r = await this.#lane.call("voiceMemos.status", {});
    if (
      !isRecord(r) ||
      typeof r.compatible !== "boolean" ||
      !isStringOrNull(r.modelVersion) ||
      typeof r.syncMeasured !== "boolean" ||
      !isStringOrNull(r.refusal)
    ) {
      throw this.#unreadable("voiceMemos.status");
    }
    return {
      compatible: r.compatible,
      modelVersion: r.modelVersion,
      syncMeasured: r.syncMeasured,
      refusal: r.refusal,
    };
  }

  async #write(method: string, params: Record<string, unknown>): Promise<LaneWrite> {
    const r = await this.#lane.call(method, params);
    if (
      !isRecord(r) ||
      typeof r.id !== "string" ||
      !Array.isArray(r.changed) ||
      !r.changed.every((c) => typeof c === "string") ||
      !isStringOrNull(r.modelVersion) ||
      typeof r.syncMeasured !== "boolean"
    ) {
      throw this.#unreadable(method);
    }
    return {
      id: r.id,
      changed: r.changed as string[],
      modelVersion: r.modelVersion,
      syncMeasured: r.syncMeasured,
    };
  }

  #unreadable(method: string): StoreLaneError {
    return new StoreLaneError(
      VOICE_MEMOS_SURFACE,
      "protocol",
      `the reply to ${method} is not the shape this server reads`,
    );
  }
}
