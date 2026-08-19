#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { MAIL_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-mail-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: MAIL_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server } = createServer({ config, logger });
    return {
      server,
      banner:
        `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
        `accounts=${config.accounts.length ? config.accounts.join("/") : "all"}, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
