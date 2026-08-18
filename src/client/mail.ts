import type { Config } from "../config.js";
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

  constructor(opts: AppleMailClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.runner =
      opts.osascript ??
      createOsascriptRunner({
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
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
    let applescript: LaneStatus["applescript"] = "unavailable";
    try {
      await this.accounts();
      applescript = "live";
    } catch {
      applescript = "unavailable";
    }

    if (this.config.indexMode === "off") {
      return { applescript, index: "disabled", indexReason: "APPLE_MAIL_INDEX_MODE=off" };
    }
    const located = await this.locate();
    return {
      applescript,
      index: located.readable ? "live" : "unavailable",
      indexReason: located.reason,
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
