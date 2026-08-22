import { IndexUnavailableError, type Logger } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { ContactsUnavailableError } from "./errors.js";
import { locateStores, type LocateResult } from "./locate.js";
import { resolveHandles, summarise, type ResolvedHandle } from "./resolve.js";
import {
  ContactsIndex,
  openShard,
  type HandleLookup,
  type IndexContact,
  type Shard,
} from "./store.js";

/**
 * Contacts' one lane, orchestrated.
 *
 * There is no lane *choice* here, which is what makes this the smallest client
 * in the repo: no Apple Events fallback, no write path, no cache TTL. What it
 * does own is the two things the store is awkward about — opening several
 * databases instead of one, and building the resolver index lazily, because
 * building it walks every contact and every phone row and most callers only
 * want to list a few names.
 */

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests. */
  home?: string;
};

export type LaneStatus = {
  located: LocateResult;
  /** One row per store that opened. */
  shards: { label: string; path: string; mode: string; contacts: number; fingerprint: string }[];
  totalContacts: number;
  indexMode: string;
};

export type ContactDetail = IndexContact & {
  phones: { value: string; label: string | null }[];
  emails: { value: string; label: string | null }[];
};

export class AppleContactsClient {
  readonly #config: Config;
  readonly #logger: Logger | undefined;
  readonly #home: string | undefined;

  #located: LocateResult | null = null;
  #index: ContactsIndex | null = null;
  #indexTried = false;
  #lookup: HandleLookup | null = null;

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
  }

  get config(): Config {
    return this.#config;
  }

  located(): LocateResult {
    this.#located ??= locateStores({
      storePath: this.#config.storePath,
      ...(this.#home ? { home: this.#home } : {}),
    });
    return this.#located;
  }

  /**
   * Open every readable store, once.
   *
   * `indexMode: "off"` is honoured as a hard no — it is what the test suite uses
   * so that a machine WITH the grant does not silently read the developer's own
   * address book and pass or fail on data nobody wrote.
   */
  index(): ContactsIndex | null {
    if (this.#indexTried) return this.#index;
    this.#indexTried = true;
    if (this.#config.indexMode === "off") return null;

    const located = this.located();
    const mode = this.#config.indexMode === "auto" ? "ro" : this.#config.indexMode;
    const shards: Shard[] = [];
    for (const candidate of located.readable) {
      const shard = openShard(candidate.path, candidate.label, mode, this.#logger);
      if (shard) shards.push(shard);
    }
    this.#index = shards.length ? new ContactsIndex(shards) : null;
    return this.#index;
  }

  /**
   * The index, or an error naming what is wrong.
   *
   * Never `[]`. An empty list is the answer to "you have no contacts", and this
   * surface has exactly one way to produce that answer wrongly — reading the
   * root store and finding one person in it. Callers get a reason instead.
   */
  #require(): ContactsIndex {
    const index = this.index();
    if (index) return index;
    if (this.#config.indexMode === "off") {
      throw new IndexUnavailableError(
        "The Contacts index is disabled (APPLE_CONTACTS_INDEX_MODE=off). This server has no " +
          "other lane, so nothing can be read until it is re-enabled.",
      );
    }
    throw new ContactsUnavailableError(
      this.located().reason ?? "No readable Contacts store was found.",
    );
  }

  list(limit?: number): IndexContact[] {
    return this.#require().list(limit ?? this.#config.maxResults);
  }

  search(query: string, limit?: number): IndexContact[] {
    return this.#require().search(query, limit ?? this.#config.maxResults);
  }

  /** One contact with its phone numbers and email addresses. */
  get(source: string, recordPk: number): ContactDetail | null {
    const index = this.#require();
    const contact = index.byPk(source, recordPk);
    if (!contact) return null;
    return {
      ...contact,
      phones: index.phonesFor(source, [recordPk]).map(({ value, label }) => ({ value, label })),
      emails: index.emailsFor(source, [recordPk]).map(({ value, label }) => ({ value, label })),
    };
  }

  /**
   * Built on first use and kept.
   *
   * Walking every contact and every phone row is cheap once (970 rows on the
   * probed store) and pointless per call. There is no TTL: this process does not
   * write to Contacts, and a server that has been running while the user edited
   * their address book is not the case worth optimising for. `diagnostics`
   * reports when it was built.
   */
  lookup(): HandleLookup {
    this.#lookup ??= this.#require().buildLookup(this.#config.phoneSuffixDigits);
    return this.#lookup;
  }

  /** The function `packages/messages` is meant to call. */
  resolve(handles: readonly string[]): {
    results: ResolvedHandle[];
    summary: Record<string, number>;
  } {
    const results = resolveHandles(handles, this.lookup());
    return { results, summary: summarise(results) };
  }

  status(): LaneStatus {
    const index = this.index();
    return {
      located: this.located(),
      shards: (index?.shards ?? []).map((s) => ({
        label: s.label,
        path: s.path,
        mode: s.mode,
        contacts: s.contacts,
        fingerprint: s.caps.fingerprint,
      })),
      totalContacts: index?.totalContacts ?? 0,
      indexMode: this.#config.indexMode,
    };
  }

  close(): void {
    this.#index?.close();
    this.#index = null;
    this.#lookup = null;
    this.#indexTried = false;
  }
}
