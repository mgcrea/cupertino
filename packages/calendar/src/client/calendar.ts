import type { Logger } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { locateStore, type LocateResult } from "./locate.js";
import { CalendarStore, openStore } from "./store.js";

/**
 * The lane orchestrator.
 *
 * Thinner than `packages/reminders`' by design. That surface arbitrates between
 * two read lanes and caches an expensive Apple Events bulk fetch; Calendar has
 * exactly one read lane, because `docs/distribution.md` sets the policy for new
 * surfaces — file-lane reads, Apple Events for writes and live state — and
 * `docs/calendar.md` measured why: a range query over Apple Events costs 3.4 s
 * and does not improve with batching.
 *
 * So there is nothing to arbitrate. Either the store opens or the surface says
 * plainly that it cannot answer, and never returns an empty list that reads like
 * an empty calendar.
 */
export type LaneStatus = {
  /**
   * Always reported, never probed here.
   *
   * Reminders probes its Apple Events lane on every `lanes()` call because that
   * lane answers reads. Calendar's does not: it exists only for writes, which
   * are not implemented yet. Probing it would fire the Automation prompt for a
   * capability the server does not currently have, which is a worse trade than
   * saying so.
   */
  applescript: "not-used" | "live" | "unavailable";
  index: "live" | "unavailable" | "disabled";
  indexMode: string | null;
  storeFingerprint: string | null;
  reason: string | null;
};

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
};

export class AppleCalendarClient {
  readonly config: Config;
  readonly #logger: Logger | undefined;

  #located: LocateResult | null = null;
  #store: CalendarStore | null = null;
  #storeTried = false;

  constructor(opts: CreateClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
  }

  /** Cached: the answer cannot change without the process being restarted anyway. */
  locate(): LocateResult {
    this.#located ??= locateStore({ storePath: this.config.storePath });
    return this.#located;
  }

  /**
   * The store, opened lazily and at most once.
   *
   * Returns null rather than throwing, because "no index" is a state the caller
   * has to render, not an exception. The reason lives on the locate result.
   */
  index(): CalendarStore | null {
    if (this.#storeTried) return this.#store;
    this.#storeTried = true;
    if (this.config.indexMode === "off") return null;
    try {
      this.#store = openStore(this.locate().storePath, this.config.indexMode, this.#logger);
    } catch (err) {
      this.#logger?.debug?.("could not open the Calendar store", err);
      this.#store = null;
    }
    return this.#store;
  }

  /**
   * Drop the open handle so the next read reopens.
   *
   * Called after a write: Calendar owns the store and reconciles it against a
   * server, so an event created over Apple Events lands in the file on the
   * app's schedule, not ours.
   */
  invalidate(): void {
    this.#store?.close();
    this.#store = null;
    this.#storeTried = false;
    this.#located = null;
  }

  lanes(): LaneStatus {
    const located = this.locate();
    const store = this.index();
    return {
      applescript: "not-used",
      index: this.config.indexMode === "off" ? "disabled" : store ? "live" : "unavailable",
      indexMode: store?.mode ?? null,
      storeFingerprint: store?.caps.fingerprint ?? null,
      reason: store ? null : located.reason,
    };
  }
}
