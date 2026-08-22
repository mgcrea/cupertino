import {
  AppleContactsClient,
  loadConfig as loadContactsConfig,
  type ResolvedHandle,
} from "@mgcrea/mcp-apple-contacts";
import { IndexUnavailableError, type Logger } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { renderInstant, toAppleSeconds } from "./dates.js";
import { MessagesUnavailableError } from "./errors.js";
import { locateStore, type LocateResult } from "./locate.js";
import { encodeChatRef, encodeMessageRef } from "./ref.js";
import { openStore, type ChatRow, type MessageRow, type MessagesStore } from "./store.js";

/**
 * Messages' one lane, plus the resolver.
 *
 * ## Why this depends on another surface
 *
 * `chat.db` records a correspondent as `+15551234567` and nothing else, so a
 * server built on it alone answers *"+15551234567 said …"* — complete, and
 * useless. `packages/contacts` exists because of that, and this is the consumer
 * it was built for. It is a workspace import rather than an MCP call: reaching a
 * function in the same repo through a protocol would be absurd.
 *
 * `docs/contacts.md` measured what to expect, and the numbers set the contract:
 *
 * | denominator                   | resolved |
 * | ----------------------------- | -------- |
 * | every handle ever seen        | 27.6%    |
 * | messages in the last year     | 97.6%    |
 * | the 25 busiest correspondents | 84%      |
 *
 * So **`unknown` is a normal outcome, not an error.** About one in six of even
 * the busiest correspondents does not resolve, and a caller that treats that as
 * a failure will be wrong several times on any real inbox. Every rendered
 * correspondent therefore carries both the resolved name and the raw handle.
 *
 * ## Degrading
 *
 * If Contacts cannot be read — its own TCC grant, separate from Full Disk
 * Access, and one the user may simply not have answered — resolution is skipped
 * and handles are returned raw. That is a capability downgrade, reported through
 * `diagnostics`, never a throw: a Messages server with no names is still a
 * Messages server.
 */

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests. */
  home?: string;
  /** Injected by tests, so no test reaches the developer's real address book. */
  contacts?: AppleContactsClient | null;
};

export type Correspondent = {
  /** Always present. The raw `handle.id` from the store. */
  handle: string | null;
  /** Null when unresolved, which is normal — see above. */
  name: string | null;
  /** `resolved` | `unknown` | `ambiguous` | `shortcode` | `unavailable`. */
  resolution: string;
};

export type RenderedMessage = {
  ref: string;
  chatRef: string | null;
  chat: string | null;
  from: Correspondent;
  fromMe: boolean;
  sentAt: string | null;
  editedAt: string | null;
  text: string | null;
  /** `column` | `decoded` | `none` — which lane produced the text. */
  textSource: string;
  subject: string | null;
  service: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  /** Present only when this row is a reply. */
  replyToRef?: string;
  /** Present only when this row is a group event rather than a message. */
  itemType?: number;
};

export type RenderedChat = {
  ref: string;
  name: string | null;
  isGroup: boolean;
  service: string | null;
  participants: Correspondent[];
  messages: number;
  lastMessageAt: string | null;
};

export class AppleMessagesClient {
  readonly #config: Config;
  readonly #logger: Logger | undefined;
  readonly #home: string | undefined;

  #located: LocateResult | null = null;
  #store: MessagesStore | null = null;
  #storeTried = false;

  #contacts: AppleContactsClient | null;
  #contactsTried: boolean;
  #resolved = new Map<string, ResolvedHandle>();

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
    // `null` means "explicitly none" (tests); `undefined` means "make one".
    this.#contacts = opts.contacts ?? null;
    this.#contactsTried = opts.contacts !== undefined;
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

  store(): MessagesStore | null {
    if (this.#storeTried) return this.#store;
    this.#storeTried = true;
    if (this.#config.indexMode === "off") return null;
    const located = this.located();
    if (!located.readable) return null;
    const mode = this.#config.indexMode === "auto" ? "ro" : this.#config.indexMode;
    this.#store = openStore(located.storePath, mode, this.#logger);
    return this.#store;
  }

  /**
   * Never `[]` when the store is missing.
   *
   * An empty list is a valid answer to "no messages match", and this surface has
   * no second lane to produce one from. Callers get a reason instead — and on
   * this surface the reason is load-bearing, because the fix is a permission.
   */
  #require(): MessagesStore {
    const store = this.store();
    if (store) return store;
    if (this.#config.indexMode === "off") {
      throw new IndexUnavailableError(
        "The Messages index is disabled (APPLE_MESSAGES_INDEX_MODE=off). This surface has no " +
          "Apple Events read lane at all, so nothing can be read until it is re-enabled.",
      );
    }
    throw new MessagesUnavailableError(
      this.located().reason ?? "No readable Messages store was found.",
    );
  }

  // ─── contacts ──────────────────────────────────────────────────────────────

  #contactsClient(): AppleContactsClient | null {
    if (this.#contactsTried) return this.#contacts;
    this.#contactsTried = true;
    if (!this.#config.resolveContacts) return null;
    try {
      this.#contacts = new AppleContactsClient({
        config: loadContactsConfig({}),
        ...(this.#logger ? { logger: this.#logger } : {}),
        ...(this.#home ? { home: this.#home } : {}),
      });
    } catch (err) {
      this.#logger?.debug?.(`contacts resolver unavailable: ${String(err)}`);
      this.#contacts = null;
    }
    return this.#contacts;
  }

  /**
   * Resolve a batch, memoised for the life of the process.
   *
   * Batched because building the lookup walks every contact once (3 ms on the
   * measured store) and every subsequent handle is a map hit. Memoised because a
   * conversation renders the same correspondent hundreds of times.
   */
  #resolve(handles: readonly (string | null)[]): void {
    const wanted = [...new Set(handles.filter((h): h is string => Boolean(h)))].filter(
      (h) => !this.#resolved.has(h),
    );
    if (!wanted.length) return;
    const contacts = this.#contactsClient();
    if (!contacts) return;
    try {
      for (const r of contacts.resolve(wanted).results) this.#resolved.set(r.handle, r);
    } catch (err) {
      // A Contacts failure must not take Messages down with it.
      this.#logger?.debug?.(`resolve failed: ${String(err)}`);
      this.#contacts = null;
    }
  }

  #correspondent(handle: string | null): Correspondent {
    if (!handle) return { handle: null, name: null, resolution: "unknown" };
    const hit = this.#resolved.get(handle);
    if (!hit) {
      return {
        handle,
        name: null,
        // Distinct from "unknown": nobody looked, rather than nobody matched.
        resolution: this.#contacts ? "unknown" : "unavailable",
      };
    }
    return { handle, name: hit.name, resolution: hit.status };
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  #render(rows: readonly MessageRow[]): RenderedMessage[] {
    this.#resolve(rows.map((r) => r.handle));
    return rows.map((r) => ({
      ref: encodeMessageRef(r.guid),
      chatRef: r.chatGuid ? encodeChatRef(r.chatGuid) : null,
      chat: r.chatName,
      from: r.isFromMe
        ? { handle: null, name: "me", resolution: "self" }
        : this.#correspondent(r.handle),
      fromMe: r.isFromMe,
      sentAt: renderInstant(r.sentAt),
      editedAt: renderInstant(r.editedAt),
      text: r.text,
      textSource: r.textSource,
      subject: r.subject,
      service: r.service,
      isRead: r.isRead,
      hasAttachments: r.hasAttachments,
      ...(r.threadOriginator ? { replyToRef: encodeMessageRef(r.threadOriginator) } : {}),
      ...(r.itemType ? { itemType: r.itemType } : {}),
    }));
  }

  listMessages(opts: {
    chatRef?: string | undefined;
    fromApple?: number | undefined;
    toApple?: number | undefined;
    includeReactions?: boolean | undefined;
    limit?: number | undefined;
  }): RenderedMessage[] {
    return this.#render(
      this.#require().range({
        ...(opts.chatRef ? { chatGuid: opts.chatRef } : {}),
        ...(opts.fromApple === undefined ? {} : { fromApple: opts.fromApple }),
        ...(opts.toApple === undefined ? {} : { toApple: opts.toApple }),
        ...(opts.includeReactions === undefined ? {} : { includeReactions: opts.includeReactions }),
        limit: opts.limit ?? this.#config.maxResults,
      }),
    );
  }

  searchMessages(query: string, limit?: number): RenderedMessage[] {
    return this.#render(this.#require().search(query, limit ?? this.#config.maxResults));
  }

  getMessage(guid: string):
    | (RenderedMessage & {
        reactions: { label: string; from: Correspondent }[];
        attachments: ReturnType<MessagesStore["attachmentsFor"]>;
      })
    | null {
    const store = this.#require();
    const row = store.byGuid(guid);
    if (!row) return null;
    const reactions = store.reactionsFor(guid);
    this.#resolve(reactions.map((r) => r.handle));
    const [rendered] = this.#render([row]);
    return {
      ...(rendered as RenderedMessage),
      reactions: reactions.map((r) => ({ label: r.label, from: this.#correspondent(r.handle) })),
      attachments: store.attachmentsFor(guid),
    };
  }

  listChats(limit?: number): RenderedChat[] {
    const rows: ChatRow[] = this.#require().chats(limit ?? this.#config.maxResults);
    this.#resolve(rows.flatMap((c) => c.participants));
    return rows.map((c) => ({
      ref: encodeChatRef(c.guid),
      // A group chat usually has a name; a one-to-one never does, so fall back
      // to the resolved participant rather than showing a bare guid.
      name:
        c.displayName ??
        (c.participants.length === 1 && c.participants[0]
          ? (this.#correspondent(c.participants[0]).name ?? c.participants[0])
          : null),
      isGroup: c.isGroup,
      service: c.service,
      participants: c.participants.map((h) => this.#correspondent(h)),
      messages: c.messages,
      lastMessageAt: renderInstant(c.lastMessageAt),
    }));
  }

  /** Bounds for a range query, as apple-seconds. */
  window(from?: Date, to?: Date): { fromApple?: number; toApple?: number } {
    return {
      ...(from ? { fromApple: toAppleSeconds(from) } : {}),
      ...(to ? { toApple: toAppleSeconds(to) } : {}),
    };
  }

  status(): {
    located: LocateResult;
    store: { opened: boolean; mode: string | null; fingerprint: string | null };
    counts: ReturnType<MessagesStore["counts"]> | null;
    contacts: { enabled: boolean; available: boolean; resolved: number };
  } {
    const store = this.store();
    return {
      located: this.located(),
      store: {
        opened: Boolean(store),
        mode: store?.mode ?? null,
        fingerprint: store?.caps.fingerprint ?? null,
      },
      counts: store?.counts() ?? null,
      contacts: {
        enabled: this.#config.resolveContacts,
        available: Boolean(this.#contactsClient()),
        resolved: this.#resolved.size,
      },
    };
  }

  close(): void {
    this.#store?.close();
    this.#store = null;
    this.#storeTried = false;
    this.#contacts?.close();
    this.#resolved.clear();
  }
}
