import { dirname } from "node:path";

import {
  fileTrigger,
  normalizeFilter,
  type ArrivalSource,
  type Watch,
  type WatchRegistry,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EnvelopeIndex } from "../client/envelope.js";
import { PreconditionError } from "../client/errors.js";
import type { AppleMailClient } from "../client/mail.js";
import type { Logger } from "../client/osascript.js";
import {
  isMailRunning as defaultIsMailRunning,
  MailArrivalSource,
  type MailArrival,
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
 * ## How the lookup stays fresh while `head()` and `since()` stay synchronous
 *
 * The registry's source methods are synchronous, but the mailbox lookup and the
 * account's own addresses come from async calls. A mailbox created after the
 * watch started would be unknown to a lookup built before it, and every row in it
 * would be excluded for as long as the watch lived. So the refresh happens on the
 * caller's side: the trigger's `onChange` awaits `refreshIfStale()` and only then
 * calls the registry's tick, which finds the new lookup already in place. A
 * refresh runs when the client's mailbox cache TTL (`mailboxCacheTtlMs`) has
 * passed, so at most once per TTL however often the trigger fires.
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
  #index: EnvelopeIndex | undefined;
  #inner: MailArrivalSource | undefined;
  #lookup: ReturnType<typeof toLookup> | undefined;
  #own: string[] = [];
  #dir: string | undefined;
  #init: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshedAt = 0;

  /** What `createWatches` is given. Delegates to the source `ensure()` builds. */
  readonly source: ArrivalSource<MailArrival> = {
    head: () => this.#ready().head(),
    since: (after, limit) => this.#ready().since(after, limit),
  };

  constructor(opts: MailWatchServiceOptions) {
    this.#client = opts.client;
    this.#ttlMs = opts.config.mailboxCacheTtlMs;
    this.#logger = opts.logger;
    this.#isMailRunning = opts.isMailRunning ?? (() => defaultIsMailRunning());
    this.#now = opts.now ?? Date.now;
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
   * two simultaneous `watch` calls share the promise. A failure is not kept, so a
   * later call can try again.
   */
  ensure(): Promise<void> {
    this.#init ??= this.#setUp().catch((err: unknown) => {
      this.#init = undefined;
      throw err;
    });
    return this.#init.then(() => this.#refreshIfStale());
  }

  async #setUp(): Promise<void> {
    const index = await this.#client.index();
    if (!index) {
      throw new PreconditionError(
        `The Envelope Index cannot be read, so there is nothing to watch: ${
          this.#client.indexError ?? "reason unknown"
        }`,
      );
    }
    // `immutable` is WAL-blind, and the WAL is where the newest mail is.
    if (index.mode === "immutable") throw new PreconditionError(IMMUTABLE_REASON);
    this.#index = index;

    const located = await this.#client.locate();
    if (!located.envelopeIndexPath) {
      throw new PreconditionError(located.reason ?? "The Envelope Index was not located.");
    }
    await this.#load();
    this.#dir = dirname(located.envelopeIndexPath);
  }

  /** Rebuild the lookup and the own addresses. */
  async #load(): Promise<void> {
    const [map, accounts] = await Promise.all([
      this.#client.mailboxLookup(),
      this.#client.accounts(),
    ]);
    this.#lookup = toLookup(map);
    this.#own = accounts.flatMap((a) => a.emailAddresses);
    this.#refreshedAt = this.#now();
    this.#rebuild();
  }

  #rebuild(): void {
    if (!this.#lookup || !this.#index) return;
    this.#inner = new MailArrivalSource({
      index: this.#index,
      ownAddresses: this.#own,
      lookup: this.#lookup,
    });
  }

  #refreshIfStale(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    if (this.#now() - this.#refreshedAt < this.#ttlMs) return Promise.resolve();
    this.#refreshing = this.#load().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /**
   * The trigger's callback: refresh the lookup if the TTL has passed, then tick.
   * A refresh that fails is logged and the tick still runs on the old lookup,
   * since a stale lookup is better than a missed arrival.
   */
  async onTrigger(tick: () => void): Promise<void> {
    try {
      await this.#refreshIfStale();
    } catch (err) {
      this.#logger?.warn?.("watch: could not refresh the mailbox map, using the last one", err);
    }
    tick();
  }

  /** What `createWatches` is given as `startTrigger`. Reads the directory now, not at construction. */
  startTrigger = (onChange: () => void): { stop(): void } => {
    if (!this.#dir) throw new Error("A watch trigger was started before the index was located.");
    return fileTrigger({
      dir: this.#dir,
      names: ["Envelope Index", "Envelope Index-wal"],
      ...(this.#logger ? { logger: this.#logger } : {}),
    })(() => {
      this.onTrigger(onChange).catch((err: unknown) => {
        this.#logger?.warn?.("watch: tick failed", err);
      });
    });
  };

  remove(id: string): boolean {
    return this.#registry?.remove(id) ?? false;
  }

  /** Resolve `mailboxes` to scope keys and register the watch. */
  async add(
    filter: ReturnType<typeof normalizeFilter>,
    mailboxes: string[] | undefined,
  ): Promise<{ watch: Watch; running: boolean }> {
    const registry = this.#registry;
    if (!registry) throw new Error("Mail watches are not bound to a registry.");
    await this.ensure();
    const scope =
      mailboxes && mailboxes.length > 0
        ? (await this.#client.mailboxRowidsFor(mailboxes)).map(String)
        : [];
    const running = await this.#isMailRunning();
    const watch = registry.add(normalizeFilter({ ...filter, scope }));
    return { watch, running };
  }
}

const toLookup = (map: Awaited<ReturnType<AppleMailClient["mailboxLookup"]>>) => {
  return (rowid: number): { accountUuid: string; mailbox: string } | null => {
    const e = map.get(rowid);
    return e ? { accountUuid: e.accountUuid, mailbox: e.mailbox } : null;
  };
};

export const registerWatchTools = (server: McpServer, service: MailWatchService): void => {
  server.registerTool(
    "apple_mail_watch",
    {
      description:
        "Watch for new mail from chosen senders. Give `from` (exact addresses) and/or `domains` " +
        "(matches the domain and its subdomains); a sender is required, there is no watch on all " +
        "mail. Returns a handle and its `uri`. The HOST subscribes to the uri to be told when to " +
        "read it, not you; reading it lists what arrived since the watch began (or since `after`), " +
        "envelope only, so fetch a body with apple_mail_get_message. The watch lasts as long as " +
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
