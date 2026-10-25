import { execFile } from "node:child_process";

import type { ArrivalRow, ArrivalSource } from "@mgcrea/mcp-apple-core";

import type { EnvelopeIndex } from "./envelope.js";
import { encodeRef } from "./ref.js";

/**
 * Mail's arrival source over the Envelope Index.
 *
 * Envelope metadata only: a `MailArrival` carries no body and no snippet.
 * The `messages` table is AUTOINCREMENT, so the ROWID is the cursor and never
 * repeats; `key` is row identity only.
 */

export type MailArrival = ArrivalRow & {
  ref: string;
  mailbox: string;
  senderAddress: string | null;
  senderName: string | null;
  subject: string | null;
  dateReceived: string;
};

/** Last path components whose mail is never an arrival: sent, drafted, binned or spam. */
const UNWATCHED_LEAVES = new Set(
  [
    "Sent Messages",
    "Sent",
    "Sent Mail",
    "Sent Items",
    "Drafts",
    "Junk",
    "Junk E-mail",
    "Spam",
    "Trash",
    "Deleted Messages",
    "Deleted Items",
    "Bin",
  ].map((s) => s.toLowerCase()),
);

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Split an index mailbox URL into its account (the host) and decoded path. */
const splitUrl = (url: string): { accountUuid: string; mailbox: string } => {
  const m = /^[a-z-]+:\/\/([^/]*)\/?(.*)$/i.exec(url);
  return { accountUuid: decode(m?.[1] ?? ""), mailbox: decode(m?.[2] ?? "") };
};

/** Whether a mailbox URL names Sent, Drafts, Junk or Trash, by its decoded last path component. */
export const isUnwatchedMailbox = (mailboxUrl: string): boolean => {
  const leaf = splitUrl(mailboxUrl).mailbox.split("/").pop() ?? "";
  return UNWATCHED_LEAVES.has(leaf.trim().toLowerCase());
};

export type MailArrivalSourceOptions = {
  index: EnvelopeIndex;
  ownAddresses: Iterable<string>;
  /** When given, rows in any other mailbox are excluded. */
  mailboxRowids?: number[];
  /**
   * Map an index mailbox URL to the scriptable account and mailbox name, as the
   * mailbox map does for search results. Default (and fallback when it returns
   * null): the URL's host and decoded path.
   */
  resolveMailbox?: (url: string) => { accountUuid: string; mailbox: string } | null;
};

export class MailArrivalSource implements ArrivalSource<MailArrival> {
  readonly #index: EnvelopeIndex;
  readonly #own: Set<string>;
  readonly #scope: Set<number> | null;
  readonly #resolve: ((url: string) => { accountUuid: string; mailbox: string } | null) | undefined;

  constructor(opts: MailArrivalSourceOptions) {
    this.#index = opts.index;
    this.#own = new Set([...opts.ownAddresses].map((a) => a.trim().toLowerCase()));
    this.#scope = opts.mailboxRowids ? new Set(opts.mailboxRowids) : null;
    this.#resolve = opts.resolveMailbox;
  }

  head(): number {
    return this.#index.headRowid();
  }

  since(after: number, limit: number): MailArrival[] {
    return this.#index.arrivalsAfter(after, limit).map((r) => {
      const sender = r.senderAddress?.trim().toLowerCase() ?? null;
      const excluded =
        isUnwatchedMailbox(r.mailboxUrl) ||
        (sender !== null && this.#own.has(sender)) ||
        (this.#scope !== null && !this.#scope.has(r.mailboxRowid));
      const where = this.#resolve?.(r.mailboxUrl) ?? splitUrl(r.mailboxUrl);
      return {
        cursor: r.rowid,
        key: r.key,
        sender: r.senderAddress,
        ...(excluded ? { excluded: true } : {}),
        ref: encodeRef({ accountUuid: where.accountUuid, mailbox: where.mailbox, id: r.rowid }),
        mailbox: where.mailbox,
        senderAddress: r.senderAddress,
        senderName: r.senderName,
        subject: r.subject,
        dateReceived: this.#index.renderDate(r.dateReceived) ?? "",
      };
    });
  }
}

type Run = (cmd: string, args: string[]) => Promise<number>;

const defaultRun: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, (err) => {
      if (!err) return resolve(0);
      const code = (err as { code?: unknown }).code;
      resolve(typeof code === "number" ? code : 1);
    });
  });

/** Whether Mail.app is running: `/usr/bin/pgrep -x Mail` exits 0. Any failure reads as not running. */
export const isMailRunning = async (run: Run = defaultRun): Promise<boolean> => {
  try {
    return (await run("/usr/bin/pgrep", ["-x", "Mail"])) === 0;
  } catch {
    return false;
  }
};
