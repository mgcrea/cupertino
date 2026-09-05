import {
  type Logger,
  type OsascriptRunner,
  registerSurfaceResources,
  withLazyTools,
} from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleRemindersClient } from "./client/reminders.js";
import type { Config } from "./config.js";
import { REMINDERS_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches a real Reminders. */
  osascript?: OsascriptRunner;
  /** Injected by tests so the TTL cache can be exercised without waiting. */
  now?: () => Date;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleRemindersClient;
};

/**
 * Build the server. Side-effect free: it opens no connection, spawns no
 * process and reads no file, so a test can construct it freely and every
 * external dependency arrives through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleRemindersClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  withLazyTools(
    server,
    {
      surface: "reminders",
      displayName: "Reminders",
      lazy: config.lazyTools,
      allowWrites: config.allowWrites,
    },
    (target, allowWrites) => registerTools(target, client, { allowWrites }),
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
      surface: "reminders",
      displayName: "Reminders",
      guide: REMINDERS_GUIDE,
      diagnostics: () => buildDiagnostics(client, { allowWrites: config.allowWrites }),
      inventory: {
        describes: "accounts and lists",
        read: async () => ({
          accounts: await client.accounts(),
          lists: await client.lists(),
        }),
      },
    });
  }

  return { server, client };
};
