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
 *
 * What the source drops for every watch (`excluded`): Sent, Drafts, Junk and
 * Trash, the account's own addresses, and rows whose mailbox the lookup does not
 * know. What only some watches want, the mailbox, is `scope`.
 */

export type MailArrival = ArrivalRow & {
  /** Empty on an excluded row whose mailbox does not resolve; such a row is never delivered. */
  ref: string;
  mailbox: string;
  senderAddress: string | null;
  senderName: string | null;
  subject: string | null;
  dateReceived: string | null;
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

/** Whether a mailbox URL names Sent, Drafts, Junk or Trash, by its decoded last path component. */
export const isUnwatchedMailbox = (mailboxUrl: string): boolean => {
  const m = /^[a-z-]+:\/\/[^/]*\/?(.*)$/i.exec(mailboxUrl);
  const leaf = decode(m?.[1] ?? "")
    .split("/")
    .pop();
  return UNWATCHED_LEAVES.has((leaf ?? "").trim().toLowerCase());
};

export type MailboxLookup = (
  mailboxRowid: number,
) => { accountUuid: string; mailbox: string } | null;

export type MailArrivalSourceOptions = {
  index: EnvelopeIndex;
  ownAddresses: Iterable<string>;
  /**
   * Mailbox rowid to scriptable account and mailbox name, built the way search
   * builds its own: `await client.mailboxLookup()`, then `(id) => map.get(id) ?? null`.
   * A row whose mailbox is missing is excluded and never gets a ref: that is
   * how `local://` mailboxes and accounts hidden by the allowlist drop out.
   */
  lookup: MailboxLookup;
};

export class MailArrivalSource implements ArrivalSource<MailArrival> {
  readonly #index: EnvelopeIndex;
  readonly #own: Set<string>;
  readonly #lookup: MailboxLookup;

  constructor(opts: MailArrivalSourceOptions) {
    this.#index = opts.index;
    this.#own = new Set([...opts.ownAddresses].map((a) => a.trim().toLowerCase()));
    this.#lookup = opts.lookup;
  }

  head(): number {
    return this.#index.headRowid();
  }

  since(after: number, limit: number): MailArrival[] {
    return this.#index.arrivalsAfter(after, limit).map((r) => {
      const where = this.#lookup(r.mailboxRowid);
      const sender = r.senderAddress?.trim().toLowerCase() ?? null;
      // Which mailboxes a row is "in" is the watch's question, not the source's:
      // the row carries its own mailbox and its Gmail labels as scope keys, and a
      // watch scoped to mailboxes needs one of them. Whether Mail writes a label
      // row in the same transaction as the message is not established anywhere in
      // this repo, so a row can be scanned a moment before its label lands. The
      // live run measures that.
      const scope = [r.mailboxRowid, ...r.labelMailboxIds].map(String);
      const excluded =
        where === null ||
        r.mailboxUrl === null ||
        isUnwatchedMailbox(r.mailboxUrl) ||
        (sender !== null && this.#own.has(sender));
      return {
        cursor: r.rowid,
        key: r.key,
        sender: r.senderAddress,
        ...(excluded ? { excluded: true } : {}),
        ref: where ? encodeRef({ ...where, id: r.rowid }) : "",
        mailbox: where?.mailbox ?? "",
        senderAddress: r.senderAddress,
        senderName: r.senderName,
        subject: r.subject,
        dateReceived: this.#index.renderDate(r.dateReceived),
        scope,
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
