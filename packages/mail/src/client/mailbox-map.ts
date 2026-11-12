import { PreconditionError } from "./errors.js";
import { LIST_ACCOUNTS } from "./jxa/read.js";
import type { OsascriptRunner } from "./osascript.js";

/**
 * The account/mailbox join table, and the single choke point for the account
 * allowlist.
 *
 * Everything downstream — search, reads, writes — resolves through here, so
 * filtering the account list once at construction is enough to guarantee that
 * no query path can reach an account the user excluded. Enforcing it in each
 * tool instead would be a list of places to forget.
 */

export type MailAccount = {
  id: string;
  name: string;
  enabled: boolean;
  accountType: string | null;
  emailAddresses: string[];
  fullName: string | null;
  directory: string | null;
  messageCaching: string | null;
  mailboxes: string[];
};

/** Split an Envelope Index mailbox URL into its account host and mailbox path. */
const parseIndexUrl = (url: string): { host: string; path: string } | null => {
  const m = /^([a-z-]+):\/\/([^/]*)\/?(.*)$/i.exec(url);
  if (!m) return null;
  return { host: decodeURIComponent(m[2] ?? ""), path: decodeURIComponent(m[3] ?? "") };
};

export type MailboxMapOptions = {
  runner: OsascriptRunner;
  /** Names or UUIDs. Empty = every account. */
  allowlist: string[];
  ttlMs: number;
  now?: () => number;
};

export class MailboxMap {
  readonly #runner: OsascriptRunner;
  readonly #allowlist: string[];
  readonly #ttlMs: number;
  readonly #now: () => number;

  #cache: { at: number; accounts: MailAccount[] } | null = null;
  /** The one read in flight, so concurrent callers share it rather than queue several. */
  #inflight: Promise<MailAccount[]> | null = null;

  constructor(opts: MailboxMapOptions) {
    this.#runner = opts.runner;
    this.#allowlist = opts.allowlist;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * True when an allowlist is set. A query that names no account then has a
   * scope of its own, the admitted accounts, rather than none: a SQL lane that
   * read "no account given" as "no filter" would count, name and page through
   * mail the user excluded before any row reached this map.
   */
  get restricted(): boolean {
    return this.#allowlist.length > 0;
  }

  /** True when the allowlist admits this account, by UUID or by display name. */
  #admits(account: MailAccount): boolean {
    if (this.#allowlist.length === 0) return true;
    return this.#allowlist.some(
      (entry) => entry === account.id || entry.toLowerCase() === account.name.toLowerCase(),
    );
  }

  /**
   * The account list. An expired one is served at once and refreshed behind
   * the call: LIST_ACCOUNTS measured ~1 s, and with a plain TTL that second
   * came back on the first call after every minute-long pause. Only a list
   * nobody has yet, an invalidated one or a forced read is waited for.
   */
  async accounts(force = false): Promise<MailAccount[]> {
    const cached = this.#cache;
    if (force || !cached) return this.#read();
    if (this.#now() - cached.at >= this.#ttlMs) {
      // A failed refresh keeps the list it would have replaced, and the next
      // call to find it expired tries again.
      this.#read().catch(() => undefined);
    }
    return cached.accounts;
  }

  #read(): Promise<MailAccount[]> {
    this.#inflight ??= this.#runner
      .run<MailAccount[]>(LIST_ACCOUNTS)
      .then((raw) => {
        const accounts = raw.filter((a) => this.#admits(a));
        this.#cache = { at: this.#now(), accounts };
        return accounts;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  /**
   * Resolve an account by UUID or display name. Case-insensitive on the name.
   * A name the cached list lacks earns one fresh read before it is refused,
   * since that list can be stale by design.
   */
  async resolveAccount(needle: string): Promise<MailAccount> {
    const find = (accounts: MailAccount[]) =>
      accounts.find((a) => a.id === needle) ??
      accounts.find((a) => a.name.toLowerCase() === needle.toLowerCase());
    let accounts = await this.accounts();
    let found = find(accounts);
    if (!found) {
      accounts = await this.accounts(true);
      found = find(accounts);
    }
    if (!found) {
      throw new PreconditionError(
        `No account "${needle}". Known accounts: ${accounts.map((a) => a.name).join(", ") || "(none visible)"}.` +
          (this.#allowlist.length ? " An allowlist is active (APPLE_MAIL_ACCOUNTS)." : ""),
      );
    }
    return found;
  }

  /**
   * Resolve a mailbox name within an account using the same ladder the JXA side
   * uses, so a name that works in one lane works in the other: exact, then
   * `[Gmail]/`-stripped, then final path segment, then case-insensitive.
   */
  resolveMailboxName(account: MailAccount, wanted: string): string {
    const candidates = [wanted];
    if (wanted.startsWith("[Gmail]/")) candidates.push(wanted.slice(8));
    if (wanted.includes("/")) {
      const last = wanted.split("/").pop();
      if (last) candidates.push(last);
    }
    for (const c of candidates) {
      if (account.mailboxes.includes(c)) return c;
    }
    for (const c of candidates) {
      const hit = account.mailboxes.find((m) => m.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
    throw new PreconditionError(
      `No mailbox "${wanted}" in account "${account.name}". Available: ${account.mailboxes.join(", ")}.`,
    );
  }

  /**
   * `resolveMailboxName` for a name a caller asked for, with `resolveAccount`'s
   * second chance: the account came out of a list that can be stale by design,
   * so a name it lacks earns one fresh read before it is refused. A mailbox
   * created in Mail, or synced from another device, since that list was taken
   * is then found on the first call rather than the one after.
   */
  async resolveMailbox(account: MailAccount, wanted: string): Promise<string> {
    try {
      return this.resolveMailboxName(account, wanted);
    } catch (error) {
      if (!(error instanceof PreconditionError)) throw error;
      const fresh = (await this.accounts(true)).find((a) => a.id === account.id);
      if (!fresh) throw error;
      return this.resolveMailboxName(fresh, wanted);
    }
  }

  /**
   * Map an Envelope Index `mailboxes.url` onto a scriptable account + mailbox.
   * The URL host is the account UUID (verified against live Mail), so this join
   * is exact rather than a heuristic on display names.
   */
  async resolveIndexUrl(url: string): Promise<{ account: MailAccount; mailbox: string } | null> {
    return this.resolveIndexUrlIn(await this.accounts(), url);
  }

  /**
   * `resolveIndexUrl` against accounts the caller already holds, with no Apple
   * Event: a watch rebuilds its lookup after reopening the index, from the
   * accounts it last asked Mail for.
   */
  resolveIndexUrlIn(
    accounts: readonly MailAccount[],
    url: string,
  ): { account: MailAccount; mailbox: string } | null {
    const parsed = parseIndexUrl(url);
    if (!parsed) return null;
    const account = accounts.find((a) => a.id === parsed.host);
    if (!account) return null;
    try {
      return { account, mailbox: this.resolveMailboxName(account, parsed.path) };
    } catch {
      return null;
    }
  }

  /**
   * True when an Envelope Index `mailboxes.url` belongs to an admitted account.
   *
   * The host alone decides, on purpose. `resolveIndexUrl` also needs the path
   * to name a mailbox Mail scripts, and a row whose path does not resolve is
   * still that account's mail: scoping by the host keeps it in the admitted
   * set, where the per-row lookup decides what it can show.
   */
  async admitsIndexUrl(url: string): Promise<boolean> {
    const parsed = parseIndexUrl(url);
    if (!parsed) return false;
    return (await this.accounts()).some((a) => a.id === parsed.host);
  }

  invalidate(): void {
    this.#cache = null;
  }
}
