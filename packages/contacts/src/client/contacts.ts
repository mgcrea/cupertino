import {
  createOsascriptRunner,
  IndexUnavailableError,
  resolveLimit,
  withBusyRetry,
  type Logger,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import {
  CONTACTS_SURFACE,
  ContactNotFoundError,
  ContactWriteNotPersistedError,
  ContactsUnavailableError,
} from "./errors.js";
import { CREATE_CONTACT, UPDATE_CONTACT } from "./jxa/write.js";
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
  /** Injected by tests so nothing spawns a process or touches real Contacts. */
  osascript?: OsascriptRunner;
  /** Injected by tests. */
  home?: string;
};

/** The scalar fields a write may set. Absent means "leave alone". */
export type ContactFields = {
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  note?: string | null;
  company?: boolean;
};

export type LabelledValue = { label?: string; value: string };

/** What a write reports: what Contacts stored, re-read after the save. */
export type WriteResult = {
  ref: string | null;
  personId: string | null;
  name: string | null;
  organization: string | null;
  phones: { label: string | null; value: string | null }[];
  emails: { label: string | null; value: string | null }[];
  source: "apple-events";
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

  readonly #runner: OsascriptRunner;

  #located: LocateResult | null = null;
  #index: ContactsIndex | null = null;
  #indexTried = false;
  #lookup: HandleLookup | null = null;

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
    this.#runner =
      opts.osascript ??
      createOsascriptRunner({
        surface: CONTACTS_SURFACE,
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
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
    return this.#require().list(resolveLimit(limit, this.#config.maxResults));
  }

  search(query: string, limit?: number): IndexContact[] {
    return this.#require().search(query, resolveLimit(limit, this.#config.maxResults));
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

  // ─── writes ────────────────────────────────────────────────────────────────
  // Apple Events, always. The store is opened `PRAGMA query_only` because
  // Contacts owns it and reconciles it against iCloud, so writing to it would
  // corrupt sync state — the lane policy in docs/distribution.md, not a
  // preference. There is no delete: the dictionary has no such command.

  async #run<T>(scriptText: string, params: unknown): Promise<T> {
    try {
      return await withBusyRetry(() => this.#runner.run<T>(scriptText, params));
    } catch (err) {
      const code = (err as { details?: { code?: string } })?.details?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "CONTACT_NOT_FOUND") throw new ContactNotFoundError(message);
      if (code === "CREATE_NOT_PERSISTED" || code === "UPDATE_NOT_PERSISTED") {
        throw new ContactWriteNotPersistedError(message);
      }
      throw err;
    }
  }

  /**
   * Invalidate the read lane after a write.
   *
   * The index and the resolver lookup are both built once and kept, so a contact
   * created through Apple Events would otherwise stay invisible to `resolve` for
   * the life of the process — the exact "wrote it, cannot find it" confusion the
   * id bridge exists to prevent.
   */
  #invalidate(): void {
    this.#index?.close();
    this.#index = null;
    this.#lookup = null;
    this.#indexTried = false;
  }

  #shapeWrite(data: Record<string, unknown>): WriteResult {
    const personId = typeof data.id === "string" ? data.id : null;
    const shaped = (key: string) =>
      Array.isArray(data[key])
        ? (data[key] as Record<string, unknown>[]).map((r) => ({
            label: typeof r.label === "string" ? r.label : null,
            value: typeof r.value === "string" ? r.value : null,
          }))
        : [];
    return {
      // Best effort: the file-lane ref needs a shard and a rowid, and the write
      // lane knows neither. A caller that wants one searches again — which is
      // also the only way to be sure the new row reached the store.
      ref: null,
      personId,
      name: typeof data.name === "string" ? data.name : null,
      organization: typeof data.organization === "string" ? data.organization : null,
      phones: shaped("phones"),
      emails: shaped("emails"),
      source: "apple-events",
    };
  }

  async createContact(input: {
    fields: ContactFields;
    phones?: readonly LabelledValue[];
    emails?: readonly LabelledValue[];
  }): Promise<WriteResult> {
    const data = await this.#run<Record<string, unknown>>(CREATE_CONTACT, {
      fields: input.fields,
      phones: input.phones ?? [],
      emails: input.emails ?? [],
      allowLaunch: true,
    });
    this.#invalidate();
    return this.#shapeWrite(data);
  }

  async updateContact(input: {
    personId: string;
    fields: ContactFields;
    phones?: readonly LabelledValue[];
    emails?: readonly LabelledValue[];
  }): Promise<WriteResult> {
    const data = await this.#run<Record<string, unknown>>(UPDATE_CONTACT, {
      personId: input.personId,
      fields: input.fields,
      phones: input.phones ?? [],
      emails: input.emails ?? [],
      allowLaunch: true,
    });
    this.#invalidate();
    return this.#shapeWrite(data);
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
