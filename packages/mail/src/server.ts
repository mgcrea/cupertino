import {
  createWatches,
  registerSurfaceResources,
  withLazyTools,
  type Era,
} from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "./build-info.js";
import { AppleMailClient } from "./client/mail.js";
import type { Logger, OsascriptRunner } from "./client/osascript.js";
import type { Config } from "./config.js";
import { MAIL_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";
import { MailWatchService } from "./tools/watch.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches a real Mail. */
  osascript?: OsascriptRunner;
  /** Which protocol era this instance serves. Only watches care. Default `legacy`. */
  era?: Era;
  /** Injected by tests so a watch never runs `pgrep`. */
  isMailRunning?: () => Promise<boolean>;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleMailClient;
};

/**
 * Build the server. Side-effect free: it opens no connection, spawns no
 * process and reads no file, so a test can construct it freely and every
 * external dependency arrives through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleMailClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
  });

  /*
   * Built here, outside `withLazyTools`, because the facade registers the tools
   * twice to sort reads from writes and `createWatches` must run once. Nothing
   * opens until a `watch` call (see MailWatchService), so a server built for a
   * discarded `server/discover` probe leaves nothing behind.
   */
  let watches: MailWatchService | undefined;
  if (config.allowWatches) {
    watches = new MailWatchService({
      client,
      config,
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.isMailRunning ? { isMailRunning: opts.isMailRunning } : {}),
    });
    const service = watches;
    const registry = createWatches(server, {
      surface: "mail",
      displayName: "Mail",
      era: opts.era ?? "legacy",
      source: service.source,
      startTrigger: service.startTrigger,
    });
    service.bind(registry);
    // The registry's trigger is `unref`ed and its watchers non-persistent, so a
    // closing process needs no help; this just stops a long-lived host (a test,
    // an embedder) from keeping a timer and two watchers after the connection ends.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's close hook, not a DOM event; serveStdio chains whatever is set here.
    server.server.onclose = () => registry.close();
  }

  withLazyTools(
    server,
    {
      surface: "mail",
      displayName: "Mail",
      lazy: config.lazyTools,
      allowWrites: config.allowWrites,
    },
    (target, allowWrites) => registerTools(target, client, { allowWrites, watches }),
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
      surface: "mail",
      displayName: "Mail",
      guide: MAIL_GUIDE,
      diagnostics: () => buildDiagnostics(client, { allowWrites: config.allowWrites }),
      inventory: {
        describes: "accounts and mailboxes",
        // The AppleScript lane, not the index: the Envelope Index stores no
        // account display names at all, so an index-first inventory would have
        // to invent them out of URL fragments. Cost is O(mailboxes), not
        // O(messages) — measured at 0.6s for every account on this machine.
        read: async () =>
          (await client.accounts()).map((a) => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            type: a.accountType,
            emailAddresses: a.emailAddresses,
            mailboxes: a.mailboxes,
          })),
      },
    });
  }

  return { server, client };
};
