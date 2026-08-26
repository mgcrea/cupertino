import { registerSurfaceResources } from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleMailClient } from "./client/mail.js";
import type { Logger, OsascriptRunner } from "./client/osascript.js";
import type { Config } from "./config.js";
import { MAIL_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches a real Mail. */
  osascript?: OsascriptRunner;
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

  registerTools(server, client, { allowWrites: config.allowWrites });
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
