import { dirname } from "node:path";

import {
  fileTrigger,
  normalizeFilter,
  type ArrivalSource,
  type Logger,
  type Watch,
  type WatchRegistry,
} from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PreconditionError } from "../client/errors.js";
import type { AppleMessagesClient } from "../client/messages.js";
import type { MessagesStore } from "../client/store.js";
import { MessagesArrivalSource, type MessageArrival } from "../client/watch.js";
import { wrap } from "./util.js";

/**
 * Messages' side of incoming watches: the lazily opened source, the trigger, the
 * handle resolution and the two tools.
 *
 * ## Why the source is lazy
 *
 * `createWatches` needs an `ArrivalSource` when the server is built, but a server
 * is built far more often than it is used (`serveStdio` makes one per
 * `server/discover` probe and throws it away). So the source handed over is an
 * adapter that delegates to a `MessagesArrivalSource` built by `ensure()`, which
 * runs on the first `watch` call. A server that never sees one opens nothing.
 *
 * ## Messages need not be running
 *
 * `imagent` writes chat.db, not Messages.app, so there is no running check and no
 * lookup to refresh: the trigger just ticks the registry.
 *
 * ## Handles
 *
 * A watch's `from` holds exact store spellings, because the source stamps each row
 * with `handle.id` lowercased and core compares for equality. What the caller types
 * is resolved against the store's handles first (see `resolveFrom`).
 */

const WAL_REASON =
  "The Messages store was opened in immutable mode, which cannot see its WAL, so the newest " +
  "messages are exactly what a watch would miss. APPLE_MESSAGES_INDEX_MODE=immutable asks for " +
  "that: set it to auto or ro, or unset it, then try again.";

export type MessagesWatchServiceOptions = {
  client: AppleMessagesClient;
  logger?: Logger | undefined;
};

/** How a handle compares: emails case-folded, phone numbers without their punctuation. */
const handleKey = (value: string): string => {
  const v = value.trim().toLowerCase();
  return v.includes("@") ? v : v.replaceAll(/[\s.\-()]/g, "");
};

export class MessagesWatchService {
  readonly #client: AppleMessagesClient;
  readonly #logger: Logger | undefined;

  #registry: WatchRegistry<MessageArrival> | undefined;
  #inner: MessagesArrivalSource | undefined;
  #dir: string | undefined;
  #store: MessagesStore | undefined;
  #init: Promise<void> | undefined;

  /** What `createWatches` is given. Delegates to the source `ensure()` builds. */
  readonly source: ArrivalSource<MessageArrival> = {
    head: () => this.#ready().head(),
    since: (after, limit) => this.#ready().since(after, limit),
  };

  constructor(opts: MessagesWatchServiceOptions) {
    this.#client = opts.client;
    this.#logger = opts.logger;
  }

  /** How many watches this connection holds. */
  get count(): number {
    return this.#registry?.size ?? 0;
  }

  /** Called once, by `createServer`, after `createWatches` returns. */
  bind(registry: WatchRegistry<MessageArrival>): void {
    this.#registry = registry;
  }

  #ready(): MessagesArrivalSource {
    if (!this.#inner) throw new Error("The messages watch source was used before it was set up.");
    return this.#inner;
  }

  /**
   * Open the store and build the source, once. Concurrency-safe: two simultaneous
   * `watch` calls share the promise. A failure is not kept, so a later call runs
   * setup again.
   */
  ensure(): Promise<void> {
    this.#init ??= Promise.resolve()
      .then(() => this.#setUp())
      .catch((err: unknown) => {
        this.#init = undefined;
        throw err;
      });
    return this.#init;
  }

  #setUp(): void {
    // Throws the store's own reason when it is off or unreadable.
    const { store, path } = this.#client.watchStore();
    // `immutable` is WAL-blind, and the WAL is where the newest message is.
    if (store.mode !== "ro") throw new PreconditionError(WAL_REASON);
    this.#store = store;
    this.#inner = new MessagesArrivalSource({ store });
    this.#dir = dirname(path);
  }

  /** What `createWatches` is given as `startTrigger`. Reads the directory now, not at construction. */
  startTrigger = (onChange: () => void): { stop(): void } => {
    if (!this.#dir) throw new Error("A watch trigger was started before the store was located.");
    return fileTrigger({
      dir: this.#dir,
      names: ["chat.db", "chat.db-wal"],
      ...(this.#logger ? { logger: this.#logger } : {}),
    })(onChange);
  };

  remove(id: string): boolean {
    return this.#registry?.remove(id) ?? false;
  }

  /**
   * Turn what the caller typed into exact store spellings.
   *
   * `storeHandlesFor` is a candidate list (a local "06 12 ..." reaches "+33 6 12 ..."),
   * so a typed value counts as resolved only when a candidate equals it after
   * normalisation. A short "+336" therefore resolves nothing, rather than every
   * French number. What does not resolve is kept, normalised and lowercased, and
   * reported (with `suggestions` when the store holds near misses).
   */
  resolveFrom(typed: readonly string[]): {
    from: string[];
    unresolved: string[];
    suggestions: { typed: string; candidates: string[] }[];
  } {
    const from: string[] = [];
    const unresolved: string[] = [];
    const suggestions: { typed: string; candidates: string[] }[] = [];
    // One read of the store's handles for the whole call, not one per entry.
    const pool = this.#store?.handles();
    for (const entry of typed) {
      const key = handleKey(entry);
      if (key === "") continue;
      const candidates = this.#client.storeHandlesFor(entry, pool);
      const exact = candidates.filter((h) => handleKey(h) === key);
      if (exact.length > 0) from.push(...exact);
      else {
        from.push(key);
        unresolved.push(key);
        if (candidates.length > 0) suggestions.push({ typed: entry, candidates });
      }
    }
    return { from: [...new Set(from)], unresolved: [...new Set(unresolved)], suggestions };
  }

  async add(input: { from?: string[] | undefined; domains?: string[] | undefined }): Promise<{
    watch: Watch;
    unresolved: string[];
    suggestions: { typed: string; candidates: string[] }[];
  }> {
    const registry = this.#registry;
    if (!registry) throw new Error("Messages watches are not bound to a registry.");
    // Refuse an empty filter before anything opens.
    normalizeFilter({
      ...(input.from ? { from: input.from } : {}),
      ...(input.domains ? { domains: input.domains } : {}),
    });
    await this.ensure();
    const { from, unresolved, suggestions } = this.resolveFrom(input.from ?? []);
    const filter = normalizeFilter({
      ...(from.length ? { from } : {}),
      ...(input.domains ? { domains: input.domains } : {}),
    });
    return { watch: registry.add(filter), unresolved, suggestions };
  }
}

export const registerWatchTools = (server: McpServer, service: MessagesWatchService): void => {
  server.registerTool(
    "apple_messages_watch",
    {
      description:
        "Watch for new messages from chosen handles. Give `from` (email addresses, or phone " +
        "numbers in international form such as +33612345678) and/or `domains` (email handles only; matches the " +
        "domain and its subdomains); a sender is required, there is no watch on all messages. " +
        "Returns a handle and its `uri`. The HOST subscribes to the uri to be told when to read " +
        "it, not you; reading it lists what arrived since the watch began (or since `after`), " +
        "metadata only, so fetch the text with apple_messages_get_message and the `id`. The " +
        "watch lasts as long as this connection. Your own messages and tapbacks never match. " +
        "Needs Full Disk Access; Messages does not have to be running.",
      inputSchema: z.object({
        from: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Email addresses, or phone numbers in international form (+33612345678: no trunk 0, " +
              "no (0)); spaces and punctuation are ignored, but a local spelling like 06 12 34 56 " +
              "78 never matches. An entry the store does not hold is kept without spaces or " +
              "punctuation, lowercased, and listed in `unresolved`, which does not prove the " +
              "person has not written: it fires only if the store later holds exactly that " +
              "spelling. Near misses come back as `suggestions` to retry with.",
          ),
        domains: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Email domains, e.g. acme.com. Matches only email handles, never a phone number.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, domains }) =>
      wrap(async () => {
        const { watch, unresolved, suggestions } = await service.add({ from, domains });
        return {
          watch: watch.id,
          uri: watch.uri,
          filter: { from: watch.filter.from, domains: watch.filter.domains },
          cursor: watch.createdAt,
          unresolved,
          ...(suggestions.length ? { suggestions } : {}),
        };
      }),
  );

  server.registerTool(
    "apple_messages_unwatch",
    {
      description:
        "Stop a watch made by apple_messages_watch, by its `watch` id. Returns whether one was " +
        "removed. Watches also end on their own when the connection closes, so this is only " +
        "needed to free one of the ten a connection may hold.",
      inputSchema: z.object({
        watch: z.string().min(1).describe("The `watch` id from apple_messages_watch."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ watch }) => wrap(async () => ({ removed: service.remove(watch) })),
  );
};
