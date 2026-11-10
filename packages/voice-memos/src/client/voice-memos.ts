import { type Logger, openReadOnly, type ReadOnlyMode } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { VoiceMemosStoreUnavailableError } from "./errors.js";
import { FDA_HINT, type LocateResult, locateStore } from "./locate.js";
import { VERIFIED_FINGERPRINT, VoiceMemosStore } from "./store.js";

export type VoiceMemosStatus = {
  store: LocateResult & { opened: boolean; mode: "ro" | "immutable" | null; error: string | null };
  schema: { fingerprint: string | null; verified: boolean };
  counts: { recordings: number; deleted: number; favorites: number; folders: number } | null;
};

export type CreateClientOptions = {
  config: Config;
  logger?: Logger | undefined;
  /** Injected by tests so discovery never reaches anyone's real home. */
  home?: string | undefined;
};

/**
 * The surface's one client. It opens the store lazily, once, and every read goes through
 * `store()`, which throws `VoiceMemosStoreUnavailableError` rather than returning nothing:
 * an empty list reads exactly like a person who has never recorded a memo.
 */
export class VoiceMemosClient {
  readonly #config: Config;
  readonly #logger: Logger | undefined;
  readonly #home: string | undefined;

  #located: LocateResult | null = null;
  #store: VoiceMemosStore | null = null;
  #mode: "ro" | "immutable" | null = null;
  #storeError: string | null = null;

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
  }

  get config(): Config {
    return this.#config;
  }

  located(): LocateResult {
    this.#located ??= locateStore({ storePath: this.#config.storePath, home: this.#home });
    return this.#located;
  }

  /** Open the store, once, lazily. */
  store(): VoiceMemosStore {
    if (this.#store) return this.#store;
    if (this.#storeError !== null) throw new VoiceMemosStoreUnavailableError(this.#storeError);
    const located = this.located();
    if (!located.readable) {
      this.#storeError = located.reason ?? "Voice Memos' store could not be read.";
      throw new VoiceMemosStoreUnavailableError(this.#storeError);
    }
    try {
      const opened = openReadOnly(located.storePath, this.#config.indexMode as ReadOnlyMode, {
        envVar: "APPLE_VOICE_MEMOS_INDEX_MODE",
        label: "Voice Memos' store",
        hint: FDA_HINT,
        onFallback: () =>
          this.#logger?.warn?.(
            "Voice Memos' store opened immutable=1: reads may miss a recording made moments ago.",
          ),
      });
      this.#mode = opened.mode;
      this.#store = new VoiceMemosStore(opened.db, located.directory);
      return this.#store;
    } catch (err) {
      this.#storeError = err instanceof Error ? err.message : String(err);
      throw new VoiceMemosStoreUnavailableError(this.#storeError);
    }
  }

  /** Everything diagnostics needs, with no failure allowed to fail the call. */
  status(): VoiceMemosStatus {
    const located = this.located();
    let store: VoiceMemosStore | null = null;
    let error: string | null = null;
    try {
      store = this.store();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (!store) {
      return {
        store: { ...located, opened: false, mode: null, error },
        schema: { fingerprint: null, verified: false },
        counts: null,
      };
    }
    const fingerprint = store.schemaFingerprint();
    const rows = store.listRecordings();
    return {
      store: { ...located, opened: true, mode: this.#mode, error: null },
      schema: { fingerprint, verified: fingerprint === VERIFIED_FINGERPRINT },
      counts: {
        recordings: rows.length,
        deleted: rows.filter((r) => r.deletedAt !== null).length,
        favorites: rows.filter((r) => r.favorite).length,
        folders: store.listFolders().length,
      },
    };
  }
}
