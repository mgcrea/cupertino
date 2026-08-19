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

  constructor(opts: MailboxMapOptions) {
    this.#runner = opts.runner;
    this.#allowlist = opts.allowlist;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
  }

  /** True when the allowlist admits this account, by UUID or by display name. */
  #admits(account: MailAccount): boolean {
    if (this.#allowlist.length === 0) return true;
    return this.#allowlist.some(
      (entry) => entry === account.id || entry.toLowerCase() === account.name.toLowerCase(),
    );
  }

  async accounts(force = false): Promise<MailAccount[]> {
    const cached = this.#cache;
    if (!force && cached && this.#now() - cached.at < this.#ttlMs) return cached.accounts;

    const raw = await this.#runner.run<MailAccount[]>(LIST_ACCOUNTS);
    const accounts = raw.filter((a) => this.#admits(a));
    this.#cache = { at: this.#now(), accounts };
    return accounts;
  }

  /** Resolve an account by UUID or display name. Case-insensitive on the name. */
  async resolveAccount(needle: string): Promise<MailAccount> {
    const accounts = await this.accounts();
    const found =
      accounts.find((a) => a.id === needle) ??
      accounts.find((a) => a.name.toLowerCase() === needle.toLowerCase());
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
   * Map an Envelope Index `mailboxes.url` onto a scriptable account + mailbox.
   * The URL host is the account UUID (verified against live Mail), so this join
   * is exact rather than a heuristic on display names.
   */
  async resolveIndexUrl(url: string): Promise<{ account: MailAccount; mailbox: string } | null> {
    const m = /^([a-z-]+):\/\/([^/]*)\/?(.*)$/i.exec(url);
    if (!m) return null;
    const host = decodeURIComponent(m[2] ?? "");
    const path = decodeURIComponent(m[3] ?? "");
    const accounts = await this.accounts();
    const account = accounts.find((a) => a.id === host);
    if (!account) return null;
    try {
      return { account, mailbox: this.resolveMailboxName(account, path) };
    } catch {
      return null;
    }
  }

  invalidate(): void {
    this.#cache = null;
  }
}
