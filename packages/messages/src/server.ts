import {
  createWatches,
  registerEvents,
  type Era,
  type Logger,
  type OsascriptRunner,
  registerSurfaceResources,
  withLazyTools,
} from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "./build-info.js";
import { AppleMessagesClient } from "./client/messages.js";
import type { Config } from "./config.js";
import { MESSAGES_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { messagesEventAdapter } from "./tools/events.js";
import { registerTools } from "./tools/index.js";
import { MessagesWatchService } from "./tools/watch.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches real Messages. */
  osascript?: OsascriptRunner;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
  /** Injected by tests, so no test reaches the developer's real address book. */
  contacts?: ConstructorParameters<typeof AppleMessagesClient>[0]["contacts"];
  /** Which protocol era this instance serves. Only watches care. Default `legacy`. */
  era?: Era;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleMessagesClient;
  /** Present only with `allowWatches` on. */
  watches?: MessagesWatchService | undefined;
  /** Present only with `allowEvents` on. Its own service, never the watches'. */
  events?: MessagesWatchService | undefined;
};

/**
 * Build the server. Side-effect free: it opens no database and reads no file,
 * so a test can construct it freely and every external dependency arrives
 * through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleMessagesClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.contacts === undefined ? {} : { contacts: opts.contacts }),
  });

  /*
   * Built here, outside `withLazyTools`, because the facade registers the tools
   * twice to sort reads from writes and `createWatches` must run once. Nothing
   * opens until a `watch` call (see MessagesWatchService), so a server built for a
   * discarded `server/discover` probe leaves nothing behind.
   */
  const closers: (() => void)[] = [];
  let watches: MessagesWatchService | undefined;
  if (config.allowWatches) {
    watches = new MessagesWatchService({
      client,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const service = watches;
    const registry = createWatches(server, {
      surface: "messages",
      displayName: "Messages",
      era: opts.era ?? "legacy",
      source: service.source,
      startTrigger: service.startTrigger,
    });
    service.bind(registry);
    closers.push(() => {
      registry.close();
      service.close();
    });
  }

  /*
   * Events read through a service of their own, never `bind`ed to a registry, so
   * a watch and a stream keep separate handles on chat.db and each is closed with
   * the connection. Nothing opens until the first events call.
   */
  let events: MessagesWatchService | undefined;
  if (config.allowEvents) {
    events = new MessagesWatchService({
      client,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const service = events;
    const served = registerEvents(server, {
      era: opts.era ?? "legacy",
      adapters: [messagesEventAdapter(service)],
    });
    closers.push(() => {
      served.close();
      service.close();
    });
  }

  if (closers.length > 0) {
    // `Protocol._onclose` calls `onclose` when the channel closes; nothing in
    // serveStdio assigns it for us. The registry's trigger is `unref`ed and its
    // watchers non-persistent, so a closing process needs no help; this stops a
    // long-lived host (a test, an embedder) from keeping a timer and two watchers
    // after the connection ends.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's close hook, not a DOM event.
    server.server.onclose = () => {
      for (const close of closers) close();
    };
  }

  withLazyTools(
    server,
    {
      surface: "messages",
      displayName: "Messages",
      lazy: config.lazyTools,
      allowWrites: config.allowWrites,
    },
    (target, allowWrites) =>
      registerTools(target, client, {
        allowWrites,
        allowCodes: config.allowCodes,
        allowFileSend: config.allowFileSend,
        watches,
      }),
  );
  /*
   * One flag, both primitives — see `exposePrompts` in core's config. A prompt
   * embeds its surface guide, so registering prompts without the resources
   * would leave every expansion naming a `cupertino://…/guide` that this
   * server does not serve.
   */
  if (config.exposePrompts) {
    registerPrompts(server, config.allowWrites);
    registerSurfaceResources(server, {
      surface: "messages",
      displayName: "Messages",
      guide: MESSAGES_GUIDE,
      diagnostics: () => buildDiagnostics(client),
      // No inventory. Chats are unbounded and change constantly, which makes them
      // a query (apple_messages_list_chats) rather than a fixed set worth
      // addressing by URI — a resource that is never the same twice is a tool
      // call wearing a URI.
    });
  }

  return { server, client, watches, events };
};
