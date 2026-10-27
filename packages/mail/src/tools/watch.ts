import { dirname } from "node:path";

import {
  fileIdentity,
  fileTrigger,
  normalizeFilter,
  sameFile,
  type ArrivalSource,
  type FileIdentity,
  type Watch,
  type WatchRegistry,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { EnvelopeIndex, openIndex } from "../client/envelope.js";
import { PreconditionError } from "../client/errors.js";
import type { AppleMailClient } from "../client/mail.js";
import type { MailAccount } from "../client/mailbox-map.js";
import type { Logger } from "../client/osascript.js";
import {
  isMailRunning as defaultIsMailRunning,
  isUnwatchedMailbox,
  MailArrivalSource,
  type MailArrival,
  type MailboxLookup,
} from "../client/watch.js";
import type { Config } from "../config.js";
import { wrap } from "./util.js";

/**
 * Mail's side of incoming watches: the lazily opened source, the trigger, and the
 * two tools.
 *
 * ## Why the source is lazy
 *
 * `createWatches` needs an `ArrivalSource` when the server is built, but Mail's
 * needs an async setup (open the index, ask Mail for its accounts, build the
 * mailbox map, locate the file), and a server is built far more often than it is
 * used: `serveStdio` makes one per `server/discover` probe and throws it away. So
 * the source handed over is an adapter that delegates to a `MailArrivalSource`
 * built by `ensure()`, and `ensure()` runs on the first `watch` call. A server
 * that never sees one opens nothing.
 *
 * ## What a trigger costs: osascript only when there are rows to judge
 *
 * The registry's source methods are synchronous, but the accounts (whose
 * mailboxes and own addresses the lookup is built from) come from an Apple
 * Event, so a refresh happens on the caller's side: the trigger's `onChange`
 * awaits it and only then ticks. The poll fires every minute whether or not
 * anything arrived, so a refresh on a timer alone would run osascript every
 * minute for as long as a watch lived, and log a line each time while Mail is
 * closed. A refresh therefore runs only when a tick is about to judge rows
 * (`head() > mark`) and either no lookup has loaded yet or the TTL
 * (`mailboxCacheTtlMs`) has passed. An idle poll costs one `MAX(ROWID)` and no
 * Apple Event.
 *
 * A mailbox created since the last refresh is the other reason. Its rowid is not
 * among the mailboxes the lookup was built from, and judging its rows with that
 * lookup would exclude them for good. So the tick runs with the source holding
 * back at the first such row; the service then refreshes once and ticks again.
 * A mailbox that was there at the last refresh and still did not resolve
 * (`local://`, an account the allowlist hides) is not new, and costs nothing.
 *
 * A refresh that fails is logged once until one succeeds, and the tick runs on
 * the last lookup. So is a tick that fails.
 *
 * ## The watch keeps its own handle on the index, and reopens it when replaced
 *
 * A connection reads the inode it opened for as long as it lives. A re-index
 * that writes a new `Envelope Index` and renames it over the old one leaves that
 * connection reading the deleted file: nothing new arrives there and nothing
 * errors. So the service records the file's inode when it opens it, compares on
 * every trigger, and reopens before the tick when it changed. The registry then
 * sees the renumbered head below its mark and resets without notifying. The
 * mailbox rowids may be renumbered too, so the lookup is rebuilt from the new
 * file's `mailboxes` table with the accounts already in hand.
 *
 * The handle is the watch's own, not the client's `index()`. Reopening the
 * client's would change what search reads, and could close a handle a search
 * holds across an `await`; a second read-only connection changes nothing for
 * search. The client's index is still opened once at setup, to refuse with its
 * own reason (missing, no permission, immutable only) exactly as search would.
 *
 * ## Mailboxes are per watch
 *
 * `mailboxes` names resolve to Envelope Index rowids through the resolver search
 * uses, and go into the watch's filter as `scope` (as strings). The source stamps
 * each row with its own mailbox rowid and its Gmail label rowids, and core's
 * matching needs a shared key, so two watches on one connection can follow
 * different mailboxes.
 */

const IMMUTABLE_REASON =
  "The Envelope Index only opened in immutable mode, which cannot see Mail's WAL, so the " +
  "newest mail is exactly what a watch would miss. Grant Full Disk Access so the index " +
  "opens read-only (or leave APPLE_MAIL_INDEX_MODE on auto), then try again.";

/**
 * What one watch may follow, in mailboxes. A name can match a mailbox in every
 * account ("INBOX"), and core caps a filter's scope keys at 50; this keeps the
 * refusal in the tool's own terms.
 */
const MAX_WATCHED_MAILBOXES = 50;

export type MailWatchServiceOptions = {
  client: AppleMailClient;
  config: Pick<Config, "mailboxCacheTtlMs">;
  logger?: Logger | undefined;
  /** Injected by tests; the default asks `pgrep`. */
  isMailRunning?: (() => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
};

export class MailWatchService {
  readonly #client: AppleMailClient;
  readonly #ttlMs: number;
  readonly #logger: Logger | undefined;
  readonly #isMailRunning: () => Promise<boolean>;
  readonly #now: () => number;

  #registry: WatchRegistry<MailArrival> | undefined;
  /** The watch's own handle on the index, never the client's. */
  #index: EnvelopeIndex | undefined;
  #path: string | undefined;
  #identity: FileIdentity | null = null;
  #inner: MailArrivalSource | undefined;
  /** From the last refresh that succeeded; undefined until one has. */
  #accounts: MailAccount[] | undefined;
  #dir: string | undefined;
  #init: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshedAt = 0;
  /** Whether the last refresh failed, so a failure that persists is logged once. */
  #refreshFailing = false;
  #tickFailing = false;
  #reopenFailing = false;

  /**
   * Whether a refresh has ever succeeded. Until then the lookup is the empty one
   * seeded for a watch set while Mail was closed, and scanning with it would mark
   * every row excluded and move the cursor past arrivals that were never judged.
   */
  get #loaded(): boolean {
    return this.#accounts !== undefined;
  }

  /** What `createWatches` is given. Delegates to the source `ensure()` builds. */
  readonly source: ArrivalSource<MailArrival> = {
    head: () => this.#ready().head(),
    // Nothing is scanned before the first real lookup: no rows, so the cursor
    // stays where it was and a read or tick later sees these rows properly.
    since: (after, limit) => (this.#loaded ? this.#ready().since(after, limit) : []),
  };

  constructor(opts: MailWatchServiceOptions) {
    this.#client = opts.client;
    this.#ttlMs = opts.config.mailboxCacheTtlMs;
    this.#logger = opts.logger;
    this.#isMailRunning = opts.isMailRunning ?? (() => defaultIsMailRunning());
    this.#now = opts.now ?? Date.now;
  }

  /** How many watches this connection holds. */
  get count(): number {
    return this.#registry?.size ?? 0;
  }

  /** Called once, by `createServer`, after `createWatches` returns. */
  bind(registry: WatchRegistry<MailArrival>): void {
    this.#registry = registry;
  }

  #ready(): MailArrivalSource {
    if (!this.#inner) throw new Error("The mail watch source was used before it was set up.");
    return this.#inner;
  }

  /**
   * Open the index and build the source, once. Idempotent and concurrency-safe:
   * two simultaneous `watch` calls share the promise.
   *
   * A failure is not kept, so a later call runs setup again. What that recovers
   * is a failed refresh; an index that would not open stays unopenable, because
   * `client.index()` memoizes its own failure and answers the same thing again.
   *
   * A stale lookup is refreshed on the way out, since a `watch` call is not an
   * idle poll, and a refresh that fails is tolerated exactly as `onTrigger`
   * tolerates it: the watch is still usable on the last lookup, so a later
   * `watch` call must not fail for want of one.
   */
  ensure(): Promise<void> {
    this.#init ??= this.#setUp().catch((err: unknown) => {
      this.#init = undefined;
      throw err;
    });
    return this.#init.then(async () => {
      this.#reopenIfReplaced();
      if (this.#stale()) await this.#refreshSoftly();
    });
  }

  async #setUp(): Promise<void> {
    // The client's own open, for its reason when it fails: the watch then reads
    // through a handle of its own (see "keeps its own handle" above).
    const shared = await this.#client.index();
    if (!shared) {
      throw new PreconditionError(
        `The Envelope Index cannot be read, so there is nothing to watch: ${
          this.#client.indexError ?? "reason unknown"
        }`,
      );
    }
    // `immutable` is WAL-blind, and the WAL is where the newest mail is.
    if (shared.mode === "immutable") throw new PreconditionError(IMMUTABLE_REASON);

    const located = await this.#client.locate();
    if (!located.envelopeIndexPath) {
      throw new PreconditionError(located.reason ?? "The Envelope Index was not located.");
    }
    this.#open(located.envelopeIndexPath);
    try {
      await this.#refresh();
    } catch (err) {
      // Asking Mail for its accounts needs Mail running, and a watch is allowed
      // to be set before it is: `watch` then says so in its `note`. Start with an
      // empty lookup and nothing loaded, so the first trigger with rows refreshes.
      // Any other failure with Mail running is a real one and is not hidden.
      if (await this.#isMailRunning()) throw err;
      this.#logger?.warn?.("watch: Mail is not running, starting with an empty mailbox map", err);
      this.#refreshFailing = true;
    }
    this.#dir = dirname(located.envelopeIndexPath);
  }

  /** Open (or reopen) the watch's own handle, and only then let go of the old one. */
  #open(path: string): void {
    // Read before the open: a replacement between the two is then seen as one
    // on the next trigger, rather than missed for good.
    const identity = fileIdentity(path);
    const index = new EnvelopeIndex(openIndex(path, this.#client.config.indexMode, this.#logger));
    if (index.mode === "immutable") {
      index.close();
      throw new PreconditionError(IMMUTABLE_REASON);
    }
    const old = this.#index;
    this.#index = index;
    this.#path = path;
    this.#identity = identity;
    this.#rebuild();
    old?.close();
  }

  /**
   * Reopen when `Envelope Index` is now a different file. A path that cannot be
   * read is a replacement in progress, so it is left for the next trigger. A
   * reopen that fails keeps the old handle and is logged once until one works.
   */
  #reopenIfReplaced(): void {
    if (!this.#path) return;
    const now = fileIdentity(this.#path);
    if (now === null || (this.#identity !== null && sameFile(now, this.#identity))) return;
    try {
      this.#open(this.#path);
      this.#reopenFailing = false;
    } catch (err) {
      if (!this.#reopenFailing) {
        this.#logger?.warn?.(
          "watch: the Envelope Index was replaced and could not be reopened",
          err,
        );
      }
      this.#reopenFailing = true;
    }
  }

  /** Ask Mail for its accounts, then rebuild the lookup from them. */
  async #refresh(): Promise<void> {
    // Forced: the point of a refresh is Mail's answer now, not the client's cache.
    this.#accounts = await this.#client.accounts(true);
    this.#refreshedAt = this.#now();
    this.#rebuild();
  }

  /**
   * The lookup and the source, from the accounts in hand and the index's own
   * `mailboxes` table. No Apple Event: it runs after a refresh and after a reopen.
   */
  #rebuild(): void {
    const index = this.#index;
    if (!index) return;
    const accounts = this.#accounts ?? [];
    const map = new Map<number, { accountUuid: string; mailbox: string }>();
    const known = new Set<number>();
    for (const row of index.mailboxes()) {
      known.add(row.rowid);
      const resolved = this.#client.mailboxes.resolveIndexUrlIn(accounts, row.url);
      if (resolved)
        map.set(row.rowid, { accountUuid: resolved.account.id, mailbox: resolved.mailbox });
    }
    const lookup: MailboxLookup = (rowid) => map.get(rowid) ?? null;
    this.#inner = new MailArrivalSource({
      index,
      ownAddresses: accounts.flatMap((a) => a.emailAddresses),
      lookup,
      knownMailboxes: known,
    });
  }

  #stale(): boolean {
    return !this.#loaded || this.#now() - this.#refreshedAt >= this.#ttlMs;
  }

  /**
   * Refresh, sharing one in flight. Never throws: a failure is logged once until
   * a refresh succeeds, and the answer says whether this one did.
   */
  async #refreshSoftly(): Promise<boolean> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    try {
      await this.#refreshing;
      this.#refreshFailing = false;
      return true;
    } catch (err) {
      if (!this.#refreshFailing) {
        this.#logger?.warn?.("watch: could not refresh the mailbox map, using the last one", err);
      }
      this.#refreshFailing = true;
      return false;
    }
  }

  /**
   * The trigger's callback: reopen a replaced index, refresh if rows are waiting
   * and the lookup is stale, then tick, and refresh once more and tick again if
   * the scan held back at a mailbox it has never seen.
   *
   * Before any lookup has loaded there is none to fall back on (Mail may be
   * launching, and has written the index before it can answer for its
   * accounts), so a failed first refresh skips the tick and the next trigger or
   * the poll tries again.
   */
  async onTrigger(tick: () => void): Promise<void> {
    this.#reopenIfReplaced();
    const waiting = this.#ready().head() > (this.#registry?.mark ?? 0);
    if (waiting && this.#stale() && !(await this.#refreshSoftly()) && !this.#loaded) return;

    const inner = this.#ready();
    inner.holdNewMailboxes = true;
    try {
      tick();
    } finally {
      inner.holdNewMailboxes = false;
    }
    if (!inner.takeHeld()) return;
    // Refreshed or not, tick again with nothing held: a mailbox still unknown
    // after asking is excluded, as it would have been before.
    await this.#refreshSoftly();
    tick();
  }

  /**
   * What the file trigger runs. `onTrigger` is async and the trigger's own
   * log-once guard only sees what throws synchronously, so this one applies the
   * same rule: a failing tick is logged once until a tick succeeds.
   */
  runTrigger(tick: () => void): Promise<void> {
    return this.onTrigger(tick).then(
      () => {
        this.#tickFailing = false;
      },
      (err: unknown) => {
        if (!this.#tickFailing) this.#logger?.warn?.("watch: tick failed", err);
        this.#tickFailing = true;
      },
    );
  }

  /** What `createWatches` is given as `startTrigger`. Reads the directory now, not at construction. */
  startTrigger = (onChange: () => void): { stop(): void } => {
    if (!this.#dir) throw new Error("A watch trigger was started before the index was located.");
    return fileTrigger({
      dir: this.#dir,
      names: ["Envelope Index", "Envelope Index-wal"],
      ...(this.#logger ? { logger: this.#logger } : {}),
    })(() => {
      void this.runTrigger(onChange);
    });
  };

  /** Close the watch's own handle. Called when the connection ends. */
  close(): void {
    this.#index?.close();
    this.#index = undefined;
    this.#inner = undefined;
    this.#path = undefined;
    this.#init = undefined;
  }

  remove(id: string): boolean {
    return this.#registry?.remove(id) ?? false;
  }

  /** The file identity of the index the watch reads now, or null when it is unknown or unreadable. */
  identity(): FileIdentity | null {
    return this.#identity;
  }

  /**
   * Resolve mailbox names to scope keys (Envelope Index rowids, as strings).
   * Empty for no names. Refuses with a `PreconditionError` for a name that can
   * never fire, for names when Mail is not running, for a name that matches no
   * mailbox, and for more mailboxes than a watch can follow. `running` is for a
   * caller that has already asked.
   */
  async resolveMailboxScope(mailboxes: string[], running?: boolean): Promise<string[]> {
    if (mailboxes.length === 0) {
      await this.ensure();
      return [];
    }
    if (!(running ?? (await this.#isMailRunning()))) {
      throw new PreconditionError(
        "Mailbox names cannot be resolved until Mail is running: Mail is what says which " +
          "mailboxes an account has. Open Mail and try again, or watch without `mailboxes`.",
      );
    }
    for (const name of mailboxes) {
      // The source excludes these for every watch, so a watch on one would never fire.
      if (isUnwatchedMailbox(`imap://x/${name}`)) {
        throw new PreconditionError(
          `"${name}" is never watched: Sent, Drafts, Junk and Trash are excluded, so a watch ` +
            "on it could never fire.",
        );
      }
    }
    await this.ensure();
    const rowids = await this.#client.mailboxRowidsFor(mailboxes);
    if (rowids.length > MAX_WATCHED_MAILBOXES) {
      throw new PreconditionError(
        `Those names cover ${rowids.length} mailboxes across the accounts, more than a watch can ` +
          `follow (${MAX_WATCHED_MAILBOXES}). Name fewer mailboxes.`,
      );
    }
    return rowids.map(String);
  }

  /** Resolve `mailboxes` to scope keys and register the watch. */
  async add(
    filter: ReturnType<typeof normalizeFilter>,
    mailboxes: string[] | undefined,
  ): Promise<{ watch: Watch; running: boolean }> {
    const registry = this.#registry;
    if (!registry) throw new Error("Mail watches are not bound to a registry.");
    const running = await this.#isMailRunning();
    const scope = await this.resolveMailboxScope(mailboxes ?? [], running);
    const watch = registry.add(normalizeFilter({ ...filter, scope }));
    return { watch, running };
  }
}

export const registerWatchTools = (server: McpServer, service: MailWatchService): void => {
  server.registerTool(
    "apple_mail_watch",
    {
      description:
        "Watch for new mail from chosen senders. Give `from` (exact addresses) and/or `domains` " +
        "(matches the domain and its subdomains); a sender is required, there is no watch on all " +
        "mail. Returns a handle and its `uri`. Read the uri to see what arrived since the watch began " +
        "(or since `after`): a host that subscribes is told when to read it, but many never do, so " +
        "check it yourself rather than promising the user a notification. Envelope only, so fetch " +
        "a body with apple_mail_get_message. The watch lasts as long as " +
        "this connection. Sent, Drafts, Junk and Trash and your own addresses never match. " +
        "Needs Full Disk Access, and Mail has to be running for mail to arrive.",
      inputSchema: z.object({
        from: z
          .array(z.string().min(1))
          .optional()
          .describe("Exact sender addresses, case-insensitive."),
        domains: z
          .array(z.string().min(1))
          .optional()
          .describe("Sender domains, e.g. acme.com. Matches @acme.com and any subdomain."),
        mailboxes: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            "Only mail in these mailboxes, named as in apple_mail_list_mailboxes. Omit for every " +
              "mailbox except Sent, Drafts, Junk and Trash.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, domains, mailboxes }) =>
      wrap(async () => {
        const filter = normalizeFilter({
          ...(from ? { from } : {}),
          ...(domains ? { domains } : {}),
        });
        const { watch, running } = await service.add(filter, mailboxes);
        return {
          watch: watch.id,
          uri: watch.uri,
          filter: {
            from: watch.filter.from,
            domains: watch.filter.domains,
            mailboxes: mailboxes && mailboxes.length > 0 ? mailboxes : "default",
          },
          cursor: watch.createdAt,
          ...(running
            ? {}
            : {
                note:
                  "Mail is not running. Mail has to be running for mail to arrive: the index only " +
                  "changes while Mail fetches, so nothing will match until it is open.",
              }),
        };
      }),
  );

  server.registerTool(
    "apple_mail_unwatch",
    {
      description:
        "Stop a watch made by apple_mail_watch, by its `watch` id. Returns whether one was " +
        "removed. Watches also end on their own when the connection closes, so this is only " +
        "needed to free one of the ten a connection may hold.",
      inputSchema: z.object({
        watch: z.string().min(1).describe("The `watch` id from apple_mail_watch."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ watch }) => wrap(async () => ({ removed: service.remove(watch) })),
  );
};
