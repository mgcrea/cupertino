import {
  registerSurfaceResources,
  type Logger,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { AppleContactsClient } from "./client/contacts.js";
import type { Config } from "./config.js";
import { CONTACTS_GUIDE } from "./guide.js";
import { registerPrompts } from "./prompts.js";
import { buildDiagnostics } from "./tools/diagnostics.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches real Contacts. */
  osascript?: OsascriptRunner;
  /** Injected by tests so discovery never reaches the developer's real home. */
  home?: string;
};

export type CreatedServer = {
  server: McpServer;
  client: AppleContactsClient;
};

/**
 * Build the server. Side-effect free: it opens no database and reads no file,
 * so a test can construct it freely and every external dependency arrives
 * through an option.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new AppleContactsClient({
    config,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.osascript ? { osascript: opts.osascript } : {}),
    ...(opts.home ? { home: opts.home } : {}),
  });

  registerTools(server, client, { allowWrites: config.allowWrites });
  registerPrompts(server);
  registerSurfaceResources(server, {
    surface: "contacts",
    displayName: "Contacts",
    guide: CONTACTS_GUIDE,
    diagnostics: () => buildDiagnostics(client),
    // No inventory. The other surfaces have containers you address by name —
    // mailboxes, lists, calendars — and this one does not: you reach a contact
    // by searching for it, never by naming the store it happens to live in.
    // The stores are reported in diagnostics, where they are a permissions
    // fact rather than something to filter on.
  });

  return { server, client };
};
