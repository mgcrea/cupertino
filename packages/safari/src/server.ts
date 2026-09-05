import {
  type Logger,
  type OsascriptRunner,
  registerSurfaceResources,
  withLazyTools,
} from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleSafariClient } from "./client/safari.js";
import type { Config } from "./config.js";
import { SAFARI_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches real Safari. */
  osascript?: OsascriptRunner;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleSafariClient;
};

/**
 * Build the server. Side-effect free: it opens no database and reads no file,
 * so a test can construct it freely and every external dependency arrives
 * through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleSafariClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });

  withLazyTools(
    server,
    {
      surface: "safari",
      displayName: "Safari",
      lazy: config.lazyTools,
      allowWrites: config.allowWrites,
    },
    (target, allowWrites) =>
      registerTools(target, client, {
        allowWrites,
        allowCodes: config.allowCodes,
      }),
  );
  /*
   * One flag, both primitives — see `exposePrompts` in core's config. A prompt
   * embeds its surface guide, so registering prompts without the resources
   * would leave every expansion naming a `cupertino://…/guide` that this
   * server does not serve.
   */
  if (config.exposePrompts) {
    registerPrompts(server);
    registerSurfaceResources(server, {
      surface: "safari",
      displayName: "Safari",
      guide: SAFARI_GUIDE,
      diagnostics: () => buildDiagnostics(client),
      // No inventory. Safari has no containers you address by name — history,
      // tabs and the Reading List are three queries, not three folders, and the
      // guide's job here is to stop them being confused for one another.
    });
  }

  return { server, client };
};
