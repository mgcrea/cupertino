import type { Config } from "../config.js";
import { COUNT_MAILBOX, GET_MESSAGES, LIST_MAILBOXES, LIST_RECENT } from "./jxa/read.js";
import { locateEnvelopeIndex, type LocateResult } from "./locate.js";
import { MailboxMap, type MailAccount } from "./mailbox-map.js";
import {
  createOsascriptRunner,
  type Logger,
  type OsascriptRunner,
  withBusyRetry,
} from "./osascript.js";
import { encodeRef, type MessageRef } from "./ref.js";

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

  #withRef(m: Omit<MessageSummary, "ref">): MessageSummary {
    const ref: MessageRef = { accountUuid: m.accountUuid, mailbox: m.mailbox, id: m.id };
    return { ...m, ref: encodeRef(ref) };
  }
}
