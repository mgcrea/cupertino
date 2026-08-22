#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { SAFARI_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-safari-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: SAFARI_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server, client } = createServer({ config, logger });
    const status = client.status();
    return {
      server,
      // Both lanes are named, because half-working is the normal degraded state
      // here and a banner reporting one number would hide it. No writes= line:
      // this surface has no mutating tool, and printing a flag that gates
      // nothing would imply one exists.
      banner:
        `read-only, ` +
        `history=${status.store.opened ? "open" : "UNREADABLE"}, ` +
        `items=${(status.capabilities?.counts as { items?: number } | undefined)?.items ?? 0}, ` +
        `bookmarks=${status.located.bookmarks.readable ? "readable" : "UNREADABLE"}, ` +
        `tabs=${config.liveTabs ? "apple-events" : "disabled"}, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
