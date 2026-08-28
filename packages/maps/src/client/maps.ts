import type { Logger, ReadOnlyMode } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { renderInstant, type Epoch } from "./dates.js";
import { MapsStoreUnavailableError } from "./errors.js";
import { locateStore, type LocateResult } from "./locate.js";
import { encodeCollectionRef, encodePlaceRef, type PlaceKind } from "./ref.js";
import type { EntityKey } from "./store.js";
import { openStore, type CollectionRow, type MapsStore, type PlaceRow } from "./store.js";

/**
 * The client.
 *
 * ## One lane, and the consequence of that
 *
 * Safari's orchestrator exists to keep two lanes from being mistaken for one
 * another. Maps has no second lane at all — the app ships no scripting
 * dictionary — so this class has the opposite job: making sure the ABSENCE of
 * the one lane is never mistaken for an absence of data.
 *
 * Without Full Disk Access every list would naturally come back `[]`, and an
 * empty `favorites` reads exactly like a person who has saved no places. So a
 * read with no store THROWS a named error; it never returns an empty array.
 * That is the same rule `packages/messages` follows, and for the same reason:
 * both are surfaces where the grant is not an optimisation.
 */

export type RenderedPlace = {
  ref: string;
  kind: PlaceKind;
  /** The user's own label when they set one, otherwise the place's name. */
  name: string | null;
  /** The place's own name, kept separate so a rename is visible as one. */
  placeName: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Apple's place identifier. Stable for the same place across devices, and
   * shared between a favourite and a collection entry for the same place — so
   * it is reported, and never used as the ref. See `ref.ts`.
   *
   * A STRING: it is a 64-bit integer that does not fit in a JS number. A real
   * store returned `-2679868148951248105`.
   */
  muid: string | null;
  created: string | null;
  modified: string | null;
  /**
   * False for a row with no linked place record. MEASURED: 3 of 23 favourites,
   * carrying no name and no coordinate — almost certainly the unconfigured
   * Home / Work / School slots Maps creates whether or not anyone fills them in.
   */
  linked: boolean;
};

export type RenderedCollection = {
  ref: string;
  title: string | null;
  /** Maps' own count, which may include items this server cannot enumerate. */
  placesCount: number | null;
  created: string | null;
  modified: string | null;
};

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
};

/**
 * What diagnostics says about one entity: how many rows, which column won for
 * each field, and which fields resolved to nothing. `resolved` is the part that
 * matters when a result looks wrong — it names the column actually being read.
 */
const summariseEntity = (e: MapsStore["caps"]["favorites"]) => ({
  rows: e.rows,
  resolved: Object.fromEntries(Object.entries(e.fields).filter(([, v]) => v !== null)),
  unresolved: Object.entries(e.fields)
    .filter(([, v]) => v === null)
    .map(([k]) => k),
});

export class AppleMapsClient {
  readonly #config: Config;
  readonly #logger: Logger | undefined;
  readonly #home: string | undefined;

  #located: LocateResult | null = null;
  #store: MapsStore | null = null;
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
    this.#located ??= locateStore({
      storePath: this.#config.storePath,
      ...(this.#home ? { home: this.#home } : {}),
    });
    return this.#located;
  }

  /** Open the store, once, lazily. Every read goes through here. */
  store(): MapsStore {
    if (this.#store) return this.#store;
    if (this.#storeError !== null) throw new MapsStoreUnavailableError(this.#storeError);

    const located = this.located();
    if (!located.readable || !located.storePath) {
      this.#storeError = located.reason ?? "Maps' store could not be opened.";
      throw new MapsStoreUnavailableError(this.#storeError);
    }
    try {
      this.#store = openStore({
        path: located.storePath,
        mode: this.#config.indexMode as ReadOnlyMode,
        ...(this.#logger ? { logger: this.#logger } : {}),
      });
      return this.#store;
    } catch (err) {
      this.#storeError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  get epoch(): Epoch {
    return this.store().caps.epoch;
  }

  #render(kind: PlaceKind, row: PlaceRow, epoch: Epoch): RenderedPlace {
    return {
      ref: encodePlaceRef(kind, row.uuid ? { uuid: row.uuid } : { rowId: row.id }),
      kind,
      name: row.customName ?? row.name,
      placeName: row.name,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      muid: row.muid,
      created: renderInstant(row.createdRaw, epoch),
      modified: renderInstant(row.modifiedRaw, epoch),
      linked: row.linked,
    };
  }

  #renderCollection(row: CollectionRow, epoch: Epoch): RenderedCollection {
    return {
      ref: encodeCollectionRef(row.uuid ? { uuid: row.uuid } : { rowId: row.id }),
      title: row.title,
      placesCount: row.placesCount,
      created: renderInstant(row.createdRaw, epoch),
      modified: renderInstant(row.modifiedRaw, epoch),
    };
  }

  places(
    kind: PlaceKind,
    opts: { limit: number; collectionId?: number | undefined; query?: string | undefined },
  ): { places: RenderedPlace[]; truncated: boolean; datesAvailable: boolean } {
    const store = this.store();
    const { rows, truncated } = store.places(kind, opts);
    return {
      places: rows.map((r) => this.#render(kind, r, store.caps.epoch)),
      truncated,
      datesAvailable: store.caps.epoch.confident,
    };
  }

  place(kind: PlaceKind, key: EntityKey): RenderedPlace | null {
    const store = this.store();
    const row = store.place(kind, key);
    return row ? this.#render(kind, row, store.caps.epoch) : null;
  }

  /**
   * A collection ref to the row id its items point at, or null when the ref
   * addresses nothing in this store.
   *
   * Collection membership is a Core Data foreign key and always holds `Z_PK`,
   * so a uuid ref has to be translated before it can filter items.
   */
  collectionRowId(key: EntityKey): number | null {
    return this.store().collectionRowId(key);
  }

  collections(opts: { limit: number }): {
    collections: RenderedCollection[];
    truncated: boolean;
    /** Null when the membership key was not found — see `store.ts`. */
    itemsEnumerable: boolean;
  } {
    const store = this.store();
    const { rows, truncated } = store.collections(opts);
    return {
      collections: rows.map((r) => this.#renderCollection(r, store.caps.epoch)),
      truncated,
      itemsEnumerable: store.caps.membership !== null,
    };
  }

  /**
   * Search every place-bearing entity at once.
   *
   * Three separate queries rather than a UNION, because the three tables have
   * different resolved columns and a UNION would have to flatten them to the
   * narrowest — which on this store means losing history's coordinates, since
   * they live in a differently named column from the other two.
   */
  search(opts: { query: string; limit: number }): {
    places: RenderedPlace[];
    truncated: boolean;
    datesAvailable: boolean;
  } {
    const store = this.store();
    const kinds: PlaceKind[] = ["favorite", "collection-item", "history"];
    const places: RenderedPlace[] = [];
    let truncated = false;
    for (const kind of kinds) {
      const { rows, truncated: t } = store.places(kind, {
        limit: opts.limit,
        query: opts.query,
      });
      truncated ||= t;
      for (const r of rows) places.push(this.#render(kind, r, store.caps.epoch));
    }
    return {
      places: places.slice(0, opts.limit),
      truncated: truncated || places.length > opts.limit,
      datesAvailable: store.caps.epoch.confident,
    };
  }

  /** Everything diagnostics needs, with no failure allowed to fail the call. */
  status(): {
    located: LocateResult;
    store: { opened: boolean; mode: string | null; reason: string | null };
    capabilities: Record<string, unknown> | null;
  } {
    const located = this.located();
    let store: MapsStore | null = null;
    let reason: string | null = located.reason;
    try {
      store = this.store();
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    return {
      located,
      store: { opened: store !== null, mode: store?.mode ?? null, reason },
      capabilities: store
        ? {
            fingerprint: store.caps.fingerprint,
            tableCount: store.caps.tables.length,
            epoch: store.caps.epoch,
            collectionFk: store.caps.collectionFk,
            collectionMembership: store.caps.membership,
            entities: {
              favorites: summariseEntity(store.caps.favorites),
              collections: summariseEntity(store.caps.collections),
              collectionItems: summariseEntity(store.caps.collectionItems),
              history: summariseEntity(store.caps.history),
              mapItems: summariseEntity(store.caps.mapItems),
            },
          }
        : null,
    };
  }

  close(): void {
    this.#store?.close();
    this.#store = null;
  }
}
