import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath, sep } from "node:path";

import {
  AppleContactsClient,
  emailKey,
  handleKind,
  loadConfig as loadContactsConfig,
  suffixKey,
  type ResolvedHandle,
} from "@mgcrea/mcp-apple-contacts";
import {
  createOsascriptRunner,
  IndexUnavailableError,
  withBusyRetry,
  type Logger,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { renderInstant, toAppleSeconds } from "./dates.js";
import {
  ChatNotFoundError,
  MESSAGES_SURFACE,
  MessagesUnavailableError,
  PreconditionError,
  SendFailedError,
  SendTargetNotFoundError,
} from "./errors.js";
import { SEND_MESSAGE } from "./jxa/write.js";
import { locateStore, type LocateResult } from "./locate.js";
import { decodeChatRef, encodeChatRef, encodeMessageRef } from "./ref.js";
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
  /** Injected by tests, so no test sends a real message to a real person. */
  osascript?: OsascriptRunner;
};

/**
 * What a send actually knows, which is less than a caller might assume.
 *
 * `sent` means Messages accepted the command without throwing. `delivered` is
 * not a field here at all, because nothing in either lane reports it at send
 * time. What closes the gap is `message`: the row the file lane found afterwards
 * — a real ref, usable with `apple_messages_get_message` like any other.
 */
export type SendResult = {
  sent: true;
  /** Which rung of the ladder in `client/jxa/core.ts` answered. */
  strategy: string;
  targetKind: string;
  /** The chat the file lane chose, when it could choose one. */
  chatRef: string | null;
  chat: string | null;
  to: Correspondent | null;
  /** Whether Messages had to be launched. A launch is visible to the user. */
  launched: boolean;
  /** `matched` | `pending` | `unavailable` — see `#reconcile`. */
  reconciliation: string;
  message: RenderedMessage | null;
  note?: string;
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

  /**
   * Built even when writes are off, and that costs nothing.
   *
   * `createOsascriptRunner` spawns no process until something calls it, and with
   * `allowWrites` off nothing does — the send tool is never registered. So this
   * server still sends no Apple Event and still asks for no Automation grant in
   * its default configuration, which is the claim `surfaces.json` makes.
   */
  readonly #runner: OsascriptRunner;

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
    // `null` means "explicitly none" (tests); `undefined` means "make one".
    this.#contacts = opts.contacts ?? null;
    this.#contactsTried = opts.contacts !== undefined;
    this.#runner =
      opts.osascript ??
      createOsascriptRunner({
        surface: MESSAGES_SURFACE,
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
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

  /**
   * Copy one attachment out of the Messages store onto disk.
   *
   * ## Why this is a copy and not an extraction
   *
   * Mail's equivalent has to parse MIME out of an `.emlx` because the bytes are
   * inside the message file. Messages does not work that way: `attachment` rows
   * point at real files under `~/Library/Messages`, so the work here is finding
   * the row, deciding the path is one we are willing to read, and copying.
   *
   * ## Two boundaries, not one
   *
   * The DESTINATION boundary is the same one Mail and Notes enforce:
   * `attachmentDir` is a confinement, `directory` may only select inside it, and
   * the leaf name is `basename`d because it comes from whoever sent the message.
   *
   * The SOURCE boundary is this surface's own. `filename` comes out of a
   * database this server never writes, and it is a fully-qualified path: taken
   * at face value it names any file the process can read. So it is required to
   * resolve inside the Messages root before a single byte is read. That check
   * has never fired on a real store and is not expected to — it is here so that
   * the day the schema surprises us, the surprise is a refusal.
   */
  async saveAttachment(
    attachmentId: string,
    opts: { directory?: string | undefined; overwrite?: boolean } = {},
  ): Promise<{ path: string; bytes: number; source: string; mimeType: string | null }> {
    const store = this.#require();
    const meta = store.attachmentById(attachmentId);
    if (!meta) {
      throw new PreconditionError(
        `No attachment with id "${attachmentId}". Ids come from apple_messages_get_message and ` +
          "are the attachment's guid; the message may have been deleted since it was listed.",
      );
    }
    if (!meta.path) {
      throw new PreconditionError(
        "That attachment has no file path in the store, which normally means iCloud has " +
          "offloaded it. Open the conversation in Messages to download it, then try again.",
      );
    }

    const home = this.#home ?? homedir();
    // `~/Library/Messages/…` is the shape the column actually holds — not a
    // shell convention this can leave to something else to expand.
    const expanded = meta.path.startsWith("~/") ? join(home, meta.path.slice(2)) : meta.path;
    const source = resolvePath(expanded);
    const root = resolvePath(this.located().messagesRoot);
    if (source !== root && !source.startsWith(root + sep)) {
      throw new PreconditionError(
        `Refusing to read ${source}: it is outside ${root}, and this tool only copies files ` +
          "Messages itself stores.",
      );
    }
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new PreconditionError(
        `The store names ${source} but there is no file there. Messages prunes attachment bytes ` +
          "while keeping the row, so this is a normal state for an old conversation.",
      );
    }

    const dest = resolvePath(this.#config.attachmentDir);
    const dir = opts.directory ? resolvePath(dest, opts.directory) : dest;
    if (dir !== dest && !dir.startsWith(dest + sep)) {
      throw new PreconditionError(
        `Refusing to write outside ${dest}. Set APPLE_MESSAGES_ATTACHMENT_DIR to change the ` +
          "destination.",
      );
    }
    // The sender chose `transfer_name`, so it is basename'd before it is
    // trusted — path traversal wants exactly that field.
    const name = basename(meta.transferName ?? basename(source));
    const target = resolvePath(join(dir, name));
    if (target !== join(dir, name) || !target.startsWith(dir + sep)) {
      throw new PreconditionError(`Refusing to write outside ${dir}.`);
    }
    if (existsSync(target) && !opts.overwrite) {
      throw new PreconditionError(`${target} already exists; refusing to overwrite it.`);
    }

    const bytes = readFileSync(source);
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    return { path: target, bytes: bytes.length, source, mimeType: meta.mimeType };
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

  // ─── writes ────────────────────────────────────────────────────────────────
  // One verb, and it is the only thing Apple Events can do on this surface.
  //
  // The shape is unlike every other surface here. Elsewhere a write is a
  // round-trip: change something, re-read it, report what the app stored.
  // Messages cannot re-read — every read through its scripting dictionary fails
  // — so the write lane fires and the FILE lane reports. See `#reconcile`.

  /**
   * Pick the chat to address, using the store.
   *
   * Handles are matched the way `packages/contacts` measured them rather than by
   * string equality: a caller who types `06 12 34 56 78` and a store that holds
   * `+33612345678` are the same person, and `suffixKey`'s last-9 rule is what
   * says so. The candidate set is the store's own handles — 1,075 on the
   * measured machine — so this is a scan over a list that is already in memory.
   */
  #chatFor(input: { chatRef?: string | undefined; to?: string | undefined }): {
    guid: string | null;
    chat: ChatRow | null;
    handle: string | null;
  } {
    // `store()`, not `#require()`. A send is the one operation on this surface
    // that can work without the file lane — the JXA ladder's lower rungs guess a
    // chat guid from the handle — so an unreadable store degrades the RESULT
    // (no ref to report) rather than blocking the send. Reads still refuse.
    const store = this.store();
    if (input.chatRef) {
      const guid = decodeChatRef(input.chatRef);
      const chat = store?.chatByGuid(guid) ?? null;
      if (store && !chat) throw new ChatNotFoundError(input.chatRef);
      return { guid, chat, handle: chat?.participants[0] ?? null };
    }
    const to = input.to?.trim();
    if (!to) return { guid: null, chat: null, handle: null };
    if (!store) return { guid: null, chat: null, handle: to };

    const kind = handleKind(to);
    const wantedSuffix = kind === "phone" ? suffixKey(to) : null;
    const wantedEmail = kind === "email" ? emailKey(to) : null;
    const candidates = store.handles().filter((h) => {
      if (h === to) return true;
      if (wantedEmail) return emailKey(h) === wantedEmail;
      if (wantedSuffix) return suffixKey(h) === wantedSuffix;
      return false;
    });
    if (!candidates.length) return { guid: null, chat: null, handle: to };

    // A one-to-one chat wins over a group with the same person in it: "message
    // Alice" must not land in a six-person thread Alice happens to be in.
    const chats = store.chatsForHandles(candidates, 25);
    const direct = chats.find((c) => !c.isGroup) ?? null;
    return { guid: direct?.guid ?? null, chat: direct, handle: candidates[0] ?? to };
  }

  /**
   * Find the row Messages wrote, or say plainly that it was not found.
   *
   * `docs/messages.md` left this as an open question — "whether a send should
   * re-resolve by scanning the store for a recent row on the target chat" — and
   * this is the answer, because the alternative is a send that can report
   * nothing at all. Apple Events hands back no identifier of any kind.
   *
   * Three things make the match safe rather than merely plausible:
   *
   *   1. `since` is taken BEFORE the send, so nothing earlier can match.
   *   2. The window is scoped to the target chat.
   *   3. Text is compared when it is available, which separates our row from one
   *      the user sent from their phone in the same second. Only when it is not
   *      available does the oldest row in the window win.
   *
   * A miss is `pending`, never an error: the send already happened, and iMessage
   * writes its row asynchronously. Reporting a failure there would be the worst
   * possible lie — it would invite a retry that sends the message twice.
   */
  async #reconcile(guid: string, since: number, text: string): Promise<RenderedMessage | null> {
    const deadline = Date.now() + this.#config.sendReconcileMs;
    for (;;) {
      // Reopen: this handle was opened before the send, and the point is to see
      // what another process has written since.
      this.#invalidate();
      const store = this.store();
      if (!store) return null;
      const rows = store.sentSince([guid], since, 10);
      const hit = rows.find((r) => r.text !== null && r.text === text) ?? rows[0];
      if (hit) return this.#render([hit])[0] ?? null;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  #invalidate(): void {
    this.#store?.close();
    this.#store = null;
    this.#storeTried = false;
  }

  /**
   * Send one message. A real one, to a real person, immediately.
   *
   * Everything difficult about this is in `client/jxa/core.ts`; what is left
   * here is choosing the target from the file lane and reconciling afterwards.
   */
  async sendMessage(input: {
    chatRef?: string | undefined;
    to?: string | undefined;
    text: string;
    service?: string | undefined;
  }): Promise<SendResult> {
    const { guid, chat, handle } = this.#chatFor(input);
    const since = toAppleSeconds(new Date(Date.now() - 2_000));

    let data: {
      strategy?: unknown;
      targetKind?: unknown;
      launched?: unknown;
      attempts?: unknown;
    };
    try {
      data = await withBusyRetry(() =>
        this.#runner.run<Record<string, unknown>>(SEND_MESSAGE, {
          ...(guid ? { chatGuid: guid } : {}),
          ...(handle ? { handle } : {}),
          ...(input.service ? { service: input.service } : {}),
          text: input.text,
          allowLaunch: true,
        }),
      );
    } catch (err) {
      const details = (err as { details?: { code?: string; detail?: unknown } })?.details;
      const attempts = Array.isArray(details?.detail) ? (details.detail as string[]) : [];
      const message = err instanceof Error ? err.message : String(err);
      if (details?.code === "SEND_TARGET_NOT_FOUND") {
        throw new SendTargetNotFoundError(input.chatRef ?? input.to ?? "", attempts);
      }
      if (details?.code === "SEND_FAILED") throw new SendFailedError(message, attempts);
      throw err;
    }

    const message = guid ? await this.#reconcile(guid, since, input.text) : null;
    if (handle) this.#resolve([handle]);
    return {
      sent: true,
      strategy: typeof data.strategy === "string" ? data.strategy : "unknown",
      targetKind: typeof data.targetKind === "string" ? data.targetKind : "unknown",
      chatRef: guid ? encodeChatRef(guid) : null,
      chat: chat?.displayName ?? null,
      to: handle ? this.#correspondent(handle) : null,
      launched: data.launched === true,
      reconciliation: message ? "matched" : guid ? "pending" : "unavailable",
      message,
      ...(message
        ? {}
        : {
            note: guid
              ? "Messages accepted the send, but no matching row had appeared in the store yet. " +
                "That is normal for a slow network — re-run apple_messages_list_messages on this " +
                "chat rather than sending again."
              : "Messages accepted the send, but there was no existing chat to reconcile it " +
                "against, so no ref can be reported for it. Read the chat back once it exists.",
          }),
    };
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
