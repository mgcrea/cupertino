#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { CONTACTS_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-contacts-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: CONTACTS_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server, client } = createServer({ config, logger });
    const status = client.status();
    return {
      server,
      // No writes= line: this surface has no mutating tool, and printing a flag
      // that gates nothing would imply one exists.
      banner:
        `read-only, ` +
        `stores=${status.shards.length}/${status.located.candidates.length}, ` +
        `contacts=${status.totalContacts}, ` +
        `suffix=${config.phoneSuffixDigits}, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
