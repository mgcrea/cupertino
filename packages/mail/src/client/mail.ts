import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import type { Config } from "../config.js";
import {
  extractAttachment,
  locateEmlx,
  readEmlx,
  readEmlxSource,
  type ParsedMessage,
} from "./emlx.js";
import { EnvelopeIndex, openIndex, type MessageRow, type SearchFilters } from "./envelope.js";
import { MAIL_SURFACE, MessageNotFoundError, PreconditionError } from "./errors.js";
import { COUNT_MAILBOX, GET_MESSAGES, LIST_MAILBOXES, LIST_RECENT } from "./jxa/read.js";
import {
  CHECK_FOR_NEW_MAIL,
  DELETE_MESSAGES,
  MOVE_MESSAGES,
  REPLY_OR_FORWARD,
  SEND_MESSAGE,
  SET_FLAGS,
} from "./jxa/write.js";
import { locateEnvelopeIndex, type LocateResult } from "./locate.js";
import { MailboxMap, type MailAccount } from "./mailbox-map.js";
import {
  createOsascriptRunner,
  type Logger,
  type OsascriptRunner,
  withBusyRetry,
} from "./osascript.js";
import { decodeRef, encodeRef, groupRefsByMailbox, type MessageRef } from "./ref.js";

/**
 * The facade every tool talks to. It owns three things the tools should not
 * each re-decide: which lane answers a question, what to say when a lane is
 * unavailable, and the read-after-write rule.
 */

export type MessageSummary = {
  ref: string;
  id: number;
  accountUuid: string;
  mailbox: string;
  subject: string | null;
  sender: string | null;
  dateReceived: string | null;
  dateSent?: string | null;
  messageId?: string | null;
  read: boolean | null;
  flagged?: boolean | null;
  junk?: boolean | null;
  size?: number | null;
  content?: string | null;
  source?: string | null;
  allHeaders?: string | null;
};

export type LaneStatus = {
  applescript: "live" | "unavailable";
  index: "live" | "unavailable" | "disabled";
  indexReason: string | null;
  indexMode?: string;
  schemaFingerprint?: string;
};

export type AppleMailClientOptions = {
  config: Config;
  logger?: Logger | undefined;
  osascript?: OsascriptRunner | undefined;
};

export class AppleMailClient {
  readonly config: Config;
  readonly runner: OsascriptRunner;
  readonly mailboxes: MailboxMap;
  readonly #logger: Logger | undefined;

  #located: LocateResult | null = null;
  #index: EnvelopeIndex | null = null;
  #indexError: string | null = null;
  #indexTried = false;

  constructor(opts: AppleMailClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.runner =
      opts.osascript ??
      createOsascriptRunner({
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        surface: MAIL_SURFACE,
        logger: opts.logger,
      });
    this.mailboxes = new MailboxMap({
      runner: this.runner,
      allowlist: opts.config.accounts,
      ttlMs: opts.config.mailboxCacheTtlMs,
    });
  }

  accounts(force = false): Promise<MailAccount[]> {
    return this.mailboxes.accounts(force);
  }

  /**
   * Where the Envelope Index is and whether we may read it. Resolved lazily and
   * cached: it needs an Apple Event to ask Mail for its own directory, and that
   * answer does not change while the process lives.
   */
  async locate(force = false): Promise<LocateResult> {
    if (this.#located && !force) return this.#located;

    let accountDirectory: string | undefined;
    try {
      const accounts = await this.accounts();
      accountDirectory = accounts.find((a) => a.directory)?.directory ?? undefined;
    } catch (err) {
      this.#logger?.debug?.("locate: could not ask Mail for its account directory", err);
    }

    this.#located = locateEnvelopeIndex({
      envelopeIndexPath: this.config.envelopeIndexPath,
      mailRoot: this.config.mailRoot,
      accountDirectory,
    });
    return this.#located;
  }

  async lanes(): Promise<LaneStatus> {
    /**
     * Probe twice before declaring the lane dead.
     *
     * The FIRST Apple Event a fresh process sends is what triggers the macOS
     * Automation prompt, and osascript can come back failed while the user is
     * still deciding. Reporting "denied" off that one attempt produced a
     * diagnostic that said automation was denied in the same breath as listing
     * four accounts it had just read over automation — which sends people to
     * fix a permission that was never the problem.
     */
    let applescript: LaneStatus["applescript"] = "unavailable";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.accounts();
        applescript = "live";
        break;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (this.config.indexMode === "off") {
      return { applescript, index: "disabled", indexReason: "APPLE_MAIL_INDEX_MODE=off" };
    }
    const index = await this.index();
    return {
      applescript,
      index: index ? "live" : "unavailable",
      indexReason: index ? null : (this.#indexError ?? (await this.locate()).reason),
      ...(index ? { indexMode: index.mode, schemaFingerprint: index.caps.fingerprint } : {}),
    };
  }

  async listMailboxes(opts: {
    accountUuids?: string[];
    withCounts: boolean;
  }): Promise<
    { accountUuid: string; accountName: string; name: string; unread?: number; total?: number }[]
  > {
    const accounts = await this.accounts();
    const allowed = opts.accountUuids?.length
      ? accounts.filter((a) => opts.accountUuids?.includes(a.id)).map((a) => a.id)
      : accounts.map((a) => a.id);
    return withBusyRetry(() =>
      this.runner.run(LIST_MAILBOXES, { accountUuids: allowed, withCounts: opts.withCounts }),
    );
  }

  async countMailbox(account: MailAccount, mailbox: string) {
    const name = this.mailboxes.resolveMailboxName(account, mailbox);
    return withBusyRetry(() =>
      this.runner.run<{
        accountUuid: string;
        mailbox: string;
        total: number | null;
        unread: number | null;
      }>(COUNT_MAILBOX, { accountUuid: account.id, mailbox: name }),
    );
  }

  /**
   * The degraded listing lane. Capped rather than paginated on purpose: each
   * extra message costs another ~42ms per property, so a "just fetch 500" call
   * is a 20-second call, and a limit the model can see beats a timeout it cannot.
   */
  async listRecent(
    account: MailAccount,
    mailbox: string,
    limit: number,
  ): Promise<{ mailbox: string; total: number; messages: MessageSummary[] }> {
    const name = this.mailboxes.resolveMailboxName(account, mailbox);
    const capped = Math.min(limit, this.config.degradedMaxMessages);
    const raw = await withBusyRetry(() =>
      this.runner.run<{
        mailbox: string;
        total: number;
        messages: Omit<MessageSummary, "ref">[];
      }>(LIST_RECENT, { accountUuid: account.id, mailbox: name, limit: capped }),
    );
    return { ...raw, messages: raw.messages.map((m) => this.#withRef(m)) };
  }

  /** Resolve message ids inside one mailbox. This is the search-to-action bridge. */
  async getMessages(
    ref: { accountUuid: string; mailbox: string },
    ids: number[],
    opts: { withContent?: boolean; withSource?: boolean; withHeaders?: boolean } = {},
  ): Promise<MessageSummary[]> {
    const raw = await withBusyRetry(() =>
      this.runner.run<(Omit<MessageSummary, "ref"> & { found?: boolean })[]>(GET_MESSAGES, {
        accountUuid: ref.accountUuid,
        mailbox: ref.mailbox,
        ids,
        withContent: opts.withContent ?? false,
        withSource: opts.withSource ?? false,
        withHeaders: opts.withHeaders ?? false,
      }),
    );
    return raw.filter((m) => m.found !== false).map((m) => this.#withRef(m));
  }

  // ── index lane ─────────────────────────────────────────────────────────────

  /**
   * Open the index on first use, once. A failure is remembered rather than
   * retried on every call: the usual cause is a missing permission, which will
   * not change until the user restarts the host app anyway.
   */
  async index(): Promise<EnvelopeIndex | null> {
    if (this.#indexTried) return this.#index;
    this.#indexTried = true;

    if (this.config.indexMode === "off") {
      this.#indexError = "APPLE_MAIL_INDEX_MODE=off";
      return null;
    }
    const located = await this.locate();
    if (!located.envelopeIndexPath) {
      this.#indexError = located.reason;
      return null;
    }
    try {
      this.#index = new EnvelopeIndex(
        openIndex(located.envelopeIndexPath, this.config.indexMode, this.#logger),
      );
    } catch (err) {
      this.#indexError = err instanceof Error ? err.message : String(err);
      this.#index = null;
    }
    return this.#index;
  }

  get indexError(): string | null {
    return this.#indexError;
  }

  /** How stale the index file is, so callers can see when they are reading history. */
  async indexAgeSeconds(): Promise<number | null> {
    const located = await this.locate();
    if (!located.mtime) return null;
    return Math.max(0, Math.round((Date.now() - Date.parse(located.mtime)) / 1000));
  }

  /**
   * Map index mailbox rows onto scriptable account/mailbox names.
   *
   * Three of the mailbox URLs on a real machine are `local://` (On My Mac) with
   * no account UUID in the host position, so entries that do not resolve are
   * dropped rather than guessed at.
   */
  async #mailboxLookup(): Promise<
    Map<number, { accountUuid: string; mailbox: string; url: string }>
  > {
    const index = await this.index();
    const map = new Map<number, { accountUuid: string; mailbox: string; url: string }>();
    if (!index) return map;
    for (const row of index.mailboxes()) {
      const resolved = await this.mailboxes.resolveIndexUrl(row.url);
      if (!resolved) continue;
      map.set(row.rowid, {
        accountUuid: resolved.account.id,
        mailbox: resolved.mailbox,
        url: row.url,
      });
    }
    return map;
  }

  /** Resolve account/mailbox filters down to the index rowids they cover. */
  async #targetMailboxRowids(opts: {
    account?: string | undefined;
    mailbox?: string | undefined;
  }): Promise<number[] | undefined> {
    if (!opts.account && !opts.mailbox) return undefined;
    const lookup = await this.#mailboxLookup();
    const account = opts.account ? await this.mailboxes.resolveAccount(opts.account) : null;
    const wanted = opts.mailbox
      ? account
        ? this.mailboxes.resolveMailboxName(account, opts.mailbox)
        : opts.mailbox
      : null;

    const rowids: number[] = [];
    for (const [rowid, entry] of lookup) {
      if (account && entry.accountUuid !== account.id) continue;
      if (wanted && entry.mailbox.toLowerCase() !== wanted.toLowerCase()) continue;
      rowids.push(rowid);
    }
    return rowids;
  }

  async searchMessages(
    opts: Omit<SearchFilters, "mailboxRowids"> & {
      account?: string | undefined;
      mailbox?: string | undefined;
    },
  ): Promise<{
    messages: MessageSummary[];
    source: "index";
    indexMode: string;
    indexAgeSeconds: number | null;
    walBlind: boolean;
  } | null> {
    const index = await this.index();
    if (!index) return null;

    const mailboxRowids = await this.#targetMailboxRowids(opts);
    const lookup = await this.#mailboxLookup();
    const rows = index.search({ ...opts, ...(mailboxRowids ? { mailboxRowids } : {}) });

    return {
      messages: rows
        .map((r) => this.#rowToSummary(r, lookup))
        .filter((m): m is MessageSummary => m !== null),
      source: "index",
      indexMode: index.mode,
      indexAgeSeconds: await this.indexAgeSeconds(),
      // immutable=1 cannot see the -wal, so results may lag reality.
      walBlind: index.mode === "immutable",
    };
  }

  async threadOf(ref: string, limit: number): Promise<MessageSummary[] | null> {
    const index = await this.index();
    if (!index) return null;
    const decoded = decodeRef(ref);
    const conversationId = index.conversationOf(decoded.id);
    if (conversationId === null) return [];
    const lookup = await this.#mailboxLookup();
    return index
      .thread(conversationId, limit)
      .map((r) => this.#rowToSummary(r, lookup))
      .filter((m): m is MessageSummary => m !== null);
  }

  async countViaIndex(opts: {
    account?: string | undefined;
    mailbox?: string | undefined;
  }): Promise<{ total: number; unread: number } | null> {
    const index = await this.index();
    if (!index) return null;
    const mailboxRowids = await this.#targetMailboxRowids(opts);
    return index.count(mailboxRowids ? { mailboxRowids } : {});
  }

  #rowToSummary(
    row: MessageRow,
    lookup: Map<number, { accountUuid: string; mailbox: string; url: string }>,
  ): MessageSummary | null {
    const entry = [...lookup.values()].find((e) => e.url === row.mailboxUrl);
    if (!entry) return null;
    const sender = row.senderName
      ? `${row.senderName} <${row.senderAddress ?? ""}>`
      : (row.senderAddress ?? null);
    return {
      ref: encodeRef({ accountUuid: entry.accountUuid, mailbox: entry.mailbox, id: row.rowid }),
      id: row.rowid,
      accountUuid: entry.accountUuid,
      mailbox: entry.mailbox,
      subject: row.subject,
      sender,
      dateReceived: row.dateReceived,
      dateSent: row.dateSent,
      read: row.read,
      flagged: row.flagged,
      size: row.size,
    };
  }

  // ── body lane ──────────────────────────────────────────────────────────────

  /**
   * Read a message body.
   *
   * Preferred path is the `.emlx` file on disk, which is instant and gives us
   * the real MIME structure. Falls back to asking Mail for `content` (~250ms),
   * which also covers accounts whose message caching keeps headers only — so a
   * missing file is a slow answer, not a failure.
   */
  async getMessageBody(
    ref: string,
    opts: { maxBodyBytes?: number } = {},
  ): Promise<{
    message: MessageSummary;
    parsed: ParsedMessage | null;
    source: "emlx" | "applescript";
  }> {
    const decoded = decodeRef(ref);
    const located = await this.#locateMessageFile(decoded);

    if (located) {
      const parsed = readEmlx(located.path, {
        maxBodyBytes: opts.maxBodyBytes ?? this.config.bodyMaxBytes,
        partial: located.partial,
        rowid: decoded.id,
      });
      const [summary] = await this.getMessages(decoded, [decoded.id]);
      if (summary) return { message: summary, parsed, source: "emlx" };
    }

    const [summary] = await this.getMessages(decoded, [decoded.id], { withContent: true });
    if (!summary) throw new MessageNotFoundError(ref);
    return { message: summary, parsed: null, source: "applescript" };
  }

  async getMessageSource(
    ref: string,
    opts: { offset: number; maxBytes: number },
  ): Promise<{
    source: string;
    totalBytes: number | null;
    truncated: boolean;
    via: "emlx" | "applescript";
  }> {
    const decoded = decodeRef(ref);
    const located = await this.#locateMessageFile(decoded);
    if (located) {
      return { ...readEmlxSource(located.path, opts), via: "emlx" };
    }
    const [summary] = await this.getMessages(decoded, [decoded.id], { withSource: true });
    if (!summary) throw new MessageNotFoundError(ref);
    const full = summary.source ?? "";
    const slice = full.slice(opts.offset, opts.offset + opts.maxBytes);
    return {
      source: slice,
      totalBytes: full.length,
      truncated: opts.offset + slice.length < full.length,
      via: "applescript",
    };
  }

  async #locateMessageFile(ref: MessageRef): Promise<{ path: string; partial: boolean } | null> {
    const accounts = await this.accounts();
    const account = accounts.find((a) => a.id === ref.accountUuid);
    if (!account?.directory) return null;
    try {
      return locateEmlx({
        accountDirectory: account.directory,
        mailbox: ref.mailbox,
        rowid: ref.id,
      });
    } catch {
      // Almost always a permission error on the mail store — the AppleScript
      // fallback still works, so this is not worth failing the call over.
      return null;
    }
  }

  /**
   * Save one attachment into the configured directory.
   *
   * The destination is resolved and then checked to be inside
   * `APPLE_MAIL_ATTACHMENT_DIR`, so a filename of `../../.ssh/authorized_keys`
   * lands nowhere. Existing files are never overwritten.
   */
  async saveAttachment(
    ref: string,
    filename: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<{ path: string; bytes: number; from: "inline" | "sidecar" }> {
    const decoded = decodeRef(ref);
    const located = await this.#locateMessageFile(decoded);
    if (!located) {
      throw new PreconditionError(
        "The message file could not be read, so its attachments are not reachable. " +
          "Grant Full Disk Access and restart the host app.",
      );
    }

    const { bytes, from } = extractAttachment(located.path, filename, decoded.id);

    const root = resolve(this.config.attachmentDir);
    // basename() first: the filename comes from message content, which is
    // attacker-controlled in exactly the way path traversal needs.
    const target = resolve(join(root, basename(filename)));
    if (target !== join(root, basename(filename)) || !target.startsWith(root + sep)) {
      throw new PreconditionError(
        `Refusing to write outside ${root}. Set APPLE_MAIL_ATTACHMENT_DIR to change the destination.`,
      );
    }
    if (existsSync(target) && !opts.overwrite) {
      throw new PreconditionError(`${target} already exists; refusing to overwrite it.`);
    }

    mkdirSync(root, { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    return { path: target, bytes: bytes.length, from };
  }

  // ── write lane ─────────────────────────────────────────────────────────────
  // Every mutation reports the state Mail re-read after the change. Verifying a
  // write against the search index instead would race Mail's own update of it.

  /** Set flags across refs, one Apple Event per distinct mailbox. */
  async setFlags(
    refs: string[],
    flags: { read?: boolean; flagged?: boolean; flagIndex?: number; junk?: boolean },
  ): Promise<{ changed: number; failed: number; results: unknown[] }> {
    const groups = groupRefsByMailbox(refs.map((r) => decodeRef(r)));
    const results: unknown[] = [];
    let changed = 0;
    let failed = 0;

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const res = await withBusyRetry(() =>
        this.runner.run<{ mailbox: string; results: { id: number; ok: boolean }[] }>(SET_FLAGS, {
          accountUuid: first.accountUuid,
          mailbox: first.mailbox,
          ids: group.map((r) => r.id),
          ...flags,
        }),
      );
      for (const r of res.results) {
        if (r.ok) changed += 1;
        else failed += 1;
        results.push({
          ref: encodeRef({ accountUuid: first.accountUuid, mailbox: first.mailbox, id: r.id }),
          ...r,
        });
      }
    }
    return { changed, failed, results };
  }

  async moveMessages(
    refs: string[],
    opts: { destinationMailbox: string; destinationAccount?: string },
  ): Promise<{ moved: number; failed: number; destination: string; results: unknown[] }> {
    const destAccount = opts.destinationAccount
      ? await this.mailboxes.resolveAccount(opts.destinationAccount)
      : null;
    const groups = groupRefsByMailbox(refs.map((r) => decodeRef(r)));
    const results: unknown[] = [];
    let moved = 0;
    let failed = 0;
    let destination = opts.destinationMailbox;

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const res = await withBusyRetry(() =>
        this.runner.run<{
          destination: string;
          destinationAccountUuid: string;
          results: { id: number; ok: boolean; newId: number | null }[];
        }>(MOVE_MESSAGES, {
          accountUuid: first.accountUuid,
          mailbox: first.mailbox,
          ids: group.map((r) => r.id),
          destMailbox: opts.destinationMailbox,
          destAccountUuid: destAccount?.id ?? null,
        }),
      );
      destination = res.destination;
      for (const r of res.results) {
        if (r.ok) moved += 1;
        else failed += 1;
        results.push({
          previousRef: encodeRef({
            accountUuid: first.accountUuid,
            mailbox: first.mailbox,
            id: r.id,
          }),
          // A moved message has a new row id, so the old ref is dead. Null here
          // means Mail moved it but we could not re-locate it by Message-ID.
          ref:
            r.ok && r.newId
              ? encodeRef({
                  accountUuid: res.destinationAccountUuid || first.accountUuid,
                  mailbox: res.destination,
                  id: r.newId,
                })
              : null,
          ...r,
        });
      }
    }
    return { moved, failed, destination, results };
  }

  async deleteMessages(refs: string[]): Promise<{
    deleted: number;
    failed: number;
    movedToTrash: boolean | null;
    results: unknown[];
  }> {
    const groups = groupRefsByMailbox(refs.map((r) => decodeRef(r)));
    const results: unknown[] = [];
    let deleted = 0;
    let failed = 0;
    let movedToTrash: boolean | null = null;

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const res = await withBusyRetry(() =>
        this.runner.run<{ movedToTrash: boolean | null; results: { id: number; ok: boolean }[] }>(
          DELETE_MESSAGES,
          { accountUuid: first.accountUuid, mailbox: first.mailbox, ids: group.map((r) => r.id) },
        ),
      );
      movedToTrash = res.movedToTrash;
      for (const r of res.results) {
        if (r.ok) deleted += 1;
        else failed += 1;
        results.push(r);
      }
    }
    return { deleted, failed, movedToTrash, results };
  }

  async checkForNewMail(account?: string): Promise<unknown> {
    const resolved = account ? await this.mailboxes.resolveAccount(account) : null;
    return this.runner.run(CHECK_FOR_NEW_MAIL, { accountUuid: resolved?.id ?? null });
  }

  async sendMessage(opts: {
    account?: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    sendNow: boolean;
  }): Promise<unknown> {
    const account = opts.account ? await this.mailboxes.resolveAccount(opts.account) : null;
    return this.runner.run(SEND_MESSAGE, {
      senderAddress: account?.emailAddresses[0] ?? null,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      body: opts.body,
      sendNow: opts.sendNow,
    });
  }

  async replyOrForward(
    ref: string,
    opts: {
      mode: "reply" | "forward";
      body?: string;
      to?: string[];
      replyToAll?: boolean;
      sendNow: boolean;
    },
  ): Promise<unknown> {
    const decoded = decodeRef(ref);
    return this.runner.run(REPLY_OR_FORWARD, {
      accountUuid: decoded.accountUuid,
      mailbox: decoded.mailbox,
      id: decoded.id,
      mode: opts.mode,
      body: opts.body ?? null,
      to: opts.to ?? [],
      replyToAll: opts.replyToAll ?? false,
      sendNow: opts.sendNow,
    });
  }

  #withRef(m: Omit<MessageSummary, "ref">): MessageSummary {
    const ref: MessageRef = { accountUuid: m.accountUuid, mailbox: m.mailbox, id: m.id };
    return { ...m, ref: encodeRef(ref) };
  }
}
